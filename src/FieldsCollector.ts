import assert from 'node:assert';
import {webcrypto} from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {createRunner, PuppeteerRunnerExtension, UserFlow} from '@puppeteer/replay';
import type {BrowserContext, ElementHandle, Frame, Page} from 'puppeteer';
import {groupBy} from 'rambda';
import * as tldts from 'tldts';
import {BaseCollector, puppeteer, TargetCollector} from 'tracker-radar-collector';
import {DeepRequired, UnreachableCaseError} from 'ts-essentials';

import {SelectorChain} from 'leak-detect-inject';
import {
	addAll,
	appendDomainToEmail,
	AsBound,
	filterUniqBy,
	formatDuration,
	forwardPromise,
	getRelativeUrl,
	MaybePromise,
	MaybePromiseLike,
	nonEmpty,
	notFalsy,
	populateDefaults,
	raceWithCondition,
	tryAdd,
} from './utils';
import {ColoredLogger, Logger, PlainLogger} from './logger';
import {fillEmailField, fillPasswordField, submitField} from './formInteraction';
import {
	closeExtraPages,
	ElementAttrs,
	ElementInfo,
	FathomElementAttrs,
	FieldElementAttrs,
	formSelectorChain,
	getElementAttrs,
	getElementBySelectorChain,
	getElementInfoFromAttrs,
	getElemIdentifier,
	LinkElementAttrs,
	LinkMatchType,
	selectorStr,
} from './pageUtils';
import {getLoginLinks} from './loginLinks';
import {exposeFunction, getFrameStack, unwrapHandle} from './puppeteerUtils';
import chalk from 'chalk';
import ErrnoException = NodeJS.ErrnoException;
import TimeoutError = puppeteer.TimeoutError;

export class FieldsCollector extends BaseCollector {
	static defaultOptions: FullFieldsCollectorOptions;
	/** Page function to inject leak-detect-inject */
	static #doInjectFun: (debug: boolean) => void;
	/** @return Newly injected? */
	static #doInjectPasswordLeakDetectionFun: (password: string) => boolean;

	readonly options: FullFieldsCollectorOptions;
	#log: Logger | undefined;
	#dataParams!: Parameters<typeof BaseCollector.prototype.getData>[0];
	#initialUrl!: URL;
	#context!: BrowserContext;
	#headless                  = true;
	/** `null` for IP or localhost */
	#siteDomain: string | null = null;

	/** Landing page */
	#page!: Page;
	#frameIdMap               = new Map<string /*ID*/, Frame>();
	#frameIdReverseMap        = new Map<Frame, string /*ID*/>();
	/** Pages that password leak callback has been injected into */
	#injectedPasswordCallback = new Set<Page>();
	#startUrls                = new Map<Page, string>();
	#postCleanListeners       = new Map<Page, () => MaybePromiseLike<void>>();
	#dirtyPages               = new Set<Page>();

	#events: FieldsCollectorEvent[]  = [];
	/** Selectors of processed fields */
	#processedFields                 = new Set<string>();
	#passwordLeaks: PasswordLeak[]   = [];
	#visitedTargets: VisitedTarget[] = [];
	#errors: ErrorInfo[]             = [];

	constructor(options?: FieldsCollectorOptions, logger?: Logger) {
		super();
		this.options = populateDefaults<FullFieldsCollectorOptions>(options ?? {}, FieldsCollector.defaultOptions);

		FieldsCollector.#loadInjectScripts();
		this.#log = logger;
	}

	static #loadInjectScripts() {
		this.#doInjectFun ??= (() => {
			const bundle = require.resolve('leak-detect-inject/dist/bundle.js');
			let bundleTime;
			try {
				bundleTime = fs.statSync(bundle).mtimeMs;
			} catch (err) {
				if ((err as ErrnoException).code === 'ENOENT')
					console.error('bundle to inject not found, run `npm run pack` in the `inject` folder');
				throw err;
			}
			const sourceDir      = path.join(path.dirname(path.dirname(bundle)), 'src/');
			const sourceFileTime = fs.readdirSync(sourceDir)
				  .map(fileName => fs.statSync(path.join(sourceDir, fileName)).mtimeMs)
				  .reduce((a, b) => Math.max(a, b));
			const timeDiff       = sourceFileTime - bundleTime;
			if (timeDiff > 0)
				console.warn(chalk.yellow(`\n⚠️ inject script was modified ${formatDuration(timeDiff)} after bundle creation, ` +
					  'you should probably run `npm run -w inject pack` ⚠️\n'));
			const injectSrc = fs.readFileSync(bundle, 'utf8');
			// eslint-disable-next-line @typescript-eslint/no-implied-eval
			return Function('debug', /*language=JavaScript*/ `'use strict';
			try {
				window[${JSON.stringify(PageVars.INJECTED)}] ??= (function getLeakDetectInject() {
					/** @type typeof import('leak-detect-inject') */
					var leakDetectInject = {};
					${injectSrc};
					if (debug) leakDetectInject.enableDebug();
					return leakDetectInject;
				})();
			} catch (err) {
				window[${JSON.stringify(PageVars.ERROR_CALLBACK)}](window[${JSON.stringify(PageVars.FRAME_ID)}], String(err), err instanceof Error && err.stack || Error().stack);
			}`) as (debug: boolean) => void;
		})();

		this.#doInjectPasswordLeakDetectionFun ??= function doInjectPasswordLeakDetection(password: string) {
			// noinspection JSNonStrictModeUsed
			'use strict';
			if (window[PageVars.PASSWORD_OBSERVED] === true) return false;
			window[PageVars.PASSWORD_OBSERVED] = true;

			const observer = new MutationObserver(mutations => {
				try {
					for (const m of mutations)
						for (const node of m.addedNodes)
							inspectRecursive(node, true);

					const leakSelectors = mutations
						  .filter(m => m.attributeName && m.target instanceof Element &&
								m.target.getAttribute(m.attributeName)?.includes(password))
						  .map(m => ({
							  selector: window[PageVars.INJECTED].formSelectorChain(m.target as Element),
							  attribute: m.attributeName!,
						  }));
					if (leakSelectors.length)
						void window[PageVars.PASSWORD_CALLBACK]!(window[PageVars.FRAME_ID]!, leakSelectors);
				} catch (err) {
					window[PageVars.ERROR_CALLBACK](window[PageVars.FRAME_ID], String(err), err instanceof Error && err.stack || Error().stack!);
				}
			});

			function inspectRecursive(node: Node, checkExistingAttrs: boolean) {
				if ([Node.DOCUMENT_NODE, Node.DOCUMENT_FRAGMENT_NODE].includes(node.nodeType))
					observer.observe(node, {subtree: true, attributes: true, childList: true});
				if (node instanceof Element) {
					if (checkExistingAttrs) {
						const leakSelectors = [...node.attributes]
							  .filter(attr => attr.value === password)
							  .map(attr => ({
								  selector: window[PageVars.INJECTED].formSelectorChain(node),
								  attribute: attr.name,
							  }));
						if (leakSelectors.length)
							void window[PageVars.PASSWORD_CALLBACK]!(window[PageVars.FRAME_ID]!, leakSelectors);
					}
					if (node.shadowRoot) inspectRecursive(node.shadowRoot, checkExistingAttrs);
				}
				for (const child of node.childNodes)
					inspectRecursive(child, checkExistingAttrs);
			}

			// Also catch ShadowRoots added after element was added to document
			// eslint-disable-next-line @typescript-eslint/unbound-method
			const attachShadow: AsBound<typeof Element, 'attachShadow'> = Element.prototype.attachShadow;

			Element.prototype.attachShadow = function(...args) {
				const shadow = attachShadow.call(this, ...args);
				try {
					inspectRecursive(shadow, true);
				} catch (err) {
					window[PageVars.ERROR_CALLBACK](window[PageVars.FRAME_ID], String(err), err instanceof Error && err.stack || Error().stack!);
				}
				return shadow;
			};

			inspectRecursive(document, false);
			return true;
		};
	}

	override id() { return 'fields' as const; }

	override init({log, url, context}: BaseCollector.CollectorInitOptions) {
		this.#log ??= new ColoredLogger(new PlainLogger(log));
		this.#context    = context;
		this.#headless   = context.browser().process()?.spawnargs.includes('--headless') ?? true;
		this.#initialUrl = url;
		this.#siteDomain = tldts.getDomain(url.href);

		this.#page = undefined!;  // Initialized in addTarget
		this.#frameIdMap.clear();
		this.#frameIdReverseMap.clear();
		this.#injectedPasswordCallback.clear();
		this.#startUrls.clear();
		this.#postCleanListeners.clear();
		this.#dirtyPages.clear();

		this.#events = [];
		this.#processedFields.clear();
		this.#passwordLeaks  = [];
		this.#visitedTargets = [];
		this.#errors         = [];
	}

	override async addTarget({url, type}: Parameters<typeof BaseCollector.prototype.addTarget>[0]) {
		try {
			this.#visitedTargets.push({time: Date.now(), type, url});  // Save other targets as well
			if (type !== 'page') return;

			const pages   = await this.#context.pages();
			const newPage = pages.at(-1)!;
			this.#page ??= newPage;  // Take first page

			newPage.once('load', () => void this.#screenshot(newPage, 'new-page'));

			await exposeFunction(newPage, PageVars.ERROR_CALLBACK, this.#errorCallback.bind(this));

			const newFrameId = async (frame: Frame) => {
				const frameId = webcrypto.randomUUID();
				this.#frameIdMap.set(frameId, frame);
				this.#frameIdReverseMap.set(frame, frameId);
				try {
					await frame.evaluate(frameId => {
						window[PageVars.FRAME_ID] = frameId;
					}, frameId);
				} catch (err) {
					if (!String(err).includes('Execution context was destroyed') && this.options.debug)
						this.#reportError(err, ['failed to add frame ID'], 'warn');
				}
			};
			await Promise.all(newPage.frames().map(newFrameId));
			newPage.on('frameattached', frame => void newFrameId(frame));
			newPage.on('framenavigated', frame =>
				  void frame.evaluate(frameId => {
					  window[PageVars.FRAME_ID] = frameId;
				  }, this.#frameIdReverseMap.get(frame)!)
						.catch(err => {
							if (!frame.isDetached() && !String(err).includes('Target closed')
								  && this.options.debug)
								this.#reportError(err, ['failed to add frame ID (framenavigated)'], 'warn');
						}));

			async function evaluateOnAll<Args extends unknown[]>(pageFunction: (...args: Args) => void, ...args: Args) {
				// Add on new & existing frames
				await newPage.evaluateOnNewDocument(pageFunction, ...args);
				await Promise.all(newPage.frames().map(frame => frame.evaluate(pageFunction, ...args)));
			}

			await evaluateOnAll(FieldsCollector.#doInjectFun, this.options.debug);

			// May not catch all, as scripts may have already run
			if (this.options.disableClosedShadowDom)
				await evaluateOnAll(() => {
					// noinspection JSNonStrictModeUsed
					'use strict';
					try {
						// eslint-disable-next-line @typescript-eslint/unbound-method
						const attachShadow: AsBound<typeof Element, 'attachShadow'> = Element.prototype.attachShadow;

						// Make sure to keep forwards-compatible
						Element.prototype.attachShadow = function(init, ...args) {
							return attachShadow.call(this,
								  typeof init === 'object' ? {...init, mode: 'open'} : init,
								  ...args);
						};
					} catch (err) {
						window[PageVars.ERROR_CALLBACK](window[PageVars.FRAME_ID], String(err), err instanceof Error && err.stack || Error().stack!);
					}
				});

			if (this.options.immediatelyInjectAttributeLeakDetection) {
				if (tryAdd(this.#injectedPasswordCallback, newPage))
					await exposeFunction(newPage, PageVars.PASSWORD_CALLBACK, this.#passwordLeakCallback.bind(this));
				await evaluateOnAll(FieldsCollector.#doInjectPasswordLeakDetectionFun, this.options.fill.password);
			}
		} catch (err) {
			this.#reportError(err, ['failed to add target']);
		}
	}

	override async getData(options: Parameters<typeof BaseCollector.prototype.getData>[0]): Promise<FieldsCollectorData | null> {
		const fields = [];
		let links    = null;
		try {
			this.#dataParams = options;
			this.#log?.log('🌐 final URL:', this.#dataParams.finalUrl);

			if (this.#siteDomain === null && this.#initialUrl.hostname !== 'localhost') {
				this.#log?.warn('URL has no domain with public suffix, will skip this page');
				return null;
			}

			await this.#screenshot(this.#page, 'loaded');

			// Search for fields on the landing page(s)
			fields.push(...await this.#processFieldsOnAllPages());

			fields.push(...await this.#executeInteractChains());

			if (this.options.clickLinkCount
				  && !(this.options.stopEarly === 'first-page-with-form' && fields.length)) {
				const res = await this.#inspectLinkedPages();
				if (res) {
					links = res.links;
					fields.push(...res.fields);
				}
			}
		} catch (err) {
			this.#reportError(err, ['failed to get all data']);
		}

		return {
			visitedTargets: this.#visitedTargets,
			fields,
			links,
			passwordLeaks: this.#passwordLeaks,
			events: this.#events,
			errors: this.#errors,
		};
	}

	/**
	 * @returns Processed fields
	 */
	async #executeInteractChains(): Promise<FieldElementAttrs[]> {
		const fields: FieldElementAttrs[] = [];
		for (const [nChain, chain] of this.options.interactChains.entries()) {
			try {
				this.#log?.log(`🖱 starting click chain ${nChain + 1}${
					  chain.type === 'puppeteer-replay' ? `: ${chain.flow.title}` : ''}`);
				await this.#cleanPage(this.#page);
				await this.#closeExtraPages();

				const executeChain = async () => {
					switch (chain.type) {
						case 'js-path-click':
							for (const [nElem, elemPath] of chain.paths.entries()) {
								const elem = await unwrapHandle(await this.#page.evaluateHandle(
									  // eslint-disable-next-line @typescript-eslint/no-implied-eval
									  Function(`return (${elemPath});`) as () => Element | null | undefined));
								if (!elem) {
									// noinspection ExceptionCaughtLocallyJS
									throw new Error(`element for click chain not found: ${elemPath}`);
								}
								const selector = await formSelectorChain(elem);

								this.#log?.log(`🖱 clicking element ${nElem + 1}/${chain.paths.length}`, selectorStr(selector));
								this.#events.push(new ClickLinkEvent(selector, 'manual'));
								await this.#click(elem);
								await this.#sleep(this.options.sleepMs?.postNavigate);
							}
							break;
						case 'puppeteer-replay': {
							const flow       = chain.flow;
							const noNavSteps = flow.steps.filter(step => step.type !== 'navigate');
							if (noNavSteps.length < flow.steps.length)
								this.#log?.info(`ignoring ${flow.steps.length - noNavSteps.length} navigate steps`);
							const flowRunner = await createRunner({...flow, steps: noNavSteps},
								  new PuppeteerRunnerExtension(this.#context.browser(), this.#page));
							await flowRunner.run();
							break;
						}
					}
				};
				await executeChain();
				await this.#screenshot(this.#page, 'interact-chain-executed');

				await this.#doWithOnCleanPage(this.#page, executeChain, async () =>
					  fields.push(...await this.#processFieldsOnAllPages()));
			} catch (err) {
				this.#reportError(err, ['failed to inspect page for click chain', chain]);
			} finally {
				this.#setDirty(this.#page);
			}
		}
		return fields;
	}

	/**
	 * Search for fields on linked pages
	 * @returns Used links & processed fields
	 */
	async #inspectLinkedPages(): Promise<{ links: LinkElementAttrs[], fields: FieldElementAttrs[] } | null> {
		try {
			await this.#cleanPage(this.#page);
			let links = (await getLoginLinks(this.#page.mainFrame(), new Set(['exact', 'loose', 'coords'])))
				  .map(info => info.attrs);

			const matchTypeCounts = links.reduce((acc, attrs) =>
				  acc.set(attrs.linkMatchType, (acc.get(attrs.linkMatchType) ?? 0) + 1), new Map<LinkMatchType, number>());

			this.#log?.debug(`🔗🔍 found ${links.length} login/register links on the landing page`, matchTypeCounts);

			if (links.length > this.options.clickLinkCount)
				this.#log?.log(`skipping last ${links.length - this.options.clickLinkCount} links`);

			const fields: FieldElementAttrs[] = [];

			links = links.slice(0, this.options.clickLinkCount);
			for (const link of links) {
				await this.#group(`🔗 ${selectorStr(link.selectorChain)}`, async () => {
					try {
						if (this.options.skipExternal !== false && link.href &&
							  tldts.getDomain(new URL(link.href, this.#dataParams.finalUrl).href) !== this.#siteDomain) {
							this.#log?.log('skipping external link', link.href);
							return;
						}

						await this.#cleanPage(this.#page);
						await this.#closeExtraPages();

						await this.#doWithNewCleanPageScope(this.#page, async () => {
							await this.#followLink(link);
							fields.push(...await this.#processFieldsOnAllPages());
						});
					} catch (err) {
						this.#reportError(err, ['failed to inspect linked page for link', link], 'warn');
					}
				});
				if (this.options.stopEarly === 'first-page-with-form' && fields.length)
					break;
			}
			return {links, fields};
		} catch (err) {
			this.#reportError(err, ['failed to inspect linked pages']);
			return null;
		}
	}

	/** Click detected link & wait for navigation */
	async #followLink(link: ElementAttrs) {
		this.#log?.log('🔗🖱 following link', selectorStr(link.selectorChain));
		this.#events.push(new ClickLinkEvent(link.selectorChain, 'auto'));
		const page     = this.#page;
		const linkInfo = await getElementInfoFromAttrs(link, page.mainFrame(), this.options.debug);
		if (!linkInfo) throw new Error('could not find link element anymore');
		const waitNavigation = this.#waitForNavigation(page.mainFrame(), this.options.timeoutMs.followLink);
		await this.#click(linkInfo.handle);
		const opened = await waitNavigation;
		await this.#screenshot(opened?.page() ?? page, 'link-clicked');
	}

	/** Just click an element */
	async #click(elem: ElementHandle) {
		await elem.frame.page().bringToFront();
		try {
			// Can miss if the element moves or if it is covered
			// But is less detectable as script click
			await elem.click();
		} catch {
			await elem.evaluate(el => {
				el.scrollIntoView({behavior: 'smooth', block: 'end', inline: 'end'});
				if (el instanceof HTMLElement) el.click();
				else el.dispatchEvent(new MouseEvent('click', {view: window, bubbles: true, cancelable: true}));
			});
		}
	}

	#setDirty(page: Page) {
		this.#dirtyPages.add(page);
	}

	async #cleanPage(page: Page) {
		let startUrl = this.#startUrls.get(page);
		if (!startUrl) this.#startUrls.set(page, (startUrl = page.url()));
		if (this.#dirtyPages.delete(page)) {
			this.#events.push(new ReturnEvent(page === this.#page));
			await this.#goBack(page.mainFrame(), startUrl);
			await this.#postCleanListeners.get(page)?.();
		}
	}

	#doWithNewCleanPageScope<T extends MaybePromise<unknown>>(
		  page: Page, scopeFunc: () => T): T {
		const prevStartUrl = this.#startUrls.get(page) ?? page.url();
		this.#startUrls.delete(page);
		this.#dirtyPages.delete(page);
		return forwardPromise(scopeFunc, () => {
			this.#startUrls.set(page, prevStartUrl);
			this.#setDirty(page);
		});
	}

	#doWithOnCleanPage<T extends MaybePromise<unknown>>(
		  page: Page, listener: () => MaybePromiseLike<void>, scopeFunc: () => T): T {
		assert(!this.#postCleanListeners.has(page));
		this.#postCleanListeners.set(page, listener);
		return forwardPromise(scopeFunc, () => this.#postCleanListeners.delete(page));
	}

	async #goBack(frame: Frame, url: string) {
		const maxWaitTimeMs = Math.max(
			  this.options.timeoutMs.reload,
			  this.#dataParams.pageLoadDurationMs * 2);

		this.#log?.log(frame.url() === url ? '🔙 will reload' : `🔙 will navigate ${frame.url()} → ${url}`);
		await frame.page().bringToFront();
		try {
			await frame.goto(url, {timeout: maxWaitTimeMs, waitUntil: 'load'});
			await this.#sleep(this.options.sleepMs?.postNavigate);
		} catch (err) {
			if (err instanceof TimeoutError) {
				this.#log?.log('⏱️ navigation timeout exceeded (will continue)');
				return;
			}
			throw err;
		}
	}

	/**
	 * @returns Main frame of opened Page or `frame` if navigated
	 */
	async #waitForNavigation(frame: Frame, minTimeoutMs: number): Promise<Frame | null> {
		const maxWaitTimeMs = Math.max(minTimeoutMs,
			  this.#dataParams.pageLoadDurationMs * 2);

		const frameStartUrl = frame.url(),
		      pageStartUrl  = frame.page().url();

		this.#log?.debug('🔜 started waiting for navigation');
		try {
			const preTargets    = new Set(this.#context.targets());
			const {msg, target} = (await raceWithCondition([
				(async () => {
					const page         = frame.page();
					const pageNavigate = page.mainFrame() !== frame
						  ? page.waitForNavigation({timeout: maxWaitTimeMs, waitUntil: 'load'})
						  : null;
					try {
						await frame.waitForNavigation({timeout: maxWaitTimeMs, waitUntil: 'load'});
						return {msg: `🧭 navigated to ${frame.url()}`, target: frame};
					} catch (err) {
						if (err instanceof TimeoutError) throw err;
						// Frame may be detached due to parent navigating
						// (Error: Navigating frame was detached)
						if (!pageNavigate) return null;
						await pageNavigate;
						return {msg: `🧭 parent page navigated to ${page.url()}`, target: page.mainFrame()};
					} finally {
						void pageNavigate?.catch(() => {/*ignore TimeoutError or other*/});
					}
				})(),
				this.#context.waitForTarget(
					  target => target.type() === 'page' && !preTargets.has(target),
					  {timeout: maxWaitTimeMs})
					  .then(async page => ({msg: `🧭 opened ${page.url()}`, target: (await page.page())!.mainFrame()})),
			], notFalsy))!;
			this.#log?.log(msg);
			await this.#sleep(this.options.sleepMs?.postNavigate);
			return target;
		} catch (err) {
			if (err instanceof TimeoutError) {
				if (frame.page().url() !== pageStartUrl)
					this.#log?.log(`parent page started navigating to ${frame.page().url()}`);
				else if (frame.url() !== frameStartUrl)
					this.#log?.log(`started navigating to ${frame.url()}`);
				this.#log?.log('⏱️ navigation timeout exceeded (will continue)');
				return null;
			}
			throw err;
		}
	}

	async #closeExtraPages() {
		const closedPages = await closeExtraPages(this.#context, new Set([this.#page]));
		if (closedPages.length) this.#log?.debug(`closed ${closedPages.length} pages`);
	}

	//region Field process logic
	async #processFieldsOnAllPages(): Promise<FieldElementAttrs[]> {
		const fields = [];
		for (const page of await this.#context.pages()) {
			fields.push(...await this.#processFieldsOnPage(page) ?? []);
			if (this.options.stopEarly === 'first-page-with-form' && fields.length)
				break;
		}
		return fields;
	}

	/**
	 * @returns Processed fields or `null` if an external page was excluded
	 */
	async #processFieldsOnPage(page: Page): Promise<FieldElementAttrs[] | null> {
		const logPageUrl = page.url();
		return this.#group(`📃${getRelativeUrl(new URL(logPageUrl), new URL(this.#dataParams.finalUrl))}`, async () => {
			if (this.options.skipExternal !== false && tldts.getDomain(page.url()) !== this.#siteDomain) {
				this.#log?.log('skipping external page');
				return null;
			}

			const completedFrames = new Set<string>();

			await this.#cleanPage(page);

			const pageFields = [];

			let allDone   = false;
			let submitted = false;
			while (!allDone) oneSubmission: {
				if (submitted) {
					// Reload only after submissions,
					// and only when we need to continue search
					submitted = false;
					await this.#cleanPage(page);
				}
				const incompleteFrames = page.frames()
					  .filter(frame => frame.url()  // Skip mixed-content frames, see puppeteer/puppeteer#8812
							&& !completedFrames.has(frame.url()));
				for (const frame of incompleteFrames) {
					const {fields: frameFields, done: frameDone} = await this.#group(
						  `🔳frame ${getRelativeUrl(new URL(frame.url()), new URL(logPageUrl))}`,
						  () => this.#processFields(frame), frame !== page.mainFrame());
					if (frameDone) {
						completedFrames.add(frame.url());  // This frame is done
						if (frame === incompleteFrames.at(-1)!)
							allDone = true;  // All frames done, prevent extra reload even on submission
					}
					if (nonEmpty(frameFields)) {
						pageFields.push(...frameFields);
						if (this.options.fill.submit) {
							// We submitted a field, now reload the page and try other fields
							submitted = true;
							break oneSubmission;
						}
					}
				}
				allDone = true;  // All frames are done
			}

			if (this.#processedFields.size >= this.options.fill.maxFields)
				this.#log?.log('💯 reached maximum number of filled fields');
			this.#log?.log(`${pageFields.length ? '🆕' : '🔚'} processed ${pageFields.length} new fields`);
			return pageFields;
		}, logPageUrl !== this.#dataParams.finalUrl);
	}

	/**
	 * Fill and optionally submit field(s) on a frame.
	 * For submission, only one form will be filled & submitted at a time.
	 * @returns Newly processed fields and whether all fields were processed,
	 *  `fields` is `null` if an external frame was skipped.
	 *  Also includes previously processed fields in forms which have new fields.
	 */
	async #processFields(frame: Frame): Promise<{ fields: FieldElementAttrs[] | null, done: boolean }> {
		if (this.#processedFields.size >= this.options.fill.maxFields)
			return {fields: null, done: true};
		const frameFields = await this.#findFields(frame);
		if (!frameFields) return {fields: null, done: true};

		if (this.options.fill.submit) {
			// Key '' means no form
			const fieldsByForm     = groupBy(field => field.attrs.form ? selectorStr(field.attrs.form) : '', frameFields);
			// Fields without form come last
			const fieldsByFormList = Object.entries(fieldsByForm).sort(([formA]) => formA === '' ? 1 : 0);
			for (const [lastForm, [formSelector, formFields]] of
				  fieldsByFormList.map((e, i, l) => [i === l.length - 1, e] as const)) {
				const res = await this.#group(`📝form ${formSelector}`, async () => {
					try {
						// First non-processed form field
						const field = formFields.find(field => !this.#processedFields.has(getElemIdentifier(field)));
						if (!field) return null;

						// Fill all fields in the form
						// For a field outside a form, we fill all fields outside a form in the frame
						await this.#fillFields(formFields);
						await this.#screenshot(frame.page(), 'filled');

						await this.#sleep(this.options.sleepMs?.postFill);

						if (this.options.fill.addFacebookButton)
							await this.#clickFacebookButton(frame);

						await this.#submitField(field);

						if (formSelector) addAll(this.#processedFields, formFields.map(getElemIdentifier));
						else this.#processedFields.add(getElemIdentifier(field));

						return {
							// For a form, all fields in the form
							// Otherwise, just the submitted field
							fields: formSelector ? formFields.map(f => f.attrs) : [field.attrs],
							// We are done if this was the last form or the last loose field
							done: lastForm && this.#processedFields.has(getElemIdentifier(formFields.at(-1)!))
								  || this.#processedFields.size >= this.options.fill.maxFields,
						};
					} catch (err) {
						this.#reportError(err, ['failed to process form', formSelector], 'warn');
					}
					return null;
				}, !!formSelector);
				if (res) return res;
			}
			return {fields: [], done: true};

		} else {
			if (frameFields.length) {
				await this.#fillFields(filterUniqBy(frameFields, this.#processedFields, f => getElemIdentifier(f.attrs)));
				await this.#screenshot(frame.page(), 'filled');

				await this.#sleep(this.options.sleepMs?.postFill);

				if (this.options.fill.addFacebookButton) {
					await this.#clickFacebookButton(frame);
					await this.#sleep(this.options.sleepMs?.postFacebookButtonClick);
				}
			}
			return {fields: frameFields.map(f => f.attrs), done: true};
		}
	}

	//endregion

	/**
	 * @returns `null` if an external frame was skipped
	 */
	async #findFields(frame: Frame): Promise<ElementInfo<FieldElementAttrs>[] | null> {
		if (!this.#headless) {
			// For some reason non-headless chrome does not execute code on background pages
			await frame.page().bringToFront();
		}

		const url = frame.url();
		if (this.options.skipExternal === 'frames' && tldts.getDomain(url) !== this.#siteDomain) {
			this.#log?.debug('skipping external frame');
			return null;
		}

		this.#log?.debug('🔍 finding fields');
		const fields = (await Promise.all([this.#getEmailFields(frame), this.#getPasswordFields(frame)])).flat();
		this.#log?.log(`🔍 found ${fields.length} fields`);
		return fields;
	}

	async #getEmailFields(frame: Frame): Promise<ElementInfo<FieldElementAttrs & FathomElementAttrs>[]> {
		const emailFieldsFromFathom = await unwrapHandle(await frame.evaluateHandle(() => {
			const found      = [
				...window[PageVars.INJECTED].detectEmailInputs(document.documentElement),
				...window[PageVars.INJECTED].detectUsernameInputs(document.documentElement),
			];
			const elemScores = new Map<Element, number>();
			for (const {elem, score} of found) {
				const prev = elemScores.get(elem);
				if (prev === undefined || score > prev) elemScores.set(elem, score);
			}
			return [...elemScores].map(([elem, score]) => ({elem, score}));
		}));
		return (await Promise.all(emailFieldsFromFathom.map(async field => ({
			handle: field.elem,
			attrs: {
				...await getElementAttrs(field.elem),
				score: field.score,
				fieldType: 'email',
			},
		}) as const))).filter(({attrs: {visible}}) => visible);
	}

	async #getPasswordFields(frame: Frame): Promise<ElementInfo<FieldElementAttrs>[]> {
		const elHandles = await frame.$$('pierce/input[type=password]');
		return (await Promise.all(elHandles.map(async handle => ({
			handle,
			attrs: {
				...await getElementAttrs(handle),
				fieldType: 'password',
			},
		} as const)))).filter(({attrs: {visible}}) => visible);
	}

	async #submitField(field: ElementInfo<FieldElementAttrs>) {
		this.#events.push(new SubmitEvent(field.attrs.selectorChain));
		this.#log?.log('⏎ submitting field', selectorStr(field.attrs.selectorChain));
		this.#setDirty(field.handle.frame.page());
		try {
			const waitNavigation = this.#waitForNavigation(field.handle.frame,
				  this.options.timeoutMs.submitField);
			await submitField(field.handle, this.options.sleepMs?.fill?.clickDwell ?? 0);
			field.attrs.submitted = true;

			const frame  = field.handle.frame;
			const opened = await waitNavigation;
			await this.#screenshot((opened ?? frame).page(), 'submitted');
		} catch (err) {
			this.#reportError(err, ['failed to submit field', field.attrs], 'warn');
		}
	}

	async #fillFields(fields: ElementInfo<FieldElementAttrs>[]) {
		this.#log?.log(`🖊 filling ${fields.length} fields`);
		const fillTimes = this.options.sleepMs?.fill ?? {clickDwell: 0, keyDwell: 0, betweenKeys: 0};
		for (const field of fields.filter(f => !(f.attrs.filled ?? false))) {
			this.#events.push(new FillEvent(field.attrs.selectorChain));
			this.#setDirty(field.handle.frame.page());
			try {
				switch (field.attrs.fieldType) {
					case 'email':
						await fillEmailField(field.handle, this.#initialUrl.hostname,
							  this.options.fill.appendDomainToEmail
									? appendDomainToEmail(this.options.fill.email, this.#initialUrl.hostname)
									: this.options.fill.email, fillTimes);
						break;
					case 'password':
						await this.#injectPasswordLeakDetection(field.handle.frame);
						await fillPasswordField(field.handle, this.options.fill.password, fillTimes);
						break;
					default:
						// noinspection ExceptionCaughtLocallyJS
						throw new UnreachableCaseError(field.attrs.fieldType);
				}
				field.attrs.filled = true;
				this.#log?.debug('✒️ filled field', selectorStr(field.attrs.selectorChain));
			} catch (err) {
				this.#reportError(err, ['failed to fill field', field.attrs], 'warn');
			}
		}
	}

	async #injectPasswordLeakDetection(frame: Frame) {
		try {
			const page = frame.page();
			if (tryAdd(this.#injectedPasswordCallback, page))
				await exposeFunction(page, PageVars.PASSWORD_CALLBACK, this.#passwordLeakCallback.bind(this));

			const newlyInjected = await frame.evaluate(FieldsCollector.#doInjectPasswordLeakDetectionFun, this.options.fill.password);
			if (newlyInjected) this.#log?.debug('injected password leak detection');
		} catch (err) {
			this.#reportError(err, ['failed to inject password leak detection on', frame.url()]);
		}
	}

	/** Called from the page when a password leak is detected */
	async #passwordLeakCallback(frameId: string, leaks: PagePasswordLeak[]) {
		try {
			const frame = this.#frameIdMap.get(frameId)!;
			this.#log?.info(`🔓💧 password leaked on ${frame.url()} to attributes: ${
				  leaks.map(l => `${selectorStr(l.selector)} @${l.attribute}`).join(', ')}`);
			const time = Date.now();
			this.#passwordLeaks.push(...await Promise.all(leaks.map(async leak => {
				let attrs;
				try {
					const handle = (await getElementBySelectorChain(leak.selector, frame))?.elem;
					if (handle) attrs = await getElementAttrs(handle);
				} catch (err) {
					this.#reportError(err, ['failed to get attributes for leak element', selectorStr(leak.selector)], 'warn');
				}
				const fullLeak: PasswordLeak = {time, ...leak};
				if (attrs) fullLeak.attrs = attrs;
				else fullLeak.frameStack = getFrameStack(frame).map(f => f.url());
				return fullLeak;
			})));
		} catch (err) {
			this.#reportError(err, ['error in password leak callback']);
		}
	}

	async #clickFacebookButton(frame: Frame) {
		this.#log?.log('adding and clicking button for Facebook leak detection');
		this.#events.push(new FacebookButtonEvent());
		this.#setDirty(frame.page());
		try {
			await frame.evaluate(function clickFacebookButton() {
				const btn          = document.createElement('button');
				btn.className      = 'leak-detect-btn button';
				btn.textContent    = 'button';
				btn.style.position = 'fixed';
				btn.style.top      = btn.style.left = '0';
				document.body.append(btn);
				btn.click();
				btn.remove();
			});
		} catch (err) {
			this.#reportError(err, ['failed to add & click Facebook leak detect button'], 'warn');
		}
	}

	async #screenshot(page: Page, trigger: ScreenshotTrigger) {
		const opts = this.options.screenshot;
		if (!opts) return;
		if (opts.triggers === true || opts.triggers.includes(trigger)) {
			try {
				const img = await page.screenshot() as Buffer;
				if (typeof opts.target === 'string') {
					const name = `${Date.now()}-${trigger}.png`;
					this.#log?.debug('📸', name);
					this.#events.push(new ScreenshotEvent(trigger, name));
					const dirPath = path.join(opts.target, this.#siteDomain ?? this.#initialUrl.hostname);
					await fsp.mkdir(dirPath, {recursive: true});
					await fsp.writeFile(path.join(dirPath, name), img);
				} else {
					this.#log?.debug('📸', trigger);
					this.#events.push(new ScreenshotEvent(trigger));
					await opts.target(img, trigger);
				}
			} catch (err) {
				this.#reportError(err, [`failed to make ${trigger} screenshot`, page.url()], 'warn');
			}
		}
	}

	/** Called from an asynchronous page script when an error occurs */
	#errorCallback(frameId: string | undefined | null, message: string, stack: string) {
		this.#reportError({message, stack, toString() {return message;}},
			  ['error in background page script',
				  frameId && getFrameStack(this.#frameIdMap.get(frameId)!).map(f => f.url()).join(', ')]);
	}

	#reportError(error: unknown, context: unknown[], level: 'warn' | 'error' = 'error') {
		if (level === 'warn' && error instanceof Error &&
			  /^Protocol error\b.*\b(?:Session closed|Target closed)|^Execution context was destroyed\b|^Execution context is not available in detached frame\b/i
					.test(error.message)) {
			// Do not regard warnings due to navigation etc. as errors
			this.#log?.log(...context, error);
		} else {
			this.#log?.logLevel(level, ...context, error);
			this.#errors.push({error, context, level});
		}
	}

	async #sleep(ms: number | undefined) {
		if (ms ?? 0) {
			this.#log?.debug('💤');
			return new Promise<void>(resolve => setTimeout(resolve, ms));
		}
	}

	/** Group for logging if a logger is set */
	#group<T>(name: string, func: () => T, doGroup = true): T {
		return doGroup && this.#log ? this.#log.group(name, func) : func();
	}
}

//region Config
// noinspection JSClassNamingConvention
type integer = number;

/**
 * &#64;puppeteer/replay (Chrome DevTools) flow
 * @TJS-description "@puppeteer/replay (Chrome DevTools) flow"
 * @see https://developer.chrome.com/docs/devtools/recorder/
 */
type PuppeteerReplayUserFlow = UserFlow;

export interface JSPathClickInteractChain {
	type: 'js-path-click';
	/** JavaScript expressions returning elements on page to click in order */
	paths: string[];
}

export interface PuppeteerReplayInteractChain {
	type: 'puppeteer-replay';
	flow: PuppeteerReplayUserFlow;
}

export type InteractChain = JSPathClickInteractChain | PuppeteerReplayInteractChain;

export interface FieldsCollectorOptions {
	/** Timeouts in milliseconds */
	timeoutMs?: {
		/** Page reload timeout (e.g. after submit)
		 * @minimum 0 */
		reload?: number;
		/** Timeout waiting for navigation after following a link
		 * @minimum 0 */
		followLink?: number;
		/** Timeout waiting for navigation after submitting a field
		 * @minimum 0 */
		submitField?: number;
	};
	/** Intentional delays in milliseconds, or null to disable all delays */
	sleepMs?: {
		/** Delay after filling some fields (in a form)
		 * @minimum 0 */
		postFill?: number;
		/** Delay after adding & clicking Facebook button
		 * @minimum 0 */
		postFacebookButtonClick?: number;
		/** Delay after navigating to some page
		 * @minimum 0 */
		postNavigate?: number;
		/** Field fill-related delays, or null to disable these delays */
		fill?: {
			/** Time between mouse down & mouse up when clicking a field
			 * @minimum 0 */
			clickDwell?: number;
			/** Maximum time between key down & key up when typing in a field
			 * @minimum 0 */
			keyDwell?: number;
			/** Maximum time between keystrokes when typing in a field
			 * @minimum 0 */
			betweenKeys?: number;
		} | null;
	} | null;
	/**
	 * Whether to skip external sites.
	 * Specify "pages" to only look at top-level URLs.
	 * @default "frames"
	 */
	skipExternal?: 'frames' | 'pages' | false;
	/** Maximum number of links to click automatically on the landing page, can be 0
	 * @minimum 0 */
	clickLinkCount?: integer;
	/**
	 * Whether to stop crawl early.
	 * Specify "first-page-with-form" to stop after the first page with a form
	 * (after filling all forms on that page)
	 * @default false
	 */
	stopEarly?: 'first-page-with-form' | false;
	/** Field fill-related settings */
	fill?: {
		/** Email address to fill in */
		email?: string;
		/** Append "+domainname" to the local part of the email address?
		 * @default false */
		appendDomainToEmail?: boolean;
		/** Password to fill in */
		password?: string;
		/** Try to submit forms?
		 * @default true */
		submit?: boolean;
		/** Add and click a dummy button to detect Facebook leaks
		 * @default true */
		addFacebookButton?: boolean;
		/** Maximum number of fields to fill (approximate)
		 * @minimum 0 */
		maxFields?: integer;
	};
	/**
	 * Always immediately inject password to attribute leak detection,
	 * instead of before filling a password field.
	 * Useful for manual form filling
	 * @default false
	 */
	immediatelyInjectAttributeLeakDetection?: boolean,
	/**
	 * Transform calls to attach closed ShadowRoots into calls to attach open ones,
	 * to enable the crawler to search for fields etc. there.
	 * (May not always work.)
	 * @default true
	 */
	disableClosedShadowDom?: boolean;
	/** Extra things to do to find forms */
	interactChains?: InteractChain[];
	/**
	 * Options for making screenshots after certain actions.
	 * null to disable.
	 * @default null
	 */
	screenshot?: {
		/**
		 * Triggers for making screenshots, or true to enable all triggers
		 */
		triggers: ScreenshotTrigger[] | true;
		/**
		 * Folder to place screenshots in (under subfolder with domain name),
		 * or callback for created screenshots (JS-only)
		 * @TJS-type string
		 */
		target: string | ((img: Buffer, trigger: ScreenshotTrigger) => MaybePromiseLike<void>);
	} | null;
	/** Turn on some debugging assertions
	 * @default false */
	debug?: boolean;
}

/**
 * - `loaded`: first page loaded;
 * - `filled`: after group of fields filled;
 * - `submitted`: after group of fields submitted;
 * - `link-clicked`: page opened after detected login/register link clicked;
 * - `interact-chain-executed`: after a specified interact chain was executed;
 * - `new-page`: after a new tab has fully loaded;
 */
export type ScreenshotTrigger =
	  | 'loaded'
	  | 'filled'
	  | 'submitted'
	  | 'link-clicked'
	  | 'interact-chain-executed'
	  | 'new-page';

export type FullFieldsCollectorOptions = DeepRequired<Omit<FieldsCollectorOptions, 'interactChains'>>
	  & Required<Pick<FieldsCollectorOptions, 'interactChains'>>;

FieldsCollector.defaultOptions = {
	timeoutMs: {
		reload: 2_500,
		followLink: 5_000,
		submitField: 2_500,
	},
	sleepMs: {
		postFill: 5_000,
		postFacebookButtonClick: 1_000,
		postNavigate: 4_000,
		fill: {
			clickDwell: 100,
			keyDwell: 100,
			betweenKeys: 250,
		},
	},
	clickLinkCount: 5,
	skipExternal: 'frames',
	stopEarly: false,
	fill: {
		email: 'leak-detector@example.com',
		appendDomainToEmail: false,
		password: 'The--P@s5w0rd',
		submit: true,
		addFacebookButton: true,
		maxFields: 10,
	},
	immediatelyInjectAttributeLeakDetection: false,
	disableClosedShadowDom: true,
	interactChains: [],
	screenshot: null,
	debug: false,
};

//endregion

/** Password leak as passed to the callback */
export interface PagePasswordLeak {
	selector: SelectorChain;
	attribute: string;
}

/** Password leak as reported in the data */
export interface PasswordLeak extends PagePasswordLeak {
	time: number;
	attrs?: ElementAttrs;
	frameStack?: string[];
}

export interface VisitedTarget {
	url: string;
	type: TargetCollector.TargetType;
	time: number;
}

//region Events
export abstract class FieldsCollectorEvent {
	protected constructor(public readonly type: string, public readonly time = Date.now()) {}
}

export class FillEvent extends FieldsCollectorEvent {
	constructor(public readonly field: SelectorChain) {
		super('fill');
	}
}

export class SubmitEvent extends FieldsCollectorEvent {
	constructor(public readonly field: SelectorChain) {
		super('submit');
	}
}

export class FacebookButtonEvent extends FieldsCollectorEvent {
	constructor() {
		super('fb-button');
	}
}

export class ReturnEvent extends FieldsCollectorEvent {
	/**
	 * @param toLanding Return to landing page after examining a page for a link?
	 */
	constructor(public readonly toLanding: boolean) {
		super('return');
	}
}

export class ClickLinkEvent extends FieldsCollectorEvent {
	constructor(public readonly link: SelectorChain, public readonly linkType: 'auto' | 'manual') {
		super('link');
	}
}

export class ScreenshotEvent extends FieldsCollectorEvent {
	constructor(public readonly trigger: ScreenshotTrigger, public readonly name?: string) {
		super('screenshot');
	}
}

//endregion

interface ErrorInfo {
	error: unknown;
	/** messages / objects with more info */
	context: unknown[];
	level: 'error' | 'warn';
}

export interface FieldsCollectorData {
	/** Similar to what {@link import('tracker-radar-collector').TargetCollector} does but with timestamps */
	visitedTargets: VisitedTarget[];
	fields: FieldElementAttrs[];
	/** `null` on fail */
	links: LinkElementAttrs[] | null;
	passwordLeaks: PasswordLeak[];
	events: FieldsCollectorEvent[];
	errors: ErrorInfo[];
}

// This is a const enum such that the TypeScript transpiler replaces names with values in the page scripts
/** Names of in-page things */
export const enum PageVars {
	FRAME_ID          = '@@leakDetectFrameId',
	INJECTED          = '@@leakDetectInjected',
	PASSWORD_OBSERVED = '@@leakDetectPasswordObserved',
	PASSWORD_CALLBACK = '@@leakDetectPasswordObserverCallback',
	ERROR_CALLBACK    = '@@leakDetectError',
}

declare global {
	/** In-page things */
	interface Window {
		[PageVars.FRAME_ID]?: string;
		[PageVars.ERROR_CALLBACK]: (frameId: string | undefined, message: string, stack: string) => void;
		[PageVars.INJECTED]: typeof import('leak-detect-inject');
		[PageVars.PASSWORD_OBSERVED]?: boolean;
		[PageVars.PASSWORD_CALLBACK]?: (frameId: string, leaks: PagePasswordLeak[]) => Promise<void>;
	}
}
