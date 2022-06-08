import fs from 'node:fs';
import consumers from 'node:stream/consumers';

import jsonschema from 'jsonschema';
import {APICallCollector, crawler, RequestCollector} from 'tracker-radar-collector';
import yargs from 'yargs';

import {FieldsCollector, FieldsCollectorOptions} from './FieldsCollector';
import {ConsoleLogger} from './logger';
import breakpoints from './breakpoints';
import configSchema from './crawl-config.schema.json';

async function main() {
	const args = yargs
		  .command('crawl <url>', 'crawl a URL', yargs => yargs
				.positional('url', {
					description: 'URL of homepage to crawl',
					type: 'string',
					demandOption: true,
				})
				.option('config', {
					description: 'path to configuration file, see src/crawl-config.schema.json for syntax',
					type: 'string',
					normalize: true,
				})
				.option('output', {
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
	}

	const result = await crawler(
		  new URL(args.url),
		  {
			  log: console.log,
			  maxCollectionTimeMs: 120_000,
			  collectors: [
				  new FieldsCollector(options, new ConsoleLogger()),
				  new APICallCollector(breakpoints),
				  new RequestCollector(),
			  ],
		  },
	);
	if (args.output) {
		fs.writeFileSync(args.output, JSON.stringify(result, undefined, '\t'));
		console.info('output written to', args.output);
	} else {
		console.info(result);
		// eslint-disable-next-line no-debugger
		debugger  // Give you the ability to inspect the result in a debugger
		console.log(JSON.stringify(result, undefined, 2));
	}
}

void (async () => {
	try {
		await main();
	} catch (err) {
		console.error(err);
		if (err instanceof AggregateError)
			for (const [index, inner] of err.errors.entries())
				console.error(`[Inner error ${index + 1}/${err.errors.length}]`, inner);
	}
})();
