import t from 'tap';
import {findValue} from '../../src/analysis';
import {RequestCollector} from 'tracker-radar-collector';

void t.test(findValue.name, t => Promise.all([
	t.test('searches in URL', async t => {
		const request: RequestCollector.RequestData = {
			url: 'https://example.com/?email=leak-detector%40example.com&password=The--P%40s5w0rd',
			method: 'GET',
			type: 'Document',
			remoteIPAddress: '0.0.0.0',
			requestHeaders: [],
			responseHeaders: [],
			failureReason: '',
		};
		t.strictSame(await findValue('The--P@s5w0rd', [request]), [{
			request,
			part: 'url',
			encodings: ['uri'],
		}]);
	}),
	t.test('searches in body', async t => {
		const request: RequestCollector.RequestData = {
			url: 'https://example.com/',
			method: 'POST',
			type: 'Document',
			postData: 'email=leak-detector%40example.com&password=The--P%40s5w0rd',
			remoteIPAddress: '0.0.0.0',
			requestHeaders: [],
			responseHeaders: [],
			failureReason: '',
		};
		t.strictSame(await findValue('The--P@s5w0rd', [request]), [{
			request,
			part: 'body',
			encodings: ['uri'],
		}]);
	}),
]));