import fs from 'node:fs';

import {APICallCollector, crawler, RequestCollector} from 'tracker-radar-collector';
import yargs from 'yargs';

import {FieldsCollector} from './FieldsCollector';
import {ConsoleLogger} from './logger';
import breakpoints from './breakpoints';
import {formatDuration} from './utils';
import ErrnoException = NodeJS.ErrnoException;

async function main() {
	const args = yargs
		  .command('crawl <url>', 'crawl a URL', yargs =>
				yargs.positional('url', {
					description: 'URL of homepage to crawl',
					type: 'string',
					demandOption: true,
				}))
		  .demandCommand()
		  .strict()
		  .parseSync();

	let bundleTime;
	try {
		bundleTime = fs.statSync('./inject/dist/bundle.js').mtimeMs;
	} catch (err) {
		if ((err as ErrnoException).code === 'ENOENT')
			console.error('Bundle to inject not found, run `npm run pack` in the `inject` folder');
		throw err;
	}
	const timeDiff = fs.statSync('./inject/src/main.ts').mtimeMs - bundleTime;
	if (timeDiff > 0)
		console.error(`!!! inject script was modified ${formatDuration(timeDiff)} after bundle creation, ` +
			  'you should probably run `npm run pack` in the `inject` folder !!!');

	const result = await crawler(
		  new URL(args.url),
		  {
			  log: console.log,
			  maxCollectionTimeMs: 120_000,
			  collectors: [
				  new FieldsCollector(new ConsoleLogger()),
				  new APICallCollector(breakpoints),
				  new RequestCollector(),
			  ],
		  },
	);
	console.info(result);
	debugger  // Give you the ability to inspect the result in a debugger
	console.log(JSON.stringify(result, undefined, 2));
}

void (async () => {
	try {
		await main();
	} catch (err) {
		console.error(err);
	}
})();
