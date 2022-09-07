import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import consumers from 'node:stream/consumers';

import sanitizeFilename from 'sanitize-filename';
import * as tldts from 'tldts';
import {XOR} from 'ts-essentials';
import type {StaticNetFilteringEngine} from '@gorhill/ubo-core';

import ErrnoException = NodeJS.ErrnoException;

export class ThirdPartyClassifier {
	static #instancePromise?: Promise<ThirdPartyClassifier>;
	static #instance?: ThirdPartyClassifier;

	readonly #domainMap: SimpleDomainMap;

	private constructor(domainMap: SimpleDomainMap) {
		this.#domainMap = domainMap;
	}

	static get instance() {return this.#instance;}

	static get() {
		return this.#instancePromise ??= (async () => {
			const cacheDir = './tmp/';
			await fsp.mkdir(cacheDir, {recursive: true});

			const file = path.join(cacheDir, 'simple-domain-map.json');

			let domainMap;
			try {
				domainMap = await consumers.json(fs.createReadStream(file)) as SimpleDomainMap;
			} catch (err) {
				if ((err as ErrnoException).code !== 'ENOENT') throw err;

				const entityMapUrl = 'https://raw.githubusercontent.com/duckduckgo/tracker-radar/main/build-data/generated/entity_map.json';
				const entityMap    = await (await fetch(entityMapUrl)).json() as EntityMap;
				domainMap          = Object.fromEntries(Object.values(entityMap)
					  .flatMap(({properties}, i) => properties.map(domain => [domain, i])));
				await fsp.writeFile(file, JSON.stringify(domainMap));
			}
			return this.#instance = new this(domainMap);
		})();
	}

	isThirdParty(domainOrUrl: string, originDomainOrUrl: string): boolean {
		if (domainOrUrl === originDomainOrUrl) return false;
		const domain       = tldts.getHostname(domainOrUrl),
		      originDomain = tldts.getHostname(originDomainOrUrl);
		if (!domain || !originDomain) return true;
		if (domain === originDomain) return false;

		const originEntity = this.#getEntity(originDomain);
		if (originEntity !== null)
			return originEntity !== this.#getEntity(domain);

		return tldts.getDomain(domain, {allowPrivateDomains: true}) !==
			  tldts.getDomain(originDomain, {allowPrivateDomains: true});
	}

	#getEntity(domain: string): number | null {
		let superDomain = domain;
		while (true) {
			console.log('start');
			const entity = this.#domainMap[superDomain];
			if (entity !== undefined) return entity;
			const dotIndex = superDomain.indexOf('.');
			if (dotIndex === -1) break;
			superDomain = superDomain.substring(dotIndex + 1);
		}
		return null;
	}
}

type SimpleDomainMap = Record<string /*domain*/, number /*entity ID*/>;

type EntityMap = Record<string /*name*/, Entity>;

type Entity = {
	aliases: string[],
	/** Domain names */
	properties: string[],
} & XOR<{ displayName: string }, { displayname: string }>;


export class TrackerClassifier {
	static #instancePromise?: Promise<TrackerClassifier>;
	static #instance?: TrackerClassifier;

	readonly #filter: StaticNetFilteringEngine;

	private constructor(filter: StaticNetFilteringEngine) {
		this.#filter = filter;
	}

	static get instance() {return this.#instance;}

	static get() {
		return this.#instancePromise ??= (async () => {
			// Prevent TypeScript from rewriting to `require`...
			const {StaticNetFilteringEngine} = await eval('import(\'@gorhill/ubo-core\')') as typeof import('@gorhill/ubo-core');
			const filter                     = await StaticNetFilteringEngine.create();

			const listCacheDir = './tmp/block-lists/';
			await fsp.mkdir(listCacheDir, {recursive: true});

			const trackerLists = {
				EasyPrivacy: 'https://easylist.to/easylist/easyprivacy.txt',
			};

			await filter.useLists(Object.entries(trackerLists)
				  .map(async ([name, url]) => {
					  const file = path.join(listCacheDir, `${sanitizeFilename(name)}.txt`);
					  try {
						  return {name, raw: await fsp.readFile(file, 'utf8')};
					  } catch (err) {
						  if ((err as ErrnoException).code !== 'ENOENT') throw err;
					  }
					  const raw = await (await fetch(url)).text();
					  await fsp.writeFile(file, raw);
					  return {name, raw};
				  }));
			return this.#instance = new this(filter);
		})();
	}

	isTracker(url: string, originUrl: string) {
		return this.#filter.matchRequest({
			url,
			type: 'no_type',
			originURL: originUrl,
		}) === FilterResult.BLOCK;
	}
}

export const enum FilterResult {
	NO_MATCH = 0,
	BLOCK    = 1,
	ALLOW    = 2,
}
