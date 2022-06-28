import {ElementHandle} from 'puppeteer';

import {Logger} from './logger';
import {getPageFromHandle} from './puppeteerUtils';
import {ElementInfo} from './pageUtils';

function getRandomUpTo(maxValue: number) {
	return Math.random() * maxValue;
}

export async function focusElement(handle: ElementHandle, clickDwellTimeMs: number) {
	const page = getPageFromHandle(handle)!;
	await page.bringToFront();
	await smoothScrollToElement(handle);
	await handle.hover();
	await handle.click({delay: clickDwellTimeMs});
}

async function smoothScrollToElement(handle: ElementHandle) {
	await handle.evaluate(el => el.scrollIntoView({behavior: 'smooth', block: 'end', inline: 'end'}));
}

async function fillInputElement(elem: ElementInfo, text: string, options: FillTimesMs) {
	await focusElement(elem.handle, options.clickDwell);
	const page = getPageFromHandle(elem.handle)!;
	for (const key of text) {
		await elem.handle.type(key, {delay: getRandomUpTo(options.keyDwell)});
		await page.waitForTimeout(getRandomUpTo(options.betweenKeys));
	}
	await page.keyboard.press('Tab');  // Trigger blur
}

export async function fillPasswordField(elem: ElementInfo, password: string, options: FillTimesMs, log?: Logger) {
	try {
		await fillInputElement(elem, password, options);
	} catch (err) {
		log?.warn('failed to fill password field', elem.attrs, err);
		return false;
	}
	log?.debug('filled password field', elem.attrs.selectorChain.join('>>>'));
	return true;
}


export async function fillEmailField(elem: ElementInfo, hostname: string, emailAddress: string, options: FillTimesMs, log?: Logger) {
	let emailSuffix = hostname;
	if (emailSuffix.startsWith('www.')) {
		emailSuffix = emailSuffix.substring(4, 4 + emailSuffix.length);
	}
	const [local, domain] = emailAddress.split('@');
	const emailToFill     = `${local}+${emailSuffix}@${domain}`;

	try {
		await fillInputElement(elem, emailToFill, options);
	} catch (err) {
		log?.warn('failed to fill email field', elem.attrs, err);
		return false;
	}
	log?.debug('filled email field', elem.attrs.selectorChain.join('>>>'));
	return true;
}

export async function submitField(elem: ElementInfo, clickDwellTimeMs: number, log?: Logger) {
	log?.log('submitting field', elem.attrs.selectorChain.join('>>>'));
	try {
		await focusElement(elem.handle, clickDwellTimeMs);
		const page = getPageFromHandle(elem.handle)!;
		await page.keyboard.press('Enter');

	} catch (err) {
		log?.warn('failed to submit field', elem.attrs, err);
		return false;
	}
	return true;
}

export interface FillTimesMs {
	clickDwell: number;
	keyDwell: number;
	betweenKeys: number;
}
