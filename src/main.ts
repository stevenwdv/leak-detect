import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import consumers from 'node:stream/consumers';

import async, {ErrorCallback, IterableCollection} from 'async';
import chalk from 'chalk';
import yaml from 'js-yaml';
import jsonschema from 'jsonschema';
import ProgressBar from 'progress';
import sanitizeFilename from 'sanitize-filename';
import {APICallCollector, BaseCollector, crawler, RequestCollector} from 'tracker-radar-collector';
import {CollectResult} from 'tracker-radar-collector/crawler';
import yargs from 'yargs';

import {defaultOptions, FieldCollectorData, FieldsCollector, FieldsCollectorOptions} from './FieldsCollector';
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
import breakpoints from './breakpoints';
import configSchema from './crawl-config.schema.json';
import {appendDomainToEmail, populateDefaults} from './utils';
import {findValue} from './analysis';
import {UnreachableCaseError} from 'ts-essentials';

// Fix wrong type
const eachLimit = async.eachLimit as <T, E = Error>(
	  arr: IterableCollection<T>, limit: number,
	  iterator: (item: T, callback: ErrorCallback<E>) => Promise<void> /*added*/ | void,
) => Promise<void>;

process.on('uncaughtExceptionMonitor', (error, origin) =>
	  console.error('\n❌️', origin));

process.on('exit', () => process.stdout.write('\x1B]9;4;0;0\x1B\\'));

async function main() {
	const args = yargs
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
					default: 30,
				})
				.option('config', {
					description: 'path to configuration JSON/YAML file for fields collector, see src/crawl-config.schema.json for syntax',
					type: 'string',
					normalize: true,
				})
				.option('log-level', {
					description: `log level for crawl; one of ${logLevels.join(', ')}`,
					type: 'string',
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
				.option('headed', {
					description: 'open a browser window',
					type: 'boolean',
					default: false,
				})
				.option('devtools', {
					description: 'open developer tools',
					type: 'boolean',
					default: false,
				})
				.option('timeout', {
					description: 'timeout for crawl, in seconds, or 0 to disable',
					type: 'number',
					default: 0,
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

	let options: FieldsCollectorOptions = {};
	if (args.config !== undefined) {
		const extension = path.extname(args.config).toLowerCase();
		switch (extension) {
			case '.json':
				options = await consumers.json(fs.createReadStream(args.config))
					  .catch(reason => {
						  console.error('error parsing config file');
						  return Promise.reject(reason);
					  }) as FieldsCollectorOptions;
				break;
			case '.yml':
			case '.yaml':
				options = yaml.load(await fsp.readFile(args.config, 'utf8'), {
					filename: path.basename(args.config),
					onWarning: console.warn,
				}) as FieldsCollectorOptions;
				break;
			default:
				throw new Error(`unknown config file extension: ${extension || '<none>'}`);
		}

		const res = new jsonschema.Validator().validate(options, configSchema);
		if (res.errors.length)
			throw new AggregateError(res.errors.map(String), 'config file validation failed');
	}

	console.debug('crawler config: %o', populateDefaults(options, defaultOptions));

	if (args.logLevel)
		if (!(logLevels as readonly string[]).includes(args.logLevel))
			throw new Error(`invalid log level: ${args.logLevel}`);
	const logLevel = args.logLevel as LogLevel | undefined;

	const apiBreakpoints = args.headed && args.devtools
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
		console.log(`crawling ${urls.length} URLs (max ${args.parallelism} in parallel)`);

		await fsp.mkdir(outputDir, {recursive: true});

		const progressBar = new ProgressBar(' :bar :current/:total:msg │ ETA: :etas', {
			complete: chalk.green('═'),
			incomplete: chalk.gray('┄'),
			total: urls.length,
			width: 30,
		});
		progressBar.render({msg: ''});
		process.stdout.write('\x1B]9;4;1;0\x1B\\');

		const urlsInProgress = new Set<string>();

		process.on('uncaughtExceptionMonitor', () =>
			  console.log('URLs for which crawl was in progress:\n', [...urlsInProgress].join('\n')));

		process.setMaxListeners(Infinity);
		await eachLimit(urls, args.parallelism, async url => {
			urlsInProgress.add(url.href);
			try {
				const fileBase     = path.join(outputDir, sanitizeFilename(
					  url.hostname + (url.pathname !== '/' ? ` ${url.pathname.substring(1)}` : ''),
					  {replacement: '_'},
				));
				const fileLogger   = new FileLogger(`${fileBase}.log`);
				let logger: Logger = new TaggedLogger(fileLogger);
				logger.info(`crawling ${url.href} at ${new Date().toString()}`);
				if (logLevel) logger = new FilteringLogger(logger, logLevel);
				const counter = logger = new CountingLogger(logger);

				const fieldsCollector             = new FieldsCollector(options, logger);
				const collectors: BaseCollector[] = [fieldsCollector];
				if (args.apiCalls) collectors.push(new APICallCollector(apiBreakpoints));
				if (args.requests) collectors.push(new RequestCollector());

				const crawlResult = await crawler(
					  url,
					  {
						  log: plainToLogger.bind(undefined, logger),
						  maxCollectionTimeMs: args.timeout * 1e3,
						  throwCollectorErrors: false,
						  headed: args.headed,
						  keepOpen: args.headed,
						  devtools: args.devtools,
						  collectors,
					  },
				) as CrawlResult;

				const output: OutputFile = {crawlResult};

				try {
					const leakedValues = await getLeakedValues(fieldsCollector, crawlResult);
					if (leakedValues) output.leakedValues = leakedValues;
				} catch (err) {
					logger.error('error while searching for leaks', err);
				}

				const errors   = counter.count('error'),
				      warnings = counter.count('warn');
				if (errors || warnings)
					progressBar.interrupt(`${errors ? `❌️${errors} ` : ''}${warnings ? `⚠️${warnings} ` : ''}${url.href}`);

				await fsp.writeFile(`${fileBase}.json`, JSON.stringify(output, undefined, '\t'));
				await fileLogger.finalize();
			} catch (err) {
				progressBar.interrupt(`❌️ ${url.href}: ${String(err)}`);
			}
			urlsInProgress.delete(url.href);
			const maxUrlLength = 70;
			progressBar.tick({
				msg: ` ✔️ ${
					  url.href.length > maxUrlLength ? `${url.href.substring(0, maxUrlLength - 1)}…` : url.href}`,
			});
			process.stdout.write(`\x1B]9;4;1;${Math.floor(progressBar.curr / progressBar.total * 100)}\x1B\\`);
		});
		progressBar.terminate();

		console.info('data & logs saved to', outputDir);

	} else {
		const url = new URL(args.url!);

		let logger: Logger = new ColoredLogger(new ConsoleLogger());
		if (logLevel) logger = new FilteringLogger(logger, logLevel);

		const fieldsCollector             = new FieldsCollector(options, logger);
		const collectors: BaseCollector[] = [fieldsCollector];
		if (args.apiCalls) collectors.push(new APICallCollector(apiBreakpoints));
		if (args.requests) collectors.push(new RequestCollector());

		process.stdout.write('\x1B]9;4;3;0\x1B\\');
		const crawlResult = await crawler(
			  url,
			  {
				  log: plainToLogger.bind(undefined, logger),
				  maxCollectionTimeMs: args.timeout * 1e3,
				  throwCollectorErrors: true,
				  headed: args.headed,
				  keepOpen: args.headed,
				  devtools: args.devtools,
				  collectors,
			  },
		) as CrawlResult;

		const output: OutputFile = {crawlResult};

		logger.log('searching for leaked values in web requests');
		const leakedValues = await getLeakedValues(fieldsCollector, crawlResult);
		if (leakedValues) {
			output.leakedValues = leakedValues;
			for (const {type, requestIndex, part, encodings} of leakedValues) {
				const {url} = crawlResult.data.requests![requestIndex]!;
				switch (part) {
					case 'url':
						logger.info(`Found ${type} in request URL: ${url}\n\tEncoded using ${encodings.join('→')}→value`);
						break;
					case 'body':
						logger.info(`Found ${type} in body of request to ${url}\n\tEncoded using ${encodings.join('→')}→value`);
						break;
					default:
						throw new UnreachableCaseError(part);
				}
			}
		}

		if (args.output) {
			await fsp.writeFile(args.output, JSON.stringify(output, undefined, '\t'));
			console.info('output written to', args.output);
		} else {
			console.info('%o', output);  // %o: print more properties
			// eslint-disable-next-line no-debugger
			debugger  // Give you the ability to inspect the result in a debugger
		}
	}
	console.info('\x07');
}

async function getLeakedValues(
	  fieldsCollector: FieldsCollector, crawlResult: CollectResult): Promise<null | LeakedValue[]> {
	const requests = crawlResult.data.requests;
	if (!requests) return null;

	const values = {
		email: fieldsCollector.options.fill.appendDomainToEmail
			  ? appendDomainToEmail(fieldsCollector.options.fill.email, new URL(crawlResult.initialUrl).hostname)
			  : fieldsCollector.options.fill.email,
		password: fieldsCollector.options.fill.password,
	};

	return (await Promise.all(Object.entries(values).map(async ([prop, value]) =>
		  (await findValue(value, requests))
				.map(({part, request, encodings}) => ({
					type: prop as keyof typeof values,
					requestIndex: requests.indexOf(request),
					part, encodings,
				} as const))))).flat();
}

function plainToLogger(logger: Logger, ...args: unknown[]) {
	let level: LogLevel = 'log';
	if (typeof args[0] === 'string') {
		if (args[0].includes('\x1B[31m' /*red*/)) level = 'error';
		else if (args[0].includes('\x1B[33m' /*yellow*/) || args[0].includes('⚠')) level = 'warn';
	}
	logger.logLevel(level, ...args);
}

void main().catch(err => console.error('\n❌️', err));

type CrawlResult =
	  CollectResult
	  & { data: { [fieldsId in ReturnType<typeof FieldsCollector.prototype.id>]?: FieldCollectorData } };

interface OutputFile {
	crawlResult: CrawlResult;
	leakedValues?: LeakedValue[];
}

interface LeakedValue {
	type: 'password' | 'email';
	requestIndex: number;
	part: 'url' | 'body';
	/** Encodings (e.g. `uri`) that were used to encode value, outside-in */
	encodings: string[];
}
