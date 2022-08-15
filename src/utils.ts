import {DeepPartial} from 'ts-essentials';

export type OmitFirstParameter<Func> = Func extends (first: never, ...args: infer Rest) => infer Return
	  ? (...args: Rest) => Return : never;

export type AsBound<Constructor extends { prototype: object } & (abstract new (...args: never) => unknown),
	  MemberName extends keyof Constructor['prototype']>
	  = Constructor['prototype'][MemberName] extends (...args: infer P) => infer R
	  ? (this: InstanceType<Constructor>, ...args: P) => R
	  : Constructor['prototype'][MemberName]

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
                                                   map: (item: ItemType) => FilterType): ItemType[] {
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

export function populateDefaults<T>(obj: DeepPartial<T>, defaults: T): T {
	const objMap      = obj as { [key in string]?: unknown },
	      defaultsMap = defaults as { [key in string]?: unknown };
	if (obj && defaults && typeof obj === 'object' && typeof defaults === 'object'
		  && Object.getPrototypeOf(obj) === Object.prototype
		  && !(defaults instanceof Array)) {
		for (const key of Object.keys(defaults))
			if (objMap[key] === undefined) objMap[key] = defaultsMap[key];
			else populateDefaults(objMap[key], defaultsMap[key]);
	}
	return obj as T;
}
