import {SelectorChain} from 'leak-detect-inject';
import type {BoundingBox, BrowserContext, ElementHandle, Frame, Page} from 'puppeteer';
import {NonEmptyArray} from 'ts-essentials';

import {stripHash} from './utils';
import {PageVars} from './FieldsCollector';
import {getFrameStack, unwrapHandle} from './puppeteerUtils';

/** Matches file name in Chromium stack frame from which the 'at' prefix is stripped */
export const stackFrameFileRegex = /(?<=\().+?(?=(?::\d+){0,2}\)$)|^[^()]+?(?=(?::\d+){0,2}$)/;

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
	return `${stripHash(attrs.frameStack[0]!)} ${selectorStr(attrs.selectorChain)}`;
}

export function selectorStr(selectorChain: SelectorChain): string {
	return selectorChain.join('>>>').replaceAll(':nth-of-type', ':nth…');
}

export async function getElementInfoFromAttrs(
	  attrs: ElementAttrs, frame: Frame, checkUrl = false): Promise<ElementInfo | null> {
	if (checkUrl && attrs.frameStack[0] !== frame.url())
		throw new Error(`trying to get attributes of ${selectorStr(attrs.selectorChain)} on wrong frame ${frame.url()} instead of ${attrs.frameStack[0]}`);
	const handle = (await getElementBySelectorChain(attrs.selectorChain, frame))?.elem;
	return handle ? {handle, attrs} : null;
}

export async function getElementBySelectorChain(selector: SelectorChain, frame: Frame):
	  Promise<{ elem: ElementHandle, unique: boolean } | null> {
	return await unwrapHandle(await frame.evaluateHandle(
		  (selector: SelectorChain) => window[PageVars.INJECTED].getElementBySelectorChain(selector), selector));
}

export function formSelectorChain(handle: ElementHandle): Promise<SelectorChain> {
	return handle.evaluate(el => window[PageVars.INJECTED].formSelectorChain(el));
}

export async function getElementAttrs(handle: ElementHandle): Promise<ElementAttrs> {
	const inView         = await handle.isIntersectingViewport();
	const boundingBox    = await handle.boundingBox();
	const elAttrsPartial = await handle.evaluate(el => {
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
			form: form ? window[PageVars.INJECTED].formSelectorChain(form) : null,

			onTop: window[PageVars.INJECTED].isOnTop(el),
			visible: window[PageVars.INJECTED].isVisible(el),

			selectorChain: window[PageVars.INJECTED].formSelectorChain(el),
		};
	});
	return {
		...elAttrsPartial,
		frameStack: getFrameStack(handle.frame).map(f => f.url()) as NonEmptyArray<string>,
		inView,
		boundingBox,
		time: Date.now(),
	};
}

export interface ElementAttrs {
	/** URLs starting with the bottom frame, going up */
	frameStack: NonEmptyArray<string>;

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
