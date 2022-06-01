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
