// noinspection JSUnusedGlobalSymbols

import {detectEmailInputs as _detectEmailInputs} from './email_detector';
import {detectUsernameInputs as _detectUsernameInputs} from './username_detector';
// @ts-expect-error Fathom has no type declarations
import {utils} from 'fathom-web';

export const detectEmailInputs    = _detectEmailInputs as (domRoot: Element) => Generator<FathomResult, void, undefined>;
export const detectUsernameInputs = _detectUsernameInputs as (domRoot: Element) => Generator<FathomResult, void, undefined>;
export const {isVisible}          = utils as { isVisible: (elem: Element) => boolean };

export interface FathomResult {
	elem: Element;
	score: number;
}

export function isOnTop(elem: Element): boolean {
	const rect    = elem.getBoundingClientRect();
	const centerX = (rect.left + rect.right) / 2,
	      centerY = (rect.top + rect.bottom) / 2;
	const topEl   = document.elementFromPoint(centerX, centerY);
	return elem.isSameNode(topEl);
}

function escapeAttrVal(str: string): string {
	return str.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'');
}

function formSelectorFromRoot(elem: Element): string {
	if (!elem.parentNode) {
		console.warn('elem is detached (or not an Element)', elem);
		// Best-effort info
		return elem.id ? `${elem.tagName}[id='${escapeAttrVal(elem.id)}']` : `${elem.tagName}[detached]`;
	}
	if (elem.parentNode instanceof Document) return ':root';  // <html> element

	function globallyUnique(selector: string): boolean {
		try {
			return (elem.getRootNode() as ParentNode)
				  .querySelectorAll(selector)
				  .length === 1;
		} catch (err) {
			// Catch errors due to weird names/IDs
			if (err instanceof SyntaxError) return false;
			throw err;
		}
	}

	function validSelector(selector: string): string | null {
		try {
			void (elem.getRootNode() as ParentNode).querySelector(selector);
			return selector;
		} catch (err) {
			// Catch errors due to weird names/IDs
			if (err instanceof SyntaxError) return null;
			throw err;
		}
	}

	function matchSiblings(selector: string): { index: number, matchCount: number } {
		// These are sorted in document order
		const matches = elem.parentNode!.querySelectorAll(`:scope>${selector}`);
		return {
			index: [...matches].indexOf(elem),
			matchCount: matches.length,
		};
	}

	let mySelector;

	if (elem.id) {
		const globalSelector = /^[a-z_][a-z0-9_-]*$/i.test(elem.id)
			  ? `#${elem.id}`
			  : `[id='${escapeAttrVal(elem.id)}']`;
		if (globallyUnique(globalSelector)) return globalSelector;
		mySelector = validSelector(globalSelector);
	}

	mySelector ||= elem.hasAttribute('name') && validSelector(`[name='${escapeAttrVal(elem.getAttribute('name')!)}']`);
	mySelector ||= elem.tagName.toLowerCase();

	let sameSiblings = matchSiblings(mySelector);
	if (sameSiblings.matchCount > 1) {
		// Note: :nth-of-type takes selects the xth element with the matched *tag name*, unlike XPath's [x]
		//TODO use :nth-child(x of mySelector) when it becomes available
		mySelector   = elem.tagName.toLowerCase();
		sameSiblings = matchSiblings(mySelector);
		if (sameSiblings.matchCount > 1)
			mySelector += `:nth-of-type(${sameSiblings.index + 1})`;
	}

	// No parentElement: parentNode is ShadowRoot
	const parentSelector = elem.parentElement ? formSelectorFromRoot(elem.parentElement) : ':host';
	return `${parentSelector}>${mySelector}`;
}

/**
 * Get chain of CSS selectors, one selector from each Document / Shadow DOM root in the hierarchy
 */
export function formSelectorChain(elem: Element): SelectorChain {
	const chain = [];
	while (true) {
		chain.unshift(formSelectorFromRoot(elem));
		const root = elem.getRootNode();
		// root is equal to elem if it has no parent, or Document for <html>
		if (!(root instanceof ShadowRoot)) break;
		elem = root.host;
	}
	return chain;
}

/**
 * Get Node from CSS selector chain, across Shadow roots
 * @param reference Default: {@link document}
 */
export function getElementBySelectorChain(
	  selectorChain: SelectorChain, reference: ParentNode = document): SelectorChainResult | null {
	let unique = true;
	if (!selectorChain.length) return reference instanceof Element ? {elem: reference, unique} : null;
	// Cannot use selectorChain.entries(), because some Prototype.js library (e.g. via 'scriptaculous') overrides it with a wrong implementation
	for (let i = 0; i < selectorChain.length; ++i) {
		const selector = selectorChain[i]!;
		const matches  = reference.querySelectorAll(selector);
		const [match]  = matches;
		if (!match) return null;
		if (i + 1 < selectorChain.length) {
			const shadow = match.shadowRoot;
			if (!shadow) return null;
			reference = shadow;
		} else reference = match;
		unique &&= matches.length === 1;
	}
	return {elem: reference as Element, unique};
}

export type SelectorChain = string[];

export interface SelectorChainResult {
	elem: Element;
	/** Is this the only matching Element? */
	unique: boolean;
}
