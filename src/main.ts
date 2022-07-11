import fs from 'node:fs';
import consumers from 'node:stream/consumers';

import jsonschema from 'jsonschema';
import {APICallCollector, crawler, RequestCollector} from 'tracker-radar-collector';
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
				    description: 'path to configuration file for collector, see src/crawl-config.schema.json for syntax',
				    type: 'string',
				    normalize: true,
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

	const options = args.config
		  ? await consumers.json(fs.createReadStream(args.config))
				.catch(reason => {
					console.error('error parsing config file');
					return Promise.reject(reason);
				}) as FieldsCollectorOptions
		  : {};

	if (args.config) {
		const res = new jsonschema.Validator().validate(options, configSchema);
		if (res.errors.length)
			throw new AggregateError(res.errors.map(err => err.stack /*actually more like message*/),
				  'config file validation failed');
		console.debug('loaded config: %o', options);
	}

	const result = await crawler(
		  new URL(args.url),
		  {
			  log: console.log,
			  maxCollectionTimeMs: args.timeout * 1e3,
			  throwCollectorErrors: true,
			  headed: args.headed,
			  keepOpen: args.headed,
			  devtools: args.devtools,
			  collectors: [
				  new FieldsCollector(options, new ColoredLogger(new ConsoleLogger())),
				  new APICallCollector(args.headed && args.devtools
						? breakpoints
						: breakpoints.map(b => ({
							...b,
							props: b.props.map(p => ({...p, pauseDebugger: false})),
							methods: b.methods.map(m => ({...m, pauseDebugger: false})),
						}))),
				  new RequestCollector(),
			  ],
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
