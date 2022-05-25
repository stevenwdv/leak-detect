export interface Logger {
	debug(...args: unknown[]): void;

	log(...args: unknown[]): void;

	info(...args: unknown[]): void;

	warn(...args: unknown[]): void;

	error(...args: unknown[]): void;
}

export class ConsoleLogger implements Logger {
	static #printConsole(print: (msg?: unknown, ...args: unknown[]) => void, args: unknown[]) {
		if (args.length)
			print(typeof args[0] === 'string' ? '%s' : '%O', ...args);
	}

	debug(...args: unknown[]): void {
		ConsoleLogger.#printConsole(console.debug, args);
	}

	log(...args: unknown[]): void {
		ConsoleLogger.#printConsole(console.log, args);
	}

	info(...args: unknown[]): void {
		ConsoleLogger.#printConsole(console.info, args);
	}

	warn(...args: unknown[]): void {
		ConsoleLogger.#printConsole(console.warn, args);
	}

	error(...args: unknown[]): void {
		ConsoleLogger.#printConsole(console.error, args);
	}
}

export class TaggedLogger implements Logger {
	readonly #log: (...args: unknown[]) => void;

	constructor(log: (...args: unknown[]) => void) {
		this.#log = log;
	}

	debug(...args: unknown[]): void {
		this.#log('[dbg]', ...args);
	}

	log(...args: unknown[]): void {
		this.#log('[log]', ...args);
	}

	info(...args: unknown[]): void {
		this.#log('[INFO]', ...args);
	}

	warn(...args: unknown[]): void {
		this.#log('[WARN]', ...args);
	}

	error(...args: unknown[]): void {
		this.#log('[ERROR]', ...args);
	}
}