import fs from 'node:fs';

import {BrowserContext, Frame, Page} from 'puppeteer';
import {groupBy} from 'ramda';
import * as tldts from 'tldts';
import {BaseCollector, TargetCollector} from 'tracker-radar-collector';
import {DeepPartial, UnreachableCaseError} from 'ts-essentials';

import {SelectorChain} from 'leak-detect-inject';
import {addAll, filterUniqBy, formatDuration, getRelativeUrl, populateDefaults, tryAdd} from './utils';
import {Logger, TaggedLogger} from './logger';
import {fillEmailField, fillPasswordField, submitField} from './formInteraction';
import {
	closeExtraPages,
	ElementAttrs,
	ElementInfo,
	FathomElementAttrs,
	FieldElementAttrs,
	getElementAttrs,
	getElementBySelectorChain,
	getElementInfoFromAttrs,
	getElemIdentifier,
	LinkElementAttrs,
	LinkMatchType,
} from './pageUtils';
import {getLoginLinks} from './loginLinks';
import {
	evaluate,
	evaluateHandle,
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
	static #injectSrc: string;

	#options: FieldsCollectorOptions;
	#log?: Logger;
	#dataParams!: Parameters<typeof BaseCollector.prototype.getData>[0];
	#initialUrl!: URL;
	#context!: BrowserContext;
	#headless                  = true;
	#siteDomain: string | null = null;

	#page!: Page;
	#injectedPasswordCallback = new Set<Page>();
	#injectedErrorCallback    = new Set<Page>();

	#events: FieldCollectorEvent[]   = [];
	#processedFields                 = new Set<string>();
	#passwordLeaks: PasswordLeak[]   = [];
	#visitedTargets: VisitedTarget[] = [];

	constructor(options?: DeepPartial<FieldsCollectorOptions>, logger?: Logger) {
		super();
		this.#options = populateDefaults<FieldsCollectorOptions>(options ?? {}, defaultOptions);

		FieldsCollector.#loadInjectScript();
		this.#log = logger;
	}

	static #loadInjectScript() {
		FieldsCollector.#injectSrc ||= (() => {
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
			return fs.readFileSync('./inject/dist/bundle.js', 'utf8');
		})();
	}

	//TODO use `Page#evaluateOnNewDocument` instead for injections?
	static async #injectPageScript(frame: Frame) {
		await frame.evaluate(`void (
			window["${GlobalNames.INJECTED}"] ??= (() => {
				${FieldsCollector.#injectSrc};
				return leakDetectToBeInjected;
			})())`);
	}

	override id() { return 'fields' as const; }

	override init({log, url, context}: BaseCollector.CollectorInitOptions) {
		this.#log ??= new TaggedLogger(log);
		this.#context    = context;
		this.#headless   = context.browser().process()?.spawnargs.includes('--headless') ?? true;
		this.#initialUrl = url;
		this.#siteDomain = tldts.getDomain(url.href);

		this.#page                     = undefined!;  // Initialized in addTarget
		this.#injectedPasswordCallback = new Set();
		this.#injectedErrorCallback    = new Set();
		this.#processedFields          = new Set();

		this.#events         = [];
		this.#passwordLeaks  = [];
		this.#visitedTargets = [];
	}

	override async addTarget({url, type}: Parameters<typeof BaseCollector.prototype.addTarget>[0]) {
		if (!this.#page && type === 'page') this.#page = (await this.#context.pages())[0];  // Take first page
		this.#visitedTargets.push({time: Date.now(), type, url});  // Save other targets as well
	}

	override async getData(options: Parameters<typeof BaseCollector.prototype.getData>[0]): Promise<FieldCollectorData> {
		this.#dataParams = options;

		if (this.#siteDomain === null && this.#initialUrl?.hostname !== 'localhost') {
			this.#log?.warn('URL has no domain with public suffix, will skip this page');
			return {};
		}

		// Search for fields on the landing page(s)
		const fields = await this.#processFieldsOnAllPages();

		// Search for fields on linked pages
		let links = null;
		if (this.#options.clickLinkCount) try {
			await FieldsCollector.#injectPageScript(this.#page.mainFrame());
			links = (await getLoginLinks(this.#page.mainFrame(), new Set(['exact', 'loose', 'coords'])))
				  .map(info => info.attrs);

			const matchTypeCounts = links.reduce((acc, attrs) =>
				  acc.set(attrs.linkMatchType, (acc.get(attrs.linkMatchType) ?? 0) + 1), new Map<LinkMatchType, number>());

			this.#log?.debug(`found ${links.length} login/register links on the landing page`, matchTypeCounts);

			if (links.length > this.#options.clickLinkCount)
				this.#log?.log(`skipping last ${links.length - this.#options.clickLinkCount} links`);

			links = links.slice(0, this.#options.clickLinkCount);
			for (const link of links)
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
		this.#events.push(new ClickLinkEvent(link.selectorChain));
		const page = this.#page;
		await FieldsCollector.#injectPageScript(page.mainFrame());
		const linkInfo = await getElementInfoFromAttrs(link, page.mainFrame());
		if (!linkInfo) throw new Error('could not find link element anymore');
		if (await this.#click(linkInfo))
			await this.#waitForNavigation(page.mainFrame(), this.#options.timeoutMs.followLink);
	}

	async #goto(frame: Frame, url: string, minTimeoutMs: number) {
		const maxWaitTimeMs = Math.max(minTimeoutMs,
			  this.#dataParams.pageLoadDurationMs * 2);

		this.#log?.log(frame.url() === url ? 'will reload' : `will navigate ${frame.url()} → ${url}`);
		await getPageFromFrame(frame).bringToFront();
		try {
			await frame.goto(url, {timeout: maxWaitTimeMs, waitUntil: 'load'});
			this.#log?.debug('💤');
			await frame.waitForTimeout(this.#options.sleepMs?.postNavigate ?? 0);
		} catch (err) {
			if (isOfType(err, 'TimeoutError')) {
				this.#log?.log('navigation timeout exceeded (will continue)');
				return;
			}
			throw err;
		}
	}

	async #click(link: ElementInfo): Promise<boolean> {
		await getPageFromHandle(link.handle)!.bringToFront();
		// Note: the alternative `ElementHandle#click` can miss if the element moves or if it is covered
		const success = await evaluate(link.handle, el => {
			if (el instanceof HTMLElement) {
				el.scrollIntoView({behavior: 'smooth', block: 'end', inline: 'end'});
				el.click();
				return true;
			} else return false;
		});
		//TODO Could call `dispatchEvent` with a `click` `PointerEvent`, but tricky to get the same result
		if (!success) this.#log?.warn('link is not an HTMLElement');
		return success;
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
			this.#log?.debug('💤');
			await frame.waitForTimeout(this.#options.sleepMs?.postNavigate ?? 0);
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
		for (const page of await this.#context.pages())
			fields.push(await this.#processFieldsRecursive(page) ?? []);
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
					const {fields, done} = await (frame.url() !== page.url()
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

						this.#log?.debug('💤');
						await frame.waitForTimeout(this.#options.sleepMs?.postFill ?? 0);

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
				this.#log?.debug('💤');
				await frame.waitForTimeout(this.#options.sleepMs?.postFacebookButtonClick ?? 0);
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

		await FieldsCollector.#injectPageScript(frame);

		const fields = (await Promise.all([this.#getEmailFields(frame), await this.#getPasswordFields(frame)])).flat();
		this.#log?.log(`found ${fields.length} fields`);
		return fields;
	}

	async #getEmailFields(frame: Frame): Promise<ElementInfo<FieldElementAttrs & FathomElementAttrs>[]> {
		const emailFieldsFromFathom = await unwrapHandle(await evaluateHandle(frame,
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
		const elHandles = await frame.$$<HTMLInputElement>('pierce/input[type=password]');
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
			await this.#injectErrorCallback(page);
			if (tryAdd(this.#injectedPasswordCallback, page))
				await exposeFunction(page, GlobalNames.PASSWORD_CALLBACK, this.#passwordObserverCallback.bind(this, frame));

			const didInject = await evaluate(frame, (password: string) => {
				if (window[GlobalNames.PASSWORD_OBSERVED]) return false;
				window[GlobalNames.PASSWORD_OBSERVED] = true;

				const observer = new MutationObserver(mutations => {
					try {
						for (const m of mutations)
							for (const node of m.addedNodes)
								observeRecursive(node);

						const leakSelectors = mutations
							  .filter(m => m.attributeName && m.target instanceof Element &&
									m.target.getAttribute(m.attributeName)?.includes(password))
							  .map(m => ({
								  selector: window[GlobalNames.INJECTED]!.formSelectorChain(m.target as Element),
								  attribute: m.attributeName!,
							  })); //TODO what if elem removed immediately
						if (leakSelectors.length)
							void window[GlobalNames.PASSWORD_CALLBACK]!(leakSelectors);
					} catch (err) {
						window[GlobalNames.ERROR_CALLBACK]!(String(err), err instanceof Error ? err.stack! : new Error().stack!);
					}
				});

				function observeRecursive(node: Node) {
					if ([Node.DOCUMENT_NODE, Node.DOCUMENT_FRAGMENT_NODE].includes(node.nodeType))
						observer.observe(node, {subtree: true, attributes: true, childList: true});
					if (node instanceof Element && node.shadowRoot) //TODO what if shadow attach after elem added?
						observeRecursive(node.shadowRoot);
					for (const child of node.childNodes)
						observeRecursive(child);
				}

				observeRecursive(document);
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
			return {
				time: Date.now(),
				frameStack: !attrs ? getFrameStack(frame).map(f => f.url()) : undefined,
				attrs,
				...leak,
			};
		})));
	}

	async #clickFacebookButton(frame: Frame) {
		this.#log?.log('adding and clicking button for Facebook detection');
		this.#events.push(new FacebookButtonEvent());
		await evaluate(frame, () => {
			const btn          = document.createElement('button');
			btn.className      = 'leak-detect-btn button';
			btn.textContent    = 'button';
			btn.style.position = 'fixed';
			btn.style.top      = btn.style.left = '0';
			document.body.append(btn);
			btn.click();
		});
	}

	async #injectErrorCallback(page: Page) {
		if (tryAdd(this.#injectedErrorCallback, page))
			await exposeFunction(page, GlobalNames.ERROR_CALLBACK, this.#errorCallback.bind(this));
	}

	#errorCallback(message: string, stack: string) {
		this.#log?.error('error in background page script', message, stack);
	}
}

type integer = number;

export interface FieldsCollectorOptions {
	/** Timeouts in milliseconds */
	timeoutMs: {
		/** Page reload timeout (e.g. after submit)
		 * @minimum 0 */
		reload: number;
		/** Timeout waiting for navigation after following a link
		 * @minimum 0 */
		followLink: number;
		/** Timeout waiting for navigation after submitting a field
		 * @minimum 0 */
		submitField: number;
	};
	/** Intentional delays in milliseconds, or `null` to disable all delays */
	sleepMs: {
		/** Delay after filling some fields (in a form)
		 * @minimum 0 */
		postFill: number;
		/** Delay after adding & clicking Facebook button
		 * @minimum 0 */
		postFacebookButtonClick: number;
		/** Delay after navigating to some page
		 * @minimum 0 */
		postNavigate: number;
		/** Field fill-related delays */
		fill: {
			/** Time between mouse down & mouse up when clicking a field
			 * @minimum 0 */
			clickDwell: number;
			/** Maximum time between key down & key up when typing in a field
			 * @minimum 0 */
			keyDwell: number;
			/** Maximum time between keystrokes when typing in a field
			 * @minimum 0 */
			betweenKeys: number;
		};
	} | null;
	/**
	 * Whether to skip external sites.
	 * Specify `"pages"` to only look at top-level URLs.
	 * @default "frames"
	 */
	skipExternal: 'frames' | 'pages' | false;
	/** Maximum number of links to click on the landing page, can be 0
	 * @minimum 0 */
	clickLinkCount: integer;
	/** Field fill-related settings */
	fill: {
		/** Email address to fill in (`domainname+` is prepended to this) */
		emailBase: string;
		/** Password to fill in */
		password: string;
		/** Try to submit forms?
		 * @default true */
		submit: boolean;
		/** Add and click a dummy button to detect Facebook leaks
		 * @default true */
		addFacebookButton: boolean;
	};
}

const defaultOptions: FieldsCollectorOptions = {
	timeoutMs: {
		reload: 2_500,
		followLink: 2_500,
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
	fill: {
		emailBase: 'x@example.com',
		password: 'P@s5w0rd!',
		submit: true,
		addFacebookButton: true,
	},
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
	constructor(public readonly link: SelectorChain) {
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
