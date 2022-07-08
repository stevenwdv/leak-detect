import fs from 'node:fs';

import {createRunner, PuppeteerRunnerExtension} from '@puppeteer/replay';
import {BrowserContext, ElementHandle, Frame, Page} from 'puppeteer';
import {groupBy} from 'ramda';
import * as tldts from 'tldts';
import {BaseCollector, TargetCollector} from 'tracker-radar-collector';
import {DeepRequired, UnreachableCaseError} from 'ts-essentials';

import {SelectorChain} from 'leak-detect-inject';
import {addAll, AsBound, filterUniqBy, formatDuration, getRelativeUrl, populateDefaults, tryAdd} from './utils';
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
} from './pageUtils';
import {getLoginLinks} from './loginLinks';
import {
	exposeFunction,
	getFrameStack,
	getPageFromFrame,
	getPageFromHandle,
	isOfType,
	unwrapHandle,
} from './puppeteerUtils';
import ErrnoException = NodeJS.ErrnoException;

// This is a const enum such that the TypeScript transpiler replaces names with values in the page scripts
export const enum GlobalNames {
	INJECTED          = '@@leakDetectInjected',
	PASSWORD_OBSERVED = '@@leakDetectPasswordObserved',
	PASSWORD_CALLBACK = '@@leakDetectPasswordObserverCallback',
	ERROR_CALLBACK    = '@@leakDetectError',
}

export class FieldsCollector extends BaseCollector {
	static #doInjectFun: () => void;

	readonly #options: FullFieldsCollectorOptions;
	#log: Logger | undefined;
	#dataParams!: Parameters<typeof BaseCollector.prototype.getData>[0];
	#initialUrl!: URL;
	#context!: BrowserContext;
	#headless                  = true;
	#siteDomain: string | null = null;

	#page!: Page;
	#injectedPasswordCallback = new Set<Page>();

	#events: FieldCollectorEvent[]   = [];
	#processedFields                 = new Set<string>();
	#passwordLeaks: PasswordLeak[]   = [];
	#visitedTargets: VisitedTarget[] = [];

	constructor(options?: FieldsCollectorOptions, logger?: Logger) {
		super();
		this.#options = populateDefaults<FullFieldsCollectorOptions>(options ?? {}, defaultOptions);

		FieldsCollector.#loadInjectScript();
		this.#log = logger;
	}

	static #loadInjectScript() {
		FieldsCollector.#doInjectFun ||= (() => {
			let bundleTime;
			try {
				bundleTime = fs.statSync('./inject/dist/bundle.js').mtimeMs;
			} catch (err) {
				if ((err as ErrnoException).code === 'ENOENT')
					console.error('bundle to inject not found, run `npm run pack` in the `inject` folder');
				throw err;
			}
			const timeDiff = fs.statSync('./inject/src/main.ts').mtimeMs - bundleTime;
			if (timeDiff > 0)
				console.error(`⚠️ inject script was modified ${formatDuration(timeDiff)} after bundle creation, ` +
					  'you should probably run `npm run pack` in the `inject` folder');
			const injectSrc = fs.readFileSync('./inject/dist/bundle.js', 'utf8');
			// eslint-disable-next-line @typescript-eslint/no-implied-eval
			return Function(`try {
				window["${GlobalNames.INJECTED}"] ??= (() => {
					${injectSrc};
					return leakDetectToBeInjected;
				})();
			} catch (err) {
				window["${GlobalNames.ERROR_CALLBACK}"](String(err), err instanceof Error && err.stack || Error().stack);
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
		this.#processedFields          = new Set();

		this.#events         = [];
		this.#passwordLeaks  = [];
		this.#visitedTargets = [];
	}

	override async addTarget({url, type}: Parameters<typeof BaseCollector.prototype.addTarget>[0]) {
		this.#visitedTargets.push({time: Date.now(), type, url});  // Save other targets as well
		if (type === 'page') {
			const pages   = await this.#context.pages();
			const newPage = pages.at(-1)!;
			this.#page ??= newPage;  // Take first page

			await exposeFunction(newPage, GlobalNames.ERROR_CALLBACK, this.#errorCallback.bind(this));

			async function evaluateOnAll(pageFunction: (...args: never) => void) {
				// Add on new & existing frames
				await newPage.evaluateOnNewDocument(pageFunction);
				await Promise.all(await Promise.all(newPage.frames().map(frame => frame.evaluate(pageFunction))));
			}

			await evaluateOnAll(FieldsCollector.#doInjectFun);

			// May not catch all, as scripts may have already run
			if (this.#options.disableClosedShadowDom)
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
						window[GlobalNames.ERROR_CALLBACK]!(String(err), err instanceof Error && err.stack || Error().stack!);
					}
				});
		}
	}

	override async getData(options: Parameters<typeof BaseCollector.prototype.getData>[0]): Promise<FieldCollectorData> {
		this.#dataParams = options;

		if (this.#siteDomain === null && this.#initialUrl?.hostname !== 'localhost') {
			this.#log?.warn('URL has no domain with public suffix, will skip this page');
			return {};
		}

		// Search for fields on the landing page(s)
		const fields = await this.#processFieldsOnAllPages();

		for (const [nChain, chain] of this.#options.interactChains.entries()) {
			try {
				this.#log?.log(`starting click chain ${nChain + 1}${
					  chain.type === 'puppeteer-replay' ? `: ${chain.flow.title}` : ''}`);
				this.#events.push(new ReturnEvent(true));
				await this.#goto(this.#page.mainFrame(), this.#dataParams.finalUrl, this.#options.timeoutMs.reload);
				await this.#closeExtraPages();

				switch (chain.type) {
					case 'js-path-click':
						for (const [nElem, elemPath] of chain.paths.entries()) {
							const elem = await unwrapHandle(await this.#page.evaluateHandle(
								  // eslint-disable-next-line @typescript-eslint/no-implied-eval
								  Function(`return (${elemPath});`) as () => Element | null));
							if (!elem) throw new Error(`element for click chain not found: ${elemPath}`);
							const selector = await formSelectorChain(elem);

							this.#log?.log(`clicking element ${nElem + 1}/${chain.paths.length}`, selector.join('>>>'));
							this.#events.push(new ClickLinkEvent(selector, 'manual'));
							await this.#click(elem);
							await this.#sleep(this.#options.sleepMs?.postNavigate);
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

				fields.push(...await this.#processFieldsOnAllPages());
			} catch (err) {
				this.#log?.warn('failed to inspect page for click chain', chain, err);
			}
		}

		// Search for fields on linked pages
		let links = null;
		if (this.#options.clickLinkCount
			  && !(this.#options.stopEarly === 'first-page-with-form' && fields.length)) try {
			links = (await getLoginLinks(this.#page.mainFrame(), new Set(['exact', 'loose', 'coords'])))
				  .map(info => info.attrs);

			const matchTypeCounts = links.reduce((acc, attrs) =>
				  acc.set(attrs.linkMatchType, (acc.get(attrs.linkMatchType) ?? 0) + 1), new Map<LinkMatchType, number>());

			this.#log?.debug(`found ${links.length} login/register links on the landing page`, matchTypeCounts);

			if (links.length > this.#options.clickLinkCount)
				this.#log?.log(`skipping last ${links.length - this.#options.clickLinkCount} links`);

			links = links.slice(0, this.#options.clickLinkCount);
			for (const link of links) {
				await this.#group(`link ${link.selectorChain.join('>>>')}`, async () => {
					try {
						if (this.#options.skipExternal && link.href &&
							  tldts.getDomain(new URL(link.href, this.#dataParams.finalUrl).href) !== this.#siteDomain) {
							this.#log?.log('skipping external link', link.href);
							return;
						}

						this.#events.push(new ReturnEvent(true));
						await this.#goto(this.#page.mainFrame(), this.#dataParams.finalUrl, this.#options.timeoutMs.reload);
						await this.#closeExtraPages();

						await this.#followLink(link);
						fields.push(...await this.#processFieldsOnAllPages());
					} catch (err) {
						this.#log?.warn('failed to inspect linked page for link', link, err);
					}
				});
				if (this.#options.stopEarly === 'first-page-with-form' && fields.length)
					break;
			}
		} catch (err) {
			this.#log?.error('failed to inspect linked pages', err);
		}

		await this.#closeExtraPages();

		return {
			visitedTargets: this.#visitedTargets,
			fields,
			links,
			passwordLeaks: this.#passwordLeaks,
			events: this.#events,
		};
	}

	#group<T>(name: string, func: () => T): T {
		return this.#log ? this.#log.group(name, func) : func();
	}

	async #closeExtraPages() {
		const closedPages = await closeExtraPages(this.#context, new Set([this.#page]));
		if (closedPages.length) this.#log?.debug(`closed ${closedPages.length} pages`);
	}

	async #followLink(link: ElementAttrs) {
		this.#log?.log('following link', link.selectorChain.join('>>>'));
		this.#events.push(new ClickLinkEvent(link.selectorChain, 'auto'));
		const page     = this.#page;
		const linkInfo = await getElementInfoFromAttrs(link, page.mainFrame());
		if (!linkInfo) throw new Error('could not find link element anymore');
		await this.#click(linkInfo.handle);
		await this.#waitForNavigation(page.mainFrame(), this.#options.timeoutMs.followLink);
	}

	async #goto(frame: Frame, url: string, minTimeoutMs: number) {
		const maxWaitTimeMs = Math.max(minTimeoutMs,
			  this.#dataParams.pageLoadDurationMs * 2);

		this.#log?.log(frame.url() === url ? 'will reload' : `will navigate ${frame.url()} → ${url}`);
		await getPageFromFrame(frame).bringToFront();
		try {
			await frame.goto(url, {timeout: maxWaitTimeMs, waitUntil: 'load'});
			await this.#sleep(this.#options.sleepMs?.postNavigate);
		} catch (err) {
			if (isOfType(err, 'TimeoutError')) {
				this.#log?.log('navigation timeout exceeded (will continue)');
				return;
			}
			throw err;
		}
	}

	async #click(link: ElementHandle) {
		await getPageFromHandle(link)!.bringToFront();
		// Note: the alternative `ElementHandle#click` can miss if the element moves or if it is covered
		await link.evaluate(el => {
			el.scrollIntoView({behavior: 'smooth', block: 'end', inline: 'end'});
			if (el instanceof HTMLElement) el.click();
			else el.dispatchEvent(new MouseEvent('click', {view: window, bubbles: true, cancelable: true}));
		});
	}

	async #waitForNavigation(frame: Frame, minTimeoutMs: number) {
		const maxWaitTimeMs = Math.max(minTimeoutMs,
			  this.#dataParams.pageLoadDurationMs * 2);

		this.#log?.debug(`waiting for navigation from ${frame.url()}`);
		try {
			const prePages = new Set(await this.#context.pages());
			const msg      = await Promise.race([
				frame.waitForNavigation({timeout: maxWaitTimeMs, waitUntil: 'load'})
					  .then(() => `navigated to ${frame.url()}`),
				this.#context.waitForTarget(
					  async target => target.type() === 'page' && !prePages.has((await target.page())!),
					  {timeout: maxWaitTimeMs})
					  .then(page => `opened ${page.url()}`),
			]);
			this.#log?.log(msg);
			await this.#sleep(this.#options.sleepMs?.postNavigate);
		} catch (err) {
			if (isOfType(err, 'TimeoutError')) {
				this.#log?.log('navigation timeout exceeded (will continue)');
				return;
			}
			throw err;
		}
	}

	async #processFieldsOnAllPages(): Promise<FieldElementAttrs[]> {
		const fields = [];
		for (const page of await this.#context.pages()) {
			fields.push(await this.#processFieldsRecursive(page) ?? []);
			if (this.#options.stopEarly === 'first-page-with-form' && fields.length)
				break;
		}
		return fields.flat();
	}

	async #processFieldsRecursive(page: Page): Promise<FieldElementAttrs[] | null> {
		const pageUrl = page.url();
		return this.#group(pageUrl, async () => {
			if (this.#options.skipExternal && tldts.getDomain(page.url()) !== this.#siteDomain!) {
				this.#log?.log('skipping external page');
				return null;
			}

			const submittedFrames = new Set<string>();

			const startUrl  = page.url();
			const openPages = new Set(await this.#context.pages());

			const pageFields = [];

			let done = false;
			while (!done) attempt: {
				for (const frame of page.frames().filter(frame => !submittedFrames.has(frame.url()))) {
					const {fields, done} = await (frame !== page.mainFrame()
						  ? this.#group(`frame ${getRelativeUrl(new URL(frame.url()), new URL(pageUrl))}`,
								() => this.#processFields(frame))
						  : this.#processFields(frame));
					if (done) submittedFrames.add(frame.url());  // This frame is done
					if (fields?.length) {
						pageFields.push(...fields);
						if (this.#options.fill.submit) {
							// We submitted a field, now reload the page and try other fields
							this.#events.push(new ReturnEvent(false));
							await this.#goto(page.mainFrame(), startUrl, this.#options.timeoutMs.reload);
							await closeExtraPages(this.#context, openPages);
							break attempt;
						}
					}
				}
				done = true;  // All frames are done
			}

			this.#log?.log(`processed ${pageFields.length} new fields`);
			return pageFields;
		});
	}

	/**
	 * Fill and optionally submit field(s) on a frame.
	 * For submission, only one form will be filled & submitted at a time.
	 */
	async #processFields(frame: Frame): Promise<{ fields: FieldElementAttrs[] | null, done: boolean }> {
		const frameFields = await this.#findFields(frame);
		if (!frameFields) return {fields: null, done: true};

		if (this.#options.fill.submit) {
			const fieldsByForm     = groupBy(field => field.attrs.form?.join('>>>') ?? '', frameFields);
			const fieldsByFormList = Object.entries(fieldsByForm).sort(([formA]) => formA === '' ? 1 : 0);
			for (const [lastForm, [formSelector, formFields]] of fieldsByFormList.map((e, i, l) => [i === l.length - 1, e] as const)) {
				const res = await this.#group(formSelector ? `form ${formSelector}` : 'no form', async () => {
					try {
						const field = formFields.find(field => !this.#processedFields.has(getElemIdentifier(field)));
						if (!field) return null;

						await this.#fillFields(formFields);

						await this.#sleep(this.#options.sleepMs?.postFill);

						if (this.#options.fill.addFacebookButton)
							await this.#clickFacebookButton(frame);

						this.#events.push(new SubmitEvent(field.attrs.selectorChain));
						if (await submitField(field, this.#options.sleepMs?.fill.clickDwell ?? 0, this.#log)) {
							field.attrs.submitted = true;
							await this.#waitForNavigation(field.handle.executionContext().frame()!,
								  this.#options.timeoutMs.submitField); //TODO what if parent navigates?
						}
						if (formSelector) addAll(this.#processedFields, formFields.map(getElemIdentifier));
						else this.#processedFields.add(getElemIdentifier(field));

						return {
							fields: formSelector ? formFields.map(f => f.attrs) : [field.attrs],
							done: lastForm && this.#processedFields.has(getElemIdentifier(formFields.at(-1)!)),
						};
					} catch (err) {
						this.#log?.warn('failed to process form', formSelector, err);
					}
					return null;
				});
				if (res) return res;
			}
			return {fields: [], done: true};
		} else {
			await this.#fillFields(filterUniqBy(frameFields, this.#processedFields, f => getElemIdentifier(f.attrs)));
			if (this.#options.fill.addFacebookButton) {
				await this.#clickFacebookButton(frame);
				await this.#sleep(this.#options.sleepMs?.postFacebookButtonClick);
			}
			return {fields: frameFields.map(f => f.attrs), done: true};
		}
	}

	async #findFields(frame: Frame): Promise<ElementInfo<FieldElementAttrs>[] | null> {
		if (!this.#headless) {
			// For some reason non-headless chrome does not execute code on background pages
			await getPageFromFrame(frame).bringToFront();
		}

		this.#log?.debug('finding fields');
		const url = frame.url();
		if (this.#options.skipExternal === 'frames' && tldts.getDomain(url) !== this.#siteDomain!) {
			this.#log?.log('skipping external frame');
			return null;
		}

		const fields = (await Promise.all([this.#getEmailFields(frame), await this.#getPasswordFields(frame)])).flat();
		this.#log?.log(`found ${fields.length} fields`);
		return fields;
	}

	async #getEmailFields(frame: Frame): Promise<ElementInfo<FieldElementAttrs & FathomElementAttrs>[]> {
		const emailFieldsFromFathom = await unwrapHandle(await frame.evaluateHandle(
			  () => [...window[GlobalNames.INJECTED]!.detectEmailInputs(document.documentElement)]));
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

	async #fillFields(fields: ElementInfo<FieldElementAttrs>[]) {
		this.#log?.log(`filling ${fields.length} fields`);
		const fillTimes = this.#options.sleepMs?.fill ?? {clickDwell: 0, keyDwell: 0, betweenKeys: 0};
		for (const field of fields.filter(f => !f.attrs.filled)) {
			this.#events.push(new FillEvent(field.attrs.selectorChain));
			await this.#injectPasswordLeakDetection(field.handle.executionContext().frame()!);
			switch (field.attrs.fieldType) {
				case 'email':
					await fillEmailField(field, this.#initialUrl.hostname, this.#options.fill.emailBase, fillTimes, this.#log);
					break;
				case 'password':
					await fillPasswordField(field, this.#options.fill.password, fillTimes, this.#log);
					break;
				default:
					throw new UnreachableCaseError(field.attrs.fieldType);
			}
			field.attrs.filled = true;
		}
	}

	async #injectPasswordLeakDetection(frame: Frame) {
		try {
			const page = getPageFromFrame(frame);
			if (tryAdd(this.#injectedPasswordCallback, page))
				await exposeFunction(page, GlobalNames.PASSWORD_CALLBACK, this.#passwordObserverCallback.bind(this, frame));

			const didInject = await frame.evaluate((password: string) => {
				if (window[GlobalNames.PASSWORD_OBSERVED]) return false;
				window[GlobalNames.PASSWORD_OBSERVED] = true;

				const observer = new MutationObserver(mutations => {
					try {
						for (const m of mutations)
							for (const node of m.addedNodes)
								inspectRecursive(node, true);

						const leakSelectors = mutations
							  .filter(m => m.attributeName && m.target instanceof Element &&
									m.target.getAttribute(m.attributeName)?.includes(password))
							  .map(m => ({
								  selector: window[GlobalNames.INJECTED]!.formSelectorChain(m.target as Element),
								  attribute: m.attributeName!,
							  }));
						if (leakSelectors.length)
							void window[GlobalNames.PASSWORD_CALLBACK]!(leakSelectors);
					} catch (err) {
						window[GlobalNames.ERROR_CALLBACK]!(String(err), err instanceof Error && err.stack || Error().stack!);
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
									  selector: window[GlobalNames.INJECTED]!.formSelectorChain(node),
									  attribute: attr.name,
								  }));
							if (leakSelectors.length)
								void window[GlobalNames.PASSWORD_CALLBACK]!(leakSelectors);
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
						window[GlobalNames.ERROR_CALLBACK]!(String(err), err instanceof Error && err.stack || Error().stack!);
					}
					return shadow;
				};

				inspectRecursive(document, false);
				return true;
			}, this.#options.fill.password);

			if (didInject) this.#log?.debug('injected password leak detection');
		} catch (err) {
			this.#log?.error('failed to inject password leak detection on', frame.url(), err);
		}
	}

	async #passwordObserverCallback(frame: Frame, leaks: PagePasswordLeak[]) {
		this.#log?.info(`password leaked on ${frame.url()} to attributes: ${leaks.map(l => `${l.selector.join('>>>')} @${l.attribute}`).join(', ')}`);
		this.#passwordLeaks.push(...await Promise.all(leaks.map(async leak => {
			let attrs;
			try {
				const handle = (await getElementBySelectorChain(leak.selector, frame))?.elem;
				if (handle) attrs = await getElementAttrs(handle);
			} catch (err) {
				this.#log?.warn('failed to get attributes for password field', leak.selector.join('>>>'), err);
			}
			const fullLeak: PasswordLeak = {
				time: Date.now(),
				...leak,
			};
			if (attrs) fullLeak.attrs = attrs;
			else fullLeak.frameStack = getFrameStack(frame).map(f => f.url());
			return fullLeak;
		})));
	}

	async #clickFacebookButton(frame: Frame) {
		this.#log?.log('adding and clicking button for Facebook detection');
		this.#events.push(new FacebookButtonEvent());
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
	}

	#errorCallback(message: string, stack: string) {
		this.#log?.error('error in background page script:', message, stack);
	}

	async #sleep(ms: number | undefined): Promise<void> {
		if (ms) {
			this.#log?.debug('💤');
			return new Promise(resolve => setTimeout(resolve, ms));
		}
	}
}

// noinspection JSClassNamingConvention
type integer = number;

// For some reason @puppeteer/replay doesn't export this
/** &#64;puppeteer/replay (Chrome DevTools) flow */
type PuppeteerReplayUserFlow = Parameters<typeof createRunner>[0];

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
		/** Field fill-related delays */
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
		};
	} | null;
	/**
	 * Whether to skip external sites.
	 * Specify "pages" to only look at top-level URLs.
	 * @default "frames"
	 */
	skipExternal?: 'frames' | 'pages' | false;
	/** Maximum number of links to click on the landing page, can be 0
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
		/** Email address to fill in ("domainname+" is prepended to this) */
		emailBase?: string;
		/** Password to fill in */
		password?: string;
		/** Try to submit forms?
		 * @default true */
		submit?: boolean;
		/** Add and click a dummy button to detect Facebook leaks
		 * @default true */
		addFacebookButton?: boolean;
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
}

type FullFieldsCollectorOptions = DeepRequired<Omit<FieldsCollectorOptions, 'interactChains'>>
	  & Required<Pick<FieldsCollectorOptions, 'interactChains'>>;

const defaultOptions: FullFieldsCollectorOptions = {
	timeoutMs: {
		reload: 2_500,
		followLink: 5_000,
		submitField: 2_500,
	},
	sleepMs: {
		postFill: 5_000,
		postFacebookButtonClick: 1_000,
		postNavigate: 1_000,
		fill: {
			clickDwell: 100,
			keyDwell: 100,
			betweenKeys: 250,
		},
	},
	clickLinkCount: 10,
	skipExternal: 'frames',
	stopEarly: false,
	fill: {
		emailBase: 'x@example.com',
		password: 'P@s5w0rd!',
		submit: true,
		addFacebookButton: true,
	},
	disableClosedShadowDom: true,
	interactChains: [],
};

export interface PagePasswordLeak {
	selector: SelectorChain;
	attribute: string;
}

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

// noinspection JSUnusedGlobalSymbols
export abstract class FieldCollectorEvent {
	protected constructor(public readonly type: string, public readonly time = Date.now()) {}
}

// noinspection JSUnusedGlobalSymbols
export class FillEvent extends FieldCollectorEvent {
	constructor(public readonly field: SelectorChain) {
		super('fill');
	}
}

// noinspection JSUnusedGlobalSymbols
export class SubmitEvent extends FieldCollectorEvent {
	constructor(public readonly field: SelectorChain) {
		super('submit');
	}
}

export class FacebookButtonEvent extends FieldCollectorEvent {
	constructor() {
		super('fb-button');
	}
}

export class ReturnEvent extends FieldCollectorEvent {
	/**
	 * @param toLanding Return to landing page after examining a page for a link?
	 */
	constructor(public readonly toLanding: boolean) {
		super('return');
	}
}

// noinspection JSUnusedGlobalSymbols
export class ClickLinkEvent extends FieldCollectorEvent {
	constructor(public readonly link: SelectorChain, public readonly linkType: 'auto' | 'manual') {
		super('link');
	}
}

export type FieldCollectorData = Record<string, never> | {
	/** Similar to what {@link import('tracker-radar-collector').TargetCollector} does but with timestamps */
	visitedTargets: VisitedTarget[],
	fields: FieldElementAttrs[],
	/** `null` on fail */
	links: LinkElementAttrs[] | null,
	passwordLeaks: PasswordLeak[],
	events: FieldCollectorEvent[],
};

declare global {
	// noinspection JSUnusedGlobalSymbols
	interface Window {
		[GlobalNames.INJECTED]?: typeof import('leak-detect-inject');
		[GlobalNames.PASSWORD_OBSERVED]?: boolean;
		[GlobalNames.PASSWORD_CALLBACK]?: (leaks: PagePasswordLeak[]) => void;
		[GlobalNames.ERROR_CALLBACK]?: (message: string, stack: string) => void;
	}
}
