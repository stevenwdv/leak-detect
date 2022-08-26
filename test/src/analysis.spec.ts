import t from 'tap';
import {RequestCollector} from 'tracker-radar-collector';

import {findValue} from '../../src/analysis';
import ValueSearcher from 'value-searcher';

void t.test(findValue.name, async t => {
	const searcher = await ValueSearcher.fromValues('The--P@s5w0rd');
	await Promise.all([
		t.test('searches in URL', async t => {
			const request: RequestCollector.RequestData = {
				url: 'https://example.com/?email=leak-detector%40example.com&password=The--P%40s5w0rd',
				method: 'GET',
				type: 'Document',
				remoteIPAddress: '0.0.0.0',
				requestHeaders: {},
				responseHeaders: {},
				failureReason: '',
			};
			t.strictSame(await findValue(searcher, [request]), [{
				requestIndex: 0,
				part: 'url',
				encodings: ['uri'],
			}]);
		}),
		t.test('searches in request headers', async t => {
			const request: RequestCollector.RequestData = {
				url: 'https://example.com/',
				method: 'GET',
				type: 'Document',
				remoteIPAddress: '0.0.0.0',
				requestHeaders: {
					Cookie: 'hello=The--P@s5w0rd',
				},
				responseHeaders: {},
				failureReason: '',
			};
			t.strictSame(await findValue(searcher, [request]), [{
				requestIndex: 0,
				part: 'header',
				header: 'Cookie',
				encodings: [],
			}]);
		}),
		t.test('searches in body', async t => {
			const request: RequestCollector.RequestData = {
				url: 'https://example.com/',
				method: 'POST',
				type: 'Document',
				postData: 'email=leak-detector%40example.com&password=The--P%40s5w0rd',
				remoteIPAddress: '0.0.0.0',
				requestHeaders: {},
				responseHeaders: {},
				failureReason: '',
			};
			t.strictSame(await findValue(searcher, [request]), [{
				requestIndex: 0,
				part: 'body',
				encodings: ['uri'],
			}]);
		}),

		t.test('searches in visited targets', async t =>
			  t.strictSame(await findValue(searcher, [],
					['https://example.com/?email=leak-detector%40example.com&password=The--P%40s5w0rd'],
			  ), [{
				  visitedTargetIndex: 0,
				  part: 'url',
				  encodings: ['uri'],
			  }])),
	]);
});
