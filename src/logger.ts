import fs from 'node:fs';
import util from 'node:util';

import chalk, {Chalk} from 'chalk';
import {ValueOf} from 'ts-essentials';

import {forwardPromise, MaybePromise} from './utils';

export type LogLevel = 'debug' | 'log' | 'info' | 'warn' | 'error';

export abstract class Logger {
	abstract logLevel(level: LogLevel, ...args: unknown[]): void;

	debug(...args: unknown[]): void {this.logLevel('debug', ...args);}

	log(...args: unknown[]): void {this.logLevel('log', ...args);}

	info(...args: unknown[]): void {this.logLevel('info', ...args);}

	warn(...args: unknown[]): void {this.logLevel('warn', ...args);}

	error(...args: unknown[]): void {this.logLevel('error', ...args);}

	abstract startGroup(name: string): void;

	abstract endGroup(): void;

	group<T extends MaybePromise<unknown>>(name: string, func: () => T): T {
		this.startGroup(name);
		return forwardPromise(func, () => this.endGroup());
	}
}

export class ConsoleLogger extends Logger {
	readonly #groups: string[] = [];
	readonly #prefix: undefined | (() => undefined | string);

	constructor(prefix?: () => undefined | string) {
		super();
		this.#prefix = prefix;
	}

	logLevel(level: LogLevel, ...args: unknown[]) {
		args.unshift(...this.#groups.map(g => chalk.gray(`${g}❯`)));
		const prefix = this.#prefix?.();
		if (prefix) args.unshift(prefix);
		if (!args.length) args.push('');
		console[level](
			  typeof args[0] === 'string' ? '%s' : '%O',
			  ...args,
		);
	}

	startGroup(name: string) {
		this.#groups.push(name);
	}

	endGroup() {
		this.#groups.pop();
	}
}

export class FileLogger extends Logger {
	readonly #groups: string[]  = [];
	readonly #file: fs.WriteStream;
	readonly #prefix: undefined | (() => undefined | string);
	#error: unknown | undefined = undefined;

	constructor(file: fs.PathLike | fs.WriteStream, prefix?: () => undefined | string) {
		super();
		this.#file = file instanceof fs.WriteStream ? file : fs.createWriteStream(file, 'utf8');
		this.#file.once('error', err => this.#error = err);
		this.#prefix = prefix;
	}

	logLevel(level: LogLevel, ...args: unknown[]) {
		args.unshift(...this.#groups.map(g => `${g}❯`));
		const prefix = this.#prefix?.();
		if (prefix) args.unshift(prefix);
		this.#file.write(args.map(o => typeof o === 'string' ? o : util.inspect(o)).join(' ') + '\n');
	}

	startGroup(name: string) {
		this.#groups.push(name);
	}

	endGroup() {
		this.#groups.pop();
	}

	checkError() {
		return this.#error;
	}

	async finalize() {
		const err = this.checkError();
		// eslint-disable-next-line @typescript-eslint/no-throw-literal
		if (err !== undefined) throw err;
		await new Promise<void>((resolve, reject) =>
			  this.#file.close(err => err ? reject(err) : resolve()));
	}
}

export class PlainLogger extends Logger {
	readonly #log: (...args: unknown[]) => void;
	readonly #groups: string[] = [];

	constructor(log: (...args: unknown[]) => void) {
		super();
		this.#log = log;
	}

	logLevel(level: LogLevel, ...args: unknown[]) {
		args.unshift(...this.#groups.map(g => `${chalk.gray(g)}❯`));
		this.#log(...args);
	}

	startGroup(name: string) {
		this.#groups.push(name);
	}

	endGroup() {
		this.#groups.pop();
	}
}

export class ColoredLogger extends Logger {
	readonly #log: Logger;
	readonly #groups: string[] = [];

	constructor(logger: Logger) {
		super();
		this.#log = logger;
	}

	logLevel(level: LogLevel, ...args: unknown[]) {
		const prefixes: { [level in LogLevel]?: string } = {
			info: 'ℹ️',
			warn: '⚠️',
			error: '❌️',
		};
		const colors: { [level in LogLevel]?: Chalk }    = {
			debug: chalk.gray,
			info: chalk.blueBright,
			warn: chalk.yellow,
			error: chalk.redBright,
		};

		const color = colors[level] ?? chalk;

		const prefix = prefixes[level];
		if (prefix) args.unshift(color(prefix));
		args = args.map(a => typeof a === 'string' ? color(a) : a);
		args.unshift(...this.#groups.map(g => `${chalk.gray(g)}❯`));
		this.#log.logLevel(level, ...args);
	}

	startGroup(name: string) {
		this.#groups.push(name);
	}

	endGroup() {
		this.#groups.pop();
	}
}

export class TaggedLogger extends Logger {
	readonly #log: Logger;

	constructor(logger: Logger) {
		super();
		this.#log = logger;
	}

	logLevel(level: LogLevel, ...args: unknown[]) {
		args.unshift(`[${level.toUpperCase()}]`);
		this.#log.logLevel(level, ...args);
	}

	startGroup(name: string) {
		this.#log.startGroup(name);
	}

	endGroup() {
		this.#log.endGroup();
	}
}

export class CountingLogger extends Logger {
	readonly #log: Logger | undefined;
	#counts = {
		debug: 0,
		log: 0,
		info: 0,
		warn: 0,
		error: 0,
	};

	constructor(logger?: Logger) {
		super();
		this.#log = logger;
	}

	logLevel(level: LogLevel, ...args: unknown[]) {
		++this.#counts[level];
		this.#log?.logLevel(level, ...args);
	}

	startGroup(name: string) {
		this.#log?.startGroup(name);
	}

	endGroup() {
		this.#log?.endGroup();
	}

	count(level?: LogLevel) {
		return level
			  ? this.#counts[level]
			  : Object.values(this.#counts).reduce((sum, c) => sum + c, 0);
	}

	reset() {
		this.#counts = {
			debug: 0,
			log: 0,
			info: 0,
			warn: 0,
			error: 0,
		};
	}
}

export class FilteringLogger extends Logger {
	readonly #log: Logger;
	#level: ValueOf<typeof logLevelOrder>;

	constructor(logger: Logger, level: LogLevel = 'debug') {
		super();
		this.#log   = logger;
		this.#level = logLevelOrder[level];
	}

	get level() {return logLevels[this.#level];}

	set level(level) {this.#level = logLevelOrder[level];}

	logLevel(level: LogLevel, ...args: unknown[]) {
		if (logLevelOrder[level] >= this.#level) this.#log.logLevel(level, ...args);
	}

	startGroup(name: string) {
		this.#log.startGroup(name);
	}

	endGroup() {
		this.#log.endGroup();
	}
}

export class BufferingLogger extends Logger {
	#msgs: { method: LogLevel | 'startGroup' | 'endGroup', args: unknown[] }[] = [];

	logLevel(level: LogLevel, ...args: unknown[]) {
		this.#msgs.push({method: level, args});
	}

	startGroup(name: string) {
		this.#msgs.push({method: 'startGroup', args: [name]});
	}

	endGroup() {
		this.#msgs.push({method: 'endGroup', args: []});
	}

	clear() {
		this.#msgs = [];
	}

	drainTo(logger: Logger) {
		for (const {method, args} of this.#msgs)
			(logger[method] as (...args: unknown[]) => void)(...args);
		this.clear();
	}
}

export const logLevels = ['debug', 'log', 'info', 'warn', 'error'] as const;

export const logLevelOrder = {
	debug: 0,
	log: 1,
	info: 2,
	warn: 3,
	error: 4,
} as const;
