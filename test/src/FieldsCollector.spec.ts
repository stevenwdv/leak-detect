import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import {AddressInfo} from 'node:net';

import {createServer} from 'http-server';
import t from 'tap';
import {DeepPartial} from 'ts-essentials';

import {crawler, RequestCollector} from 'tracker-radar-collector';

import {
	ClickLinkEvent,
	FacebookButtonEvent,
	FieldCollectorData,
	FieldsCollector,
	FieldsCollectorOptions,
	FillEvent,
	ReturnEvent,
	SubmitEvent,
} from '../../src/FieldsCollector';
import {ConsoleLogger} from '../../src/logger';
import {CollectorData} from 'tracker-radar-collector/helpers/collectorsList';

const serial = process.argv.includes('--serial');
const headed = process.argv.includes('--headed');

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

	await t.test(FieldsCollector.name, serial ? undefined : {jobs: 20, buffered: true}, t => {
		t.teardown(() => new Promise<void>((resolve, reject) =>
			  server.close(err => err ? reject(err) : resolve())));

		async function runCrawler(page: string, options: DeepPartial<FieldsCollectorOptions> = {}): Promise<FieldCollectorData> {
			return ((await crawler(
				  new URL(page, baseUrl),
				  {
					  log: console.log,
					  maxCollectionTimeMs: 120_000,
					  headed: headed,
					  devtools: headed,
					  collectors: [
						  new FieldsCollector(options, new ConsoleLogger()),
					  ],
				  },
			)).data as { [f in ReturnType<typeof FieldsCollector.prototype.id>]: FieldCollectorData }).fields;
		}

		//TODO check that no warnings/errors are generated
		return Promise.all([
			t.test('for a simple form', async t => {
				const result = await runCrawler('login_form.html');
				if (!t.strictNotSame(result, {}, 'should return a result'))
					t.bailout('collector returns an empty object');

				t.equal(result.fields.length, 2, 'should find 2 fields');

				const emailField    = result.fields.find(field => field.fieldType === 'email'),
				      passwordField = result.fields.find(field => field.fieldType === 'password');
				t.ok(emailField, 'should find email field');
				t.ok(passwordField, 'should find password field');

				t.ok(emailField?.filled, 'should fill email field');
				t.ok(passwordField?.filled, 'should fill password field');
				t.ok(emailField?.submitted, 'should submit email field');

				t.strictSame(result.links, [], 'should find no links');

				t.equal(result.visitedTargets.length, 1, 'should log 1 target');
				t.equal(result.visitedTargets[0]?.type, 'page', 'should log page target');
				t.equal(result.visitedTargets[0]?.url, new URL('login_form.html', baseUrl).href, 'should log target with right URL');

				const submitIdx = result.events.findIndex(ev => ev instanceof SubmitEvent);
				t.strictSame(result.events
							// Strip return events after submit
							.filter((ev, nEv) => !(nEv > submitIdx && ev instanceof ReturnEvent))
							.map(ev => ev.type),
					  [
						  'fill',
						  'fill',
						  'fb-button',
						  'submit',
					  ]);
			}),
			t.test('for a frame', async t => {
				const result = await runCrawler('login_form_frame.html');
				t.equal(result.fields.length, 2, 'should find 2 fields');
				t.ok(result.fields.find(field => field.fieldType === 'email'), 'should find email field');
				t.ok(result.fields.find(field => field.fieldType === 'password'), 'should find password field');
			}),
			t.test('for a hidden popup', async t => {
				const result       = await runCrawler('login_form_hidden.html');
				const popupOpenIdx = result.events.findIndex(ev =>
					        ev instanceof ClickLinkEvent && ev.link.join().includes('popupLink')),
				      fillIdx      = result.events.findIndex(ev => ev instanceof FillEvent);
				t.ok(popupOpenIdx >= 0, 'should open popup');
				t.ok(popupOpenIdx < fillIdx, 'should fill after opening popup');

				t.equal(result.fields.length, 2, 'should find 2 fields');
				t.ok(result.fields.find(field => field.fieldType === 'email'), 'should find email field');
				t.ok(result.fields.find(field => field.fieldType === 'password'), 'should find password field');
			}),
			t.test('for a popup form', async t => {
				const result = await runCrawler('login_form_popup.html');
				t.equal(result.fields.length, 2, 'should find 2 fields');
				t.ok(result.fields.find(field => field.fieldType === 'email'), 'should find email field');
				t.ok(result.fields.find(field => field.fieldType === 'password'), 'should find password field');

				t.equal(result.passwordLeaks.length, 1, 'should find 1 password leak');
				const leak = result.passwordLeaks[0];
				t.equal(leak?.attribute, 'value', 'should have password leak attr "value"');
				t.ok(leak?.attrs, 'should have password leak element attrs set');
			}),
			t.test('for an open shadow form', async t => {
				const result = await runCrawler('login_form_shadow.html');
				t.equal(result.fields.length, 2, 'should find 2 fields');
				const emailField    = result.fields.find(field => field.fieldType === 'email'),
				      passwordField = result.fields.find(field => field.fieldType === 'password');
				t.ok(emailField, 'should find email field');
				t.ok(passwordField, 'should find password field');

				t.ok(emailField?.submitted, 'should submit field');

				t.equal(result.passwordLeaks.length, 1, 'should find 1 password leak');
				const leak = result.passwordLeaks[0];
				t.equal(leak?.attribute, 'value', 'should have password leak attr "value"');
				t.ok(leak?.attrs, 'should have password leak element attrs set');
			}),
			t.test('for a closed shadow form', async t => {
				const result = await runCrawler('login_form_shadow_closed.html');
				t.equal(result.fields.length, 2, 'should find 2 fields');
				const emailField    = result.fields.find(field => field.fieldType === 'email'),
				      passwordField = result.fields.find(field => field.fieldType === 'password');
				t.ok(emailField, 'should find email field');
				t.ok(passwordField, 'should find password field');

				t.ok(emailField?.submitted, 'should submit field');

				t.equal(result.passwordLeaks.length, 1, 'should find 1 password leak');
				const leak = result.passwordLeaks[0];
				t.equal(leak?.attribute, 'value', 'should have password leak attr "value"');
				t.ok(leak?.attrs, 'should have password leak element attrs set');
			}),
			t.test('for email input with type=text', async t => {
				const result = await runCrawler('login_form_text_email.html');
				t.equal(result.fields.length, 2, 'should find 2 fields');
				t.ok(result.fields.find(field => field.fieldType === 'email'), 'should find email field');
				t.ok(result.fields.find(field => field.fieldType === 'password'), 'should find password field');
			}),
			t.test('for open shadow email input with type=text', async t => {
				const result = await runCrawler('login_form_shadow_text_email.html');
				t.equal(result.fields.length, 2, 'should find 2 fields');
				t.ok(result.fields.find(field => field.fieldType === 'email'), 'should find email field');
				t.ok(result.fields.find(field => field.fieldType === 'password'), 'should find password field');
			}),
			t.test('for closed shadow email input with type=text', async t => {
				const result = await runCrawler('login_form_shadow_closed_text_email.html');
				t.equal(result.fields.length, 2, 'should find 2 fields');
				t.ok(result.fields.find(field => field.fieldType === 'email'), 'should find email field');
				t.ok(result.fields.find(field => field.fieldType === 'password'), 'should find password field');
			}),
			t.test('for Facebook button leak', async t => {
				const data = (await crawler(
					  new URL('facebook_button_simulator.html', baseUrl),
					  {
						  log: console.log,
						  maxCollectionTimeMs: 120_000,
						  collectors: [
							  new FieldsCollector({
								  fill: {submit: false},
								  clickLinkCount: 0,
							  }, new ConsoleLogger()),
							  new RequestCollector(),
						  ],
					  },
				)).data as CollectorData & { [f in ReturnType<typeof FieldsCollector.prototype.id>]: FieldCollectorData };

				t.ok(data.fields.events.find(ev => ev instanceof FacebookButtonEvent), 'should add Facebook button');
				t.ok(data.requests!.find(r => r.url === new URL('facebook.html', baseUrl).href),
					  'should click the added button and open \'Facebook\'');
			}),
			t.test('for multiple forms', async t => {
				const result = await runCrawler('multiple_forms.html');
				t.equal(result.fields.length, 2 + 3 + 2 + 1 * 2, 'should find 9 fields');
				t.equal(result.fields.filter(f => f.filled).length, result.fields.length,
					  'should fill all fields');
				t.equal(result.events.filter(ev => ev instanceof FillEvent).length, 2 + 3 + 2 + 2 * 2,
					  'should fill 11 times in total');
				t.equal(result.events.filter(ev => ev instanceof SubmitEvent).length, 5,
					  'should submit 5 times');
				t.equal(result.events.filter(ev => ev instanceof FacebookButtonEvent).length, 5,
					  'should add Facebook button for each submit');
				t.ok(result.events.filter(ev => ev instanceof ReturnEvent).length >= 5 - 1,
					  'should reload between submits');
			}),
			t.test('for login/register links opening on same page', async t => {
				const result = await runCrawler('login_link.html');
				t.equal(result.links?.length, 2, 'should find the 2 links');
				t.equal(result.events.filter(ev => ev instanceof ClickLinkEvent).length, 2,
					  'should follow the 2 links');
				t.equal(result.fields.length, 4, 'should find 4 fields');
				t.equal(result.events.filter(ev => ev instanceof SubmitEvent).length, 2,
					  'should submit 2 times');
				t.equal(result.visitedTargets.length, 1, 'should log 1 visited target');
			}),
			t.test('for login/register links opening in new tabs', async t => {
				const result = await runCrawler('login_link_blank.html');
				t.equal(result.links?.length, 2, 'should find the 2 links');
				t.equal(result.events.filter(ev => ev instanceof ClickLinkEvent).length, 2,
					  'should follow the 2 links');
				t.equal(result.fields.length, 4, 'should find 4 fields');
				t.equal(result.events.filter(ev => ev instanceof SubmitEvent).length, 2,
					  'should submit 2 times');
				t.equal(result.visitedTargets.length, 3, 'should log 3 visited targets');
				t.ok(result.visitedTargets.find(t => t.url === new URL('login_form.html', baseUrl).href),
					  'should log visited target login_form.html');
				t.ok(result.visitedTargets.find(t => t.url === new URL('login_form.html?register', baseUrl).href),
					  'should log visited target login_form.html?register');
			}),
		]) as Promise<unknown> as Promise<void>;
	});
})();
