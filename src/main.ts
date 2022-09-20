#!npx ts-node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import consumers from 'node:stream/consumers';

import async, {ErrorCallback, IterableCollection} from 'async';
import chalk from 'chalk';
import yaml from 'js-yaml';
import jsonschema from 'jsonschema';
import ProgressBar from 'progress';
import type {Browser} from 'puppeteer';
import sanitizeFilename from 'sanitize-filename';
import {
	APICallCollector,
	BaseCollector,
	CMPCollector,
	crawler,
	puppeteer,
	RequestCollector,
	TargetCollector,
} from 'tracker-radar-collector';
import {BreakpointObject} from 'tracker-radar-collector/collectors/APICalls/breakpoints';
import {CollectResult} from 'tracker-radar-collector/crawler';
import {UnreachableCaseError} from 'ts-essentials';
import ValueSearcher, {defaultTransformers, transformers} from 'value-searcher';
import yargs from 'yargs';

import {
	FieldsCollector,
	FieldsCollectorData,
	FieldsCollectorOptions,
	FullFieldsCollectorOptions,
	VisitedTarget,
} from './FieldsCollector';
import {
	ColoredLogger,
	ConsoleLogger,
	CountingLogger,
	FileLogger,
	FilteringLogger,
	Logger,
	LogLevel,
	logLevels,
	TaggedLogger,
} from './logger';
import breakpoints, {LeakDetectorCaptureData} from './breakpoints';
import configSchema from './crawl-config.schema.json';
import {appendDomainToEmail, populateDefaults, stripIndent, truncateLine, validUrl} from './utils';
import {FindEntry, findValue, getSummary} from './analysis';
import {ThirdPartyClassifier, TrackerClassifier} from './domainInfo';
import {WaitingCollector} from './WaitingCollector';
import {RequestType} from '@gorhill/ubo-core';
import {stackFrameFileRegex} from './pageUtils';
import {sum} from 'rambda';

const {
	      CompressionTransform,
	      CustomStringMapTransform,
	      HashTransform,
	      LZStringTransform,
      } = transformers;

// Fix wrong type
const eachLimit = async.eachLimit as <T, E = Error>(
	  arr: IterableCollection<T>, limit: number,
	  iterator: (item: T, callback: ErrorCallback<E>) => Promise<void> /*added*/ | void,
) => Promise<void>;

// Fix type
const parallelLimit = async.parallelLimit as unknown as <T>(
	  items: AsyncIterable<() => T> | Iterable<() => T>, limit: number) => Promise<Awaited<T>[]>;

process.on('uncaughtException', error => {
	process.exitCode = 1;
	console.error(error);
	// eslint-disable-next-line no-debugger
	debugger;
	console.warn('\nWe will try to continue anyway\n');
});

process.on('uncaughtExceptionMonitor', (error, origin) =>
	  console.error('\n\n\x07❌️', origin));

let mainExited = false;
process.on('beforeExit', () => {
	if (!mainExited) {
		process.exitCode ??= 13;
		console.error('\n\n\x07❌️ Unexpected exit: It seems Node.js prevented a hang due to a Promise that can never be fulfilled, ' +
			  'this may be a bug in the Puppeteer library');
	}
});
process.on('exit', () => process.stdout.write('\x1b]9;4;0;0\x1b\\'));

process.stdout.write('\x1b]0;☔️ leak detector\x1b\\');

async function main() {
	const args = yargs
		  .scriptName('leak-detect')
		  .wrap(yargs.terminalWidth())
		  .command('crawl', 'crawl a URL', yargs => yargs
			    .option('url', {
				    description: 'URL of homepage to crawl',
				    type: 'string',
			    })
			    .option('urls-file', {
				    description: 'File with URLs to crawl, each on it\'s own line',
				    type: 'string',
				    normalize: true,
			    })
			    .option('parallelism', {
				    description: 'Number of crawls to run in parallel if --urls-file was specified',
				    type: 'number',
				    default: 20,
			    })
			    .option('log-succeeded', {
				    description: 'Print out URLs of succeeded crawls with --urls-file as well',
				    type: 'boolean',
				    default: false,
			    })
			    .option('config', {
				    description: 'path to configuration JSON/YAML file for fields collector, see src/crawl-config.schema.json for syntax',
				    type: 'string',
				    normalize: true,
			    })
			    .option('config-inline', {
				    description: 'inline JSON configuration for fields collector, see src/crawl-config.schema.json for syntax',
				    type: 'string',
			    })
			    .option('log-level', {
				    description: `log level for crawl; one of ${logLevels.join(', ')}`,
				    type: 'string',
			    })
			    .option('log-timestamps', {
				    description: 'start each log entry with a timestamp relative to the start of the crawl',
				    type: 'boolean',
				    default: true,
			    })
			    .option('api-calls', {
				    description: 'enable API call breakpoints collector to track field value sniffs',
				    type: 'boolean',
				    default: true,
			    })
			    .option('requests', {
				    description: 'enable requests collector',
				    type: 'boolean',
				    default: true,
			    })
			    .option('auto-consent', {
				    description: 'try to automatically indicate consent in cookie dialog; one of optIn, optOut, noAction',
				    type: 'string',
				    default: 'optIn',
			    })
			    .option('single-browser', {
				    description: 'perform crawls with --urls-file using a single browser (still multiple contexts)',
				    type: 'boolean',
				    default: false,  //TODO set to true when puppeteer/puppeteer#8691 and puppeteer/puppeteer#8838 are fixed
			    })
			    .option('headed', {
				    description: 'open a browser window',
				    type: 'boolean',
				    default: false,
			    })
			    .option('headed-wait', {
				    description: 'wait for keypress before automatic crawl',
				    type: 'boolean',
				    default: false,
			    })
			    .option('headed-autoclose', {
				    description: 'automatically close windows even in --headed mode',
				    type: 'boolean',
				    default: false,
			    })
			    .option('devtools', {
				    description: 'open developer tools',
				    type: 'boolean',
				    default: false,
			    })
			    .option('pause-on-value-read', {
				    description: 'when headless with devtools open, pause in debugger when input field value is read',
				    type: 'boolean',
				    default: true,
			    })
			    .option('timeout', {
				    description: 'timeout for crawl, in seconds, or 0 to disable',
				    type: 'number',
				    default: 20 * 60,
			    })
			    .option('check-third-party', {
				    description: 'check if request URLs are of third party servers or trackers',
				    type: 'boolean',
				    default: true,
			    })
			    .option('check-leaks', {
				    description: 'check for leaks of filled values in web requests',
				    type: 'boolean',
				    default: true,
			    })
			    .option('check-leaks-encode-layers', {
				    description: 'maximum number of reverse encoding layers with --check-leaks',
				    type: 'number',
				    default: 2,
			    })
			    .option('check-leaks-decode-layers', {
				    description: 'number of decoding layers with --check-leaks',
				    type: 'number',
				    default: 4,
			    })
			    .option('check-leaks-custom-encodings', {
				    description: 'check for values encoded with custom encodings (like salted SHA) with --check-leaks',
				    type: 'boolean',
				    default: true,
			    })
			    .option('check-leaks-poorly-delimited-substrings', {
				    description: 'besides decoding values, also encode them and search for their encodings (otherwise just search for hashes)',
				    type: 'boolean',
				    default: false,
			    })
			    .option('summary', {
				    description: 'provide a summary of each crawl result',
				    type: 'boolean',
				    default: true,
			    })
				.option('output', {
					alias: 'out',
					description: 'output file (--url) or directory (--urls-file)',
					type: 'string',
					normalize: true,
				}))
		  .demandCommand()
		  .strict()
		  .parseSync();

	if (!args.url === !args.urlsFile) throw new Error('specify either --url or --urls-file');

	let readOptions;
	if (args.config !== undefined) {
		const extension = path.extname(args.config).toLowerCase();
		switch (extension) {
			case '.json':
				readOptions = await consumers.json(fs.createReadStream(args.config))
					  .catch(reason => {
						  console.error('error parsing config file');
						  return Promise.reject(reason);
					  });
				break;
			case '.yml':
			case '.yaml':
				readOptions = yaml.load(await fsp.readFile(args.config, 'utf8'), {
					filename: path.basename(args.config),
					onWarning: console.warn,
				});
				break;
			default:
				throw new Error(`unknown config file extension: ${extension || '<none>'}`);
		}
	}
	if (args.configInline) {
		const overrideOptions: unknown = JSON.parse(args.configInline);
		readOptions                    = readOptions !== undefined
			  ? populateDefaults(overrideOptions, readOptions)
			  : overrideOptions;
	}

	const res = new jsonschema.Validator().validate(readOptions, configSchema);
	if (res.errors.length)
		throw new AggregateError(res.errors.map(String), 'config file validation failed');

	const options = populateDefaults<FullFieldsCollectorOptions>(
		  (readOptions ?? {}) as FieldsCollectorOptions,
		  FieldsCollector.defaultOptions);
	console.debug('⚙️ crawler config: %o', options);

	if (args.logLevel)
		if (!(logLevels as readonly string[]).includes(args.logLevel))
			throw new Error(`invalid log level: ${args.logLevel}`);
	const logLevel = args.logLevel as LogLevel | undefined;

	const apiBreakpoints = args.headed && args.devtools && args.pauseOnValueRead
		  ? breakpoints
		  : breakpoints.map(b => ({
			  ...b,
			  props: b.props.map(p => ({...p, pauseDebugger: false})),
			  methods: b.methods.map(m => ({...m, pauseDebugger: false})),
		  }));

	if (args.urlsFile) {
		if (!args.output) throw new Error('--output must be specified with --urls-file');
		const outputDir = args.output;

		const urlsStr = await fsp.readFile(args.urlsFile, 'utf8');
		const urls    = [...urlsStr.matchAll(/^\s*(.*\S)\s*$/mg)].map(m => m[1]!)
			  .filter(l => !l.startsWith('#')).map(u => new URL(u));
		console.log(`🕸 crawling ${urls.length} URLs (max ${args.parallelism} in parallel)`);

		await fsp.mkdir(outputDir, {recursive: true});

		const progressBar = new ProgressBar(' :bar :current/:total:msg │ ETA: :etas', {
			complete: chalk.green('═'),
			incomplete: chalk.gray('┄'),
			total: urls.length,
			width: 30,
		});
		progressBar.render({msg: ''});
		process.stdout.write('\x1b]9;4;1;0\x1b\\');

		const urlsInProgress: string[] = [];

		process.on('uncaughtExceptionMonitor', () => {
			process.stdout.write(`\x1b]9;4;2;${Math.floor(progressBar.curr / progressBar.total * 100)}\x1b\\`);
			console.log(`\nURLs for which crawl was in progress:\n${urlsInProgress.join('\n')}\n`);
		});

		process.setMaxListeners(Infinity);

		const browser = args.singleBrowser ? await puppeteer.launch({
			headless: !args.headed,
			devtools: args.devtools,
		}) : undefined;

		await eachLimit(urls, args.parallelism, async url => {
			urlsInProgress.push(url.href);
			try {
				const fileBase     = path.join(outputDir, `${Date.now()} ${sanitizeFilename(
					  url.hostname + (url.pathname !== '/' ? ` ${url.pathname.substring(1)}` : ''),
					  {replacement: '_'},
				)}`);
				let crawlStart: number | undefined;
				const fileLogger   = new FileLogger(`${fileBase}.log`,
					  args.logTimestamps
							? () => crawlStart !== undefined
								  ? `⌚️${((Date.now() - crawlStart) / 1e3).toFixed(1)}s`
								  : undefined
							: undefined);
				let logger: Logger = new TaggedLogger(fileLogger);
				logger.info(`🕸 crawling ${url.href} at ${new Date().toString()}`);
				if (logLevel) logger = new FilteringLogger(logger, logLevel);
				const counter = logger = new CountingLogger(logger);

				const output = await crawl(url, args, true, browser, options, apiBreakpoints, logger,
					  t => crawlStart = t);

				const errors   = counter.count('error'),
				      warnings = counter.count('warn');
				if (errors || warnings)
					progressBar.interrupt(`${errors ? `❌️${errors} ` : ''}${warnings ? `⚠️${warnings} ` : ''}${url.href}`);
				else if (args.logSucceeded)
					progressBar.interrupt(`✔️ ${url.href}`);

				await saveJson(`${fileBase}.json`, output);
				await fileLogger.finalize();
				if (args.summary)
					await fsp.writeFile(`${fileBase}.txt`, getSummary(output, options));
			} catch (err) {
				progressBar.interrupt(`❌️ ${url.href}: ${String(err)}`);
			}

			urlsInProgress.splice(urlsInProgress.indexOf(url.href), 1);
			progressBar.tick({
				msg: ` ✓ ${truncateLine(url.href, 60)}`,
			});
			process.stdout.write(`\x1b]9;4;1;${Math.floor(progressBar.curr / progressBar.total * 100)}\x1b\\`);
		});
		if (browser?.isConnected() === false)
			throw new Error('Browser quit unexpectedly, this may be a bug in Chromium');
		if (!args.headed || args.headedAutoclose)
			await browser?.close();
		progressBar.terminate();

		console.info('💾 data & logs saved to', outputDir);

	} else {
		const url = new URL(args.url!);

		let crawlStart: number | undefined;
		let logger: Logger = new ColoredLogger(new ConsoleLogger(
			  args.logTimestamps ?
					() => crawlStart !== undefined
						  ? `⌚️${((Date.now() - crawlStart) / 1e3).toFixed(1)}s`
						  : undefined
					: undefined));
		if (logLevel) logger = new FilteringLogger(logger, logLevel);

		process.stdout.write('\x1b]9;4;3;0\x1b\\');

		const output = await crawl(url, args, false, undefined, options, apiBreakpoints, logger,
			  t => crawlStart = t);

		if (output.leakedValues) {
			for (const {
				           type,
				           part,
				           header,
				           encodings,
				           requestIndex,
				           visitedTargetIndex
			           } of output.leakedValues) {
				const {url} = requestIndex !== undefined ? output.crawlResult.data.requests![requestIndex]!
					  : output.crawlResult.data.fields!.visitedTargets[visitedTargetIndex!]!;

				const typeStr = {
					email: '📧 email',
					password: '🔑 password',
				}[type];
				switch (part) {
					case 'url':
						logger.info(`💧 Found ${typeStr} in request URL: ${url}\n\tEncoded using ${encodings.join('→')}→value`);
						break;
					case 'header':
						logger.info(`💧 Found ${typeStr} in request header ${header!}: ${url}\n\tEncoded using ${encodings.join('→')}→value`);
						break;
					case 'body':
						logger.info(`💧 Found ${typeStr} in body of request to ${url}\n\tEncoded using ${encodings.join('→')}→value`);
						break;
					default:
						throw new UnreachableCaseError(part);
				}
			}
		}

		if (args.output) {
			await saveJson(args.output, output);
			console.info('💾 output written to', args.output);
		} else {
			// eslint-disable-next-line no-debugger
			debugger  // Give you the ability to inspect the result in a debugger
		}

		if (args.summary) {
			console.log('\n════ 📝 Summary: ════\n');
			console.log(getSummary(output, options));
		}
	}
	console.info('\x07\x1b]9;4;1;100\x1b\\');
}

async function crawl(
	  url: URL,
	  args: {
		  apiCalls: boolean,
		  requests: boolean,
		  autoConsent: string,
		  headed: boolean,
		  headedWait: boolean,
		  headedAutoclose: boolean,
		  devtools: boolean,
		  timeout: number,
		  checkThirdParty: boolean,
		  checkLeaks: boolean,
		  checkLeaksEncodeLayers: number,
		  checkLeaksDecodeLayers: number,
		  checkLeaksCustomEncodings: boolean,
		  checkLeaksPoorlyDelimitedSubstrings: boolean,
	  },
	  batchMode: boolean,
	  browser: Browser | undefined,
	  fieldsCollectorOptions: FieldsCollectorOptions,
	  apiBreakpoints: BreakpointObject[],
	  logger: Logger,
	  onStart: (crawlStartTime: number) => void,
): Promise<OutputFile> {
	const collectors: BaseCollector[]            = [];
	const collectorFlags: Record<string, string> = {};

	const fieldsCollector = new FieldsCollector(fieldsCollectorOptions, logger);
	if (args.headedWait)
		collectors.push(new WaitingCollector(
			  stripIndent`
			      \x07\x1b]9;4;4;0\x1b\\⏸️ Open the form to crawl, or fill some forms yourself!
				  Values that will be detected if leaked:
				  ${'\t'}📧 Email: ${fieldsCollector.options.fill.email}
				  ${'\t'}🔑 Password: ${fieldsCollector.options.fill.password}
				  Then press ⏎ to continue automatic crawl when you are done...\n`,
			  undefined,
			  () => console.log('\x1b]9;4;3;0\x1b\\▶️ Continuing'),
			  () => console.log('\n\x1b]9;4;3;0\x1b\\⏹️ Window was closed')));
	collectors.push(fieldsCollector);

	// Important: collectors for which we want getData to be called after FieldsCollector must be added after it
	if (args.apiCalls) collectors.push(new APICallCollector(apiBreakpoints));
	if (args.requests) collectors.push(new RequestCollector({saveResponseHash: false}));
	if (args.autoConsent !== 'noAction') {
		collectors.push(new CMPCollector());
		collectorFlags.autoconsentAction = args.autoConsent;
	}

	const browserContext = await browser?.createIncognitoBrowserContext();
	let crawlResult;
	try {
		crawlResult = await crawler(
			  url,
			  {
				  browserContext,
				  log: plainToLogger.bind(undefined, logger),
				  maxCollectionTimeMs: args.timeout * 1e3,
				  headed: args.headed,
				  keepOpen: args.headed && !args.headedAutoclose,
				  devtools: args.devtools,
				  collectors,
				  collectorFlags,
				  onError(err, context, collector) {
					  if (collector) logger.error(`collector ${collector.id()}:`, context, err);
					  else logger.error(context, err);
				  },
				  onStart,
			  },
		) as CrawlResult;
	} finally {
		if (!args.headed || args.headedAutoclose)
			await browserContext?.close();
	}
	logger.log();

	const output: OutputFile = {crawlResult};

	if (args.checkThirdParty)
		try {
			logger.log('🕵 checking third party & tracker info');
			await assignDomainInfo(crawlResult);
		} catch (err) {
			logger.error('error while adding third party & tracker info', err);
		}

	if (args.checkLeaks)
		try {
			logger.log('💧 searching for leaked values in web requests');
			const progressBar = batchMode ? undefined
				  : new ProgressBar(' :bar :current/:total │ ETA: :etas', {
					  complete: chalk.green('═'),
					  incomplete: chalk.gray('┄'),
					  total: 0,
					  width: 30,
				  });
			const start       = Date.now();
			try {
				output.leakedValues = await getLeakedValues(
					  fieldsCollector,
					  crawlResult,
					  args.checkLeaksEncodeLayers,
					  args.checkLeaksDecodeLayers,
					  args.checkLeaksPoorlyDelimitedSubstrings,
					  args.checkLeaksCustomEncodings,
					  progressBar && ((completed, total) => {
						  progressBar.total ||= total;
						  progressBar.update(completed / total);
					  }),
				);
			} finally {
				if (progressBar?.complete === false) progressBar.terminate();
			}
			logger.debug(`search took ${(Date.now() - start) / 1e3}s`);
		} catch (err) {
			logger.error('error while searching for leaks', err);
		}

	return output;
}

async function assignDomainInfo(crawlResult: CrawlResult) {
	const thirdPartyClassifier = await ThirdPartyClassifier.get(),
	      trackerClassifier    = await TrackerClassifier.get();

	const targetTypeMap: { [targetType in TargetCollector.TargetType]?: RequestType }        = {
		page: 'document',
		background_page: 'document',
	};
	const resourceTypeMap: { [resourceType in RequestCollector.ResourceType]?: RequestType } = {
		CSPViolationReport: 'csp_report',
		Document: 'document',
		Fetch: 'fetch',
		Font: 'font',
		Image: 'image',
		Media: 'media',
		Ping: 'ping',
		Script: 'script',
		Stylesheet: 'stylesheet',
		WebSocket: 'websocket',
		XHR: 'xmlhttprequest',
	};

	const getDomainInfo = (url: string, type: RequestType) => ({
		thirdParty: thirdPartyClassifier.isThirdParty(url, crawlResult.finalUrl),
		tracker: trackerClassifier.isTracker(url, crawlResult.finalUrl, type),
	});

	for (const target of crawlResult.data.fields?.visitedTargets ?? [])
		Object.assign(target, getDomainInfo(target.url, targetTypeMap[target.type] ?? 'other'));
	for (const request of crawlResult.data.requests ?? [])
		Object.assign(request, getDomainInfo(request.url, resourceTypeMap[request.type] ?? 'other'));
	for (const call of crawlResult.data.apis?.savedCalls ?? [])
		if (call.stack)
			call.stackInfo = call.stack.map(frame => {
				const file = frame.match(stackFrameFileRegex)?.[0];
				return file && validUrl(file) ? getDomainInfo(file, 'script') : null;
			});
}

let passwordSearcher: ValueSearcher | undefined,
    emailSearcher: ValueSearcher | undefined;

async function getLeakedValues(
	  fieldsCollector: FieldsCollector,
	  crawlResult: CrawlResult,
	  encodeLayers: number,
	  decodeLayers: number,
	  searchPoorlyDelimitedSubstring: boolean,
	  includeCustomEncodings: boolean,
	  onProgress: (completed: number, total: number) => void = () => {/**/},
): Promise<LeakedValue[]> {
	const createSearcher = async (value: string) => {
		const searcher = new ValueSearcher([
			...defaultTransformers,
			...(includeCustomEncodings ? [
				new HashTransform('sha256', undefined, undefined, Buffer.from('QX4QkKEU')),
				new CustomStringMapTransform(Object.fromEntries(
					  'kibp8A4EWRMKHa7gvyz1dOPt6UI5xYD3nqhVwZBXfCcFeJmrLN20lS9QGsjTuo'.split('')
							.map((
								  from,
								  i,
							) => [from, '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'[i]!]))),
			] : []),
		]);
		await searcher.addValue(
			  Buffer.from(value),
			  encodeLayers,
			  searcher.transformers.filter(t =>
					!(t instanceof CompressionTransform || t instanceof LZStringTransform)),
			  !searchPoorlyDelimitedSubstring);
		return searcher;
	};

	const searchers = {
		email: fieldsCollector.options.fill.appendDomainToEmail
			  ? await createSearcher(appendDomainToEmail(fieldsCollector.options.fill.email, new URL(crawlResult.initialUrl).hostname))
			  : emailSearcher ??= await createSearcher(fieldsCollector.options.fill.email),
		password: passwordSearcher ??= await createSearcher(fieldsCollector.options.fill.password),
	};

	let halfTotal: number | undefined;
	const completedMap = Object.fromEntries(Object.entries(searchers).map(([prop]) => [prop, 0])) as
		  Record<keyof typeof searchers, number>;
	return (await parallelLimit(Object.entries(searchers).map(([prop, searcher]) => async () =>
		  (await findValue(searcher,
				crawlResult.data.requests ?? [],
				crawlResult.data.fields?.visitedTargets.map(t => t.url) ?? [],
				decodeLayers,
				undefined,
				(completed, total) => {
					completedMap[prop as keyof typeof searchers] = completed;
					onProgress(sum(Object.values(completedMap)), (halfTotal ??= total) * 2);
				}))
				.map(entry => ({
					...entry,
					type: prop as keyof typeof searchers,
				} as const))), 1)).flat();
}

function plainToLogger(logger: Logger, ...args: unknown[]) {
	let level: LogLevel = 'log';
	if (typeof args[0] === 'string') {
		if (args[0].includes('\x1b[31m' /*red*/)) level = 'error';
		else if (args[0].includes('\x1b[33m' /*yellow*/)
			  || args[0].includes('⚠')
			  || args.some(a => a instanceof Error)) level = 'warn';
		else if (args[0].includes(' context initiated in ')
			  || args[0].includes(' init took 0.')) level = 'debug';
		args[0] = args[0].replace(/^⚠\s*/, '');
	}
	logger.logLevel(level, ...args);
}

async function saveJson(file: fs.PathLike | fsp.FileHandle, output: OutputFile) {
	await fsp.writeFile(file, JSON.stringify(output, (_key, value) =>
		  value instanceof Error ? String(value) : value as unknown, '\t'));
}

void (async () => {
	try {
		await main();
	} catch (err) {
		process.exitCode = 1;
		console.error('\n\x07❌️', err);
	} finally {
		mainExited = true;
	}
})();

export type FieldsCollectorDataEx = FieldsCollectorData & {
	visitedTargets: (VisitedTarget & Partial<ThirdPartyInfo>)[]
};

export type RequestDataEx = RequestCollector.RequestData & Partial<ThirdPartyInfo>;

export type SavedCallEx = APICallCollector.SavedCall & {
	custom: LeakDetectorCaptureData,
	stackInfo?: (ThirdPartyInfo | null)[],
};

export type APICallReportEx = APICallCollector.APICallReport & {
	savedCalls: SavedCallEx[],
};

export type CrawlResult = CollectResult & {
	data: {
		[fieldsId in ReturnType<typeof FieldsCollector.prototype.id>]?: FieldsCollectorDataEx | null
	} & {
		requests?: RequestDataEx[],
		apis?: APICallReportEx,
	}
};

export interface OutputFile {
	crawlResult: CrawlResult;
	leakedValues?: LeakedValue[];
}

export interface ThirdPartyInfo {
	thirdParty: boolean;
	tracker: boolean;
}

export interface LeakedValue extends FindEntry {
	type: 'password' | 'email';
}
