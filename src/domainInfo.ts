import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import consumers from 'node:stream/consumers';

import sanitizeFilename from 'sanitize-filename';
import * as tldts from 'tldts';
import {XOR} from 'ts-essentials';
import type {RequestType, StaticNetFilteringEngine} from '@gorhill/ubo-core';

import ErrnoException = NodeJS.ErrnoException;

const cacheDir = path.join(__dirname, '../tmp/');

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
			await fsp.mkdir(cacheDir, {recursive: true});
			const file = path.join(cacheDir, 'simple-domain-map.json');

			// Download entity map and cache, or used cached version
			let domainMap;
			try {
				domainMap = await consumers.json(fs.createReadStream(file)) as SimpleDomainMap;
			} catch (err) {
				if ((err as ErrnoException).code !== 'ENOENT') throw err;

				const entityMapUrl = 'https://raw.githubusercontent.com/duckduckgo/tracker-radar/main/build-data/generated/entity_map.json';
				const entityMap    = await (await fetch(entityMapUrl)).json() as EntityMap;
				// Simplify entity map to domain map which maps domains to entity numbers
				domainMap          = Object.fromEntries(Object.values(entityMap)
					  .flatMap(({properties}, i) => properties.map(domain => [domain, i])));
				await fsp.writeFile(file, JSON.stringify(domainMap));
			}
			return this.#instance = new this(domainMap);
		})();
	}

	isThirdParty(domainOrUrl: string, originDomainOrUrl: string): boolean {
		// Handle simple cases
		if (domainOrUrl === originDomainOrUrl) return false;
		// Do not count our scripts as third party
		if (domainOrUrl.startsWith('pptr://')) return false;

		// Compare full domain name
		const domain       = tldts.getHostname(domainOrUrl),
		      originDomain = tldts.getHostname(originDomainOrUrl);
		if (!domain || !originDomain) return true;  // Might be null for IP addresses
		if (domain === originDomain) return false;

		// Compare entities, fail if different or only domain has no associated entity
		const originEntity = this.#getEntity(originDomain);
		if (originEntity !== null)
			return originEntity !== this.#getEntity(domain);

		// Fallback: compare eTLD+1
		// We do this only here, because the domain map may give more precise results for subdomains
		return tldts.getDomain(domain, {allowPrivateDomains: true}) !==
			  tldts.getDomain(originDomain, {allowPrivateDomains: true});
	}

	#getEntity(domain: string): number | null {
		// Strip off first subdomain each time until match found
		let superDomain = domain;
		while (true) {
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

			const listCacheDir = path.join(cacheDir, 'block-lists/');
			await fsp.mkdir(listCacheDir, {recursive: true});

			const trackerLists = {
				UBlockFilters: 'https://ublockorigin.pages.dev/filters/filters.txt',
				UBlockBadware: 'https://ublockorigin.github.io/uAssetsCDN/filters/badware.txt',
				UBlockPrivacy: 'https://combinatronics.io/uBlockOrigin/uAssetsCDN/main/filters/privacy.txt',
				UBlockUnbreak: 'https://ublockorigin.github.io/uAssetsCDN/filters/unbreak.txt',

				EasyList: 'https://easylist.to/easylist/easylist.txt',
				EasyPrivacy: 'https://easylist.to/easylist/easyprivacy.txt',

				UrlHaus: 'https://malware-filter.pages.dev/urlhaus-filter-online.txt',
				PeterLowe: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=1&mimetype=plaintext',
			};

			// Load and parse block lists
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

	isTracker(url: string, originUrl: string, requestType: RequestType) {
		return this.#filter.matchRequest({
			url,
			type: requestType,
			originURL: originUrl,
		}) === FilterResult.BLOCK;
	}
}

enum FilterResult {
	NO_MATCH = 0,
	BLOCK    = 1,
	ALLOW    = 2,
}
