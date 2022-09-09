import rl from 'node:readline/promises';

import {BrowserContext} from 'puppeteer';
import {BaseCollector} from 'tracker-radar-collector';

import {MaybePromiseLike} from './utils';

export class WaitingCollector extends BaseCollector {
	#context!: BrowserContext;
	readonly #message: string;
	readonly #onWait: (() => MaybePromiseLike<void>) | undefined;
	readonly #onReturn: (() => MaybePromiseLike<void>) | undefined;
	readonly #onAbort: (() => MaybePromiseLike<void>) | undefined;

	constructor(
		  message                                = '\n⏸️ Press ⏎ to continue...',
		  onWait?: () => MaybePromiseLike<void>,
		  onReturn: () => MaybePromiseLike<void> = () => console.log('\n▶️ Continuing'),
		  onAbort: () => MaybePromiseLike<void>  = () => console.log('\n⏹️ Window was closed'),
	) {
		super();
		this.#message  = message;
		this.#onWait   = onWait;
		this.#onReturn = onReturn;
		this.#onAbort  = onAbort;
	}

	override id() {return 'wait' as const;}

	override init({context}: BaseCollector.CollectorInitOptions) {
		this.#context = context;
	}

	override async getData(): Promise<undefined> {
		if (!this.#context.browser().isConnected()) {
			await this.#onAbort?.();
			return;
		}

		await this.#onWait?.();
		const rli          = rl.createInterface(process.stdin, process.stdout);
		const abort        = new AbortController();
		const abortHandler = () => abort.abort();
		this.#context.browser().once('disconnected', abortHandler);
		try {
			await rli.question(this.#message, abort);
			await this.#onReturn?.();
		} catch (err) {
			// Node does not actually use DOMException
			if ((err as { name: string }).name === 'AbortError')
				await this.#onAbort?.();
			else throw err;
		} finally {
			rli.close();
			this.#context.browser().off('disconnected', abortHandler);
		}
		return;
	}
}
