import {ElementHandle, Frame, JSHandle, Page, SerializableOrJSHandle} from 'puppeteer';
import TypedArray = NodeJS.TypedArray;

// puppeteer does not actually export its classes, so we cannot use instanceof and instead need this stupid stuff
/** Checks if `obj` is exactly of type `className` (not derived) */
export function isOfType<Name extends keyof typeof import('puppeteer') & string>(obj: unknown, className: Name): boolean {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
	return Object.getPrototypeOf(obj)?.constructor?.name === className;
}

export function getPageFromHandle(handle: JSHandle<Element>): Page | null {
	const frame = handle.executionContext().frame();
	return frame ? getPageFromFrame(frame) : null;
}

export function getPageFromFrame(frame: Frame): Page {
	return frame._frameManager.page();  //XXX Replace with stable version if ever available
}

/** @return Stack starting with this frame, going up */
export function getFrameStack(frame: Frame): Frame[] {
	const frames: Frame[]      = [];
	let curFrame: Frame | null = frame;
	do {
		frames.push(curFrame);
		curFrame = curFrame.parentFrame();
	} while (curFrame);
	return frames;
}

type PageFunction<Target extends Frame | JSHandle, Args extends SerializableOrJSHandle[], Return> =
	  Target extends JSHandle<infer T>
			? (obj: T, ...args: Args) => Return
			: (...args: Args) => Return;

/** Typed version of {@link Frame#evaluateHandle} and {@link JSHandle#evaluateHandle} */
export async function evaluateHandle<Target extends Frame | JSHandle, Args extends SerializableOrJSHandle[], Return>(
	  target: Target,
	  pageFunction: PageFunction<Target, Args, Return>, ...args: Args): Promise<JSHandle<Return>> {
	return await target.evaluateHandle(pageFunction, ...args);
}

/** Typed version of {@link Page#exposeFunction} */
export async function exposeFunction<Name extends keyof Window & string, Func extends typeof window[Name]>(page: Page, name: Name, func: Func) {
	await page.exposeFunction(name, func);
}

export type UnwrappedHandle<T> = T extends string | boolean | number | null | undefined | bigint
	  ? T
	  : T extends Element
			? ElementHandle<T>
			: T extends (infer V)[]
				  ? UnwrappedHandle<V>[]
				  : T extends Node | RegExp | Date | Map<never, never> | Set<never> | WeakMap<object, never> | WeakSet<object>
						// eslint-disable-next-line @typescript-eslint/ban-types
						| Iterator<never, never, never> | Generator<never, never, never> | Error | Promise<never> | TypedArray | ArrayBuffer | DataView | Function
						? JSHandle<T>
						: T extends object
							  ? { [K in keyof T]: UnwrappedHandle<T[K]> }
							  : unknown;

/**
 * Like {@link JSHandle#jsonValue}, but retains some non-serializable objects as {@link JSHandle}s
 */
export async function unwrapHandle<T>(handle: JSHandle<T>): Promise<UnwrappedHandle<T>> {
	return await unwrapHandleConservative(handle, () => true) as UnwrappedHandle<T>;
}

export type UnwrappedHandleConservative<T> = T extends string | boolean | number | null | undefined | bigint
	  ? T
	  : T extends Element
			? ElementHandle<T>
			: T extends (infer V)[]
				  ? UnwrappedHandleConservative<V>[]
				  : T extends Node | RegExp | Date | Map<never, never> | Set<never> | WeakMap<object, never> | WeakSet<object>
						// eslint-disable-next-line @typescript-eslint/ban-types
						| Iterator<never, never, never> | Generator<never, never, never> | Error | Promise<never> | TypedArray | ArrayBuffer | DataView | Function
						? JSHandle<T>
						: T extends object
							  ? { [K in keyof T]: UnwrappedHandleConservative<T[K]> } | JSHandle<T>
							  : unknown;

/**
 * Like {@link JSHandle#jsonValue}, but retains non-serializable objects as {@link JSHandle}s
 */
export async function unwrapHandleConservative<T>(handle: JSHandle<T>, shouldUnwrap: (className: string) => boolean = className => ['Object', 'Proxy'].includes(className)):
	  Promise<UnwrappedHandleConservative<T>> {
	//XXX Replace _remoteObject with stable version if ever available

	// Leave functions & symbols wrapped
	if (['function', 'symbol'].includes(handle._remoteObject.type))
		return handle as UnwrappedHandleConservative<T>;

	if (handle._remoteObject.type === 'object') {
		if ([undefined, 'proxy'].includes(handle._remoteObject.subtype)) {
			if (shouldUnwrap(handle._remoteObject.className!))
				return Object.fromEntries(await Promise.all([...await handle.getProperties()]
					  .map(async ([k, v]) => [k, await unwrapHandleConservative(v, shouldUnwrap)]))) as UnwrappedHandleConservative<T>;
		} else {
			if (handle._remoteObject.subtype === 'null')
				return null as UnwrappedHandleConservative<T>;
			if (handle._remoteObject.subtype === 'array')
				return await Promise.all([...await handle.getProperties()]
					  .map(async ([, v]) => await unwrapHandleConservative(v, shouldUnwrap))) as UnwrappedHandleConservative<T>;
		}
		return (handle.asElement() ?? handle) as UnwrappedHandleConservative<T>;

	} else  // Return other types such as numbers, booleans, bigints, etc. unwrapped
		return (handle._remoteObject.type === 'undefined'
			  ? undefined
			  : handle._remoteObject.value
			  ?? (handle._remoteObject.unserializableValue
					? eval(handle._remoteObject.unserializableValue)
					: await handle.jsonValue())) as UnwrappedHandleConservative<T>;
}
