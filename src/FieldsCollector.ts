import assert from 'node:assert';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {createRunner, PuppeteerRunnerExtension, UserFlow} from '@puppeteer/replay';
import type {BrowserContext, ElementHandle, Frame, Page} from 'puppeteer';
import {groupBy} from 'ramda';
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
	getRelativeUrl,
	populateDefaults,
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
import ErrnoException = NodeJS.ErrnoException;
import TimeoutError = puppeteer.TimeoutError;

export class FieldsCollector extends BaseCollector {
	/** Page function to inject leak-detect-inject */
	static #doInjectFun: () => void;

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
	/** Pages that password leak callback has been injected into */
	#injectedPasswordCallback = new Set<Page>();
	#startUrls                = new Map<Page, string>();
	#postCleanListeners       = new Map<Page, () => PromiseLike<void> | void>();
	#dirtyPages               = new Set<Page>();

	#events: FieldsCollectorEvent[]  = [];
	/** Selectors of processed fields */
	#processedFields                 = new Set<string>();
	#passwordLeaks: PasswordLeak[]   = [];
	#visitedTargets: VisitedTarget[] = [];
	#errors: ErrorInfo[]             = [];

	constructor(options?: FieldsCollectorOptions, logger?: Logger) {
		super();
		this.options = populateDefaults<FullFieldsCollectorOptions>(options ?? {}, defaultOptions);

		FieldsCollector.#loadInjectScript();
		this.#log = logger;
	}

	static #loadInjectScript() {
		FieldsCollector.#doInjectFun ??= (() => {
			let bundleTime;
			try {
				bundleTime = fs.statSync('./inject/dist/bundle.js').mtimeMs;
			} catch (err) {
				if ((err as ErrnoException).code === 'ENOENT')
					console.error('bundle to inject not found, run `npm run pack` in the `inject` folder');
				throw err;
			}
			const sourceDir      = './inject/src/';
			const sourceFileTime = fs.readdirSync(sourceDir)
				  .map(fileName => fs.statSync(path.join(sourceDir, fileName)).mtimeMs)
				  .reduce((a, b) => Math.max(a, b));
			const timeDiff       = sourceFileTime - bundleTime;
			if (timeDiff > 0)
				console.warn(`⚠️ inject script was modified ${formatDuration(timeDiff)} after bundle creation, ` +
					  'you should probably run `npm run pack` in the `inject` folder');
			const injectSrc = fs.readFileSync('./inject/dist/bundle.js', 'utf8');
			// eslint-disable-next-line @typescript-eslint/no-implied-eval
			return Function(/*language=JavaScript*/ `try {
				window[${JSON.stringify(PageVars.INJECTED)}] ??= (() => {
					${injectSrc};
					// noinspection JSUnresolvedVariable
					return leakDetectToBeInjected;
				})();
			} catch (err) {
				window[${JSON.stringify(PageVars.ERROR_CALLBACK)}](String(err), err instanceof Error && err.stack || Error().stack);
			}`) as () => void;
		})();
	}

	override id() { return 'fields' as const; }

	override init({log, url, context}: BaseCollector.CollectorInitOptions) {
		this.#log ??= new ColoredLogger(new PlainLogger(log));
		this.#context    = context;
		this.#headless   = context.browser().process()?.spawnargs.includes('--headless') ?? true;
		this.#initialUrl = url;
		this.#siteDomain = tldts.getDomain(url.href);

		this.#page                     = undefined!;  // Initialized in addTarget
		this.#injectedPasswordCallback = new Set();

		this.#events          = [];
		this.#processedFields = new Set();
		this.#passwordLeaks   = [];
		this.#visitedTargets  = [];
		this.#errors          = [];
	}

	override async addTarget({url, type}: Parameters<typeof BaseCollector.prototype.addTarget>[0]) {
		this.#visitedTargets.push({time: Date.now(), type, url});  // Save other targets as well

		if (type === 'page') {
			const pages   = await this.#context.pages();
			const newPage = pages.at(-1)!;
			this.#page ??= newPage;  // Take first page

			await exposeFunction(newPage, PageVars.ERROR_CALLBACK, this.#errorCallback.bind(this));

			async function evaluateOnAll(pageFunction: () => void) {
				// Add on new & existing frames
				await newPage.evaluateOnNewDocument(pageFunction);
				await Promise.all(await Promise.all(newPage.frames().map(frame => frame.evaluate(pageFunction))));
			}

			await evaluateOnAll(FieldsCollector.#doInjectFun);

			// May not catch all, as scripts may have already run
			if (this.options.disableClosedShadowDom)
				await evaluateOnAll(() => {
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
						window[PageVars.ERROR_CALLBACK](String(err), err instanceof Error && err.stack || Error().stack!);
					}
				});

			newPage.once('load', () => void this.#screenshot(newPage, 'new-page'));
		}
	}

	override async getData(options: Parameters<typeof BaseCollector.prototype.getData>[0]): Promise<FieldsCollectorData | null> {
		this.#dataParams = options;

		if (this.#siteDomain === null && this.#initialUrl.hostname !== 'localhost') {
			this.#log?.warn('URL has no domain with public suffix, will skip this page');
			return null;
		}

		await this.#screenshot(this.#page, 'loaded');

		// Search for fields on the landing page(s)
		const fields = await this.#processFieldsOnAllPages();

		fields.push(...await this.#executeInteractChains());

		let links = null;
		if (this.options.clickLinkCount
			  && !(this.options.stopEarly === 'first-page-with-form' && fields.length)) {
			const res = await this.#inspectLinkedPages();
			if (res) {
				links = res.links;
				fields.push(...res.fields);
			}
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
				this.#log?.log(`starting click chain ${nChain + 1}${
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

								this.#log?.log(`clicking element ${nElem + 1}/${chain.paths.length}`, selectorStr(selector));
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

			this.#log?.debug(`found ${links.length} login/register links on the landing page`, matchTypeCounts);

			if (links.length > this.options.clickLinkCount)
				this.#log?.log(`skipping last ${links.length - this.options.clickLinkCount} links`);

			const fields: FieldElementAttrs[] = [];

			links = links.slice(0, this.options.clickLinkCount);
			for (const link of links) {
				await this.#group(`link ${selectorStr(link.selectorChain)}`, async () => {
					try {
						if (this.options.skipExternal && link.href &&
							  tldts.getDomain(new URL(link.href, this.#dataParams.finalUrl).href) !== this.#siteDomain) {
							this.#log?.log('skipping external link', link.href);
							return;
						}

						await this.#cleanPage(this.#page);
						await this.#closeExtraPages();

						await this.#followLink(link);
						fields.push(...await this.#processFieldsOnAllPages());
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
		this.#log?.log('following link', selectorStr(link.selectorChain));
		this.#events.push(new ClickLinkEvent(link.selectorChain, 'auto'));
		const page     = this.#page;
		const linkInfo = await getElementInfoFromAttrs(link, page.mainFrame());
		if (!linkInfo) throw new Error('could not find link element anymore');
		await this.#click(linkInfo.handle);
		const opened = await this.#waitForNavigation(page.mainFrame(), this.options.timeoutMs.followLink);
		await this.#screenshot(opened?.page() ?? page, 'link-clicked');
	}

	/** Just click an element */
	async #click(elem: ElementHandle) {
		await elem.frame.page().bringToFront();
		// Note: the alternative `ElementHandle#click` can miss if the element moves or if it is covered
		await elem.evaluate(el => {
			el.scrollIntoView({behavior: 'smooth', block: 'end', inline: 'end'});
			if (el instanceof HTMLElement) el.click();
			else el.dispatchEvent(new MouseEvent('click', {view: window, bubbles: true, cancelable: true}));
		});
	}

	#setDirty(page: Page) {
		this.#dirtyPages.add(page);
	}

	async #cleanPage(page: Page) {
		let startUrl = this.#startUrls.get(page);
		if (!startUrl) this.#startUrls.set(page, (startUrl = page.url()));
		if (this.#dirtyPages.delete(page)) {
			this.#events.push(new ReturnEvent(page === this.#page));
			await this.#goto(page.mainFrame(), startUrl, this.options.timeoutMs.reload);
			await this.#postCleanListeners.get(page)?.();
		}
	}

	#doWithOnCleanPage<T extends Promise<unknown> | unknown>(
		  page: Page, listener: () => PromiseLike<void> | void, scopeFunc: () => T): T {
		assert(!this.#postCleanListeners.has(page));
		this.#postCleanListeners.set(page, listener);
		let promise;
		try {
			const res = scopeFunc();
			// noinspection SuspiciousTypeOfGuard
			if ((promise = res instanceof Promise))
				return res.finally(() => this.#postCleanListeners.delete(page)) as unknown as T;
			return res;
		} finally {
			if (!promise) this.#postCleanListeners.delete(page);
		}
	}

	async #goto(frame: Frame, url: string, minTimeoutMs: number) {
		const maxWaitTimeMs = Math.max(minTimeoutMs,
			  this.#dataParams.pageLoadDurationMs * 2);

		this.#log?.log(frame.url() === url ? 'will reload' : `will navigate ${frame.url()} → ${url}`);
		await frame.page().bringToFront();
		try {
			await frame.goto(url, {timeout: maxWaitTimeMs, waitUntil: 'load'});
			await this.#sleep(this.options.sleepMs?.postNavigate);
		} catch (err) {
			if (err instanceof TimeoutError) {
				this.#log?.log('navigation timeout exceeded (will continue)');
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

		this.#log?.debug(`waiting for navigation from ${frame.url()}`);
		try {
			const prePages      = new Set(await this.#context.pages());
			const {msg, target} = await Promise.race([
				(async () => {
					try {
						await frame.waitForNavigation({timeout: maxWaitTimeMs, waitUntil: 'load'});
						return {msg: `navigated to ${frame.url()}`, target: frame};
					} catch (err) {
						if (err instanceof TimeoutError) throw err;
						// Frame may be detached due to parent navigating
						const page = frame.page();
						await page.waitForNavigation({timeout: maxWaitTimeMs, waitUntil: 'load'});
						return {msg: `parent page navigated to ${page.url()}`, target: page.mainFrame()};
					}
				})(),
				this.#context.waitForTarget(
					  async target => target.type() === 'page' && !prePages.has((await target.page())!),
					  {timeout: maxWaitTimeMs})
					  .then(async page => ({msg: `opened ${page.url()}`, target: (await page.page())!.mainFrame()})),
			]);
			this.#log?.log(msg);
			await this.#sleep(this.options.sleepMs?.postNavigate);
			return target;
		} catch (err) {
			if (err instanceof TimeoutError) {
				this.#log?.log('navigation timeout exceeded (will continue)');
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
		return this.#group(logPageUrl, async () => {
			if (this.options.skipExternal && tldts.getDomain(page.url()) !== this.#siteDomain) {
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
						  `frame ${getRelativeUrl(new URL(frame.url()), new URL(logPageUrl))}`,
						  () => this.#processFields(frame), frame !== page.mainFrame());
					if (frameDone) {
						completedFrames.add(frame.url());  // This frame is done
						if (frame === incompleteFrames.at(-1)!)
							allDone = true;  // All frames done, prevent extra reload even on submission
					}
					if (frameFields?.length) {
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
				this.#log?.log('reached maximum number of filled fields');
			this.#log?.log(`processed ${pageFields.length} new fields`);
			return pageFields;
		});
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
				const res = await this.#group(`form ${formSelector}`, async () => {
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

		this.#log?.debug('finding fields');
		const url = frame.url();
		if (this.options.skipExternal === 'frames' && tldts.getDomain(url) !== this.#siteDomain) {
			this.#log?.log('skipping external frame');
			return null;
		}

		const fields = (await Promise.all([this.#getEmailFields(frame), this.#getPasswordFields(frame)])).flat();
		this.#log?.log(`found ${fields.length} fields`);
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
		this.#log?.log('submitting field', selectorStr(field.attrs.selectorChain));
		this.#setDirty(field.handle.frame.page());
		try {
			await submitField(field.handle, this.options.sleepMs?.fill?.clickDwell ?? 0);
			field.attrs.submitted = true;

			const frame  = field.handle.frame;
			const opened = await this.#waitForNavigation(field.handle.frame,
				  this.options.timeoutMs.submitField);
			await this.#screenshot((opened ?? frame).page(), 'submitted');
		} catch (err) {
			this.#reportError(err, ['failed to submit field', field.attrs], 'warn');
		}
	}

	async #fillFields(fields: ElementInfo<FieldElementAttrs>[]) {
		this.#log?.log(`filling ${fields.length} fields`);
		const fillTimes = this.options.sleepMs?.fill ?? {clickDwell: 0, keyDwell: 0, betweenKeys: 0};
		for (const field of fields.filter(f => !f.attrs.filled)) {
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
				this.#log?.debug('filled field', selectorStr(field.attrs.selectorChain));
			} catch (err) {
				this.#reportError(err, ['failed to fill field', field.attrs], 'warn');
			}
		}
	}

	//TODO? Maybe just check once after filling
	async #injectPasswordLeakDetection(frame: Frame) {
		try {
			const page = frame.page();
			if (tryAdd(this.#injectedPasswordCallback, page))
				await exposeFunction(page, PageVars.PASSWORD_CALLBACK, this.#passwordLeakCallback.bind(this, frame));

			const newlyInjected = await frame.evaluate((password: string) => {
				if (window[PageVars.PASSWORD_OBSERVED]) return false;
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
							void window[PageVars.PASSWORD_CALLBACK](leakSelectors);
					} catch (err) {
						window[PageVars.ERROR_CALLBACK](String(err), err instanceof Error && err.stack || Error().stack!);
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
								void window[PageVars.PASSWORD_CALLBACK](leakSelectors);
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
						window[PageVars.ERROR_CALLBACK](String(err), err instanceof Error && err.stack || Error().stack!);
					}
					return shadow;
				};

				inspectRecursive(document, false);
				return true;
			}, this.options.fill.password);

			if (newlyInjected) this.#log?.debug('injected password leak detection');
		} catch (err) {
			this.#reportError(err, ['failed to inject password leak detection on', frame.url()]);
		}
	}

	/** Called from the page when a password leak is detected */
	async #passwordLeakCallback(frame: Frame, leaks: PagePasswordLeak[]) {
		this.#log?.info(`password leaked on ${frame.url()} to attributes: ${
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
	}

	async #clickFacebookButton(frame: Frame) {
		this.#log?.log('adding and clicking button for Facebook leak detection');
		this.#events.push(new FacebookButtonEvent());
		this.#setDirty(frame.page());
		try {
			await frame.evaluate(() => {
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
					const dirPath = path.join(opts.target, this.#siteDomain ?? this.#initialUrl.hostname);
					await fsp.mkdir(dirPath, {recursive: true});
					await fsp.writeFile(path.join(dirPath, name), img);
				} else {
					this.#log?.debug('📸', trigger);
					await opts.target(img, trigger);
				}
			} catch (err) {
				this.#reportError(err, [`failed to make ${trigger} screenshot`, page.url()], 'warn');
			}
		}
	}

	/** Called from an asynchronous page script when an error occurs */
	#errorCallback(message: string, stack: string) {
		this.#reportError({message, stack}, ['error in background page script']);
	}

	#reportError(error: unknown, context: unknown[], level: 'warn' | 'error' = 'error') {
		this.#log?.[level](...context, error);
		this.#errors.push({error, context, level});
	}

	async #sleep(ms: number | undefined) {
		if (ms) {
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
		target: string | ((img: Buffer, trigger: ScreenshotTrigger) => PromiseLike<void> | void);
	} | null;
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

export const defaultOptions: FullFieldsCollectorOptions = {
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
	disableClosedShadowDom: true,
	interactChains: [],
	screenshot: null,
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
	INJECTED          = '@@leakDetectInjected',
	PASSWORD_OBSERVED = '@@leakDetectPasswordObserved',
	PASSWORD_CALLBACK = '@@leakDetectPasswordObserverCallback',
	ERROR_CALLBACK    = '@@leakDetectError',
}

declare global {
	/** In-page things */
	interface Window {
		[PageVars.INJECTED]: typeof import('leak-detect-inject');
		[PageVars.PASSWORD_OBSERVED]: boolean;
		[PageVars.PASSWORD_CALLBACK]: (leaks: PagePasswordLeak[]) => Promise<void>;
		[PageVars.ERROR_CALLBACK]: (message: string, stack: string) => void;
	}
}
