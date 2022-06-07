import {APICallCollector, crawler, RequestCollector} from 'tracker-radar-collector';
import yargs from 'yargs';

import {FieldsCollector} from './FieldsCollector';
import {ConsoleLogger} from './logger';
import breakpoints from './breakpoints';

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

	const result = await crawler(
		  new URL(args.url),
		  {
			  log: console.log,
			  maxCollectionTimeMs: 120_000,
			  collectors: [
				  new FieldsCollector({}, new ConsoleLogger()),
				  new APICallCollector(breakpoints),
				  new RequestCollector(),
			  ],
		  },
	);
	console.info(result);
	// eslint-disable-next-line no-debugger
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
