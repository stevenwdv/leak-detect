import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import {AddressInfo} from 'node:net';

import {createServer} from 'http-server';
import t from 'tap';

import {crawler, RequestCollector} from 'tracker-radar-collector';
import {CrawlOptions} from 'tracker-radar-collector/crawler';

import {
	ClickLinkEvent,
	FacebookButtonEvent,
	FieldCollectorData,
	FieldsCollector,
	FieldsCollectorOptions,
	FillEvent,
	ReturnEvent,
	ScreenshotTrigger,
	SubmitEvent,
} from '../../src/FieldsCollector';
import {BufferingLogger, ColoredLogger, ConsoleLogger, CountingLogger, Logger} from '../../src/logger';
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

	await t.test(FieldsCollector.name, serial ? undefined : {jobs: 30, buffered: true}, t => {
		t.teardown(() => new Promise<void>((resolve, reject) =>
			  server.close(err => err ? reject(err) : resolve())));

		const baseCrawlOptions: CrawlOptions = {
			log() {throw new Error('log unspecified');},
			maxCollectionTimeMs: 120_000,
			headed,
			devtools: headed,
			throwCollectorErrors: true,
		};

		async function runCrawler(
			  page: string, log: Logger, options: FieldsCollectorOptions = {}): Promise<FieldCollectorData> {
			const result = await crawler(
				  new URL(page, baseUrl),
				  {
					  ...baseCrawlOptions,
					  log: log.log.bind(log),
					  collectors: [
						  new FieldsCollector(options, log),
					  ],
				  },
			);
			if (result.timeout) throw new Error('TRC detected timeout');
			return (result.data as { [f in ReturnType<typeof FieldsCollector.prototype.id>]: FieldCollectorData }).fields;
		}

		function test(name: string, fun: (t: Tap.Test, log: Logger) => PromiseLike<unknown> | unknown) {
			const testLogger = serial ? new ColoredLogger(new ConsoleLogger()) : new BufferingLogger();
			if (serial) testLogger.startGroup(name);
			const countLogger = new CountingLogger(testLogger);

			return t.test(name, async t => {
				await fun(t, countLogger);
				t.equal(countLogger.count('error'), 0, 'should not generate any errors');
				t.equal(countLogger.count('warn'), 0, 'should not generate any warnings');
				if (!t.passing() && testLogger instanceof BufferingLogger) {
					const conLogger = new ConsoleLogger();
					conLogger.group(name, () => testLogger.drainTo(new ColoredLogger(conLogger)));
				}
			});
		}

		return Promise.all([
			test('for a simple form', async (t, log) => {
				const screenshots: ScreenshotTrigger[] = [];
				const result                           = await runCrawler('login_form.html', log, {
					screenshot: {
						target(_, trigger) {screenshots.push(trigger);},
						triggers: ['loaded', 'filled', 'submitted'],
					},
				});
				if (!t.strictNotSame(result, {}, 'should return a result'))
					t.bailout('collector returns an empty object');
				t.strictSame(result.errors, [], 'should not generate any errors');

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

				t.strictSame(screenshots, ['loaded', 'filled', 'submitted'], 'should make the right screenshots');
			}),
			test('for a frame', async (t, log) => {
				const result = await runCrawler('login_form_frame.html', log);
				t.equal(result.fields.length, 2, 'should find 2 fields');
				t.ok(result.fields.find(field => field.fieldType === 'email'), 'should find email field');
				t.ok(result.fields.find(field => field.fieldType === 'password'), 'should find password field');
			}),
			test('for a hidden popup', async (t, log) => {
				const result       = await runCrawler('login_form_hidden.html', log);
				const popupOpenIdx = result.events.findIndex(ev =>
					        ev instanceof ClickLinkEvent && ev.link.join().includes('popupLink')),
				      fillIdx      = result.events.findIndex(ev => ev instanceof FillEvent);
				t.ok(popupOpenIdx >= 0, 'should open popup');
				t.ok(popupOpenIdx < fillIdx, 'should fill after opening popup');

				t.equal(result.fields.length, 2, 'should find 2 fields');
				t.ok(result.fields.find(field => field.fieldType === 'email'), 'should find email field');
				t.ok(result.fields.find(field => field.fieldType === 'password'), 'should find password field');
			}),
			test('for a popup form', async (t, log) => {
				const result = await runCrawler('login_form_popup.html', log);
				t.equal(result.fields.length, 2, 'should find 2 fields');
				t.ok(result.fields.find(field => field.fieldType === 'email'), 'should find email field');
				t.ok(result.fields.find(field => field.fieldType === 'password'), 'should find password field');

				t.equal(result.passwordLeaks.length, 1, 'should find 1 password leak');
				const leak = result.passwordLeaks[0];
				t.equal(leak?.attribute, 'value', 'should have password leak attr "value"');
				t.ok(leak?.attrs, 'should have password leak element attrs set');
			}),
			test('for an open shadow form', async (t, log) => {
				const result = await runCrawler('login_form_shadow.html', log);
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
			test('for a closed shadow form', async (t, log) => {
				const result = await runCrawler('login_form_shadow_closed.html', log);
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
			test('for email input with type=text', async (t, log) => {
				const result = await runCrawler('login_form_text_email.html', log);
				t.equal(result.fields.length, 2, 'should find 2 fields');
				t.ok(result.fields.find(field => field.fieldType === 'email'), 'should find email field');
				t.ok(result.fields.find(field => field.fieldType === 'password'), 'should find password field');
			}),
			test('for open shadow email input with type=text', async (t, log) => {
				const result = await runCrawler('login_form_shadow_text_email.html', log);
				t.equal(result.fields.length, 2, 'should find 2 fields');
				t.ok(result.fields.find(field => field.fieldType === 'email'), 'should find email field');
				t.ok(result.fields.find(field => field.fieldType === 'password'), 'should find password field');
			}),
			test('for closed shadow email input with type=text', async (t, log) => {
				const result = await runCrawler('login_form_shadow_closed_text_email.html', log);
				t.equal(result.fields.length, 2, 'should find 2 fields');
				t.ok(result.fields.find(field => field.fieldType === 'email'), 'should find email field');
				t.ok(result.fields.find(field => field.fieldType === 'password'), 'should find password field');
			}),
			test('for Facebook button leak', async (t, log) => {
				const data = (await crawler(
					  new URL('facebook_button_simulator.html', baseUrl),
					  {
						  ...baseCrawlOptions,
						  log: log.log.bind(log),
						  collectors: [
							  new FieldsCollector({
								  fill: {submit: false},
								  clickLinkCount: 0,
							  }, log),
							  new RequestCollector(),
						  ],
					  },
				)).data as CollectorData & { [f in ReturnType<typeof FieldsCollector.prototype.id>]: FieldCollectorData };

				t.ok(data.fields.events.find(ev => ev instanceof FacebookButtonEvent), 'should add Facebook button');
				t.ok(data.requests!.find(r => r.url === new URL('facebook.html', baseUrl).href),
					  'should click the added button and open \'Facebook\'');
			}),
			test('for multiple forms', async (t, log) => {
				const result = await runCrawler('multiple_forms.html', log);
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
			test('for login/register links opening on same page', async (t, log) => {
				const result = await runCrawler('login_link.html', log);
				t.equal(result.links?.length, 2, 'should find the 2 links');
				t.equal(result.events.filter(ev => ev instanceof ClickLinkEvent).length, 2,
					  'should follow the 2 links');
				t.equal(result.fields.length, 4, 'should find 4 fields');
				t.equal(result.events.filter(ev => ev instanceof SubmitEvent).length, 2,
					  'should submit 2 times');
				t.equal(result.visitedTargets.length, 1, 'should log 1 visited target');
			}),
			test('for login/register links opening in new tabs', async (t, log) => {
				const screenshots: ScreenshotTrigger[] = [];
				const result                           = await runCrawler('login_link_blank.html', log, {
					screenshot: {
						target(_, trigger) {screenshots.push(trigger);},
						triggers: ['new-page', 'filled', 'submitted', 'link-clicked'],
					},
				});
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

				// new-page load may be fired after other screenshots sometimes
				t.strictSame(screenshots.filter(t => t !== 'new-page'), [
						  'link-clicked', 'filled', 'submitted',
						  'link-clicked', 'filled', 'submitted',
					  ],
					  'should make the right screenshots');
				t.equal(screenshots.filter(t => t === 'new-page').length, 3,
					  'should make 3 new-page screenshots');
			}),
			test('for login form and linked form', async (t, log) => {
				const result = await runCrawler('login_form_and_link.html', log);
				t.equal(result.links?.length, 1, 'should find 1 link');
				t.equal(result.events.filter(ev => ev instanceof ClickLinkEvent).length, 1,
					  'should follow the link');
				t.equal(result.fields.length, 4, 'should find 4 fields');
				t.equal(result.events.filter(ev => ev instanceof SubmitEvent).length, 2,
					  'should submit 2 times');
			}),
			test('with manual JS click chain', async (t, log) => {
				const result      = await runCrawler('multiple_logins.html', log, {
					interactChains: [{
						type: 'js-path-click',
						paths: [
							'document.querySelector("body > button")',
							'document.querySelector("#loginChoice > button")',
						],
					}],
				});
				const clickEvents = result.events.filter(ev => ev instanceof ClickLinkEvent
					  && ev.linkType === 'manual');
				t.equal(clickEvents.length, 2, 'should click 2 buttons');

				t.equal(result.fields.length, 2, 'should find 2 fields');
				t.ok(result.fields.find(field => field.fieldType === 'email'), 'should find email field');
				t.ok(result.fields.find(field => field.fieldType === 'password'), 'should find password field');

				const fillEvent = result.events.find(ev => ev instanceof FillEvent);
				t.ok(fillEvent, 'should fill fields');
				t.ok(fillEvent?.time ?? -Infinity > clickEvents.reduce((max, ev) => Math.max(max, ev.time), -Infinity),
					  'should fill fields after clicking buttons');
			}),
			test('with manual @puppeteer/replay click flow', async (t, log) => {
				const screenshots: ScreenshotTrigger[] = [];
				const result                           = await runCrawler('multiple_logins.html', log, {
					interactChains: [{
						type: 'puppeteer-replay',
						flow: {
							'title': 'Click 2 buttons',
							'steps': [
								{
									'type': 'setViewport',
									'width': 981,
									'height': 753,
									'deviceScaleFactor': 1,
									'isMobile': false,
									'hasTouch': false,
									'isLandscape': false,
								},
								{
									'type': 'navigate',
									'url': 'http://localhost:63342/leak-detection.iml/multiple_logins.html?_ijt=5qqm8danufcomaqgf1hnc70m70&_ij_reload=RELOAD_ON_SAVE',
									'assertedEvents': [
										{
											'type': 'navigation',
											'url': 'http://localhost:63342/leak-detection.iml/multiple_logins.html?_ijt=5qqm8danufcomaqgf1hnc70m70&_ij_reload=RELOAD_ON_SAVE',
											'title': 'Multiple login options',
										},
									],
								},
								{
									'type': 'click',
									'target': 'main',
									'selectors': [
										['aria/Login'],
										['body > button'],
									],
									'offsetY': 13,
									'offsetX': 18.650001525878906,
								},
								{
									'type': 'click',
									'target': 'main',
									'selectors': [
										['aria/Login via email'],
										['#loginChoice > button'],
									],
									'offsetY': 7,
									'offsetX': 50.637481689453125,
								},
							],
						},
					}],
					screenshot: {
						target(_, trigger) {screenshots.push(trigger);},
						triggers: ['loaded', 'interact-chain-executed', 'filled', 'submitted', 'link-clicked'],
					},
				});

				t.equal(result.fields.length, 2, 'should find 2 fields');
				t.ok(result.fields.find(field => field.fieldType === 'email'), 'should find email field');
				t.ok(result.fields.find(field => field.fieldType === 'password'), 'should find password field');

				t.ok(result.events.find(ev => ev instanceof FillEvent), 'should fill fields');

				t.strictSame(screenshots, ['loaded', 'interact-chain-executed', 'filled', 'submitted', 'link-clicked'],
					  'should make the right screenshots');
			}),
		]) as Promise<unknown> as Promise<void> /* workaround: @types/tap is incorrect */;
	});
})();
