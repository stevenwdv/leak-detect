import rl from 'node:readline/promises';

import {BaseCollector} from 'tracker-radar-collector';
import {MaybePromiseLike} from './utils';

export class WaitingCollector extends BaseCollector {
	readonly #message: string;
	readonly #onWait: (() => MaybePromiseLike<void>) | undefined;
	readonly #onReturn: (() => MaybePromiseLike<void>) | undefined;

	constructor(
		  message = '\n⏸️ Press ⏎ to continue...',
		  onWait?: () => MaybePromiseLike<void>,
		  onReturn?: () => MaybePromiseLike<void>,
	) {
		super();
		this.#message  = message;
		this.#onWait   = onWait;
		this.#onReturn = onReturn;
	}

	override async getData(): Promise<undefined> {
		await this.#onWait?.();
		const rli = rl.createInterface(process.stdin, process.stdout);
		await rli.question(this.#message);
		rli.close();
		await this.#onReturn?.();
		return undefined;
	}
}
