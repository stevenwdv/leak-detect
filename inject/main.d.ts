export function detectEmailInputs(domRoot: Element): Generator<FathomResult, void, undefined>;

export function isVisible(elem: Element): boolean;

export function isOnTop(elem: Element): boolean;

/** Get chain of XPaths, one path from each Document / Shadow DOM root in the hierarchy */
export function formXPathChain(elem: Element | ParentNode | Attr): XPathChain;

/**
 * Get Node from XPath chain, across Shadow roots.
 * FIXME Broken for Chromium :(
 * @param reference Default: {@link document}
 */
export function getNodeByXPathChain(xpathChain: XPathChain, reference?: ParentNode): XPathChainResult;

export interface FathomResult {
	elem: Element;
	score: number;
}

export type XPathChain = string[];

export interface XPathChainResult {
	node: Node;
	/** Is this the only matching Node? */
	unique: boolean;
}
