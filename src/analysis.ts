import {RequestCollector} from 'tracker-radar-collector';
import ValueSearcher from 'value-searcher';

import {notFalsy} from './utils';

export async function findValue(
	  searcher: ValueSearcher,
	  requests: readonly RequestCollector.RequestData[],
	  visitedTargets: readonly string[] = [],
): Promise<FindEntry[]> {
	const requestUrls = new Set(requests.map(({url}) => url));
	return (await Promise.all([
		...requests.flatMap((request, requestIndex) => [
			searcher.findValueIn(Buffer.from(request.url))
				  .then(encoders => encoders && {
					  requestIndex,
					  part: 'url',
					  encodings: encoders.map(String),
				  } as const),
			...Object.entries(request.requestHeaders as Record<string, string>)
				  .map(([name, value]) =>
						searcher.findValueIn(Buffer.from(value))
							  .then(encoders => encoders && {
								  requestIndex,
								  part: 'header',
								  header: name,
								  encodings: encoders.map(String),
							  } as const)),
			request.postData && searcher.findValueIn(Buffer.from(request.postData))
				  .then(encoders => encoders && {
					  requestIndex,
					  part: 'body',
					  encodings: encoders.map(String),
				  } as const),
		]),
		...visitedTargets
			  .filter(url => !requestUrls.has(url))
			  .map((url, visitedTargetIndex) => searcher.findValueIn(Buffer.from(url))
					.then(encoders => encoders && {
						visitedTargetIndex,
						part: 'url',
						encodings: encoders.map(String),
					} as const)),
	])).filter(notFalsy);
}

export interface FindEntry {
	/** Index in requests */
	requestIndex?: number;
	/** Index in visitedTargets */
	visitedTargetIndex?: number;
	part: 'url' | 'header' | 'body';
	header?: string;
	/** Encodings (e.g. `uri`) that were used to encode value, outside-in */
	encodings: string[];
}
