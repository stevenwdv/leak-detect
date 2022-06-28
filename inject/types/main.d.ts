export declare const detectEmailInputs: (domRoot: Element) => Generator<FathomResult, void, undefined>;
export declare const isVisible: (elem: Element) => boolean;
export interface FathomResult {
    elem: Element;
    score: number;
}
export declare function isOnTop(elem: Element): boolean;
/**
 * Get chain of CSS selectors, one selector from each Document / Shadow DOM root in the hierarchy
 */
export declare function formSelectorChain(elem: Element): SelectorChain;
/**
 * Get Node from CSS selector chain, across Shadow roots
 * @param reference Default: {@link document}
 */
export declare function getElementBySelectorChain(selectorChain: SelectorChain, reference?: ParentNode): SelectorChainResult | null;
export declare type SelectorChain = string[];
export interface SelectorChainResult {
    elem: Element;
    /** Is this the only matching Element? */
    unique: boolean;
}
