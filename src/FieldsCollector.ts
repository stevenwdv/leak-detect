import fs from 'node:fs';

import {BrowserContext, ElementHandle, Frame, Page} from 'puppeteer';
import {groupBy} from 'ramda';
import tldts from 'tldts';
import {BaseCollector, TargetCollector} from 'tracker-radar-collector';
import {UnreachableCaseError} from 'ts-essentials';

import {SelectorChain} from 'leak-detect-inject';
import {addAll, OmitFirstParameter, tryAdd} from './utils';
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
	#options!: Parameters<typeof BaseCollector.prototype.getData>[0];
	#initialUrl!: URL;
	#context!: BrowserContext;
	#headless                  = true;
	#siteDomain: string | null = null;

	#page!: Page;
	#injectedPasswordCallback = new Set<Page>();
	#injectedErrorCallback    = new Set<Page>();
	#submittedFields          = new Set<string>();

	#passwordLeaks: PasswordLeak[]   = [];
	#visitedTargets: VisitedTarget[] = [];

	constructor(logger?: Logger) {
		super();
		this.#log = logger;
	}

	override id() {
		return 'fields' as const;
	}

	override init({log, url, context}: BaseCollector.CollectorInitOptions) {
		this.#log ??= new TaggedLogger(log);
		this.#context    = context;
		this.#headless   = context.browser().process()?.spawnargs.includes('--headless') ?? true;
		this.#initialUrl = url;
		this.#siteDomain = tldts.getDomain(url.href);
	}

	override async addTarget({url, type}: Parameters<typeof BaseCollector.prototype.addTarget>[0]) {
		if (!this.#page && type === 'page') this.#page = (await this.#context.pages())[0];
		this.#visitedTargets.push({time: Date.now(), type, url});
	}

	override async getData(options: Parameters<typeof BaseCollector.prototype.getData>[0]): Promise<FieldCollectorData> {
		this.#options = options;

		this.#log?.info(`getData ${options.finalUrl}`);

		if (this.#siteDomain === null && this.#initialUrl?.hostname !== 'localhost') {
			this.#log?.warn('URL has no domain with public suffix, will skip this page');
			return {};
		}

		const landingPage = this.#page;
		// Search for fields on the landing page(s)
		const fields      = await this.processFieldsOnAllPages();

		let links = null;

		// Search for fields on linked pages
		try {
			await this.injectPageScript(landingPage.mainFrame());
			links = (await getLoginLinks(landingPage.mainFrame(), new Set(['exact', 'loose', 'coords'])))
				  .map(info => info.attrs);

			const matchTypeCounts = links.reduce((acc, attrs) =>
				  acc.set(attrs.linkMatchType, (acc.get(attrs.linkMatchType) ?? 0) + 1), new Map<LinkMatchType, number>());

			this.#log?.debug(`found ${links.length} login/register links on the landing page`, matchTypeCounts);

			if (links.length > NUM_LINKS_TO_CLICK)
				this.#log?.debug(`skipping last ${links.length - NUM_LINKS_TO_CLICK} links`);

			for (const [nLink, link] of links.slice(0, NUM_LINKS_TO_CLICK).entries())
				try {
					if (SKIP_EXTERNAL_LINKS && link.href &&
						  tldts.getDomain(new URL(link.href, this.#options.finalUrl).href) !== this.#siteDomain) {
						this.#log?.debug(`skip external link: ${link.href}`);
						continue;
					}

					if (nLink) await this.goto(landingPage.mainFrame(), this.#options.finalUrl);
					await this.closeExtraPages();

					this.#log?.debug(`will follow link: ${JSON.stringify(link)}`);
					await this.followLink(link);
					fields.push(...await this.processFieldsOnAllPages());
				} catch (err) {
					this.#log?.warn(`failed to inspect linked page for link ${JSON.stringify(link)}`, err);
				}
		} catch (err) {
			this.#log?.error('failed to inspect linked pages', err);
		}

		await this.closeExtraPages();

		return {
			visitedTargets: this.#visitedTargets,
			fields,
			loginRegisterLinksDetails: links,
			passwordLeaks: this.#passwordLeaks,
		};
	}

	async closeExtraPages() {
		await closeExtraPages(this.#context, new Set([this.#page]));
	}

	async followLink(link: ElementAttrs): Promise<void> {
		const page         = this.#page;
		const preClickUrl  = page.url();
		const prevNumPages = (await this.#context.pages()).length;
		await this.injectPageScript(page.mainFrame());
		const linkInfo = await getElementInfoFromAttrs(link, page.mainFrame());
		if (!linkInfo) throw new Error('Could not find link element anymore');
		if (await this.click(linkInfo))
			await this.waitForNavigation(page.mainFrame()); //TODO what if parent navigates?

		this.#log?.debug(`navigated ${preClickUrl} -> ${page.url()}; ${
			  (await this.#context.pages()).length - prevNumPages} new pages created`);
	}

	async goto(frame: Frame, url: string) {
		const maxWaitTimeMs = Math.max(
			  this.#options.pageLoadDurationMs * 2,
			  MAX_RELOAD_TIME);

		this.#log?.debug(`will navigate ${frame.url()} -> ${url}`);
		try {
			await frame.goto(url, {'timeout': maxWaitTimeMs, 'waitUntil': 'load'});
			this.#log?.debug('sleeping');
			await frame.waitForTimeout(POST_LANDING_RELOAD_WAIT);
		} catch (error) {
			this.#log?.debug(`error while going to ${url}`, error);
		}
	}

	async click(link: ElementInfo) {
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

	async waitForNavigation(frame: Frame) {
		const maxWaitTimeMs = Math.max(
			  this.#options.pageLoadDurationMs * 2,
			  POST_CLICK_LOAD_TIMEOUT);

		this.#log?.debug(`waiting for navigation from ${frame.url()}`);

		try {
			const msg = await Promise.race([
				frame.waitForNavigation({timeout: maxWaitTimeMs, waitUntil: 'load'})
					  .then(() => `navigated to ${frame.url()}`),
				this.#context.waitForTarget(target => target.type() === 'page', {timeout: maxWaitTimeMs})
					  .then(page => `opened ${page.url()}`),
			]);
			this.#log?.debug(msg);
		} catch (err) {
			if (isOfType(err, 'TimeoutError')) {
				this.#log?.debug('navigation timeout exceeded (but maybe the link did trigger a popup or something)');
				return;
			}
			throw err;
		}
		this.#log?.debug('sleeping');
		await frame.waitForTimeout(maxWaitTimeMs);
	}

	async processFieldsOnAllPages(): Promise<FieldElementAttrs[]> {
		const fields = [];
		for (const page of await this.#context.pages())
			fields.push(await this.processFieldsRecursive(page));
		return fields.flat();
	}

	async processFieldsRecursive(page: Page): Promise<FieldElementAttrs[]> {
		const submittedFrames = new Set<string>();

		const startUrl  = page.url();
		const openPages = new Set(await this.#context.pages());

		const fields = [];

		let done = false;
		while (!done) {
			attempt: {
				for (const frame of page.frames().filter(frame => !submittedFrames.has(frame.url()))) {
					const {field, lastField} = await this.processField(frame);
					if (lastField) submittedFrames.add(frame.url());  // This frame is done
					if (field) {
						fields.push(field);
						break attempt;  // We submitted a field, now reload the page and try other fields
					}
				}
				done = true;  // All frames are done
			}
			await this.goto(page.mainFrame(), startUrl);
			await closeExtraPages(this.#context, openPages);
		}

		return fields;
	}

	async processField(frame: Frame): Promise<{ field: FieldElementAttrs | null, lastField: boolean }> {
		const frameFields = await this.findFields(frame);
		if (frameFields?.length) {
			const fieldsByForm     = groupBy(field => field.attrs.form?.join('>>>') ?? '', frameFields);
			const fieldsByFormList = Object.entries(fieldsByForm).sort(([formA]) => formA === '' ? 1 : 0);
			for (const [lastForm, [formSelector, formFields]] of fieldsByFormList.map((e, i, l) => [i === l.length - 1, e] as const)) {
				try {
					const field = formFields.find(field => !this.#submittedFields.has(getElemIdentifier(field)));
					if (!field) continue;

					await this.fillFields(formFields);
					this.#log?.debug('sleeping');
					await frame.waitForTimeout(SLEEP_AFTER_FILL);

					if (await submitField(field)) {
						field.attrs.submitted = true;
						await this.waitForNavigation(field.handle.executionContext().frame()!);
					}
					if (formSelector) addAll(this.#submittedFields, formFields.map(getElemIdentifier));
					else this.#submittedFields.add(getElemIdentifier(field));

					return {
						field: field.attrs,
						lastField: lastForm && this.#submittedFields.has(getElemIdentifier(formFields.at(-1)!)),
					};
				} catch (err) {
					this.#log?.warn(`failed to process form ${formSelector}`, err);
				}
			}
		}
		return {field: null, lastField: true};
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
		const emailFieldsFromFathom = await unwrapHandle(await evaluateHandle(frame,
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
			  .filter(inp => evaluate(inp, inp => window[GlobalNames.INJECTED]!.isVisible(inp))));
	}

	async fillFields(fields: ElementInfo<FieldElementAttrs>[]) {
		for (const field of fields.filter(f => !f.attrs.filled)) {
			await this.injectPasswordLeakDetection(field.handle.executionContext().frame()!);
			switch (field.attrs.fieldType) {
				case 'email':
					await fillEmailField(field, this.#initialUrl.hostname, EMAIL_ADDRESS, this.#log);
					break;
				case 'password':
					await fillPasswordField(field, PASSWORD, this.#log);
					break;
				default:
					throw new UnreachableCaseError(field.attrs.fieldType);
			}
			field.attrs.filled = true;
			this.#log?.debug('sleeping');
			await this.#page?.waitForTimeout(SLEEP_AFTER_SINGLE_FILL);
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
				await exposeFunction(page, GlobalNames.PASSWORD_CALLBACK, this.passwordObserverCallback.bind(this, frame));

			await evaluate(frame, (password: string) => {
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
					if (node instanceof Element && node.shadowRoot) //TODO what if shadow attach after elem added?
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
			await exposeFunction(page, GlobalNames.ERROR_CALLBACK, this.errorCallback.bind(this));
	}

	errorCallback(message: string, stack: string) {
		this.#log?.error('Error in background page script', message, stack);
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
	/** Similar to what {@link import('tracker-radar-collector').TargetCollector} does but with timestamps */
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
