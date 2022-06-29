import {ElementHandle, Frame, JSHandle, Page} from 'puppeteer';
import {Protocol} from 'devtools-protocol';
import {IsTuple} from 'ts-essentials';
import TypedArray = NodeJS.TypedArray;

// puppeteer does not actually export its classes, so we cannot use instanceof and instead need this stupid stuff
/** Checks if `obj` is exactly of type `className` (not derived) */
export function isOfType<Name extends string & keyof typeof import('puppeteer')>(obj: unknown, className: Name):
	  obj is typeof import('puppeteer')[Name] extends abstract new (...args: never) => unknown
			? InstanceType<typeof import('puppeteer')[Name]>
			: never {
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

/** Typed version of {@link Page#exposeFunction} */
export async function exposeFunction<Name extends keyof Window & string, Func extends typeof window[Name]>(page: Page, name: Name, func: Func) {
	await page.exposeFunction(name, func);
}

/**
 * Like {@link JSHandle#jsonValue}, but retains some non-serializable objects as {@link JSHandle}s
 */
export async function unwrapHandle<T>(handle: JSHandle<T>): Promise<UnwrappedHandle<T>> {
	return await unwrapHandleEx(handle, () => true) as UnwrappedHandle<T>;
}

function valueFromRemoteObject(obj: Protocol.Runtime.RemoteObject): unknown {
	if (obj.unserializableValue)
		switch (obj.type) {
			case 'bigint':
				return BigInt(obj.unserializableValue.replace('n', ''));
			case 'number': {
				const val = {
					'-0': -0,
					'NaN': NaN,
					'Infinity': Infinity,
					'-Infinity': -Infinity,
				}[obj.unserializableValue];
				if (val !== undefined) return val;
				break;
			}
		}
	return obj.value;
}

/**
 * Like {@link JSHandle#jsonValue}, but retains non-serializable objects as {@link JSHandle}s
 */
export async function unwrapHandleEx<T>(handle: JSHandle<T>, shouldUnwrap: (className: string) => boolean = className => ['Object', 'Proxy'].includes(className)):
	  Promise<UnwrappedHandleEx<T>> {
	//XXX Replace _remoteObject with stable version if ever available

	// Leave functions & symbols wrapped
	if (['function', 'symbol'].includes(handle._remoteObject.type))
		return handle as UnwrappedHandleEx<T>;

	if (handle._remoteObject.type === 'object') {
		if ([undefined, 'proxy'].includes(handle._remoteObject.subtype)) {
			if (shouldUnwrap(handle._remoteObject.className!))
				return Object.fromEntries(await Promise.all([...await handle.getProperties()]
					  .map(async ([k, v]) => [k, await unwrapHandleEx(v, shouldUnwrap)]))) as UnwrappedHandleEx<T>;
		} else {
			if (handle._remoteObject.subtype === 'null')
				return null as UnwrappedHandleEx<T>;
			if (handle._remoteObject.subtype === 'array')
				return await Promise.all([...await handle.getProperties()]
					  .map(async ([, v]) => await unwrapHandleEx(v, shouldUnwrap))) as UnwrappedHandleEx<T>;
		}
		return handle as UnwrappedHandleEx<T>;

	} else  // Return other types such as numbers, booleans, bigints, etc. unwrapped
		return (handle._remoteObject.type === 'undefined'
			  ? undefined
			  : valueFromRemoteObject(handle._remoteObject)
			  ?? await handle.jsonValue()) as UnwrappedHandleEx<T>;
}

export type UnwrappedHandle<T> = T extends string | boolean | number | null | undefined | bigint
	  ? T
	  : T extends Element
			? ElementHandle<T>
			: T extends (infer V)[]
				  ? T extends IsTuple<T>
						? { [K in keyof T]: UnwrappedHandle<T[K]> }
						: UnwrappedHandle<V>[]
				  : T extends Node | RegExp | Date | Map<unknown, unknown> | Set<unknown> | WeakMap<object, unknown> | WeakSet<object>
						| Iterator<unknown, never, never> | Error | Promise<unknown> | TypedArray | ArrayBuffer | DataView
						// eslint-disable-next-line @typescript-eslint/ban-types
						| Function | symbol
						? JSHandle<T>
						: T extends object
							  ? { [K in keyof T]: UnwrappedHandle<T[K]> }
							  : unknown;

export type UnwrappedHandleEx<T> = T extends string | boolean | number | null | undefined | bigint
	  ? T
	  : T extends Element
			? ElementHandle<T>
			: T extends (infer V)[]
				  ? T extends IsTuple<T>
						? { [K in keyof T]: UnwrappedHandleEx<T[K]> }
						: UnwrappedHandleEx<V>[]
				  : T extends Node | RegExp | Date | Map<unknown, unknown> | Set<unknown> | WeakMap<object, unknown> | WeakSet<object>
						| Iterator<unknown, never, never> | Error | Promise<unknown> | TypedArray | ArrayBuffer | DataView
						// eslint-disable-next-line @typescript-eslint/ban-types
						| Function | symbol
						? JSHandle<T>
						: T extends object
							  ? { [K in keyof T]: UnwrappedHandleEx<T[K]> } | JSHandle<T>
							  : unknown;
