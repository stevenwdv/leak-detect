import async from 'async';
import {filter, groupBy, map, pipe, reverse, zip} from 'rambda';
import * as tldts from 'tldts';
import {RequestCollector} from 'tracker-radar-collector';
import ValueSearcher, {transformers} from 'value-searcher';

import {formatDuration, getRelativeUrl, nonEmpty, notFalsy, truncateLine, validUrl} from './utils';
import {OutputFile, SavedCallEx, ThirdPartyInfo} from './main';
import {getElemIdentifierStr, selectorStr, stackFrameFileRegex} from './pageUtils';
import {
	ClickLinkEvent,
	DomPasswordLeak,
	ErrorInfo,
	FillEvent,
	FullFieldsCollectorOptions,
	NavigateEvent,
	ReturnEvent,
	ScreenshotEvent,
	StackFrame,
	SubmitEvent,
} from './FieldsCollector';

const {HashTransform} = transformers;

// Fix type
const mapLimit = async.mapLimit as <T, R>(
	  items: Iterable<T> | AsyncIterable<T>,
	  limit: number,
	  mapping: (item: T) => Promise<R>,
) => Promise<R[]>;

export function getSummary(output: OutputFile, fieldsCollectorOptions: FullFieldsCollectorOptions): string {
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
	if (result.timeout) writeln('⏰ Encountered timeout while loading main page');
	writeln(`Took ${formatDuration(result.testFinished - result.testStarted)}`);
	writeln();

	const collectorData = result.data;

	let hasDomainInfo, relevantRequestLeaks;
	{
		const annotatedLeaks = (output.requestLeaks ?? [])
			  .map(leak => {
				  const request       = leak.requestIndex !== undefined ? collectorData.requests![leak.requestIndex]! : undefined,
				        visitedTarget = leak.visitedTargetIndex !== undefined ? collectorData.fields!.visitedTargets[leak.visitedTargetIndex]! : undefined;
				  return {
					  ...leak,
					  request,
					  visitedTarget,
				  };
			  });
		hasDomainInfo        = !!annotatedLeaks[0] && (annotatedLeaks[0].request ?? annotatedLeaks[0].visitedTarget!).thirdParty !== undefined;
		relevantRequestLeaks = hasDomainInfo ? annotatedLeaks.filter(({request, visitedTarget}) => {
			const {thirdParty, tracker} = request ?? visitedTarget!;
			return thirdParty! || tracker!;
		}) : annotatedLeaks;
	}

	let valueSniffs;
	{
		const searchValues = [
			fieldsCollectorOptions.fill.email,
			fieldsCollectorOptions.fill.password,
		];
		valueSniffs = pipe(
			  filter(({description}: SavedCallEx) => description === 'HTMLInputElement.prototype.value'),
			  filter(({custom: {value}}) => searchValues.includes(value)),
		)(collectorData.apis?.savedCalls ?? []);
	}

	const fieldsData = collectorData.fields;
	if (fieldsData) {
		const fieldsMap = new Map(fieldsData.fields
			  .map(field => [getElemIdentifierStr(field), field]));
		const linksMap  = new Map(fieldsData.links
			  ?.map(link => [getElemIdentifierStr(link), link]));

		if (fieldsData.events.length) {
			const allEvents = [
				fieldsData.events,
				fieldsData.errors.map(error => ({type: 'error', time: error.time, error})),
				fieldsData.domLeaks.map(leak => ({type: 'dom-leak', time: leak.time, leak})),
				relevantRequestLeaks.map(leak => ({
					type: 'request-leak',
					time: leak.visitedTarget?.time ?? leak.request!.wallTime,
					leak,
				})),
				valueSniffs.map(call => ({type: 'value-sniff', time: call.custom.time, call})),
			].flat().sort((a, b) => a.time - b.time);

			writeln('═══ 🕰 Timeline (see below for more details): ═══\n');
			for (const event of allEvents) {
				switch (event.type) {
					case 'fill':
					case 'submit': {
						const {field: fieldIdentifier} = event as FillEvent;
						const field                    = fieldsMap.get(getElemIdentifierStr(fieldIdentifier))!;
						writeln(`\t${time(event.time)} ✒️ ${event.type} ${field.fieldType} field ${
							  selectorStr(fieldIdentifier.selectorChain)}`);
						break;
					}
					case 'fb-button':
						writeln(`\t${time(event.time)} click added button for Facebook tracking detection`);
						break;
					case 'return': {
						const {toLanding} = event as ReturnEvent;
						if (toLanding)
							writeln(`${time(event.time)} 🔙 return to landing page`);
						else writeln(`\t${time(event.time)} 🔙 reload page`);
						break;
					}
					case 'link': {
						const {link: linkIdentifier, linkType} = event as ClickLinkEvent;
						const link                             = linksMap.get(getElemIdentifierStr(linkIdentifier));
						if (linkType === 'auto')
							writeln(`${time(event.time)} 🔗🖱 follow link "${
								  truncateLine(link!.innerText, 60)
							}" ${selectorStr(linkIdentifier.selectorChain)} (matched ${link!.linkMatchType})`);
						else writeln(`${time(event.time)} 🖱 click element ${
							  selectorStr(linkIdentifier.selectorChain)} (js-path-click interact chain)`);
						break;
					}
					case 'navigate': {
						const {url: urlStr, fullyLoaded} = event as NavigateEvent;
						const url                        = new URL(urlStr);
						url.search                       = url.hash = '';
						writeln(`\t${time(event.time)} 🧭 navigated to ${
							  getRelativeUrl(url, new URL(result.finalUrl)) || 'landing page'
						}${!fullyLoaded ? ' (load timeout)' : ''}`);
						break;
					}
					case 'screenshot': {
						const {trigger, name} = event as ScreenshotEvent;
						writeln(`\t${time(event.time)} 📸 ${trigger} ${name ?? ''}`);
						break;
					}
					case 'dom-leak': {
						const {leak} = event as typeof event & { leak: DomPasswordLeak };
						const topUrl = leak.stack?.[0]?.url;
						writeln(`\t\t${time(event.time)} ⚠️ 🔑 password written to DOM${
							  topUrl ? ` by script ${shortScriptUrl(topUrl)}` : ''}`);
						break;
					}
					case 'request-leak': {
						const {leak} = event as typeof event & { leak: typeof relevantRequestLeaks[0] };
						const url    = leak.request?.url ?? leak.visitedTarget!.url;
						writeln(`\t\t${time(event.time)} ${leak.type === 'password' ? '🚨' : '⚠️'} 📤 ${
							  leak.type === 'password' ? '🔑' : '📧'} ${leak.type} sent to ${tldts.getHostname(url) ?? url}`);
						break;
					}
					case 'value-sniff': {
						const {call} = event as typeof event & { call: SavedCallEx };
						const topUrl = call.stack?.[0]?.match(stackFrameFileRegex)?.[0];
						writeln(`\t\t${time(event.time)} 🔍 ${
							  call.custom.value === fieldsCollectorOptions.fill.password ? '🔑 password' : '📧 email'
						} value of field read by script${topUrl ? ` ${shortScriptUrl(topUrl)}` : ''}`);
						break;
					}
					case 'error': {
						const {error} = event as typeof event & { error: ErrorInfo };
						writeln(`\t\t${time(event.time)} ${error.level === 'error' ? '❌️' : '⚠️'} ${
							  typeof error.context[0] === 'string' ? `${error.context[0]} ` : ''
						}${truncateLine(String(error.error).match(/.*/)![0]!, 60)}`);
						break;
					}
				}
			}
			writeln();
		}

		if (fieldsData.domLeaks.length) {
			writeln('═══ ⚠️ 🔑 Password was written to the DOM: ═══\n');
			for (const leak of fieldsData.domLeaks.sort((a, b) => a.time - b.time)) {
				write(`${time(leak.time)} to attribute "${leak.attribute}" on element "${selectorStr(leak.selector)}"`);
				const frameStack = leak.attrs?.frameStack ?? leak.frameStack!;
				if (frameStack.length > 1) writeln(` on frame "${frameStack[0]}"`);
				if (nonEmpty(leak.stack)) {
					writeln(' by:');
					for (const frame of collapseStack(leak.stack))
						writeln(`\t${frame}`);
				}
				writeln();
			}
			writeln('\nIf a script then extracts the DOM it might leak the password in a web request\n');
		}
	} else writeln('❌️ No fields collector data, it probably crashed\n');

	if (!collectorData.requests) writeln('⚠️ No request collector data found');
	if (output.requestLeaks) {
		if (relevantRequestLeaks.length) {
			writeln(`═══ ⚠️ 📤 Values were sent in web requests${hasDomainInfo ? ' to third parties' : ''}: ═══\n`);
			for (const leak of relevantRequestLeaks) {
				const reqTime = leak.visitedTarget?.time ?? leak.request!.wallTime;
				write(`${time(reqTime)} ${leak.type}${
					  leak.isHash ? ' hash' : ''} (${leak.encodings.join('→')}) sent in ${leak.part}`);
				const thirdPartyInfo = leak.request ?? leak.visitedTarget!;
				if (leak.request) {
					write(` of request to ${thirdPartyInfoStr(thirdPartyInfo)}"${leak.request.url}"`);
					if (nonEmpty(leak.request.stack)) {
						writeln(' by:');
						for (const frame of collapseStack(leak.request.stack))
							writeln(`\t${frame}`);
					}
					writeln();
				} else {
					writeln(` for navigation to ${thirdPartyInfoStr(thirdPartyInfo)}${leak.visitedTarget!.url}`);
				}
			}
			writeln();
		} else writeln(`✔️ No leaks ${output.requestLeaks.length ? 'to third parties ' : ''}detected\n`);
	} else writeln('⚠️ No request leaks data found\n');

	if (collectorData.apis) {
		const fieldValueCalls = pipe(
			  groupBy(({custom: {selectorChain, bottomFrame, type, value}, stack}) =>
					`${selectorChain ? selectorStr(selectorChain) : ''}\0${bottomFrame ?? ''}\0${type}\0${value}\0${stack?.join('\n') ?? ''}`),
			  (Object.entries<SavedCallEx[]>),
			  map(([, calls]) => ([
				  calls[0]!,
				  calls.map(({custom: {time}}) => time),
			  ] as const)),
		)(valueSniffs);

		if (fieldValueCalls.length) {
			writeln('═══ ℹ️ 🔍 Field value reads: ═══\n');
			for (const [call, times] of fieldValueCalls) {
				write(`${times.map(time).join(' ')} access to ${
					  call.custom.value === fieldsCollectorOptions.fill.password ? '🔑 password' : '📧 email'
				} value of ${call.custom.type} field`);
				if (call.custom.selectorChain) write(` "${selectorStr(call.custom.selectorChain)}"`);
				if (call.custom.bottomFrame) write(` on frame "${call.custom.bottomFrame}"`);

				if (nonEmpty(call.stack)) {
					writeln(' by:');

					const displayFrames = [];
					let prevFile: string | undefined;
					for (const [frame, frameInfo] of reverse(zip(call.stack, call.stackInfo ?? Array<undefined>(call.stack.length))))
						displayFrames.push(
							  frame.replace(stackFrameFileRegex,
									file => {
										const ret = prevFile === file
											  ? '↓'
											  : `${thirdPartyInfoStr(frameInfo ?? {})}${file}`;
										prevFile  = file;
										return ret;
									}));
					displayFrames.reverse();
					for (const frame of displayFrames)
						writeln(`\t${frame}`);
				}
				writeln();
			}
			writeln();
		}
	} else writeln('⚠️ No API call data found\n');

	if (fieldsData) {
		writeln('📊 Automated crawl statistics:\n');
		writeln(`📑 ${fieldsData.fields.length} fields found`);
		writeln(`✒️ ${fieldsData.events.filter(ev => ev instanceof FillEvent).length} fields filled`);
		writeln(`⏎ ${fieldsData.events.filter(ev => ev instanceof SubmitEvent).length} fields submitted`);
		writeln(`🔗 ${fieldsData.links?.length ?? 0} links found`);
		writeln(`🖱 ${fieldsData.events.filter(ev => ev instanceof ClickLinkEvent).length} links clicked`);

		if (fieldsData.errors.length) {
			writeln('\n═══ ⚠️ Fields collector errors: ═══\n');
			for (const error of fieldsData.errors)
				writeln(`\t${error.level === 'error' ? '❌️' : '⚠️'} ${
					  error.context.map(ctx => typeof ctx === 'string' ? ctx : JSON.stringify(ctx)).join(' ')
				}${error.error instanceof Error && error.error.stack || String(error.error)}`);
			writeln();
		}
	}

	return strings.join('');
}

function thirdPartyInfoStr({thirdParty, tracker}: Partial<ThirdPartyInfo>): string {
	return `${thirdParty === true ? '🔺 third party ' : ''}${tracker === true ? '👁 tracker ' : ''}`;
}

function shortScriptUrl(url: string): string {
	const urlObj = validUrl(url);
	return urlObj
		  ? urlObj.pathname.lastIndexOf('/') > 0
				? `${urlObj.host}/…/${urlObj.pathname.split('/').at(-1)!}`
				: `${urlObj.host}${urlObj.pathname}`
		  : url;
}

function collapseStack(stack: StackFrame[]): string[] {
	const displayFrames              = [];
	let prevFile: string | undefined = undefined;
	for (const frame of reverse(stack)) {
		const file = prevFile === frame.url ? '↓' : frame.url;
		prevFile   = frame.url;
		displayFrames.push(frame.function
			  ? `${frame.function} (${file}:${frame.line}:${frame.column})`
			  : `${file}:${frame.line}:${frame.column}`);
	}
	return displayFrames.reverse();
}

export async function findRequestLeaks(
	  searcher: ValueSearcher,
	  requests: readonly RequestCollector.RequestData[],
	  visitedTargets: readonly string[]                              = [],
	  maxDecodeLayers: number | undefined                            = undefined,
	  decoders: readonly transformers.ValueTransformer[] | undefined = undefined,
	  onProgress?: (completed: number, total: number) => void,
): Promise<RequestLeak[]> {
	const requestUrls = new Set(requests.map(({url}) => url));

	const findValueIn = (buf: Buffer) => searcher.findValueIn(buf, maxDecodeLayers, decoders);

	const getEncodings = (encoders: readonly transformers.ValueTransformer[]) => ({
		encodings: encoders.map(String),
		isHash: encoders.some(enc => enc instanceof HashTransform),
	});

	const queries: (() => Promise<null | RequestLeak>)[] = [
		...requests.flatMap((request, requestIndex) => [
			() => findValueIn(Buffer.from(request.url))
				  .then(encoders => encoders && {
					  requestIndex,
					  part: 'url',
					  ...getEncodings(encoders),
				  } as const),
			...Object.entries(request.requestHeaders ?? {})
				  .filter(([name]) => {
					  name = name.toLowerCase();
					  return name === 'referer' || name.includes('cookie') || name.startsWith('x-');
				  })
				  .map(([name, value]) =>
					    () => findValueIn(Buffer.from(value))
							  .then(encoders => encoders && {
								  requestIndex,
								  part: 'header',
								  header: name,
								  ...getEncodings(encoders),
							  } as const)),
			request.postData && (() => findValueIn(Buffer.from(request.postData!))
				  .then(encoders => encoders && {
					  requestIndex,
					  part: 'body',
					  ...getEncodings(encoders),
				  } as const)),
		]),
		...visitedTargets
			  .map((url, visitedTargetIndex) => ({url, visitedTargetIndex}))
			  .filter(({url}) => !requestUrls.has(url))
			  .map(({url, visitedTargetIndex}) =>
				    () => findValueIn(Buffer.from(url))
						  .then(encoders => encoders && {
							  visitedTargetIndex,
							  part: 'url',
							  ...getEncodings(encoders),
						  } as const)),
	].filter(notFalsy);
	onProgress?.(0, queries.length);

	let completed = 0;
	return (await mapLimit(queries, 4, async query => {
		const res = await query();
		++completed;
		onProgress?.(completed, queries.length);
		return res;
	})).filter(notFalsy);
}

export interface RequestLeak {
	/** Index in requests */
	requestIndex?: number;
	/** Index in visitedTargets, mutually exclusive with {@link requestIndex} */
	visitedTargetIndex?: number;
	part: 'url' | 'header' | 'body';
	header?: string;
	/** Encodings (e.g. `uri`) that were used to encode value, outside-in */
	encodings: string[];
	/** Is one of the encodings a hash? */
	isHash: boolean;
}
