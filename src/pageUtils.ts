import {SelectorChain} from 'leak-detect-inject';
import {BoundingBox, BrowserContext, ElementHandle, Frame, Page} from 'puppeteer';

import {stripHash} from './utils';
import {GlobalNames} from './FieldsCollector';
import {evaluate, evaluateHandle, getFrameStack, unwrapHandle} from './puppeteerUtils';

/**
 * Close pages in `context` not in `keep`
 * @returns Closed pages
 */
export async function closeExtraPages(context: BrowserContext, keep: Set<Page>): Promise<Page[]> {
	return Promise.all((await context.pages()).filter(page => !keep.has(page))
		  .map(page => page.close({runBeforeUnload: false}).then(() => page)));
}

/** Get a string which should uniquely identify an element across pages  */
export function getElemIdentifier(elem: ElementAttrs | ElementInfo): string {
	const attrs = 'attrs' in elem ? elem.attrs : elem;
	return `${stripHash(attrs.frameStack[0])} ${attrs.selectorChain.join('>>>')}`;
}

export async function getElementInfoFromAttrs(attrs: ElementAttrs, frame: Frame): Promise<ElementInfo | null> {
	const handle = (await getElementBySelectorChain(attrs.selectorChain, frame))?.elem;
	return (handle ?? null) && {handle: handle as ElementHandle, attrs};
}

export async function getElementBySelectorChain(selector: SelectorChain, frame: Frame): Promise<{ elem: ElementHandle, unique: boolean } | null> {
	return await unwrapHandle(await evaluateHandle(frame,
		  (selector: SelectorChain) => window[GlobalNames.INJECTED]!.getElementBySelectorChain(selector), selector));
}

export async function getElementAttrs(handle: ElementHandle): Promise<ElementAttrs> {
	const inView         = await handle.isIntersectingViewport();
	const boundingBox    = await handle.boundingBox();
	const elAttrsPartial = await evaluate(handle, el => {
		const form = (el as Element & { form?: HTMLFormElement }).form;
		return {
			id: el.id,
			tagName: el.nodeName,
			class: el.className,

			innerText: el instanceof HTMLElement ? el.innerText : el.textContent ?? '',
			name: el.getAttribute('name'),
			type: el.getAttribute('type'),
			href: el.getAttribute('href'),
			ariaLabel: el.ariaLabel,
			placeholder: el.getAttribute('placeholder'),
			form: form ? window[GlobalNames.INJECTED]!.formSelectorChain(form) : null,

			onTop: window[GlobalNames.INJECTED]!.isOnTop(el),
			visible: window[GlobalNames.INJECTED]!.isVisible(el),

			selectorChain: window[GlobalNames.INJECTED]!.formSelectorChain(el),
		};
	});
	return {
		...elAttrsPartial,
		frameStack: getFrameStack(handle.executionContext().frame()!).map(f => f.url()),
		inView,
		boundingBox,
		time: Date.now(),
	};
}

export interface ElementAttrs {
	/** URLs starting with the bottom frame, going up */
	frameStack: string[];

	id: string;
	tagName: string;
	class: string;

	innerText: string;

	name: string | null;
	type: string | null;
	href: string | null;
	ariaLabel: string | null;
	placeholder: string | null;
	form: SelectorChain | null;

	onTop: boolean;
	inView: boolean;
	visible: boolean;
	boundingBox: BoundingBox | null;

	selectorChain: SelectorChain;

	time: number;
}

export interface FathomElementAttrs extends ElementAttrs {
	score: number;
}

export interface FieldElementAttrs extends ElementAttrs {
	fieldType: FieldType;
	filled?: boolean;
	submitted?: boolean;
}

export interface LinkElementAttrs extends ElementAttrs {
	linkMatchType: LinkMatchType;
}

export type FieldType = 'email' | 'password';
export type LinkMatchType = 'exact' | 'loose' | 'coords';

export interface ElementInfo<AttrsType extends ElementAttrs = ElementAttrs, ElementType extends Element = Element> {
	handle: ElementHandle<ElementType>;
	attrs: AttrsType;
}
