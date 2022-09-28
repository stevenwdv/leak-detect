import chalk from 'chalk';
import ProgressBar from 'progress';

let bar: ProgressBar | undefined;

export function init(fmt: string, total: number) {
	bar = new ProgressBar(fmt, {
		complete: chalk.green('═'),
		incomplete: chalk.gray('┄'),
		total,
		width: 30,
	});
}

const interactive = !!(process.stderr.clearLine as typeof process.stderr.clearLine | undefined);

export function isInteractive() {return interactive;}

export function update(ratio: number, tokens?: Record<string, string>) {
	if (interactive) {
		process.stderr.write(`\x1b]9;4;1;${Math.floor(ratio * 100)}\x1b\\`);
		bar!.update(ratio, tokens);
	}
}

export function log(msg: string) {
	if (interactive) bar!.interrupt(msg);
	else console.error(msg);
}

export function terminate() {
	if (interactive) {
		process.stderr.write('\x1b]9;4;0;0\x1b\\');
		if (bar && !bar.complete) bar.terminate();
		bar = undefined;
	}
}

export function setState(state: 'normal' | 'error' | 'indeterminate' | 'paused' | 'complete') {
	const stateNum = ['normal', 'error', 'indeterminate', 'paused'].indexOf(state) + 1;
	if (interactive) process.stderr.write(
		  stateNum === 0
				? '\x1b]9;4;1;100\x1b\\'
				: `\x1b]9;4;${stateNum};${
					  state === 'indeterminate' || !bar ? '0' : Math.floor((bar.curr / bar.total) * 100)
				}\x1b\\`);
}
