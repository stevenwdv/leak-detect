import t from 'tap';
import {RequestType} from '@gorhill/ubo-core';

import {ThirdPartyClassifier, TrackerClassifier} from '../../src/domainInfo';

void t.test(ThirdPartyClassifier.name, async t => {
	const classifier = await ThirdPartyClassifier.get();

	const testCases: [domainOrUrl: string, originDomainOrUrl: string, thirdParty: boolean][] = [
		['github.com', 'google.com', true],
		['https://github.com/', 'https://google.com/', true],
		['github.com', 'github.com', false],
		['subdomain.github.com', 'github.com', false],
		['ai.google', 'google.com', false],
		['facebook.com', 'messenger.com', false],
		['https://raw.githubusercontent.com/duckduckgo/tracker-radar/main/build-data/generated/entity_map.json', 'github.com', false],
		['github.com', 'https://raw.githubusercontent.com/duckduckgo/tracker-radar/main/build-data/generated/entity_map.json', false],
	];
	for (const [domainOrUrl, originDomainOrUrl, thirdParty] of testCases)
		t.equal(classifier.isThirdParty(domainOrUrl, originDomainOrUrl), thirdParty,
			  `${domainOrUrl} is ${!thirdParty ? 'not ' : ''}a third party on ${originDomainOrUrl}`);
});

void t.test(TrackerClassifier.name, async t => {
	const classifier = await TrackerClassifier.get();

	const testCases: [url: string, originUrl: string, type: RequestType, tracker: boolean][] = [
		['https://github.com/', 'https://google.com/', 'document', false],
		['https://www.facebook.com/tr/?id=123', 'https://example.com/', 'xmlhttprequest', true],
		['https://example.com/', 'https://www.facebook.com/tr/?id=123', 'xmlhttprequest', false],
		['https://rs.fullstory.com/rec/bundle?', 'https://example.com/', 'xmlhttprequest', true],
	];
	for (const [url, originUrl, type, tracker] of testCases)
		t.equal(classifier.isTracker(url, originUrl, type), tracker,
			  `${type} ${url} is ${!tracker ? 'not ' : ''}a tracker on ${originUrl}`);
});
