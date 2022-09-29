import {setTimeout} from 'node:timers/promises';

import {DeepPartial, NonEmptyArray} from 'ts-essentials';

export type OmitFirstParameter<Func> = Func extends (first: never, ...args: infer Rest) => infer Return
	  ? (...args: Rest) => Return : never;

export type EmptyObject = { [key in string]?: never };

export type AsBound<Constructor extends { prototype: object } & (abstract new (...args: never) => unknown),
	  MemberName extends keyof Constructor['prototype']>
	  = Constructor['prototype'][MemberName] extends (...args: infer P) => infer R
	  ? (this: InstanceType<Constructor>, ...args: P) => R
	  : Constructor['prototype'][MemberName]

export type MaybePromise<T> = T | Promise<T>;
export type MaybePromiseLike<T> = T | PromiseLike<T>;

export function notFalsy<T>(v: T | null | undefined | 0 | false | ''): v is T {
	return Boolean(v);
}

export function nonEmpty<T>(array: T[] | null | undefined): array is NonEmptyArray<T> {
	return !!(array?.length ?? 0);
}

export function getRandomUpTo(maxValue: number) {
	return Math.random() * maxValue;
}

/**
 * Truncate str, not splitting unicode characters.
 * Put an ellipsis at the end if truncated.
 * Newlines will be collapsed
 */
export function truncateLine(str: string, maxLength: number): string {
	let truncated = str
		  .replaceAll(/\r\n|\n|\r/g, '⏎')
		  .match(new RegExp(`^.{0,${maxLength}}$|^.{0,${maxLength-1}}`, 'ug'))![0]!;
	if (truncated !== str) truncated += '…';
	return truncated;
}

/**
 * Template tag, strips indents from the template string, excluding content of placeholders
 */
export function stripIndent(strings: TemplateStringsArray, ...placeholders: unknown[]) {
	const stringsNoIndent = strings.map(s => s.replaceAll(/([\r\n])[^\S\r\n]+/g, '$1'));
	stringsNoIndent[0] = stringsNoIndent[0]!.replace(/^[^\S\r\n]+/, '');
	return stringsNoIndent.reduce((acc, s, i) => acc + String(placeholders[i - 1]!) + s);
}

export function stripHash(url: string | URL): string {
	return url.toString().match(/^[^#]*/)![0]!;
}

/**
 * Get relative URL for `url` compared to `base`
 *
 * @example
 * getRelativeUrl(
 *  new URL('https://example.com/page?n=42'),
 *  new URL('https://example.com/')
 * ) === 'page?n=42'
 */
export function getRelativeUrl(url: URL, base: URL): string {
	if (!url.protocol.startsWith('http') || !base.protocol.startsWith('http'))
		return url.href;

	let protocol  = url.protocol,
	    authority = url.host,
	    path      = url.pathname,
	    search    = url.search;

	if (url.protocol === base.protocol) {
		protocol = '';

		if (url.username === base.username && url.password === base.password
			  && url.host === base.host) authority = '';
		else if (url.username || url.password)
			authority = `${url.username}:${url.password}@${url.host}`;

		if (!authority) {
			if (url.pathname === base.pathname) path = '';
			else {
				const dir = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);
				if (url.pathname.startsWith(dir))
					path = url.pathname.substring(dir.length) || '.';
			}

			if (url.search === base.search) search = '';
		}
	}

	let res = '';
	if (protocol || authority) res += `${protocol}//`;
	res += authority + path + search + url.hash;
	return res;
}

export function validUrl(url: string): URL | null {
	try {
		return new URL(url);
	} catch {
		return null;
	}
}

/** @return `true` if `key` was newly added to `map`, `false` if it was already present */
export function trySet<K, V>(map: Map<K, V>, key: K, value: V): boolean {
	return trySetWith(map, key, () => value);
}

/** @return `true` if `key` was newly added to `map`, `false` if it was already present */
export function trySetWith<K, V>(map: Map<K, V>, key: K, getValue: () => V): boolean {
	if (map.has(key)) return false;
	map.set(key, getValue());
	return true;
}

/** Add `map(element)` for each element in `items` to `seen` and return elements that were not in `seen` before */
export function filterUniqBy<ItemType, FilterType>(items: ItemType[], seen: Set<FilterType>,
	  map: (item: ItemType) => FilterType,
): ItemType[] {
	return items.filter(item => tryAdd(seen, map(item)));
}

/** @return `true` if `value` was newly added to `set`, `false` if it was already present */
export function tryAdd<T>(set: Set<T>, value: T): boolean {
	if (set.has(value)) return false;
	set.add(value);
	return true;
}

export function addAll<T>(set: Set<T>, values: Iterable<T>) {
	for (const val of values) set.add(val);
}

export function setAll<K, V>(map: Map<K, V>, entries: Iterable<readonly [K, V]>) {
	for (const [key, val] of entries) map.set(key, val);
}

export async function waitWithTimeout<T>(timeoutMs: number, promise: PromiseLike<T>): Promise<T | undefined> {
	return await Promise.race([
		setTimeout(timeoutMs, undefined),
		promise,
	]);
}

export function raceWithCondition<T>(
	  promises: Iterable<MaybePromiseLike<T>>,
	  condition: (val: T) => MaybePromiseLike<boolean>,
): Promise<T | undefined> {
	return new Promise((resolve, reject) =>
		  void Promise.allSettled([...promises].map(async p => {
			  // Calling resolve/reject multiple times does not do anything
			  try {
				  const res = await p;
				  if (await condition(res)) resolve(res);
			  } catch (err) {
				  reject(err);
			  }
		  })).then(() => resolve(undefined)));
}

export function forwardPromise<T extends MaybePromise<unknown>>(func: () => T, onFinally: () => void): T {
	let promise = false;
	try {
		const res = func();
		if ((promise = res instanceof Promise))
			return res.finally(onFinally) as T;
		return res;
	} finally {
		if (!promise) onFinally();
	}
}

export function formatDuration(ms: number): string {
	let str = '';
	if (ms >= 3600_000) str += `${Math.floor(ms / 3600_000)}h `;
	ms %= 3600_000;
	if (ms >= 60_000) str += `${Math.floor(ms / 60_000)}m `;
	ms %= 60_000;
	if (ms >= 1_000) str += `${Math.floor(ms / 1_000)}s `;
	ms %= 1_000;
	if (!str) str += `${Math.ceil(ms)}ms `;
	str = str.slice(0, -1);
	return str;
}

export function appendDomainToEmail(email: string, domain: string) {
	let emailSuffix = domain;
	if (emailSuffix.startsWith('www.')) emailSuffix = emailSuffix.substring(4);
	const [localPart, domainPart] = email.split('@') as [string, string];
	return `${localPart}+${emailSuffix}@${domainPart}`;
}

export function populateDefaults<T>(obj: DeepPartial<T>, defaults: T): T {
	const objMap      = obj as { [key in string]?: unknown },
	      defaultsMap = defaults as { [key in string]?: unknown };
	if (obj !== null && typeof obj === 'object' && defaults !== null && typeof defaults === 'object'
		  && Object.getPrototypeOf(obj) === Object.prototype
		  && !(defaults instanceof Array)) {
		for (const key of Object.keys(defaults))
			if (objMap[key] === undefined) objMap[key] = defaultsMap[key];
			else populateDefaults(objMap[key], defaultsMap[key]);
	}
	return obj as T;
}
