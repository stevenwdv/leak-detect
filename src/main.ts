import fs from 'node:fs';
import path from 'node:path';
import consumers from 'node:stream/consumers';

import yaml from 'js-yaml';
import jsonschema from 'jsonschema';
import {APICallCollector, BaseCollector, crawler, RequestCollector} from 'tracker-radar-collector';
import yargs from 'yargs';

import {FieldsCollector, FieldsCollectorOptions} from './FieldsCollector';
import {ColoredLogger, ConsoleLogger} from './logger';
import breakpoints from './breakpoints';
import configSchema from './crawl-config.schema.json';
import {logError} from './utils';

async function main() {
	const args = yargs
		  .command('crawl <url>', 'crawl a URL', yargs => yargs
			    .positional('url', {
				    description: 'URL of homepage to crawl',
				    type: 'string',
				    demandOption: true,
			    })
			    .option('config', {
				    description: 'path to configuration JSON/YAML file for fields collector, see src/crawl-config.schema.json for syntax',
				    type: 'string',
				    normalize: true,
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
				    description: 'output file path',
				    type: 'string',
				    normalize: true,
			    }))
		  .demandCommand()
		  .strict()
		  .parseSync();

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
				options = yaml.load(fs.readFileSync(args.config, {encoding: 'utf8'}), {
					filename: path.basename(args.config),
					onWarning: console.warn,
				}) as FieldsCollectorOptions;
				break;
			default:
				throw new Error(`unknown config file extension: ${extension || '<none>'}`);
		}

		const res = new jsonschema.Validator().validate(options, configSchema);
		if (res.errors.length)
			throw new AggregateError(res.errors.map(err => err.stack /*actually more like message*/),
				  'config file validation failed');
		console.debug('loaded config: %o', options);
	}

	const collectors: BaseCollector[] = [
		new FieldsCollector(options, new ColoredLogger(new ConsoleLogger())),
	];
	if (args.apiCalls) collectors.push(
		  new APICallCollector(args.headed && args.devtools
				? breakpoints
				: breakpoints.map(b => ({
					...b,
					props: b.props.map(p => ({...p, pauseDebugger: false})),
					methods: b.methods.map(m => ({...m, pauseDebugger: false})),
				}))));
	if (args.requests) collectors.push(new RequestCollector());

	const result = await crawler(
		  new URL(args.url),
		  {
			  log: console.log,
			  maxCollectionTimeMs: args.timeout * 1e3,
			  throwCollectorErrors: true,
			  headed: args.headed,
			  keepOpen: args.headed,
			  devtools: args.devtools,
			  collectors,
		  },
	);
	if (args.output) {
		fs.writeFileSync(args.output, JSON.stringify(result, undefined, '\t'));
		console.info('output written to', args.output);
	} else {
		console.info('%o', result);  // %o: print more properties
		// eslint-disable-next-line no-debugger
		debugger  // Give you the ability to inspect the result in a debugger
	}
}

void main().catch(logError);
