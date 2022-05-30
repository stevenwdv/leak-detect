import {detectEmailInputs as _detectEmailInputs} from './email_detector';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Fathom has no type declarations
import {utils} from 'fathom-web';

const detectEmailInputs = _detectEmailInputs as (domRoot: Element) => Generator<FathomResult, void, undefined>;
export {detectEmailInputs};

const {isVisible} = (utils as { isVisible: (elem: Element) => boolean });
export {isVisible};

export interface FathomResult {
	elem: Element;
	score: number;
}

export function isOnTop(el: Element): boolean {
	const rect    = el.getBoundingClientRect();
	const centerX = (rect.left + rect.right) / 2,
	      centerY = (rect.top + rect.bottom) / 2;
	const topEl   = document.elementFromPoint(centerX, centerY);
	return el.isSameNode(topEl);
}

function escapeQuotes(str: string): string {
	return str.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'');
}

function formSelectorFromRoot(elem: Element): string {
	if (elem.id) {
		const idEscaped = escapeQuotes(elem.id);
		const root      = elem.getRootNode() as ParentNode;
		const selector  = `[id='${idEscaped}']`;
		try {
			if (root.querySelectorAll(selector).length === 1)
				return selector;
		} catch (err) {
			// Ignore errors due to weird IDs
			if (!(err instanceof SyntaxError)) throw err;
		}
	}

	if (!elem.parentNode) throw new Error('elem is detached (or not an Element)');

	if (elem.parentNode instanceof Document) return ':root';  // <html> element

	const tagName = elem.tagName;
	let me        = tagName.toLowerCase();
	const sames   = [...elem.parentNode.children].filter(child => child.tagName === tagName);
	if (sames.length > 1) me += `:nth-of-type(${sames.indexOf(elem) + 1})`;
	return `${elem.parentElement ? formSelectorFromRoot(elem.parentElement) : ':host'}>${me}`;
}

/**
 * Get chain of CSS selectors, one selector from each Document / Shadow DOM root in the hierarchy
 */
export function formSelectorChain(elem: Element): SelectorChain {
	const chain = [];
	while (true) {
		chain.unshift(formSelectorFromRoot(elem));
		const root = elem.getRootNode();
		if (!(root instanceof ShadowRoot)) break;
		elem = root.host;
	}
	return chain;
}

/**
 * Get Node from CSS selector chain, across Shadow roots
 * @param reference Default: {@link document}
 */
export function getElementBySelectorChain(selectorChain: SelectorChain, reference: ParentNode = document): SelectorChainResult | null {
	let unique = true;
	if (!selectorChain.length) return reference instanceof Element ? {elem: reference, unique} : null;
	for (const [i, selector] of selectorChain.entries()) {
		const matches = reference.querySelectorAll(selector);
		if (!matches.length) return null;
		if (i + 1 < selectorChain.length) {
			const shadow = matches[0].shadowRoot;
			if (!shadow) return null;
			reference = shadow;
		} else reference = matches[0];
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
