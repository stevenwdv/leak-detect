import t from 'tap';
import {RequestCollector} from 'tracker-radar-collector';
import ValueSearcher from 'value-searcher';

import {findRequestLeaks} from '../../src/analysis';

void t.test(findRequestLeaks.name, async t => {
	const searcher = await ValueSearcher.fromValues('The--P@s5w0rd');
	await Promise.all([
		t.test('searches in URL', async t => {
			const request: RequestCollector.RequestData = {
				url: 'https://example.com/?email=leak-detect%40example.com&password=The--P%40s5w0rd',
				method: 'GET',
				type: 'Document',
				remoteIPAddress: '0.0.0.0',
				requestHeaders: {},
				responseHeaders: {},
				wallTime: 0,
			};
			t.strictSame(await findRequestLeaks(searcher, [request]), [{
				requestIndex: 0,
				part: 'url',
				encodings: ['uri'],
				isHash: false,
			}]);
		}),
		t.test('searches in request headers', async t => {
			const request: RequestCollector.RequestData = {
				url: 'https://example.com/',
				method: 'GET',
				type: 'Document',
				requestHeaders: {
					Cookie: 'hello=The--P@s5w0rd',
				},
				responseHeaders: {},
				wallTime: 0,
			};
			t.strictSame(await findRequestLeaks(searcher, [request]), [{
				requestIndex: 0,
				part: 'header',
				header: 'Cookie',
				encodings: [],
				isHash: false,
			}]);
		}),
		t.test('searches in body', async t => {
			const request: RequestCollector.RequestData = {
				url: 'https://example.com/',
				method: 'POST',
				type: 'Document',
				postData: 'email=leak-detect%40example.com&password=The--P%40s5w0rd',
				requestHeaders: {},
				responseHeaders: {},
				wallTime: 0,
			};
			t.strictSame(await findRequestLeaks(searcher, [request]), [{
				requestIndex: 0,
				part: 'body',
				encodings: ['uri'],
				isHash: false,
			}]);
		}),

		t.test('searches in visited targets', async t =>
			  t.strictSame(await findRequestLeaks(searcher, [],
					['https://example.com/?email=leak-detect%40example.com&password=The--P%40s5w0rd'],
			  ), [{
				  visitedTargetIndex: 0,
				  part: 'url',
				  encodings: ['uri'],
				  isHash: false,
			  }])),
		t.test('sets isHash', async t =>
			  t.strictSame(await findRequestLeaks(searcher, [],
					['https://example.com/?h=c03131f116f6daf9e4a0faa3bc315fcb843338fef2989be54c4322dab3dfe59d'],
			  ), [{
				  visitedTargetIndex: 0,
				  part: 'url',
				  encodings: ['hex', 'sha256'],
				  isHash: true,
			  }])),
	]);
});
