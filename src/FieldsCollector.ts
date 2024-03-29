import assert from 'node:assert';
import {webcrypto} from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import inspector from 'node:inspector';
import path from 'node:path';

import chalk from 'chalk';
import {createRunner, PuppeteerRunnerExtension, UserFlow} from '@puppeteer/replay';
import type {BrowserContext, ElementHandle, Frame, InnerParams, Page, Protocol} from 'puppeteer';
import {groupBy} from 'rambda';
import * as tldts from 'tldts';
import {BaseCollector, puppeteer, TargetCollector} from 'tracker-radar-collector';
import {DeepRequired, NonEmptyArray, UnreachableCaseError} from 'ts-essentials';

import type {SelectorChain} from 'leak-detect-inject';
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
	populateDefaults,
	tryAdd,
	waitWithTimeout,
} from './utils';
import {ColoredLogger, Logger, PlainLogger} from './logger';
import {blurRefocus, fillEmailField, fillPasswordField, submitField} from './formInteraction';
import {
	closeExtraPages,
	ElementAttrs,
	ElementIdentifier,
	ElementInfo,
	FathomElementAttrs,
	FieldElementAttrs,
	formSelectorChain,
	getElementAttrs,
	getElementBySelectorChain,
	getElementInfoFromAttrs,
	getElemIdentifier,
	getElemIdentifierStr,
	LinkElementAttrs,
	LinkMatchType,
	selectorStr,
} from './pageUtils';
import {getLoginLinks} from './loginLinks';
import {
	attributePairs,
	DOMPauseData,
	exposeFunction,
	getFrameStack,
	isNavigationError,
	robustPierceQueryHandler,
	StackTracer,
	typedCDP,
	TypedCDPSession,
	unwrapHandle,
	waitForLoad,
} from './puppeteerUtils';
import ErrnoException = NodeJS.ErrnoException;
import Puppeteer = puppeteer.Puppeteer;
import TimeoutError = puppeteer.TimeoutError;

export class FieldsCollector extends BaseCollector {
	static defaultOptions: FullFieldsCollectorOptions;
	/** Page function to inject leak-detect-inject */
	static #injectFun: (debug: boolean) => void;
	/** @return Newly injected? */
	static #injectDomLeakDetectFun: (password: string[]) => boolean;

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
	#frameIdMap                          = new Map<string /*ID*/, Frame>();
	#frameIdReverseMap                   = new Map<Frame, string /*ID*/>();
	#asyncPageTasks: PromiseLike<void>[] = [];
	/** Pages that password leak callback has been injected into */
	#injectedDomLeakCallback             = new Set<Page>();
	#startUrls                           = new Map<Page, string>();
	#postCleanListeners                  = new Map<Page, () => MaybePromiseLike<void>>();
	#dirtyPages                          = new Set<Page>();

	#events: FieldsCollectorEvent[]  = [];
	/** All found fields */
	#fields                          = new Map<string /*elem identifier*/, FieldElementAttrs>();
	/** Selectors of fully processed fields */
	#processedFields                 = new Set<string>();
	#domLeaks: DomPasswordLeak[]     = [];
	#consoleLeaks: ConsoleLeak[]     = [];
	#visitedTargets: VisitedTarget[] = [];
	#errors: ErrorInfo[]             = [];

	constructor(options?: FieldsCollectorOptions, logger?: Logger) {
		super();
		this.options = populateDefaults<FullFieldsCollectorOptions>(options ?? {}, FieldsCollector.defaultOptions);

		FieldsCollector.#loadInjectScripts();
		this.#log = logger;
	}

	static #loadInjectScripts() {
		this.#injectFun ??= (() => {
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

		this.#injectDomLeakDetectFun ??= function doInjectDomLeakDetect(encodedPasswords: string[]) {
			// noinspection JSNonStrictModeUsed
			'use strict';
			if (window[PageVars.DOM_OBSERVED] === true) return false;
			window[PageVars.DOM_OBSERVED] = true;

			function includesPassword(haystack: string) {
				return encodedPasswords.some(p => haystack.includes(p));
			}

			const observer = new MutationObserver(mutations => {
				try {
					for (const m of mutations)
						for (const node of m.addedNodes)
							inspectRecursive(node, true);

					const leakSelectors = mutations
						  .filter(m => {
							  if (!m.attributeName || !(m.target instanceof Element)) return false;
							  const val = m.target.getAttribute(m.attributeName);
							  return val && includesPassword(val);
						  })
						  .map(m => ({
							  selectorChain: window[PageVars.INJECTED].formSelectorChain(m.target as Element),
							  attribute: m.attributeName!,
						  }));
					if (leakSelectors.length)
						window[PageVars.DOM_LEAK_CALLBACK]!(window[PageVars.FRAME_ID]!, leakSelectors);
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
							  .filter(attr => includesPassword(attr.value))
							  .map(attr => ({
								  selectorChain: window[PageVars.INJECTED].formSelectorChain(node),
								  attribute: attr.name,
							  }));
						if (leakSelectors.length)
							window[PageVars.DOM_LEAK_CALLBACK]!(window[PageVars.FRAME_ID]!, leakSelectors);
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

	static #getFullStack(stack: Protocol.Runtime.StackTrace): StackFrame[] {
		const fullStack: StackFrame[]                         = [];
		let curStack: Protocol.Runtime.StackTrace | undefined = stack;
		while (curStack) {
			fullStack.push(...curStack.callFrames.map(frame => ({
				url: frame.url,
				function: frame.functionName,
				line: frame.lineNumber + 1,
				column: frame.columnNumber + 1,
			})));
			curStack = curStack.parent;
		}
		return fullStack;
	}

	override id() { return 'fields' as const; }

	override init({log, url, context}: BaseCollector.CollectorInitOptions) {
		if (!Puppeteer.customQueryHandlerNames().includes('robustpierce'))
			Puppeteer.registerCustomQueryHandler('robustpierce', robustPierceQueryHandler);

		this.#log ??= new ColoredLogger(new PlainLogger(log));
		this.#context    = context;
		this.#headless   = context.browser().process()?.spawnargs.includes('--headless') ?? true;
		this.#initialUrl = url;
		this.#siteDomain = tldts.getDomain(url.href);

		this.#page = undefined!;  // Initialized in addTarget
		this.#frameIdMap.clear();
		this.#frameIdReverseMap.clear();
		this.#asyncPageTasks.length = 0;
		this.#injectedDomLeakCallback.clear();
		this.#startUrls.clear();
		this.#postCleanListeners.clear();
		this.#dirtyPages.clear();

		this.#events.length = 0;
		this.#fields.clear();
		this.#processedFields.clear();
		this.#domLeaks.length       = 0;
		this.#consoleLeaks.length   = 0;
		this.#visitedTargets.length = 0;
		this.#errors.length         = 0;
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
					if (this.options.debug && !isNavigationError(err))
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
							if (this.options.debug && !frame.isDetached() && !isNavigationError(err))
								this.#reportError(err, ['failed to add frame ID (framenavigated)'], 'warn');
						}));

			async function evaluateOnAll<Args extends unknown[]>(
				  pageFunction: (...args: Args | InnerParams<Args>) => void, ...args: Args) {
				// Add on new & existing frames
				await newPage.evaluateOnNewDocument(pageFunction, ...args);
				await Promise.all(newPage.frames().map(frame => frame.evaluate(pageFunction, ...args)));
			}

			await evaluateOnAll(FieldsCollector.#injectFun, this.options.debug);

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

			const encodedPasswords = this.#encodedPasswords();

			const cdp = typedCDP(await newPage.target().createCDPSession());
			cdp.on('Runtime.consoleAPICalled', ev => void (async () => {
				try {
					function includesPassword(haystack: Protocol.Runtime.RemoteObject | Protocol.Runtime.ObjectPreview | string | undefined): boolean {
						if (haystack === undefined) return false;
						if (typeof haystack === 'string') return encodedPasswords.some(p => haystack.includes(p));
						if ('value' in haystack && typeof haystack.value === 'string')
							return includesPassword(haystack.value);
						if ('preview' in haystack)
							return includesPassword(haystack.preview);
						if ('properties' in haystack && haystack.properties.some(({name, value}) =>
							  includesPassword(name) || includesPassword(value)))
							return true;
						if ('entries' in haystack && haystack.entries.some(({key, value}) =>
							  includesPassword(key) || includesPassword(value)))
							return true;
						return false;
					}

					let message: string | undefined = undefined;

					if (ev.args.some(arg => includesPassword(arg))) {
						message = ev.args.map(arg => ('value' in arg ? String(arg.value) : undefined)
							  ?? (arg.preview?.properties && JSON.stringify(Object.fromEntries(
									arg.preview.properties.map(({name, value}) => [name, value]))))
							  ?? (arg.preview?.entries && JSON.stringify(Object.fromEntries(
									arg.preview.entries.map(({key, value}, i) => [key ?? i, value]))))
							  ?? arg.description ?? arg.type).join(' ');
					} else {
						const res = await cdp.send('Runtime.callFunctionOn', {
							executionContextId: ev.executionContextId,
							functionDeclaration: ((...args: unknown[]) =>
								  args.map(arg => {
									  try {
										  const str = JSON.stringify(arg);
										  if (str !== '{}') return str;
									  } catch {
										  return JSON.stringify(Object.fromEntries(Object.getOwnPropertyNames(arg)
												.map(key => {
													const val = (arg as Record<string, unknown>)[key];
													try {
														const str = JSON.stringify(val);
														if (str !== '{}') return [key, val];
													} catch {
														/*ignore*/
													}
													return [key, String(val)];
												})));
									  }
									  return String(arg);
								  }).join(' ')).toString(),
							arguments: ev.args,
							silent: true,
							returnByValue: true,
						});
						if (!res.exceptionDetails && includesPassword(res.result.value as string))
							message = res.result.value as string;
					}
					if (message !== undefined) {
						this.#log?.info('🔓💧 Password leaked to console');
						const leak: ConsoleLeak = {
							time: ev.timestamp,
							message,
							type: ev.type,
						};
						if (ev.stackTrace)
							leak.stack = FieldsCollector.#getFullStack(ev.stackTrace);
						this.#consoleLeaks.push(leak);
					}
				} catch (err) {
					this.#reportError(err, ['error checking for console leaks']);
				}
			})());
			await cdp.send('Runtime.enable');

			if (this.options.immediatelyInjectDomLeakDetection) {
				if (tryAdd(this.#injectedDomLeakCallback, newPage))
					await exposeFunction(newPage, PageVars.DOM_LEAK_CALLBACK, this.#domLeakCallback.bind(this));
				await evaluateOnAll(FieldsCollector.#injectDomLeakDetectFun, encodedPasswords);
			}
		} catch (err) {
			if (!isNavigationError(err))
				this.#reportError(err, ['failed to add target']);
		}
	}

	override async getData(options: Parameters<typeof BaseCollector.prototype.getData>[0]): Promise<FieldsCollectorData | null> {
		let links = null;
		try {
			this.#dataParams = options;
			this.#log?.log('🌐 final URL:', this.#dataParams.finalUrl);

			if (this.#siteDomain === null && this.#initialUrl.hostname !== 'localhost') {
				this.#log?.warn('URL has no domain with public suffix, will skip this page');
				return null;
			}

			await this.#screenshot(this.#page, 'loaded');

			// Search for fields on the landing page(s)
			await this.#processFieldsOnAllPages();

			await this.#executeInteractChains();

			if (this.options.maxLinks
				  && !(this.options.stopEarly === 'first-page-with-form' && this.#fields.size)) {
				const res = await this.#inspectLinkedPages();
				if (res) links = res.links;
			}
			await this.#waitForPageTasks();
		} catch (err) {
			this.#reportError(err, ['failed to get all data']);
		}

		return {
			visitedTargets: this.#visitedTargets,
			fields: [...this.#fields.values()],
			links,
			domLeaks: this.#domLeaks,
			consoleLeaks: this.#consoleLeaks,
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
								const selectorChain = await formSelectorChain(elem);

								this.#log?.log(`🖱 clicking element ${nElem + 1}/${chain.paths.length}`, selectorStr(selectorChain));
								this.#events.push(new ClickLinkEvent(
									  {selectorChain, frameStack: [this.#page.mainFrame().url()]},
									  'manual'));
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
		if (this.#maxFieldsReached()) return {links: [], fields: []};
		try {
			await this.#waitForPageTasks();
			await this.#cleanPage(this.#page);
			let links = (await getLoginLinks(this.#page.mainFrame(), new Set(['exact', 'loose', 'coords'])))
				  .map(info => info.attrs);

			const matchTypeCounts = links.reduce((acc, attrs) =>
				  acc.set(attrs.linkMatchType, (acc.get(attrs.linkMatchType) ?? 0) + 1), new Map<LinkMatchType, number>());

			this.#log?.debug(`🔗🔍 found ${links.length} login/register links on the landing page`, matchTypeCounts);

			if (links.length > this.options.maxLinks)
				this.#log?.log(`skipping last ${links.length - this.options.maxLinks} links`);

			const fields: FieldElementAttrs[] = [];

			links = links.slice(0, this.options.maxLinks);
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
				if (this.options.stopEarly === 'first-page-with-form' && fields.length
					  || this.#maxFieldsReached())
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
		await this.#waitForPageTasks();
		this.#log?.log('🔗🖱 following link', selectorStr(link.selectorChain));
		this.#events.push(new ClickLinkEvent(getElemIdentifier(link), 'auto'));
		const page     = this.#page;
		const linkInfo = await getElementInfoFromAttrs(link, page.mainFrame(), this.options.debug);
		if (!linkInfo) throw new Error('could not find link element anymore');
		const [opened] = await Promise.all([
			this.#waitForNavigation(page.mainFrame(), this.options.timeoutMs.followLink, 'post-click-link'),
			this.#click(linkInfo.handle),
		]);
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

	async #waitForPageTasks() {
		if (!this.#asyncPageTasks.length) return;
		this.#log?.debug('waiting for async page tasks to complete');
		await Promise.all(this.#asyncPageTasks);
		this.#asyncPageTasks.length = 0;
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
		await this.#waitForPageTasks();
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
	async #waitForNavigation(
		  waitFrame: Frame,
		  minTimeoutMs: number,
		  navigateType: 'post-submit' | 'post-click-link',
	): Promise<Frame | null> {
		const maxWaitTimeMs = Math.max(minTimeoutMs,
			  this.#dataParams.pageLoadDurationMs * 2);

		this.#log?.debug('🔜 started waiting for navigation');
		try {
			const preTargets         = new Set(this.#context.targets());
			const waitPage           = waitFrame.page();
			const {msg, openedFrame} = await Promise.any([
				waitFrame.waitForNavigation({timeout: maxWaitTimeMs, waitUntil: 'domcontentloaded'})
					  .then(() => ({
						  msg: `🧭 navigated to ${waitFrame.url()}`,
						  openedFrame: waitFrame,
					  })),
				...(waitPage.mainFrame() !== waitFrame ? [
					waitPage.waitForNavigation({
						timeout: maxWaitTimeMs,
						waitUntil: 'domcontentloaded',
					}).then(() => ({
						msg: `🧭 parent page navigated to ${waitPage.url()}`,
						openedFrame: waitPage.mainFrame(),
					})),
				] : []),
				this.#context.waitForTarget(
					  target => target.type() === 'page' && !preTargets.has(target),
					  {timeout: maxWaitTimeMs})
					  .then(async openedPage => ({
						  msg: `🧭 opened ${openedPage.url()}`,
						  openedFrame: (await openedPage.page())!.mainFrame(),
					  })),
			]);

			this.#log?.log(msg);
			this.#log?.debug('waiting for page to fully load');
			if (await waitWithTimeout(maxWaitTimeMs, waitForLoad(openedFrame).then(() => true as const))) {
				this.#events.push(new NavigateEvent(navigateType, openedFrame.url(), true));
				this.#log?.log('page fully loaded');
			} else {
				this.#events.push(new NavigateEvent(navigateType, openedFrame.url(), false));
				this.#log?.log('⏱️ load timeout exceeded (will continue)');
			}

			await this.#sleep(this.options.sleepMs?.postNavigate);
			return openedFrame;
		} catch (err) {
			if (err instanceof AggregateError
				  && err.errors.every(e => e instanceof TimeoutError || isNavigationError(e))) {
				this.#log?.log('⏱️ navigation timeout exceeded (will continue)');
				await this.#sleep(this.options.sleepMs?.postNavigate);
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
				for (const frame of incompleteFrames)
					try {
						const {fields: frameFields, done: frameDone} = await this.#group(
							  `🔳frame ${getRelativeUrl(new URL(frame.url()), new URL(logPageUrl))}`,
							  () => this.#processFields(frame), frame !== page.mainFrame());
						if (this.#maxFieldsReached()) break;
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
					} catch (err) {
						this.#reportError(err, ['failed to process frame', frame.url()]);
					}
				allDone = true;  // All frames are done
			}

			if (pageFields.length && !this.options.fill.submit)
				await blurRefocus(page.mainFrame());

			if (this.#maxFieldsReached())
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
		const frameFields = await this.#findFields(frame);
		if (!frameFields) return {fields: null, done: true};

		if (this.options.fill.submit) {
			// Key '' means no form
			const fieldsByForm     = groupBy(field => field.attrs.form ? selectorStr(field.attrs.form) : '', frameFields);
			// Fields without form come last, forms with password field come first
			const fieldsByFormList = Object.entries(fieldsByForm)
				  .sort(([formA]) => formA === '' ? 1 : -1)
				  .sort(([, elemsA]) =>
						elemsA.some(e => e.attrs.fieldType === 'password')
							  ? elemsA.some(e => e.attrs.fieldType === 'password')
									? 0 : -1 : 1);
			for (const [lastForm, [formSelector, formFields]] of
				  fieldsByFormList.map((e, i, l) => [i === l.length - 1, e] as const)) {
				const res = await this.#group(`📝form ${formSelector}`, async () => {
					try {
						// First non-processed form field
						const field = formFields.find(field => !this.#processedFields.has(getElemIdentifierStr(field)));
						if (!field) return null;

						// Fill all fields in the form
						// For a field outside a form, we fill all fields outside a form in the frame
						await this.#fillFields(formFields);
						await this.#screenshot(frame.page(), 'filled');

						await this.#sleep(this.options.sleepMs?.postFill);

						if (this.options.fill.addFacebookButton)
							await this.#clickFacebookButton(frame);

						await this.#submitField(field);

						if (formSelector) addAll(this.#processedFields, formFields.map(getElemIdentifierStr));
						else this.#processedFields.add(getElemIdentifierStr(field));

						return {
							// For a form, all fields in the form
							// Otherwise, just the submitted field
							fields: formSelector ? formFields.map(f => f.attrs) : [field.attrs],
							// We are done if this was the last form or the last loose field
							done: lastForm && this.#processedFields.has(getElemIdentifierStr(formFields.at(-1)!)),
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
				await this.#fillFields(filterUniqBy(frameFields, this.#processedFields, f => getElemIdentifierStr(f.attrs)));
				await this.#screenshot(frame.page(), 'filled');

				await this.#sleep(this.options.sleepMs?.postFill);

				if (this.options.fill.addFacebookButton)
					await this.#clickFacebookButton(frame);
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
		const fields        = (await Promise.all([this.#getEmailFields(frame), this.#getPasswordFields(frame)])).flat();
		const prevFieldsLen = this.#fields.size;
		for (const field of fields) {
			const key      = getElemIdentifierStr(field);
			const existing = this.#fields.get(key);
			if (existing) field.attrs = existing;
			else this.#fields.set(key, field.attrs);
		}
		this.#log?.log(`🔍 found ${fields.length} fields (${this.#fields.size - prevFieldsLen} new)`);
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
		const elHandles = await frame.$$('robustpierce/input[type=password]');
		return (await Promise.all(elHandles.map(async handle => ({
			handle,
			attrs: {
				...await getElementAttrs(handle),
				fieldType: 'password',
			},
		} as const)))).filter(({attrs: {visible}}) => visible);
	}

	async #submitField(field: ElementInfo<FieldElementAttrs>) {
		if (!(field.attrs.filled ?? false)) {
			this.#log?.log(`skip submitting ${selectorStr(field.attrs.selectorChain)} because it was not filled`);
			return;
		}
		await this.#waitForPageTasks();
		this.#events.push(new SubmitEvent(getElemIdentifier(field)));
		this.#log?.log('⏎ submitting field', selectorStr(field.attrs.selectorChain));
		this.#setDirty(field.handle.frame.page());
		try {
			const [opened] = await Promise.all([
				this.#waitForNavigation(field.handle.frame,
					  this.options.timeoutMs.submitField, 'post-submit'),
				submitField(field.handle, this.options.sleepMs?.fill?.clickDwell ?? 0)
					  .then(() => field.attrs.submitted = true),
			]);

			await this.#screenshot((opened ?? field.handle.frame).page(), 'submitted');
			await blurRefocus(opened ?? field.handle.frame);
			await this.#sleep(this.options.sleepMs?.postFill);
		} catch (err) {
			this.#reportError(err, ['failed to submit field', field.attrs], 'warn');
		}
	}

	async #fillFields(fields: ElementInfo<FieldElementAttrs>[]) {
		this.#log?.log(`🖊 filling ${fields.length} fields`);
		const fillTimes = this.options.sleepMs?.fill ?? {clickDwell: 0, keyDwell: 0, betweenKeys: 0};
		for (const field of fields) {
			this.#events.push(new FillEvent(getElemIdentifier(field)));
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
						if (this.options.fill.simulateShowPassword) {
							this.#log?.debug('changing password field type to text');
							await field.handle.evaluate(f => (f as HTMLInputElement).type = 'text');
						}
						await this.#injectDomLeakDetection(field);
						await fillPasswordField(field.handle, this.options.fill.password, fillTimes);
						break;
					default:
						// noinspection ExceptionCaughtLocallyJS
						throw new UnreachableCaseError(field.attrs.fieldType);
				}
				field.attrs.filled = true;
				this.#log?.log(`✒️ filled ${field.attrs.fieldType} field`, selectorStr(field.attrs.selectorChain));
			} catch (err) {
				this.#reportError(err, ['failed to fill field', field.attrs], 'warn');
			}
		}
	}

	async #injectDomLeakDetection(field: ElementInfo) {
		const frame = field.handle.frame;
		try {
			const page = frame.page();
			if (tryAdd(this.#injectedDomLeakCallback, page))
				await exposeFunction(page, PageVars.DOM_LEAK_CALLBACK, this.#domLeakCallback.bind(this));

			await frame.evaluate(FieldsCollector.#injectDomLeakDetectFun, this.#encodedPasswords());

			const cdp          = typedCDP(await frame.page().target().createCDPSession());
			const observeNodes = new Map([
				...await Promise.all((await unwrapHandle(
					  await field.handle.evaluateHandle((field: HTMLInputElement | Element) =>
							'form' in field && field.form ? [...field.form].filter(e => e !== field) : [])))
					  .map(async handle =>
							[await this.#getNodeId(handle, cdp), await getElementAttrs(handle)] as const)),
				[await this.#getNodeId(field.handle, cdp), field.attrs],
			]);

			for (const [nodeId, attrs] of observeNodes)
				try {
					await cdp.send('DOMDebugger.setDOMBreakpoint', {
						type: 'attribute-modified',
						nodeId,
					});
				} catch (err) {
					this.#reportError(err, ['failed to observe node for DOM leaks', attrs]);
				}

			const stackTracer             = new StackTracer(cdp);
			stackTracer.onSourceMapLoaded = (sourceMapUrl, scriptUrl) =>
				  this.#log?.debug('loaded source map', scriptUrl ? `for ${scriptUrl}` : sourceMapUrl.href);

			page.on('close', () => void stackTracer.close()
				  .catch(err => this.options.debug && this.#reportError(err, ['failed to close source maps'], 'warn')));

			const attributesContainingPassword = new Map<Protocol.DOM.NodeId, Set<string>>(
				  [...observeNodes.keys()].map(nodeId => [nodeId, new Set()]),
			);
			cdp.on('Debugger.paused', event => this.#asyncPageTasks.push((async () => {
				if (event.reason !== 'DOM') return;
				const data = event.data as DOMPauseData;
				if (data.type !== 'attribute-modified') return;
				const {nodeId} = data;
				const attrs    = observeNodes.get(nodeId);
				if (!attrs) return;

				await cdp.send('Debugger.resume');

				const leaks = filterUniqBy(attributePairs(await cdp.send('DOM.getAttributes', {nodeId}))
							.filter(({value}) => value.includes(this.options.fill.password)
								  || value.includes(JSON.stringify(this.options.fill.password)))
							.map(({name}) => name),
					  attributesContainingPassword.get(nodeId)!, a => a);
				if (!leaks.length) return;

				this.#log?.info(`🔓💧 password leaked on ${frame.url()} to attributes (stack captured): ${
					  leaks.map(attr => `${selectorStr(attrs.selectorChain)} @${attr}`).join(', ')}`);
				const time = Date.now();

				await Promise.all(leaks.map(async (attribute) => {
					const leak: DomPasswordLeak = {
						time,
						attribute,
						element: attrs,
					};
					leak.stack                  = await stackTracer.getStack(event.callFrames, this.options.useSourceMaps,
						  (err, aggressive) => !aggressive &&
								this.#log?.debug('failed to read source map', err),
						  plainStack => {
							  leak.stack = plainStack;
							  this.#addDomLeak(leak);
						  });
				}));
			})().catch(err =>
				  this.#reportError(err, ['error handling debugger pause for DOM leak detection'],
						err instanceof Error && err.message.includes('Could not find node with given id')
							  ? 'warn' : 'error'))));

			await stackTracer.enable();

			this.#log?.debug('injected DOM password leak detection');
		} catch (err) {
			this.#reportError(err, ['failed to inject DOM password leak detection on', frame.url()]);
		}
	}

	async #getNodeId(elem: ElementHandle, cdp: TypedCDPSession): Promise<Protocol.DOM.NodeId> {
		//XXX Uses internal functionality as our CDP will not recognize the RemoteObjectId from puppeteer's CDP, see puppeteer/puppeteer#9284
		const puppeteerCdp = (elem.frame.page() as unknown as import('puppeteer-core/lib/cjs/puppeteer/common/Page').CDPPage)._client();

		const {node: {backendNodeId}} = await puppeteerCdp.send('DOM.describeNode', {
			objectId: elem.remoteObject().objectId!,
		});

		const {object: {objectId}} = await cdp.send('DOM.resolveNode', {backendNodeId});
		let {nodeId}               = await cdp.send('DOM.requestNode', {objectId: objectId!});
		// DOM.getDocument needs to be called once before NodeIds are available, see https://crbug.com/1374241
		// Calling multiple times invalidates previous NodeIds
		if (!nodeId) await cdp.send('DOM.getDocument', {depth: 0});
		({nodeId} = await cdp.send('DOM.requestNode', {objectId: objectId!}));
		return nodeId;
	}

	/** Called from the page when a DOM password leak is detected */
	#domLeakCallback(frameId: string, leaks: PagePasswordLeak[]) {
		this.#asyncPageTasks.push((async () => {
			try {
				const time  = Date.now();
				const frame = this.#frameIdMap.get(frameId)!;
				this.#log?.info(`🔓💧 password leaked on ${frame.url()} to attributes: ${
					  leaks.map(l => `${selectorStr(l.selectorChain)} @${l.attribute}`).join(', ')}`);
				(await Promise.all(leaks.map(async (leak): Promise<DomPasswordLeak> => {
					let attrs;
					try {
						const handle = (await getElementBySelectorChain(leak.selectorChain, frame))?.elem;
						if (handle) attrs = await getElementAttrs(handle);
					} catch (err) {
						this.#reportError(err, [
								  'failed to get attributes for DOM password leak element', selectorStr(leak.selectorChain)],
							  'warn');
					}
					return {
						time,
						attribute: leak.attribute,
						element: attrs ?? {
							frameStack: getFrameStack(frame).map(f => f.url()) as NonEmptyArray<string>,
							selectorChain: leak.selectorChain,
						},
					};
				}))).forEach(leak => this.#addDomLeak(leak));
			} catch (err) {
				this.#reportError(err, ['error in DOM password leak callback']);
			}
		})());
	}

	#addDomLeak(leak: DomPasswordLeak): boolean {
		const maxTimeDifferenceMs = 100;

		const prev = this.#domLeaks.at(-1);
		if (prev && Math.abs(leak.time - prev.time) < maxTimeDifferenceMs
			  && prev.element.frameStack.join('\n') === leak.element.frameStack.join('\n')
			  && selectorStr(prev.element.selectorChain) === selectorStr(leak.element.selectorChain))
			if (leak.stack && !prev.stack)
				this.#domLeaks.pop();
			else if (prev.stack && !leak.stack)
				return false;
		this.#domLeaks.push(leak);
		return true;
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
			await this.#sleep(this.options.sleepMs?.postFacebookButtonClick);
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

	#maxFieldsReached() {
		return this.#processedFields.size >= this.options.fill.maxFields;
	}

	#encodedPasswords(): string[] {
		const password = this.options.fill.password;
		return [
			password,
			encodeURIComponent(password),
			encodeURIComponent(encodeURIComponent(password)),
			JSON.stringify(password),
		];
	}

	/** Called from an asynchronous page script when an error occurs */
	#errorCallback(frameId: string | undefined | null, message: string, stack: string) {
		this.#reportError({message, stack, toString() {return message;}},
			  ['error in background page script',
				  frameId && getFrameStack(this.#frameIdMap.get(frameId)!).map(f => f.url()).join(', ')]);
	}

	#reportError(error: unknown, context: unknown[], level: 'warn' | 'error' = 'error') {
		if (isNavigationError(error)) {
			// Do not regard warnings due to navigation etc. as errors
			this.#log?.log(...context, error);
		} else {
			this.#log?.logLevel(level, ...context, error);
			this.#errors.push({time: Date.now(), error, context, level});
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
	maxLinks?: integer;
	/**
	 * Whether to stop crawl early.
	 * Specify "first-page-with-form" to stop after the first page with a form
	 * (similar to maxFields=1 but after filling all forms on that page)
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
		/** Simulate 'show password' feature by changing password field type to text
		 * @default false */
		simulateShowPassword?: boolean;
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
	 * Will not capture stack traces.
	 * Useful for manual form filling
	 * @default false
	 */
	immediatelyInjectDomLeakDetection?: boolean,
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
	/** Try to use source maps for DOM leak stack traces, specify "aggressive" to try adding .map after .js URL
	 * @default "aggressive" */
	useSourceMaps?: boolean | 'aggressive',
	/** Turn on some debugging assertions.
	 * Default false unless an inspector is activated */
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
		postFacebookButtonClick: 3_000,
		postNavigate: 4_000,
		fill: {
			clickDwell: 100,
			keyDwell: 100,
			betweenKeys: 250,
		},
	},
	maxLinks: 5,
	skipExternal: 'frames',
	stopEarly: false,
	fill: {
		email: 'leak-detector@example.com',
		appendDomainToEmail: false,
		password: 'The--P@s5w0rd',
		simulateShowPassword: false,
		submit: true,
		addFacebookButton: true,
		maxFields: 10,
	},
	immediatelyInjectDomLeakDetection: false,
	disableClosedShadowDom: true,
	interactChains: [],
	screenshot: null,
	useSourceMaps: true,
	debug: !!inspector.url(),
};

//endregion

/** Password leak as passed to the callback */
export interface PagePasswordLeak {
	selectorChain: SelectorChain;
	attribute: string;
}

/** Password leak as reported in the data */
export interface DomPasswordLeak {
	time: number;
	attribute: string;
	element: ElementIdentifier | ElementAttrs;
	stack?: StackFrame[];
}

export interface ConsoleLeak {
	time: number;
	type: Protocol.Runtime.ConsoleAPICalledEvent['type'];
	message: string;
	stack?: StackFrame[];
}

export interface StackFrame {
	/** Script URL. May be null for internal browser code */
	url: string | null;
	function: string | null;
	line: number;
	/** 1-based */
	column: number | null;

	sourceMapped?: {
		url: string | null;
		function: string | null;
		line: number | null;
		/** 1-based */
		column: number | null;
	};
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
	constructor(public readonly field: ElementIdentifier) {
		super('fill');
	}
}

export class SubmitEvent extends FieldsCollectorEvent {
	constructor(public readonly field: ElementIdentifier) {
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
	constructor(public readonly link: ElementIdentifier, public readonly linkType: 'auto' | 'manual') {
		super('link');
	}
}

export class NavigateEvent extends FieldsCollectorEvent {
	constructor(
		  public readonly navigateType: 'post-submit' | 'post-click-link',
		  public readonly url: string,
		  public readonly fullyLoaded: boolean,
	) {
		super('navigate');
	}
}

export class ScreenshotEvent extends FieldsCollectorEvent {
	constructor(public readonly trigger: ScreenshotTrigger, public readonly name?: string) {
		super('screenshot');
	}
}

//endregion

export interface ErrorInfo {
	time: number;
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
	domLeaks: DomPasswordLeak[];
	consoleLeaks: ConsoleLeak[];
	events: FieldsCollectorEvent[];
	errors: ErrorInfo[];
}

// This is a const enum such that the TypeScript transpiler replaces names with values in the page scripts
/** Names of in-page things */
export const enum PageVars {
	FRAME_ID          = '@@leakDetectFrameId',
	INJECTED          = '@@leakDetectInjected',
	DOM_OBSERVED      = '@@leakDetectDomObserved',
	DOM_LEAK_CALLBACK = '@@leakDetectDomObserverCallback',
	ERROR_CALLBACK    = '@@leakDetectError',
}

declare global {
	/** In-page things */
	interface Window {
		[PageVars.FRAME_ID]?: string;
		[PageVars.ERROR_CALLBACK]: (frameId: string | undefined, message: string, stack: string) => void;
		[PageVars.INJECTED]: typeof import('leak-detect-inject');
		[PageVars.DOM_OBSERVED]?: boolean;
		[PageVars.DOM_LEAK_CALLBACK]?: (frameId: string, leaks: PagePasswordLeak[]) => void;
	}
}
