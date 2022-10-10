#!/usr/bin/env -S npx ts-node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import consumers from 'node:stream/consumers';

import async, {ErrorCallback, IterableCollection} from 'async';
import chalk from 'chalk';
import {RequestType} from '@gorhill/ubo-core';
import yaml from 'js-yaml';
import jsonschema from 'jsonschema';
import {lock} from 'proper-lockfile';
import type {Browser} from 'puppeteer';
import {sum} from 'rambda';
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
import * as progress from './progress';
import breakpoints, {LeakDetectorCaptureData} from './breakpoints';
import configSchema from './crawl-config.schema.json';
import {appendDomainToEmail, nonEmpty, populateDefaults, stripIndent, truncateLine, validUrl} from './utils';
import {findRequestLeaks, getSummary, RequestLeak} from './analysis';
import {ThirdPartyClassifier, TrackerClassifier} from './domainInfo';
import {WaitingCollector} from './WaitingCollector';
import {stackFrameFileRegex} from './pageUtils';
import {isNavigationError} from './puppeteerUtils';

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
		console.error('\n\n\x07❌️ Unexpected exit: Either Node.js was killed or ' +
			  'it prevented a hang due to a Promise that can never be fulfilled ' +
			  '(which may be a bug in the Puppeteer library)');
	}
});
process.on('exit', () => progress.terminate());

if (progress.isInteractive())
	process.stderr.write('\x1b]0;☔️ leak detector\x1b\\');

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
			    .option('log-batch-errors', {
				    description: 'Print error messages for non-fatal errors with --urls-file',
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
			    .option('load-timeout', {
				    description: 'timeout for loading the main page, in seconds',
				    type: 'number',
				    default: 30,
			    })
			    .option('collect-timeout', {
				    description: 'timeout for crawl, in seconds, or 0 to disable',
				    type: 'number',
				    default: 20 * 60,
			    })
			    .option('error-exit-code', {
				    description: 'set nonzero exit code on non-fatal error',
				    type: 'boolean',
			    })
			    .option('check-third-party', {
				    description: 'check if request URLs are of third party servers or trackers',
				    type: 'boolean',
				    default: true,
			    })
			    .option('check-request-leaks', {
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
			    })
			    .option('ignore-crawl-state', {
				    description: 'do not skip already crawled URLs in batch mode according to .crawl-state file',
				    type: 'boolean',
				    default: false,
			    }),
		  )
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
	console.debug('⚙️ crawler config: %o\n', options);

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

		let crawlStateWriter: fs.WriteStream;
		let urls: URL[];
		{
			{
				const urlsStr = await fsp.readFile(args.urlsFile, 'utf8');
				urls          = [...urlsStr.matchAll(/^\s*(.*\S)\s*$/mg)].map(m => m[1]!)
					  .filter(l => !l.startsWith('#'))
					  .map(s => new URL(s));
			}

			const crawlStatePath = path.join(args.output, '.crawl-state');
			try {
				await lock(crawlStatePath);
			} catch (err) {
				throw new Error(
					  'failed to lock .crawl-state.lock; is another crawl process already running in this folder?',
					  {cause: err});
			}
			const crawlStateFile = await fsp.open(crawlStatePath, 'as+');

			const urlStates = new Map<string, 'started' | 'finished'>();
			{
				const crawlStateRead = crawlStateFile.createReadStream({autoClose: false});
				const lines          = readline.createInterface({
					input: crawlStateRead,
					terminal: false,
				});
				for await (let line of lines) {
					line = line.trim();
					if (!line || line.startsWith('#')) continue;
					const item = JSON.parse(line) as CrawlStateLine;
					switch (item.type) {
						case 'start':
							urlStates.set(item.url, 'started');
							break;
						case 'end':
							urlStates.set(item.url, 'finished');
							break;
					}
				}
				lines.close();
			}

			let startedCount = 0, finishedCount = 0;
			const newUrls    = urls.filter(u => {
				const state = urlStates.get(u.href);
				switch (state) {
					case 'started':
						++startedCount;
						break;
					case 'finished':
						++finishedCount;
						break;
				}
				return state !== 'finished';
			});
			if (!args.ignoreCrawlState) {
				urls = newUrls;
				if (finishedCount) console.log(`⏭️ skipping ${finishedCount} already fully crawled URLs`);
			} else {
				if (finishedCount) console.log(`🔁️ re-crawling ${finishedCount} already fully crawled URLs`);
			}
			if (startedCount) console.log(`🔁️ restarting ${startedCount} previously interrupted crawls`);

			crawlStateWriter = crawlStateFile.createWriteStream({highWaterMark: 0} as unknown as fsp.CreateWriteStreamOptions);
			crawlStateWriter.setMaxListeners(Infinity);
		}

		console.log(`🕸 crawling ${urls.length} URLs (max ${args.parallelism} in parallel)`);

		await fsp.mkdir(outputDir, {recursive: true});

		progress.init(' :bar :current/:total:msg │ ETA: :etas', urls.length);
		progress.update(0, {msg: ''});

		const urlsInProgress: { url: string, startTime: number }[] = [];

		process.on('uncaughtExceptionMonitor', () => {
			progress.setState('error');
			console.log(`\nURLs for which crawl was in progress:\n${
				  urlsInProgress.map(({url, startTime}) => `⏱️${(Date.now() - startTime) / 1e3}s ${url}`)
						.join('\n')}\n`);
		});

		process.setMaxListeners(Infinity);

		const batchCrawlStart = Date.now();

		const browser = args.singleBrowser ? await puppeteer.launch({
			headless: !args.headed,
			devtools: args.devtools,
		}) : undefined;

		async function writeCrawlState(line: CrawlStateLine): Promise<void> {
			async function waitForDrain(writer: fs.WriteStream): Promise<void> {
				if (writer.writableNeedDrain)
					await new Promise(resolve => writer.once('drain', resolve));
			}

			await waitForDrain(crawlStateWriter);
			crawlStateWriter.write(`${JSON.stringify(line)}\n`);
			await waitForDrain(crawlStateWriter);
		}

		await writeCrawlState({
			type: 'batch-start',
			time: Date.now(),
		});

		let urlsFinished = 0;
		await eachLimit(urls, args.parallelism, async url => {
			urlsInProgress.push({url: url.href, startTime: Date.now()});
			let error: unknown | undefined;
			try {
				const fileBaseName = truncateLine(`${Date.now()} ${sanitizeFilename(
					  url.hostname + (url.pathname !== '/' ? ` ${url.pathname.substring(1)}` : ''),
					  {replacement: '_'},
				)}`, 50);
				const fileBase     = path.join(outputDir, fileBaseName);
				await writeCrawlState({
					type: 'start',
					time: Date.now(),
					url: url.href,
					fileBaseName,
				});
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
				const errorCapture = args.logBatchErrors
					  ? logger = new ErrorCaptureLogger(logger)
					  : undefined;
				const counter      = logger = new CountingLogger(logger);

				try {
					const output = await crawl(url, args, true, browser, options, apiBreakpoints, logger,
						  t => crawlStart = t);

					const errors   = counter.count('error'),
					      warnings = counter.count('warn');
					if (errors || warnings) {
						progress.log(`${errors ? `❌️${errors} ` : ''}${warnings ? `⚠️${warnings} ` : ''}${url.href}`);
						for (const {level, args} of errorCapture?.errors ?? [])
							progress.log(`\t${level === 'error' ? '❌️' : '⚠️'} ${args.map(String).join(' ')}`);
					} else if (args.logSucceeded)
						progress.log(`✔️ ${url.href}`);

					await saveJson(`${fileBase}.json`, output);
					if (args.summary)
						try {
							await fsp.writeFile(`${fileBase}.txt`, getSummary(output, options));
						} catch (err) {
							logger.error('failed to create summary', err);
							progress.log(`❌️ ${url.href}: failed to create summary: ${String(err)}`);
						}
				} catch (err) {
					error = err;
					logger.error(err);
					progress.log(`❌️ ${url.href}: ${String(err)}`);
				} finally {
					logger.log('DONE.');
					await fileLogger.finalize();
				}
			} catch (err) {
				error = err;
				progress.log(`❌️ Unexpected error: ${url.href}: ${String(err)}`);
			} finally {
				urlsInProgress.splice(urlsInProgress.findIndex(e => e.url === url.href), 1);
				progress.update(++urlsFinished / urls.length, {
					msg: ` ✓ ${truncateLine(url.href, 60)}`,
				});
				await writeCrawlState({
					type: 'end',
					time: Date.now(),
					url: url.href,
					...error !== undefined ? {error: error instanceof Error ? error.stack ?? String(error) : error} : {},
				});
			}
		});
		if (browser?.isConnected() === false)
			throw new Error('Browser quit unexpectedly, this may be a bug in Chromium');
		if (!args.headed || args.headedAutoclose)
			await browser?.close();
		progress.terminate();

		await writeCrawlState({
			type: 'batch-end',
			time: Date.now(),
		});

		console.log(`Batch crawl took ${(Date.now() - batchCrawlStart) / 1e3}s`);
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

		progress.setState('indeterminate');

		const output = await crawl(url, args, false, undefined, options, apiBreakpoints, logger,
			  t => crawlStart = t);

		if (output.requestLeaks) {
			for (const {
				           type,
				           part,
				           header,
				           encodings,
				           requestIndex,
				           visitedTargetIndex
			           } of output.requestLeaks) {
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
			console.info('\n💾 output written to', args.output);
		} else {
			// eslint-disable-next-line no-debugger
			debugger  // Give you the ability to inspect the result in a debugger
			console.info('\nTo save details in JSON form, specify --output');
		}

		if (args.summary) {
			console.info(chalk.bold(chalk.blueBright('\n\n════ 📝 Summary: ════\n')));
			console.log(getSummary(output, options));
		}
	}
	process.stderr.write('\x07');
	progress.setState('complete');
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
		  collectTimeout: number,
		  loadTimeout: number,
		  errorExitCode: boolean | undefined,
		  checkThirdParty: boolean,
		  checkRequestLeaks: boolean,
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
			      \x07⏸️ Open the form to crawl, or fill some forms yourself!
				  Values that will be detected if leaked:
				  ${'\t'}📧 Email: ${fieldsCollector.options.fill.email}
				  ${'\t'}🔑 Password: ${fieldsCollector.options.fill.password}
				  Then press ⏎ to continue automatic crawl when you are done...\n`,
			  () => progress.setState('paused'),
			  () => {
				  progress.setState('indeterminate');
				  console.log('▶️ Continuing');
			  },
			  () => {
				  progress.setState('indeterminate');
				  console.log('\n⏹️ Window was closed');
			  }));
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
				  maxLoadTimeMs: args.loadTimeout * 1e3,
				  maxCollectionTimeMs: args.collectTimeout * 1e3,
				  headed: args.headed,
				  keepOpen: args.headed && !args.headedAutoclose,
				  devtools: args.devtools,
				  collectors,
				  collectorFlags,
				  onError(err, context, collector) {
					  if (args.errorExitCode ?? !batchMode)
						  process.exitCode = 1;
					  let level: LogLevel = 'error';
					  if (isNavigationError(err)) level = 'log';
					  if (collector) logger.logLevel(level, `collector ${collector.id()}:`, context, err);
					  else logger.logLevel(level, context, err);
				  },
				  onStart,
			  },
		) as CrawlResult;
	} finally {
		if (!args.headed || args.headedAutoclose)
			await browserContext?.close();
	}
	logger.log();

	if (crawlResult.timeout) logger.warn('note: we got a timeout while loading the main page');

	if ((args.errorExitCode ?? !batchMode) && nonEmpty(crawlResult.data.fields?.errors))
		process.exitCode = 1;

	const output: OutputFile = {crawlResult, durationsMs: {}};

	if (args.checkThirdParty) {
		const start = Date.now();
		try {
			logger.log('👁 checking third party & tracker info');
			await assignDomainInfo(crawlResult);
		} catch (err) {
			logger.error('error while adding third party & tracker info', err);
		}
		output.durationsMs.thirdPartyCheck = Date.now() - start;
	}

	if (args.checkRequestLeaks) {
		const start = Date.now();
		try {
			logger.log('💧 searching for leaked values in web requests');
			let progressInitialized = false;
			try {
				output.requestLeaks = await getRequestLeaks(
					  fieldsCollector,
					  crawlResult,
					  args.checkLeaksEncodeLayers,
					  args.checkLeaksDecodeLayers,
					  args.checkLeaksPoorlyDelimitedSubstrings,
					  args.checkLeaksCustomEncodings,
					  !batchMode ? ((completed, total) => {
						  if (!progressInitialized) {
							  progressInitialized = true;
							  progress.init(' :bar :current/:total │ ETA: :etas', total);
						  }
						  progress.update(completed / total);
					  }) : undefined,
				);
			} finally {
				if (!batchMode) progress.terminate();
			}
			logger.debug(`search took ${(Date.now() - start) / 1e3}s`);
		} catch (err) {
			logger.error('error while searching for request leaks', err);
		}
		output.durationsMs.requestLeakCheck = Date.now() - start;
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

async function getRequestLeaks(
	  fieldsCollector: FieldsCollector,
	  crawlResult: CrawlResult,
	  encodeLayers: number,
	  decodeLayers: number,
	  searchPoorlyDelimitedSubstring: boolean,
	  includeCustomEncodings: boolean,
	  onProgress?: (completed: number, total: number) => void,
): Promise<RequestLeakEx[]> {
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
	const requests     = crawlResult.data.requests?.slice();
	return (await parallelLimit(Object.entries(searchers).map(([prop, searcher]) => async () =>
		  (await findRequestLeaks(searcher,
				requests ?? [],
				crawlResult.data.fields?.visitedTargets.map(t => t.url) ?? [],
				decodeLayers,
				undefined,
				onProgress && ((completed, total) => {
					completedMap[prop as keyof typeof searchers] = completed;
					onProgress(sum(Object.values(completedMap)), (halfTotal ??= total) * 2);
				})))
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
			  || args.some(a => a instanceof Error)) level = 'warn';
		else if (args[0].includes(' context initiated in ')
			  || args[0].includes(' init took 0.')) level = 'debug';
	}
	logger.logLevel(level, ...args);
}

async function saveJson(file: fs.PathLike | fsp.FileHandle, output: OutputFile) {
	await fsp.writeFile(file, JSON.stringify(output, (_key, value: unknown) =>
		  value instanceof Error ? value.stack ?? String(value) : value, '\t'));
}

class ErrorCaptureLogger extends Logger {
	readonly errors: { level: 'warn' | 'error', args: unknown[] }[] = [];
	#log: Logger | undefined;

	constructor(logger?: Logger) {
		super();
		this.#log = logger;
	}

	logLevel(level: LogLevel, ...args: unknown[]) {
		this.#log?.logLevel(level, ...args);
		if (level === 'error' || level === 'warn')
			this.errors.push({level, args});
	}

	startGroup(name: string) {this.#log?.startGroup(name);}

	endGroup() {this.#log?.endGroup();}
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

export type CrawlStateLine = {
	type: 'batch-start' | 'batch-end',
	time: number,
} | {
	type: 'start';
	time: number,
	url: string;
	fileBaseName: string;
} | {
	type: 'end';
	time: number,
	url: string;
	error?: unknown;
};

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
	requestLeaks?: RequestLeakEx[];
	durationsMs: {
		thirdPartyCheck?: number;
		requestLeakCheck?: number;
	};
}

export interface ThirdPartyInfo {
	thirdParty: boolean;
	tracker: boolean;
}

export interface RequestLeakEx extends RequestLeak {
	type: 'password' | 'email';
}
