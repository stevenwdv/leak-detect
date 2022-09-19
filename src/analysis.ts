import async from 'async';
import {filter, groupBy, map, pipe, reverse, zip} from 'rambda';
import * as tldts from 'tldts';
import {RequestCollector} from 'tracker-radar-collector';
import ValueSearcher from 'value-searcher';

import {formatDuration, nonEmpty, notFalsy, truncateLine} from './utils';
import {OutputFile, SavedCallEx, ThirdPartyInfo} from './main';
import {selectorStr, stackFrameFileRegex} from './pageUtils';
import {
	ClickLinkEvent,
	FillEvent,
	FullFieldsCollectorOptions,
	ReturnEvent,
	ScreenshotEvent,
	SubmitEvent,
} from './FieldsCollector';

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
	writeln(`Took ${formatDuration(result.testFinished - result.testStarted)}`);
	writeln();

	const thirdPartyInfoStr = ({thirdParty, tracker}: Partial<ThirdPartyInfo>): string =>
		  `${thirdParty === true ? 'third party ' : ''
		  }${tracker === true ? '🕵 tracker ' : ''}`;

	const collectorData = result.data;

	let importantLeaks, hasDomainInfo;
	{
		const annotatedLeaks = (output.leakedValues ?? [])
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
		importantLeaks       = hasDomainInfo ? annotatedLeaks.filter(({request, visitedTarget}) => {
			const {thirdParty, tracker} = request ?? visitedTarget!;
			return thirdParty! || tracker!;
		}) : annotatedLeaks;
	}

	let valueAccesses;
	{
		const searchValues = [
			fieldsCollectorOptions.fill.email,
			fieldsCollectorOptions.fill.password,
		];
		valueAccesses      = pipe(
			  filter(({description}: SavedCallEx) => description === 'HTMLInputElement.prototype.value'),
			  filter(({custom: {value}}) => searchValues.includes(value)),
		)(collectorData.apis?.savedCalls ?? []);
	}

	const fieldsData = collectorData.fields;
	if (fieldsData) {
		// Some selectors might clash. I think this should not be that large of a problem?
		const fieldsMap = new Map(fieldsData.fields
			  .map(field => [selectorStr(field.selectorChain), field]));
		const linksMap  = new Map(fieldsData.links
			  ?.map(link => [selectorStr(link.selectorChain), link]));

		if (fieldsData.events.length) {
			const allEvents = [
				fieldsData.events,
				fieldsData.passwordLeaks.map(leak => ({type: 'password-leak', time: leak.time, leak})),
				importantLeaks.map(leak => ({
					type: 'request-leak',
					time: leak.visitedTarget?.time ?? leak.request!.wallTime,
					leak,
				})),
				valueAccesses.map(call => ({type: 'value-access', time: call.custom.time, call})),
			].flat().sort((a, b) => a.time - b.time);

			writeln('🕰 Timeline (see below for more details):');
			for (const event of allEvents) {
				switch (event.type) {
					case 'fill':
					case 'submit': {
						const {field: selector} = event as FillEvent;
						const field             = fieldsMap.get(selectorStr(selector))!;
						writeln(`\t${time(event.time)} ✒️ ${event.type} ${field.fieldType} field ${selectorStr(selector)}`);
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
						const {link: selector, linkType} = event as ClickLinkEvent;
						const link                       = linksMap.get(selectorStr(selector));
						if (linkType === 'auto')
							writeln(`${time(event.time)} 🔗🖱 follow link "${truncateLine(link!.innerText, 60)}" ${selectorStr(selector)} (matched ${link!.linkMatchType})`);
						else writeln(`${time(event.time)} 🖱 click element ${selectorStr(selector)} (js-path-click interact chain)`);
						break;
					}
					case 'screenshot': {
						const {trigger, name} = event as ScreenshotEvent;
						writeln(`\t${time(event.time)} 📸 ${trigger} ${name ?? ''}`);
						break;
					}
					case 'password-leak':
						writeln(`\t\t${time(event.time)} ⚠️ 🔑 password written to DOM`);
						break;
					case 'request-leak': {
						const leak = (event as typeof event & { leak: typeof importantLeaks[0] }).leak;
						const url  = leak.request?.url ?? leak.visitedTarget!.url;
						writeln(`\t\t${time(event.time)} ⚠️ 🖅 ${leak.type} sent to ${tldts.getHostname(url) ?? url}`);
						break;
					}
					case 'value-access': {
						const call = (event as typeof event & { call: SavedCallEx }).call;
						writeln(`\t\t${time(event.time)} 🔍 ${
							  call.custom.value === fieldsCollectorOptions.fill.password ? '🔑 ' : '📧 '
						}value of ${call.custom.type} field read`);
						break;
					}
				}
			}
			writeln();
		}

		if (fieldsData.passwordLeaks.length) {
			writeln('⚠️ 🔑 Password was written to the DOM:');
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
		if (importantLeaks.length) {
			writeln(`ℹ️ 🖅 Values were sent in web requests${hasDomainInfo ? ' to third parties' : ''}:`);
			for (const leak of importantLeaks) {
				const reqTime = leak.visitedTarget?.time ?? leak.request!.wallTime;
				write(`${reqTime !== undefined ? `${time(reqTime)} ` : ''}${leak.type} sent in ${leak.part}`);
				const thirdPartyInfo = leak.request ?? leak.visitedTarget!;
				if (leak.request) {
					write(` of request to ${thirdPartyInfoStr(thirdPartyInfo)}"${leak.request.url}"`);
					if (nonEmpty(leak.request.stack)) {
						writeln(' by:');
						for (const frame of leak.request.stack)
							writeln(`\t${frame}`);
					}
					writeln();
				} else {
					writeln(` for navigation to ${thirdPartyInfoStr(thirdPartyInfo)}${leak.visitedTarget!.url}`);
				}
			}
			writeln();
		} else writeln(`✔️ No leaks ${output.leakedValues.length ? 'to third parties ' : ''}detected\n`);
	} else writeln('⚠️ No leaked value data found\n');

	if (collectorData.apis) {
		const fieldValueCalls = pipe(
			  groupBy(({custom: {selectorChain, type, value}, stack}) =>
					`${selectorChain ? selectorStr(selectorChain) : ''}\0${type}\0${value}\0${stack!.join('\n')}`),
			  (Object.entries<SavedCallEx[]>),
			  map(([, calls]) => {
				  const {custom: {selectorChain, type, value}, stack, stackInfo} = calls[0]!;
				  return [
					  {selectorChain, type, value, stack: stack!, stackInfo: stackInfo!},
					  calls.map(({custom: {time}}) => time),
				  ] as const;
			  }),
		)(valueAccesses);

		if (fieldValueCalls.length) {
			writeln('ℹ️ 🔍 Field value reads:');
			for (const [call, times] of fieldValueCalls) {
				write(`${times.map(time).join(' ')} access to ${
					  call.value === fieldsCollectorOptions.fill.password ? '🔑 ' : '📧 '
				}value of ${call.type} field`);
				if (call.selectorChain) write(` "${selectorStr(call.selectorChain)}"`);
				writeln(' by:');

				const displayFrames = [];
				let prevFile: string | undefined;
				for (const [frame, frameInfo] of reverse(zip(call.stack, call.stackInfo)))
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
			writeln('\nFields collector errors:');
			for (const error of fieldsData.errors)
				writeln(`\t${error.level === 'error' ? '❌️' : '⚠️'} ${
					  typeof error.context[0] === 'string' ? `${error.context[0]} ` : ''
				}${String(error.error)}`);
			writeln();
		}
	}

	return strings.join('');
}

export async function findValue(
	  searcher: ValueSearcher,
	  requests: readonly RequestCollector.RequestData[],
	  visitedTargets: readonly string[]                      = [],
	  onProgress: (completed: number, total: number) => void = () => {/**/},
): Promise<FindEntry[]> {
	const requestUrls = new Set(requests.map(({url}) => url));

	const queries: (() => Promise<null | FindEntry>)[] = [
		...requests.flatMap((request, requestIndex) => [
			() => searcher.findValueIn(Buffer.from(request.url))
				  .then(encoders => encoders && {
					  requestIndex,
					  part: 'url',
					  encodings: encoders.map(String),
				  } as const),
			...Object.entries(request.requestHeaders ?? {})
				  .filter(([name]) => {
					  name = name.toLowerCase();
					  return name.includes('cookie') || name.startsWith('x-');
				  })
				  .map(([name, value]) =>
						() => searcher.findValueIn(Buffer.from(value))
							  .then(encoders => encoders && {
								  requestIndex,
								  part: 'header',
								  header: name,
								  encodings: encoders.map(String),
							  } as const)),
			request.postData && (() => searcher.findValueIn(Buffer.from(request.postData!))
				  .then(encoders => encoders && {
					  requestIndex,
					  part: 'body',
					  encodings: encoders.map(String),
				  } as const)),
		]),
		...visitedTargets
			  .map((url, visitedTargetIndex) => ({url, visitedTargetIndex}))
			  .filter(({url}) => !requestUrls.has(url))
			  .map(({url, visitedTargetIndex}) =>
					() => searcher.findValueIn(Buffer.from(url))
						  .then(encoders => encoders && {
							  visitedTargetIndex,
							  part: 'url',
							  encodings: encoders.map(String),
						  } as const)),
	].filter(notFalsy);
	onProgress(0, queries.length);

	let completed = 0;
	return (await mapLimit(queries, 2, async query => {
		const res = await query();
		onProgress(++completed, queries.length);
		return res;
	})).filter(notFalsy);
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
