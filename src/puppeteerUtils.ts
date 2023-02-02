import consumers from 'node:stream/consumers';

import type {
	CDPSession,
	CustomQueryHandler,
	ElementHandle,
	Frame,
	JSHandle,
	Page,
	Protocol,
	ProtocolMapping,
} from 'puppeteer';
import {SourceMapConsumer} from 'source-map';
import {IsTuple, NonEmptyArray} from 'ts-essentials';

import {StackFrame} from './FieldsCollector';
import {createProducerStream, timeoutSignal, validUrl, waitWithTimeout} from './utils';

import TypedArray = NodeJS.TypedArray;

export function isNavigationError(err: unknown): boolean {
	return err instanceof Error
		  && /^Protocol error\b.*\b(?:Session closed|Target closed|Cannot find context with specified id)|^Execution context was destroyed\b|^Execution context is not available in detached frame\b/i
				.test(err.message);
}

export async function waitForLoad(frame: Frame): Promise<void> {
	return await frame.evaluate(() => new Promise<void>(resolve => {
		function loadHandler() {
			removeEventListener('load', loadHandler);
			resolve();
		}

		addEventListener('load', loadHandler);
		if (document.readyState === 'complete') loadHandler();
	}));
}

/** @return Stack starting with this frame, going up */
export function getFrameStack(frame: Frame): NonEmptyArray<Frame> {
	const frames: NonEmptyArray<Frame> = [frame];
	let curFrame: Frame | null         = frame;
	while ((curFrame = curFrame.parentFrame()))
		frames.push(curFrame);
	return frames;
}

/** Typed version of {@link Page#exposeFunction} */
export async function exposeFunction<Name extends keyof Window & string,
	  Func extends typeof window[Name] & ((this: typeof global, ...args: never) => void)>(
	  page: Page, name: Name, func: Func) {
	await page.exposeFunction(name, func);
}

export const robustPierceQueryHandler: CustomQueryHandler = {
	queryAll(node: Node, selector: string): Node[] {
		// For some Nodes child elements can overwrite properties, so we do this
		// Also, MooTools overwrites Document & Element
		const elementProto = Object.getPrototypeOf(HTMLElement.prototype) as typeof window.Element.prototype;
		/* eslint-disable @typescript-eslint/unbound-method */
		const shadowRoot = Object.getOwnPropertyDescriptor(elementProto, 'shadowRoot')!.get! as (this: Element) => ShadowRoot | null,
		      matches    = Object.getOwnPropertyDescriptor(elementProto, 'matches')!.value as (
			        this: Element, selectors: string) => boolean;
		/* eslint-enable @typescript-eslint/unbound-method */

		function* examineChildren(node: Node): Generator<Element, void, void> {
			if (node instanceof elementProto.constructor) {
				const nodeShadow = shadowRoot.call(node as Element);
				if (nodeShadow) yield* examineChildren(nodeShadow);
			}

			// Note: document does not actually matter
			const iter = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
			// First result would be node itself
			while (iter.nextNode()) {
				const child = iter.currentNode as Element;
				if (matches.call(child, selector)) yield child;
				const nodeShadow = shadowRoot.call(child);
				if (nodeShadow) yield* examineChildren(nodeShadow);
			}
		}

		return [...examineChildren(node)];
	},
	// Code duplicated from queryAll because these will be injected
	queryOne(node: Node, selector: string): Node | null {
		// For some Nodes child elements can overwrite properties, so we do this
		// Also, MooTools overwrites Document & Element
		const elementProto = Object.getPrototypeOf(HTMLElement.prototype) as typeof window.Element.prototype;
		/* eslint-disable @typescript-eslint/unbound-method */
		const shadowRoot = Object.getOwnPropertyDescriptor(elementProto, 'shadowRoot')!.get! as (this: Element) => ShadowRoot | null,
		      matches    = Object.getOwnPropertyDescriptor(elementProto, 'matches')!.value as (
			        this: Element, selectors: string) => boolean;
		/* eslint-enable @typescript-eslint/unbound-method */

		function* examineChildren(node: Node): Generator<Element, void, void> {
			if (node instanceof elementProto.constructor) {
				const nodeShadow = shadowRoot.call(node as Element);
				if (nodeShadow) yield* examineChildren(nodeShadow);
			}

			// Note: document does not actually matter
			const iter = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
			// First result would be node itself
			while (iter.nextNode()) {
				const child = iter.currentNode as Element;
				if (matches.call(child, selector)) yield child;
				const nodeShadow = shadowRoot.call(child);
				if (nodeShadow) yield* examineChildren(nodeShadow);
			}
		}

		const [first] = examineChildren(node);
		return first ?? null;
	},
};

/**
 * Like {@link JSHandle#jsonValue}, but retains some non-serializable objects as {@link JSHandle}s
 */
export async function unwrapHandle<T>(handle: JSHandle<T>): Promise<UnwrappedHandle<T>> {
	return await unwrapHandleEx(handle, () => true) as UnwrappedHandle<T>;
}

/**
 * Like {@link JSHandle#jsonValue}, but retains non-serializable objects as {@link JSHandle}s
 */
export async function unwrapHandleEx<T>(
	  handle: JSHandle<T>,
	  shouldUnwrap: (className: string) => boolean = className => ['Object', 'Proxy'].includes(className),
): Promise<UnwrappedHandleEx<T>> {
	const remoteObject = handle.remoteObject();

	// Leave functions & symbols wrapped
	if (['function', 'symbol'].includes(remoteObject.type))
		return handle as UnwrappedHandleEx<T>;

	if (remoteObject.type === 'object') {
		if ([undefined, 'proxy'].includes(remoteObject.subtype)) {
			if (shouldUnwrap(remoteObject.className!))
				return Object.fromEntries(await Promise.all([...await handle.getProperties()]
					  .map(async ([k, v]) => [k, await unwrapHandleEx(v, shouldUnwrap)]))) as UnwrappedHandleEx<T>;
		} else {
			if (remoteObject.subtype === 'null')
				return null as UnwrappedHandleEx<T>;
			if (remoteObject.subtype === 'array')
				return await Promise.all([...await handle.getProperties()]
					  .map(async ([, v]) => await unwrapHandleEx(v, shouldUnwrap))) as UnwrappedHandleEx<T>;
		}
		return handle as UnwrappedHandleEx<T>;

	} else  // Return other types such as numbers, booleans, bigints, etc. unwrapped
		return await handle.jsonValue() as UnwrappedHandleEx<T>;
}

export type UnwrappedHandle<T> = T extends string | boolean | number | null | undefined | bigint
	  ? T
	  : T extends Node
			? ElementHandle<T>
			: T extends (infer V)[]
				  ? T extends IsTuple<T>
						? { [K in keyof T]: UnwrappedHandle<T[K]> }
						: UnwrappedHandle<V>[]
				  : T extends RegExp | Date | Map<unknown, unknown> | Set<unknown> | WeakMap<object, unknown> | WeakSet<object>
						| Iterator<unknown, never, never> | Error | Promise<unknown> | TypedArray | ArrayBuffer | DataView
						// eslint-disable-next-line @typescript-eslint/ban-types
						| Function | symbol
						? JSHandle<T>
						: T extends object
							  ? { [K in keyof T]: UnwrappedHandle<T[K]> }
							  : unknown;

export type UnwrappedHandleEx<T> = T extends string | boolean | number | null | undefined | bigint
	  ? T
	  : T extends Node
			? ElementHandle<T>
			: T extends (infer V)[]
				  ? T extends IsTuple<T>
						? { [K in keyof T]: UnwrappedHandleEx<T[K]> }
						: UnwrappedHandleEx<V>[]
				  : T extends RegExp | Date | Map<unknown, unknown> | Set<unknown> | WeakMap<object, unknown> | WeakSet<object>
						| Iterator<unknown, never, never> | Error | Promise<unknown> | TypedArray | ArrayBuffer | DataView
						// eslint-disable-next-line @typescript-eslint/ban-types
						| Function | symbol
						? JSHandle<T>
						: T extends object
							  ? { [K in keyof T]: UnwrappedHandleEx<T[K]> } | JSHandle<T>
							  : unknown;

export function attributePairs(attributesResponse: Protocol.DOM.GetAttributesResponse): { name: string, value: string }[] {
	const {attributes} = attributesResponse;
	return Array(attributes.length / 2).fill(undefined)
		  .map((_, i) => ({name: attributes[i * 2]!, value: attributes[i * 2 + 1]!}));
}

export class StackTracer {
	readonly #cdp: TypedCDPSession;
	readonly #sourceMaps = new Map<string, Promise<SourceMapConsumer | null>>();
	readonly #scriptUrls = new Map<Protocol.Runtime.ScriptId, {
		url: string | null,
		sourceMapUrl: URL | null,
		frameId: string | null,
	}>();

	public onSourceMapLoaded: ((sourceMapUrl: URL, scriptUrl: string | null) => void) | undefined;

	constructor(cdp: CDPSession | TypedCDPSession) {
		this.#cdp = cdp as TypedCDPSession;
		this.#cdp.on('Debugger.scriptParsed', ({scriptId, url, sourceMapURL, executionContextAuxData}) =>
			  this.#scriptUrls.set(scriptId, {
				  url: url || null,
				  sourceMapUrl: sourceMapURL ? validUrl(sourceMapURL, url || undefined) : null,
				  frameId: typeof executionContextAuxData === 'object' && 'frameId' in executionContextAuxData
						? (executionContextAuxData as { frameId: string }).frameId : null,
			  }));
	}

	async enable() {
		await this.#cdp.send('Debugger.enable');
	}

	getPlainStack(frames: Protocol.Debugger.CallFrame[]) {
		return frames.map((callFrame): StackFrame => ({
			url: this.#scriptUrls.get(callFrame.location.scriptId)!.url,
			function: callFrame.functionName || null,
			line: callFrame.location.lineNumber + 1,
			column: callFrame.location.columnNumber !== undefined
				  ? callFrame.location.columnNumber + 1 : null,
		}));
	}

	async getStack(
		  frames: Protocol.Debugger.CallFrame[],
		  useSourceMaps: boolean | 'aggressive',
		  onError?: (error: unknown, aggressive: boolean) => void,
		  onPlainStack?: (stack: StackFrame[]) => void,
	) {
		const stack = this.getPlainStack(frames);
		onPlainStack?.(stack);
		if (useSourceMaps === false) return stack;

		return await Promise.all(stack.map(async (frame, i) => {
			const script     = this.#scriptUrls.get(frames[i]!.location.scriptId)!;
			let sourceMapUrl = script.sourceMapUrl;
			if (!sourceMapUrl && script.url && useSourceMaps === 'aggressive') {
				const urlObj = validUrl(script.url);
				if (urlObj && /\.jsm?$/.test(urlObj.pathname))
					urlObj.pathname += '.map';
				sourceMapUrl = urlObj;
			}
			if (!sourceMapUrl) return frame;

			try {
				const sourceMap = await this.#getSourceMap(sourceMapUrl, script.url, script.frameId,
					  5e3, 10e3 /*TODO? make configurable*/);
				if (!sourceMap) return frame;

				const orig         = sourceMap.originalPositionFor({
					line: frame.line,
					column: frame.column !== null ? frame.column - 1 : 0,
				});
				frame.sourceMapped = {
					url: orig.source,
					function: orig.name,
					line: orig.line,
					column: orig.column !== null ? orig.column + 1 : null,
				};
			} catch (err) {
				onError?.(err, !script.sourceMapUrl);
			}
			return frame;
		}));
	}

	async close() {
		await Promise.all([...this.#sourceMaps.values()].map(async map => (await map)?.destroy()));
	}

	async #getSourceMap(sourceMapUrl: URL, scriptUrl: string | null, frameId: string | null,
		  requestTimeoutMs?: number, downloadTimeoutMs?: number,
	) {
		let sourceMap = this.#sourceMaps.get(sourceMapUrl.href);
		if (sourceMap) return await sourceMap;

		sourceMap = (async () => {
			let rawSourceMap: string;
			if (sourceMapUrl.protocol === 'data:') {
				rawSourceMap = await (await fetch(sourceMapUrl)).text();
			} else {
				const resource = await loadNetworkResource(this.#cdp, {
					url: sourceMapUrl.href,
					...(frameId && {frameId}),
					options: {
						includeCredentials: true,
						disableCache: false,
					},
				}, requestTimeoutMs);
				if (resource?.success !== true)
					throw new Error(`got ${resource
						  ? resource.netErrorName ?? resource.httpStatusCode!
						  : 'timeout'} while trying to load source map ${sourceMapUrl.href}`);

				rawSourceMap = await consumers.text(
					  createCDPReadStream(this.#cdp, resource.stream!, downloadTimeoutMs));
			}

			try {
				const sourceMap = await new SourceMapConsumer(rawSourceMap,
					  sourceMapUrl.protocol !== 'data:' ? sourceMapUrl.href : scriptUrl ?? undefined);
				this.onSourceMapLoaded?.(sourceMapUrl, scriptUrl);
				return sourceMap;
			} catch (err) {
				throw new Error(`failed to parse source map ${sourceMapUrl.href}`, {cause: err});
			}
		})();

		this.#sourceMaps.set(sourceMapUrl.href, sourceMap.catch(() => null));
		return await sourceMap;
	}
}

export async function loadNetworkResource(
	  cdp: CDPSession | TypedCDPSession,
	  request: Protocol.Network.LoadNetworkResourceRequest,
	  timeoutMs?: number,
): Promise<Protocol.Network.LoadNetworkResourcePageResult | undefined> {
	let timeout    = false;
	const resource = await waitWithTimeout(timeoutMs, (async () => {
		const {resource} = await cdp.send('Network.loadNetworkResource', request);
		// ESLint false positive
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		if (timeout && resource.stream)
			cdp.send('IO.close', {handle: resource.stream})
				  .catch(() => {/*ignore*/});
		return resource;
	})());
	if (!resource) {
		timeout = true;
		return undefined;
	}
	return resource;
}

export function createCDPReadStream(
	  cdp: CDPSession | TypedCDPSession, handle: Protocol.IO.StreamHandle, timeoutMs?: number) {
	async function* readStream() {
		try {
			let base64Encoded, data, eof;
			do {
				({
					base64Encoded,
					data,
					eof,
				} = await cdp.send('IO.read', {handle}));
				yield {
					chunk: data,
					encoding: base64Encoded === true ? 'base64' as const : undefined,
				};
			} while (!eof);
		} finally {
			await cdp.send('IO.close', {handle});
		}
	}

	return createProducerStream(readStream(), undefined,
		  timeoutMs !== undefined ? timeoutSignal(timeoutMs) : undefined);
}

export function typedCDP(cdp: CDPSession) {
	return cdp as unknown as TypedCDPSession;
}

export type TypedCDPSession = CDPEventEmitter & Omit<CDPSession, keyof CDPEventEmitter>;

interface CDPEventEmitter {
	on<Event extends keyof ProtocolMapping.Events>(
		  event: Event, handler: (...event: ProtocolMapping.Events[Event]) => void): this;

	off<Event extends keyof ProtocolMapping.Events>(
		  event: Event, handler: (...event: ProtocolMapping.Events[Event]) => void): this;

	emit(event: keyof ProtocolMapping.Events, eventData?: unknown): boolean;

	once<Event extends keyof ProtocolMapping.Events>(
		  event: Event, handler: (...event: ProtocolMapping.Events[Event]) => void): this;

	listenerCount(event: keyof ProtocolMapping.Events): number;

	removeAllListeners(event?: keyof ProtocolMapping.Events): this;
}

export interface DOMPauseData {
	nodeId: Protocol.DOM.NodeId,
	type: Protocol.DOMDebugger.DOMBreakpointType,
}
