import {RequestCollector} from 'tracker-radar-collector';
import ValueSearcher from 'value-searcher';

import {notFalsy} from './utils';

export async function findValue(
	  value: string, requests: readonly RequestCollector.RequestData[]): Promise<FindEntry[]> {
	const searcher = new ValueSearcher();
	await searcher.addValue(Buffer.from(value));

	return (await Promise.all(requests.flatMap(request => [
		searcher.findValueIn(Buffer.from(request.url))
			  .then(encoders => encoders && {
				  request,
				  part: 'url',
				  encodings: encoders.map(String),
			  } as const),
		request.postData && searcher.findValueIn(Buffer.from(request.postData))
			  .then(encoders => encoders && {
				  request,
				  part: 'body',
				  encodings: encoders.map(String),
			  } as const),
	]))).filter(notFalsy);
}

export interface FindEntry {
	request: RequestCollector.RequestData;
	part: 'url' | 'body';
	encodings: string[];
}
