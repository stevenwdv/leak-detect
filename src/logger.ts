import chalk, {Chalk} from 'chalk';

export interface Logger {
	debug(...args: unknown[]): void;

	log(...args: unknown[]): void;

	info(...args: unknown[]): void;

	warn(...args: unknown[]): void;

	error(...args: unknown[]): void;

	group<T>(name: string, func: () => T): T;
}

export class ConsoleLogger implements Logger {
	readonly #groups: string[] = [];

	debug(...args: unknown[]): void {
		this.#printConsole(console.debug, null, chalk.gray, args);
	}

	log(...args: unknown[]): void {
		this.#printConsole(console.log, null, chalk, args);
	}

	info(...args: unknown[]): void {
		this.#printConsole(console.info, 'ℹ️', chalk.blueBright, args);
	}

	warn(...args: unknown[]): void {
		this.#printConsole(console.warn, '⚠️', chalk.yellow, args);
	}

	error(...args: unknown[]): void {
		this.#printConsole(console.error, '❌️', chalk.redBright, args);
	}

	group<T>(name: string, func: () => T): T {
		this.#groups.push(name);
		let promise;
		try {
			const res = func();
			if ((promise = res instanceof Promise)) res.finally(() => this.#groups.pop());
			return res;
		} finally {
			if (!promise) this.#groups.pop();
		}
	}

	#printConsole(print: (msg?: unknown, ...args: unknown[]) => void, prefix: string | null, color: Chalk, args: unknown[]) {
		if (prefix) args.unshift(color(prefix));
		args.unshift(...this.#groups.map(g => chalk.gray(`${g}❯`)));
		if (args.length)
			print(typeof args[0] === 'string' ? '%s' : '%O', ...args.map(a => typeof a === 'string' ? color(a) : a));
	}
}

export class TaggedLogger implements Logger {
	readonly #groups: string[] = [];
	readonly #logFn: (...args: unknown[]) => void;

	constructor(log: (...args: unknown[]) => void) {
		this.#logFn = log;
	}

	debug(...args: unknown[]): void {
		this.#log(chalk.gray('[dbg]'), ...args);
	}

	log(...args: unknown[]): void {
		this.#log('[log]', ...args);
	}

	info(...args: unknown[]): void {
		this.#log(chalk.blueBright('[INFO]'), ...args);
	}

	warn(...args: unknown[]): void {
		this.#log(chalk.yellow('[WARN]'), ...args);
	}

	error(...args: unknown[]): void {
		this.#log(chalk.redBright('[ERROR]'), ...args);
	}

	group<T>(name: string, func: () => T): T {
		this.#groups.push(name);
		let promise;
		try {
			const res = func();
			if ((promise = res instanceof Promise)) res.finally(() => this.#groups.pop());
			return res;
		} finally {
			if (!promise) this.#groups.pop();
		}
	}

	#log(...args: unknown[]) {
		args.unshift(...this.#groups.map(g => chalk.gray(`${g}❯`)));
		this.#logFn(...args);
	}
}