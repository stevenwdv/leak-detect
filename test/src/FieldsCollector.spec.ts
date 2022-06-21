import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

import {createServer} from 'http-server';
import {AddressInfo} from 'net';
import t from 'tap';
import {DeepPartial} from 'ts-essentials';

import {crawler} from 'tracker-radar-collector';

import {
	ClickLinkEvent,
	FieldCollectorData,
	FieldsCollector,
	FieldsCollectorOptions,
	FillEvent,
} from '../../src/FieldsCollector';
import {ConsoleLogger} from '../../src/logger';

void (async () => {
	const {server, baseUrl} = await
		  new Promise<{ server: http.Server | https.Server, baseUrl: URL }>((resolve, reject) => {
			  const server = (createServer({
				  root: path.join(__dirname, '../pages/'),
			  }) as ReturnType<typeof createServer> & { server: http.Server | https.Server }).server
					.listen(undefined, 'localhost')
					.once('listening', () => {
						const addr    = server.address() as AddressInfo;
						const baseUrl = new URL(`http://localhost:${addr.port}/`);
						resolve({server, baseUrl});
					})
					.once('error', reject);
		  });

	void t.test(FieldsCollector.name, t => {
		t.teardown(() => new Promise<void>((resolve, reject) =>
			  server.close(err => err ? reject(err) : resolve())));

		async function runCrawler(page: string, options: DeepPartial<FieldsCollectorOptions> = {}): Promise<FieldCollectorData> {
			return ((await crawler(
				  new URL(page, baseUrl),
				  {
					  log: console.log,
					  maxCollectionTimeMs: 120_000,
					  collectors: [
						  new FieldsCollector(options, new ConsoleLogger()),
					  ],
				  },
			)).data as { [f in ReturnType<typeof FieldsCollector.prototype.id>]: FieldCollectorData }).fields;
		}

		//TODO extend
		return Promise.all([
			t.test('should work for a simple form', async t => {
				const result = await runCrawler('login_form.html');
				t.equal(result.fields.length, 2, 'should find 2 fields');
				t.ok(result.fields.find(field => field.fieldType === 'email'), 'should find email field');
				t.ok(result.fields.find(field => field.fieldType === 'password'), 'should find password field');
			}),
			t.test('should work for a frame', async t => {
				const result = await runCrawler('login_form_frame.html');
				t.equal(result.fields.length, 2, 'should find 2 fields');
				t.ok(result.fields.find(field => field.fieldType === 'email'), 'should find email field');
				t.ok(result.fields.find(field => field.fieldType === 'password'), 'should find password field');
			}),
			t.test('should handle hidden popup', async t => {
				const result       = await runCrawler('login_form_hidden.html');
				const popupOpenIdx = result.events.findIndex(ev =>
					  ev instanceof ClickLinkEvent && ev.link.join().includes('popupLink'));
				const fillIdx      = result.events.findIndex(ev => ev instanceof FillEvent);
				t.ok(popupOpenIdx >= 0, 'should open popup');
				t.ok(popupOpenIdx < fillIdx, 'should fill after opening popup');

				t.equal(result.fields.length, 2, 'should find 2 fields');
				t.ok(result.fields.find(field => field.fieldType === 'email'), 'should find email field');
				t.ok(result.fields.find(field => field.fieldType === 'password'), 'should find password field');
			}),
			t.test('should work for a popup form', async t => {
				const result = await runCrawler('login_form_popup.html');
				t.equal(result.fields.length, 2, 'should find 2 fields');
				t.ok(result.fields.find(field => field.fieldType === 'email'), 'should find email field');
				t.ok(result.fields.find(field => field.fieldType === 'password'), 'should find password field');
			}),
			t.test('should work for a shadow form', async t => {
				const result = await runCrawler('login_form_shadow.html');
				t.equal(result.fields.length, 2, 'should find 2 fields');
				t.ok(result.fields.find(field => field.fieldType === 'email'), 'should find email field');
				t.ok(result.fields.find(field => field.fieldType === 'password'), 'should find password field');
			}),
		]) as Promise<unknown> as Promise<void>;
	});
})();
