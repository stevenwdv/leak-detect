import {
	DOMWorld,
	ElementHandle,
	ExecutionContext,
	Frame,
	JSHandle,
	Page,
	Serializable,
	SerializableOrJSHandle,
	WebWorker,
} from 'puppeteer';
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

/** Typed version of {@link Frame#evaluateHandle}, {@link JSHandle#evaluateHandle}, etc. */
export async function evaluateHandle<Subject extends Frame | Page | ExecutionContext | DOMWorld | WebWorker | JSHandle,
	  Args extends SerializableOrJSHandle[], Return>(
	  subject: Subject, pageFunction: PageFunction<Subject, Args, Return>, ...args: Args): Promise<JSHandle<Awaited<Return>>> {
	// eslint-disable-next-line @typescript-eslint/ban-ts-comment
	// @ts-ignore This compiles for all Targets individually
	return await subject.evaluateHandle(pageFunction, ...args) as JSHandle<Return>;
}

/** Typed version of {@link Frame#evaluate}, {@link JSHandle#evaluate}, etc. */
export async function evaluate<Subject extends Frame | Page | ExecutionContext | DOMWorld | WebWorker | JSHandle,
	  Args extends SerializableOrJSHandle[], Return extends Serializable | PromiseLike<Serializable> | void>(
	  subject: Subject, pageFunction: PageFunction<Subject, Args, Return>, ...args: Args): Promise<Awaited<Return>> {
	// eslint-disable-next-line @typescript-eslint/ban-ts-comment
	// @ts-ignore This compiles for all Targets individually
	return await subject.evaluate(pageFunction as never, ...args) as Awaited<Return>;
}

// Need the ElementHandle case because inferring U on JSHandle gives unknown because currently JSHandle<A> extends JSHandle<B> for any A,B...
type HandleValue<H extends JSHandle> = H extends ElementHandle<infer U> ? U
	  : H extends JSHandle<infer U> ? U : never;

type Passed<H extends SerializableOrJSHandle> = H extends JSHandle ? HandleValue<H> : H;
type PassedArgs<Args extends SerializableOrJSHandle[]> = { [K in keyof Args]: Passed<Args[K]> };

type PageFunction<Target extends Frame | Page | ExecutionContext | DOMWorld | WebWorker | JSHandle,
	  Args extends SerializableOrJSHandle[], Return> =
	  Target extends JSHandle
			? (obj: HandleValue<Target>, ...args: PassedArgs<Args>) => Return
			: (...args: PassedArgs<Args>) => Return;

/** Typed version of {@link Page#exposeFunction} */
export async function exposeFunction<Name extends keyof Window & string, Func extends typeof window[Name]>(page: Page, name: Name, func: Func) {
	await page.exposeFunction(name, func);
}

/**
 * Like {@link JSHandle#jsonValue}, but retains some non-serializable objects as {@link JSHandle}s
 */
export async function unwrapHandle<T>(handle: JSHandle<T>): Promise<UnwrappedHandle<T>> {
	return await unwrapHandleConservative(handle, () => true) as UnwrappedHandle<T>;
}

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

export type UnwrappedHandleConservative<T> = T extends string | boolean | number | null | undefined | bigint
	  ? T
	  : T extends Element
			? ElementHandle<T>
			: T extends (infer V)[]
				  ? T extends IsTuple<T>
						? { [K in keyof T]: UnwrappedHandleConservative<T[K]> }
						: UnwrappedHandleConservative<V>[]
				  : T extends Node | RegExp | Date | Map<unknown, unknown> | Set<unknown> | WeakMap<object, unknown> | WeakSet<object>
						| Iterator<unknown, never, never> | Error | Promise<unknown> | TypedArray | ArrayBuffer | DataView
						// eslint-disable-next-line @typescript-eslint/ban-types
						| Function | symbol
						? JSHandle<T>
						: T extends object
							  ? { [K in keyof T]: UnwrappedHandleConservative<T[K]> } | JSHandle<T>
							  : unknown;
