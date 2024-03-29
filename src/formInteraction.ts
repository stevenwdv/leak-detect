import {setTimeout} from 'node:timers/promises';

import type {ElementHandle, Frame} from 'puppeteer';

import {getRandomUpTo} from './utils';

export async function blurRefocus(frame: Frame) {
	function blur() {
		Reflect.defineProperty(document, 'visibilityState', {value: 'hidden', configurable: true});
		document.hasFocus = () => false;
		dispatchEvent(new Event('blur', {
			srcElement: window,
			target: window,
			currentTarget: window,
			path: [window],
		} as EventInit));
	}

	function focus() {
		// @ts-expect-error restores original property
		// noinspection JSConstantReassignment
		delete document.visibilityState;
		// @ts-expect-error restores original property
		delete document.hasFocus;
		dispatchEvent(new Event('focus', {
			srcElement: window,
			target: window,
			currentTarget: window,
			path: [window],
		} as EventInit));
	}

	await frame.evaluate(blur);
	if (frame.page().mainFrame() !== frame)
		await frame.page().evaluate(blur);

	if (frame.page().mainFrame() !== frame)
		await frame.page().evaluate(focus);
	await frame.evaluate(focus);
}

export async function focusElement(handle: ElementHandle, clickDwellTimeMs: number) {
	const page = handle.frame.page();
	await page.bringToFront();
	await smoothScrollToElement(handle);
	await handle.hover();
	await handle.click({delay: clickDwellTimeMs});
}

async function smoothScrollToElement(handle: ElementHandle) {
	await handle.evaluate(el => el.scrollIntoView({behavior: 'smooth', block: 'end', inline: 'end'}));
}

async function fillInputElement(elem: ElementHandle, text: string, options: FillTimesMs) {
	await focusElement(elem, options.clickDwell);
	const page = elem.frame.page();
	for (const key of text) {
		await elem.type(key, {delay: getRandomUpTo(options.keyDwell)});
		await setTimeout(getRandomUpTo(options.betweenKeys));
	}
	await page.keyboard.press('Tab');  // Trigger blur
}

export async function fillPasswordField(elem: ElementHandle, password: string, options: FillTimesMs) {
	await fillInputElement(elem, password, options);
}


export async function fillEmailField(
	  elem: ElementHandle, hostname: string, email: string, options: FillTimesMs) {
	await fillInputElement(elem, email, options);
}

export async function submitField(elem: ElementHandle, clickDwellTimeMs: number) {
	await focusElement(elem, clickDwellTimeMs);
	const page = elem.frame.page();
	await page.keyboard.press('Enter');
}

export interface FillTimesMs {
	clickDwell: number;
	keyDwell: number;
	betweenKeys: number;
}
