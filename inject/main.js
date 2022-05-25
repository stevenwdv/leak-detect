export {detectEmailInputs} from './email_detector';
import {utils} from 'fathom-web';

const {isVisible} = utils;
export {isVisible};

/**
 * @param {Element} el
 * @returns boolean
 */
export function isOnTop(el) {
	const rect    = el.getBoundingClientRect();
	const centerX = (rect.left + rect.right) / 2,
	      centerY = (rect.top + rect.bottom) / 2;
	const topEl   = document.elementFromPoint(centerX, centerY);
	return el.isSameNode(topEl);
}

/**
 * @param {string} str
 * @returns {string}
 */
function escapeQuotes(str) {
	return str.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'');
}

/**
 * @param {(Element | ParentNode | Attr)} node
 * @returns {string}
 */
function getXPathInDocument(node) {
	if ([Node.DOCUMENT_NODE, Node.DOCUMENT_FRAGMENT_NODE].includes(node.nodeType))
		return '/';
	if (node instanceof Attr)
		return `${getXPathInDocument(node.ownerElement)}/@${node.name}`;
	if (node.id) {
		const idEscaped = escapeQuotes(node.id);
		/** @type {ParentNode} */
		const root      = node.getRootNode();
		if (root.querySelectorAll(`[id='${idEscaped}']`).length === 1)
			return `//*[@id='${idEscaped}']`;
	}
	const tagName = node.tagName;
	const sames   = [...node.parentNode.children].filter(child => child.tagName === tagName);
	return `${[Node.DOCUMENT_NODE, Node.DOCUMENT_FRAGMENT_NODE].includes(node.parentNode.nodeType)
	          ? '' : getXPathInDocument(node.parentNode)}/${tagName.toLowerCase()}${sames.length > 1 ? `[${sames.indexOf(node) + 1}]` : ''}`;
}

/**
 * Get chain of XPaths, one path from each Document / Shadow DOM root in the hierarchy
 * @param {(Element | ParentNode | Attr)} elem
 * @returns {XPathChain}
 */
export function formXPathChain(elem) {
	const chain = [];
	while (true) {
		chain.unshift(getXPathInDocument(elem));
		const root = (elem instanceof Attr ? elem.ownerElement : elem).getRootNode();
		if (!(root instanceof ShadowRoot)) break;
		elem = root.host;
	}
	return chain;
}

/**
 * Get Node from XPath chain, across Shadow roots
 * @param {XPathChain} xpathChain
 * @param {ParentNode} reference
 * @returns {?XPathChainResult}
 */
export function getNodeByXPathChain(xpathChain, reference = document) {
	const evaluator = new XPathEvaluator();
	/** @type {(XPathResult | undefined)} */
	let result;
	let unique      = true;
	for (const [i, xpath] of xpathChain.entries()) {
		if (reference.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
			if (xpath === '/') return {node: reference, unique};
			// Calling evaluate on a ShadowRoot throws a DOMException,
			//  as long as xpath starts with '/' this should be equivalent
			reference = reference.firstChild;
			if (!reference) return null;
		}
		//FIXME In Chromium, contrary to Firefox, `evaluate` turns out to never look into the ShadowRoot :(
		result    = evaluator.evaluate(xpath, reference, undefined, XPathResult.ORDERED_NODE_ITERATOR_TYPE, result);
		reference = result.iterateNext();
		if (i + 1 < xpathChain.length) reference = reference?.shadowRoot;
		if (!reference) return null;
		unique &&= !result.iterateNext();
	}
	return {node: reference, unique};
}

/** @typedef {string[]} XPathChain */

/**
 * @typedef XPathChainResult
 * @property {Node} node
 * @property {boolean} unique Is this the only matching Node?
 */
