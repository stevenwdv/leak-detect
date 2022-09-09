import {RequestCollector} from 'tracker-radar-collector';
import ValueSearcher from 'value-searcher';

import {formatDuration, nonEmpty, notFalsy} from './utils';
import {OutputFile} from './main';
import {selectorStr} from './pageUtils';
import {LeakDetectorCaptureData} from './breakpoints';
import {ClickLinkEvent, FillEvent, SubmitEvent} from './FieldsCollector';

export function getSummary(
	  output: OutputFile, errors: { level: 'warn' | 'error', args: unknown[] }[]): string {
	const result = output.crawlResult;
	const time   = (timestamp: number) =>
		  `⌚️${((timestamp - result.testStarted) / 1e3).toFixed(1)}s`;

	const strings: string[] = [];
	const write             = (str: string) => strings.push(str);
	const writeln           = (str = '') => {
		if (str) strings.push(str);
		strings.push('\n');
	};

	writeln(`Crawl of ${result.initialUrl}`);
	if (result.finalUrl !== result.initialUrl)
		writeln(`URL after redirects: ${result.finalUrl}`);
	writeln(`Took ${formatDuration(result.testFinished - result.testStarted)}`);
	writeln();

	const collectorData = result.data;
	const fieldsData    = collectorData.fields;
	if (fieldsData) {
		if (fieldsData.passwordLeaks.length) {
			writeln('⚠️ Password was written to the DOM:');
			for (const leak of fieldsData.passwordLeaks) {
				writeln(`${time(leak.time)} to attribute "${leak.attribute}" on element "${selectorStr(leak.selector)}"; frame stack (bottom→top):`);
				for (const frame of leak.attrs?.frameStack ?? leak.frameStack!)
					writeln(`\t${frame}`);
			}
			writeln('If a script then extracts the DOM it might leak the password\n');
		}
	} else writeln('❌️ No fields collector data, it probably crashed\n');

	if (!collectorData.requests) writeln('⚠️ No request collector data found');
	if (output.leakedValues) {
		if (output.leakedValues.length) {
			const annotatedLeaks = output.leakedValues
				  .map(leak => {
					  const request       = leak.requestIndex !== undefined ? collectorData.requests![leak.requestIndex]! : undefined,
					        visitedTarget = leak.visitedTargetIndex !== undefined ? collectorData.fields!.visitedTargets[leak.visitedTargetIndex]! : undefined;
					  const url           = request?.url ?? visitedTarget!.url;
					  return {
						  ...leak,
						  request,
						  visitedTarget,
						  domainInfo: output.domainInfo?.[url],
					  };
				  });
			const importantLeaks = annotatedLeaks.filter(({domainInfo}) =>
				  !domainInfo || domainInfo.thirdParty || domainInfo.tracker);
			if (importantLeaks.length) {
				writeln('ℹ️ Values were sent in web requests to third parties:');
				for (const leak of importantLeaks) {
					const reqTime = leak.visitedTarget?.time ?? leak.request!.wallTime;
					write(`${reqTime !== undefined ? `${time(reqTime)} ` : ''}${leak.type} sent in ${leak.part}`);
					if (leak.request) {
						write(' of request to');
						if (leak.domainInfo?.thirdParty === true) write(' third party');
						if (leak.domainInfo?.tracker === true) write(' tracker');
						write(` "${leak.request.url}"`);
						if (nonEmpty(leak.request.stack)) {
							writeln(' by:');
							for (const frame of leak.request.stack)
								writeln(`\t${frame}`);
						}
						writeln();
					} else writeln(` for navigation to ${collectorData.fields!.visitedTargets[leak.visitedTargetIndex!]!.url}`);
				}
				writeln();
			}
		}
	} else writeln('⚠️ No leaked value data found\n');

	if (collectorData.apis) {
		if (collectorData.apis.savedCalls.length) {
			writeln('ℹ️ Access to relevant APIs:');
			for (const call of collectorData.apis.savedCalls) {
				const customData = call.custom as LeakDetectorCaptureData;
				write(`${time(customData.time)} access to ${call.description} (="${customData.value}") of element with type=${customData.type}`);
				if (customData.id) write(` and id="${customData.id}"`);
				writeln(' :');
				for (const frame of call.stack!)
					writeln(`\t${frame}`);
				writeln();
			}
			writeln();
		}
	} else writeln('⚠️ No API call data found\n');

	writeln('\n📊 Statistics:\n');
	if (fieldsData) {
		writeln(`${fieldsData.fields.length} fields found`);
		writeln(`${fieldsData.events.filter(ev => ev instanceof FillEvent).length} fields filled`);
		writeln(`${fieldsData.events.filter(ev => ev instanceof SubmitEvent).length} fields submitted`);
		writeln(`${fieldsData.links?.length ?? 0} links found`);
		writeln(`${fieldsData.events.filter(ev => ev instanceof ClickLinkEvent).length} links clicked`);
		if (fieldsData.errors.length) {
			writeln('\nFields collector errors:');
			for (const error of fieldsData.errors)
				writeln(`\t${error.level === 'error' ? '❌️' : '⚠️'} ${
					  typeof error.context[0] === 'string' ? `${error.context[0]} ` : ''
				}${String(error.error)}`);
			writeln();
		}
	}
	if (errors.length) {
		writeln('\nAll logged errors:');
		for (const error of errors)
			writeln(`\t${error.level === 'error' ? '❌️' : '⚠️'} ${error.args.map(String).join(' ')}`);
		writeln();
	}

	return strings.join('');
}

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
			  .map((url, visitedTargetIndex) => ({url, visitedTargetIndex}))
			  .filter(({url}) => !requestUrls.has(url))
			  .map(({url, visitedTargetIndex}) => searcher.findValueIn(Buffer.from(url))
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
	/** Index in visitedTargets, mutually exclusive with {@link requestIndex} */
	visitedTargetIndex?: number;
	part: 'url' | 'header' | 'body';
	header?: string;
	/** Encodings (e.g. `uri`) that were used to encode value, outside-in */
	encodings: string[];
}
