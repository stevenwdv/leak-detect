import {DeepPartial} from 'ts-essentials';

export type OmitFirstParameter<Func> = Func extends (first: never, ...args: infer Rest) => infer Return
	  ? (...args: Rest) => Return : never;

export function stripHash(url: string | URL): string {
	return url.toString().match(/^[^#]*/)![0];
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
	if (obj && Object.getPrototypeOf(obj) === Object.prototype) {
		for (const key of Object.keys(defaults))
			if (objMap[key] === undefined) objMap[key] = defaultsMap[key];
			else populateDefaults(objMap[key], defaultsMap[key]);
	}
	return obj as T;
}
