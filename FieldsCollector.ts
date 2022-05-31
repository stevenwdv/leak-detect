import fs from 'fs';
import * as forms from './formInteraction';
import {submitField} from './formInteraction';
import * as tldts from 'tldts';
import {BaseCollector, TargetCollector} from 'tracker-radar-collector';
import {BrowserContext, ElementHandle, Frame, JSHandle, Page} from 'puppeteer';
import {Logger, TaggedLogger} from './logger';
import {
	ElementAttrs,
	ElementInfo,
	FathomElementAttrs,
	FieldElementAttrs,
	filterUniqBy,
	getElementAttrs,
	getElementBySelectorChain,
	getElementInfoFromAttrs,
	getFrameStack,
	getLoginLinks,
	getPageFromFrame,
	getPageFromHandle,
	isOfType,
	LinkElementAttrs,
	LinkMatchType,
	OmitFirstParameter,
	stripHash,
	tryAdd,
	unwrapHandle,
} from './utils';
import {performance} from 'perf_hooks';
import {UnreachableCaseError} from 'ts-essentials';
import {FathomResult, SelectorChain} from 'leak-detect-inject';
import ErrnoException = NodeJS.ErrnoException;

let injectSrc: string;
try {
	injectSrc = fs.readFileSync('./inject/dist/bundle.js', 'utf8');
} catch (err) {
	if ((err as ErrnoException).code === 'ENOENT')
		console.error('Bundle to inject not found, run `npm run pack` in the `inject` folder');
	throw err;
}

export const NO_DELAYS = false;

const SLEEP_AFTER_SINGLE_FILL  = NO_DELAYS ? 0 : 500;
const SLEEP_AFTER_FILL         = NO_DELAYS ? 0 : 5_000;
const MAX_RELOAD_TIME          = NO_DELAYS ? 0 : 30_000;
const EMAIL_ADDRESS            = 'stuff@example.com';
const PASSWORD                 = 'P@ssw0rd!';
const SKIP_EXTERNAL_LINKS      = true;
const NUM_LINKS_TO_CLICK       = 10;
const POST_LANDING_RELOAD_WAIT = NO_DELAYS ? 0 : 1_000;
const POST_CLICK_LOAD_TIMEOUT  = NO_DELAYS ? 0 : 2_500;

// This is a const enum such that the TypeScript transpiler replaces names with values in the page scripts
export const enum GlobalNames {
	INJECTED          = 'leakDetectInjected',
	PASSWORD_OBSERVED = 'leakDetectPasswordObserved',
	PASSWORD_CALLBACK = 'leakDetectPasswordObserverCallback',
	ERROR_CALLBACK    = 'leakDetectError',
}

export class FieldsCollector extends BaseCollector {
	#log?: Logger;
	#options?: Parameters<typeof BaseCollector.prototype.getData>[0];
	#initialUrl?: URL;
	#context?: BrowserContext;
	#headless                  = true;
	#siteDomain: string | null = null;

	#page?: Page;
	#injectedPasswordCallback = new Set<Page>();
	#injectedErrorCallback    = new Set<Page>();

	#passwordLeaks: PasswordLeak[]   = [];
	#visitedTargets: VisitedTarget[] = [];

	constructor(logger?: Logger) {
		super();
		this.#log = logger;
	}

	override id() {
		return 'fields';
	}

	override init({log, url, context}: BaseCollector.CollectorInitOptions) {
		this.#log ??= new TaggedLogger(log);
		this.#context    = context;
		this.#headless   = context.browser().process()?.spawnargs.includes('--headless') ?? true;
		this.#initialUrl = url;
		this.#siteDomain = tldts.getDomain(url.href);
	}

	override async addTarget({url, type}: Parameters<typeof BaseCollector.prototype.addTarget>[0]) {
		if (!this.#page && type === 'page') this.#page = (await this.#context!.pages())[0];
		this.#visitedTargets.push({time: Date.now(), type, url});
	}

	override async getData(options: Parameters<typeof BaseCollector.prototype.getData>[0]): Promise<FieldCollectorData> {
		this.#options = options;

		this.#log?.info(`getData ${options.finalUrl}`);

		if (this.#siteDomain === null && this.#initialUrl?.hostname !== 'localhost') {
			this.#log?.warn('URL has no domain with public suffix, will skip this page');
			return {};
		}

		/** Get a string which should uniquely identify an element across pages  */
		function getElemIdentifier(elem: ElementAttrs): string {
			return `${stripHash(elem.frameStack[0])} ${elem.selectorChain.join('>>>')}`;
		}

		const landingPage   = this.#page!;
		// Search for fields on the landing page(s)
		const fieldsLanding = await this.findFieldsOnAllPages();
		this.#log?.log(`found ${fieldsLanding.length} total fields on landing page(s) ${landingPage.url()}`);
		const fields      = fieldsLanding.map(f => f.attrs);
		const foundFields = new Set<string>();
		for (const field of fieldsLanding) foundFields.add(getElemIdentifier(field.attrs));

		await this.fillFields(fieldsLanding);
		this.#log?.debug('sleeping');
		await landingPage.waitForTimeout(SLEEP_AFTER_FILL);

		this.#log?.debug('submitting fields');
		await this.submitFields(fieldsLanding);

		let links = null;

		// Search for fields on linked pages
		try {
			links = (await getLoginLinks(landingPage.mainFrame(), new Set(['exact', 'loose', 'coords'])))
				  .map(info => info.attrs);

			const matchTypeCounts = links.reduce((acc, attrs) =>
				  acc.set(attrs.linkMatchType, (acc.get(attrs.linkMatchType) ?? 0) + 1), new Map<LinkMatchType, number>());

			this.#log?.debug(`found ${links.length} login/register links on the landing page`, matchTypeCounts);

			if (links.length > NUM_LINKS_TO_CLICK)
				this.#log?.debug(`skipping last ${links.length - NUM_LINKS_TO_CLICK} links`);

			for (const [i, link] of links.slice(0, NUM_LINKS_TO_CLICK).entries())
				try {
					if (SKIP_EXTERNAL_LINKS && link.href &&
						  tldts.getDomain(new URL(link.href, this.#options.finalUrl).href) !== this.#siteDomain) {
						this.#log?.debug(`skip external link: ${link.href}`);
						continue;
					}

					if (i) await this.goToLandingPage();
					await this.closeExtraPages();

					this.#log?.debug(`will follow link: ${JSON.stringify(link)}`);
					await this.followLink(link);
					const fieldsSub = filterUniqBy(await this.findFieldsOnAllPages(), foundFields, field => getElemIdentifier(field.attrs));
					this.#log?.log(`found ${fieldsSub.length} new fields on sub pages for link ${link.href ?? JSON.stringify(link)}`);
					fields.push(...fieldsSub.map(f => f.attrs));

					if (fieldsSub.length) {
						this.#log?.debug(`will fill fields for link ${link.href ?? JSON.stringify(link)}`);
						await this.fillFields(fieldsSub);
						this.#log?.debug('sleeping');
						await landingPage.waitForTimeout(SLEEP_AFTER_FILL);

						this.#log?.debug(`will submit fields for link ${link.href ?? JSON.stringify(link)}`);
						await this.submitFields(fieldsSub);
					}
				} catch (err) {
					this.#log?.warn(`failed to inspect linked page for link ${JSON.stringify(link)}`, err);
				}
		} catch (err) {
			this.#log?.error('failed to inspect linked pages', err);
		}

		return {
			visitedTargets: this.#visitedTargets,
			fields: fields,
			loginRegisterLinksDetails: links,
			passwordLeaks: this.#passwordLeaks,
		};
	}

	async closeExtraPages() {
		return Promise.all((await this.#context!.pages())
			  .filter(page => page !== this.#page)
			  .map(page => page.close({runBeforeUnload: false})));
	}

	async followLink(link: ElementAttrs): Promise<void> {
		const page         = this.#page!;
		const preClickUrl  = page.url();
		const prevNumPages = (await this.#context!.pages()).length;
		await this.injectPageScript(page.mainFrame());
		const linkInfo = await getElementInfoFromAttrs(link, page.mainFrame());
		if (!linkInfo) throw new Error('Could not find link element anymore');
		if (await this.click(linkInfo))
			await this.waitForNavigation();

		this.#log?.debug(`navigated ${preClickUrl} -> ${page.url()}; ${
			  (await this.#context!.pages()).length - prevNumPages} new pages created`);
	}

	async goToLandingPage() {
		const landingPage = this.#page!;
		await landingPage.bringToFront();
		const pageUrl = landingPage.url();
		this.#log?.debug(`will return to landing page ${pageUrl} -> ${this.#options!.finalUrl}`);
		try {
			await landingPage.goto(this.#options!.finalUrl, {'timeout': MAX_RELOAD_TIME, 'waitUntil': 'load'});
			this.#log?.debug('sleeping');
			await landingPage.waitForTimeout(POST_LANDING_RELOAD_WAIT);
		} catch (error) {
			this.#log?.debug('error while returning to landing page', error);
		}
	}

	async click(link: ElementInfo) {
		await getPageFromHandle(link.handle)!.bringToFront();
		// Note: the alternative `ElementHandle#click` can miss if the element moves or if it is covered
		const success = await link.handle.evaluate(el => {
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

	async waitForNavigation() {
		const maxWaitTimeMs = Math.max(
			  this.#options!.pageLoadDurationMs * 2,
			  POST_CLICK_LOAD_TIMEOUT);

		//TODO also wait until new page opened? (maybe #context.waitForTarget)
		const page = this.#page!;
		this.#log?.debug('waiting for navigation');

		const startTime = performance.now();
		try {
			await page.waitForNavigation({timeout: maxWaitTimeMs, waitUntil: 'load'});
		} catch (err) {
			if (isOfType(err, 'TimeoutError')) {
				this.#log?.debug('navigation timeout exceeded (but maybe the link did trigger a popup or something)');
				return;
			}
			throw err;
		}
		const endTime = performance.now();
		this.#log?.debug(`navigated in ${((endTime - startTime) / 1e3).toFixed(2)}s to ${page.url()}`);
		this.#log?.debug('sleeping');
		await page.waitForTimeout(maxWaitTimeMs);
	}

	async findFieldsOnAllPages(): Promise<ElementInfo<FieldElementAttrs>[]> {
		if (this.#headless)
			return (await Promise.all((await this.#context!.pages())
				  .map(async page => await this.findFieldsRecursive(page) ?? []))).flat();
		else {
			const fields = [];
			// Execute one-by-one such that we can bring pages to front
			for (const page of await this.#context!.pages())
				fields.push(...await this.findFieldsRecursive(page) ?? []);
			return fields;
		}
	}

	async findFieldsRecursive(page: Page): Promise<ElementInfo<FieldElementAttrs>[]> {
		return (await Promise.all(
			  page.frames()
					.filter(frame => !frame.isDetached())
					.map(async frame => await this.findFields(frame) ?? []))).flat();
	}

	async findFields(frame: Frame): Promise<ElementInfo<FieldElementAttrs>[] | null> {
		if (!this.#headless) {
			// For some reason non-headless chrome does not execute code on background pages
			await getPageFromFrame(frame).bringToFront();
		}

		this.#log?.debug(`searching for fields on frame ${frame.url()} on ${getPageFromFrame(frame).url()}`);
		const url    = frame.url();
		const domain = tldts.getDomain(url);
		if (SKIP_EXTERNAL_LINKS && domain !== this.#siteDomain!) {
			this.#log?.debug(`off-domain navigation. Will not search for email/password fields on ${url}`);
			return null;
		}

		await this.injectPageScript(frame);

		const fields = (await Promise.all([this.getEmailFields(frame), await this.getPasswordFields(frame)])).flat();
		this.#log?.debug(`found ${fields.length} fields on ${url}`);
		return fields;
	}

	async getEmailFields(frame: Frame): Promise<ElementInfo<FieldElementAttrs & FathomElementAttrs>[]> {
		const emailFieldsFromFathom =
			        await unwrapHandle(await frame.evaluateHandle<JSHandle<FathomResult[]>>(
					      () => [...window[GlobalNames.INJECTED]!.detectEmailInputs(document.documentElement)]));
		return Promise.all(emailFieldsFromFathom.map(async field => ({
			handle: field.elem,
			attrs: {
				...await getElementAttrs(field.elem),
				score: field.score,
				fieldType: 'email',
			},
		})));
	}

	async getPasswordFields(frame: Frame): Promise<ElementInfo<FieldElementAttrs>[]> {
		const elHandles = await this.getPasswordFieldHandles(frame);
		return Promise.all(elHandles.map(async handle => ({
			handle,
			attrs: {
				...await getElementAttrs(handle),
				fieldType: 'password',
			},
		})));
	}

	async getPasswordFieldHandles(frame: Frame): Promise<ElementHandle[]> {
		return await Promise.all((await frame.$$<HTMLInputElement>('pierce/input[type=password]'))
			  .filter(inp => inp.evaluate(inp => window[GlobalNames.INJECTED]!.isVisible(inp))));
	}

	async fillFields(fields: ElementInfo<FieldElementAttrs>[]) {
		for (const field of fields.filter(f => !f.attrs.filled)) {
			await this.injectPasswordLeakDetection(field.handle.executionContext().frame()!);
			switch (field.attrs.fieldType) {
				case 'email':
					await forms.fillEmailField(field, this.#initialUrl!.hostname, EMAIL_ADDRESS, this.#log);
					break;
				case 'password':
					await forms.fillPasswordField(field, PASSWORD, this.#log);
					break;
				default:
					throw new UnreachableCaseError(field.attrs.fieldType);
			}
			field.attrs.filled = true;
			this.#log?.debug('sleeping');
			await this.#page?.waitForTimeout(SLEEP_AFTER_SINGLE_FILL);
		}
	}

	async submitFields(fields: ElementInfo[]) {
		const submittedForms = new Set<string>();
		for (const elem of fields) {
			try {
				const page = getPageFromHandle(elem.handle)!;
				//TODO reload page & re-fill fields
				await page.bringToFront();
				const formSelector = await elem.handle.evaluate(elem => {
					const form = (elem as Element & { form?: HTMLFormElement | null }).form;
					return form ? window[GlobalNames.INJECTED]!.formSelectorChain(form) : null;
				});
				if (formSelector && !tryAdd(submittedForms, formSelector.join('>>>')))
					continue;
				if (await submitField(elem))
					await this.waitForNavigation();
			} catch (err) {
				this.#log?.warn(`failed to submit field ${JSON.stringify(elem.attrs)}`, err);
			}
		}
	}

	async injectPageScript(frame: Frame) {
		await frame.evaluate(`void (
			window["${GlobalNames.INJECTED}"] ??= (() => {
				${injectSrc};
				return leakDetectToBeInjected;
			})())`);
	}

	async injectPasswordLeakDetection(frame: Frame) {
		try {
			const page = getPageFromFrame(frame);
			await this.injectErrorCallback(page);
			if (tryAdd(this.#injectedPasswordCallback, page))
				await this.exposeFunction(page, GlobalNames.PASSWORD_CALLBACK, this.passwordObserverCallback.bind(this, frame));

			await frame.evaluate((password: string) => {
				if (window[GlobalNames.PASSWORD_OBSERVED]) return;
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
					if (node instanceof Element && node.shadowRoot)
						observeRecursive(node.shadowRoot);
					for (const child of node.childNodes)
						observeRecursive(child);
				}

				observeRecursive(document);
			}, PASSWORD);
		} catch (err) {
			this.#log?.error(`failed to inject password leak detection on ${frame.url()}`, err);
		}
	}

	async passwordObserverCallback(frame: Frame, leaks: PagePasswordLeak[]) {
		this.#log?.info(`password leaked on ${frame.url()} to attributes: ${leaks.map(l => `${l.selector.join('>>>')} @${l.attribute}`).join(', ')}`);
		this.#passwordLeaks.push(...await Promise.all(leaks.map(async leak => {
			let attrs;
			try {
				const handle = (await getElementBySelectorChain(leak.selector, frame))?.elem;
				if (handle) attrs = await getElementAttrs(handle);
			} catch (err) {
				this.#log?.warn(`failed to get attributes for password field ${leak.selector.join('>>>')}`, err);
			}
			return {
				time: Date.now(),
				frameStack: !attrs ? getFrameStack(frame).map(f => f.url()) : undefined,
				attrs,
				...leak,
			};
		})));
	}

	async injectErrorCallback(page: Page) {
		if (tryAdd(this.#injectedErrorCallback, page))
			await this.exposeFunction(page, GlobalNames.ERROR_CALLBACK, this.errorCallback.bind(this));
	}

	errorCallback(message: string, stack: string) {
		this.#log?.error('Error in background page script', message, stack);
	}

	async exposeFunction<Name extends keyof Window & string, Func extends typeof window[Name]>(page: Page, name: Name, func: Func) {
		await page.exposeFunction(name, func);
	}
}

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

export type FieldCollectorData = Record<string, never> | {
	visitedTargets: VisitedTarget[],
	fields: FieldElementAttrs[],
	/** `null` on fail */
	loginRegisterLinksDetails: LinkElementAttrs[] | null,
	passwordLeaks: PasswordLeak[],
};

declare global {
	// noinspection JSUnusedGlobalSymbols
	interface Window {
		[GlobalNames.INJECTED]?: typeof import('leak-detect-inject');
		[GlobalNames.PASSWORD_OBSERVED]?: boolean;
		[GlobalNames.PASSWORD_CALLBACK]?: OmitFirstParameter<OmitThisParameter<typeof FieldsCollector.prototype.passwordObserverCallback>>;
		[GlobalNames.ERROR_CALLBACK]?: OmitThisParameter<typeof FieldsCollector.prototype.errorCallback>;
	}
}
