import {ElementHandle} from 'puppeteer';

import {Logger} from './logger';
import {evaluate, getPageFromHandle} from './puppeteerUtils';
import {ElementInfo} from './pageUtils';
import {NO_DELAYS} from './FieldsCollector';

const KEY_PRESS_DWELL_TIME = NO_DELAYS ? 0 : 100;
const CLICK_DWELL_TIME     = NO_DELAYS ? 0 : 100;
const DELAY_BETWEEN_KEYS   = NO_DELAYS ? 0 : 250;

function getRandomUpTo(maxValue: number) {
	return Math.random() * maxValue;
}

export async function focusElement(handle: ElementHandle) {
	const page = getPageFromHandle(handle)!;
	await page.bringToFront();
	await smoothScrollToElement(handle);
	await handle.hover();
	await handle.click({delay: CLICK_DWELL_TIME});
}

async function smoothScrollToElement(handle: ElementHandle) {
	await evaluate(handle, el => el.scrollIntoView({behavior: 'smooth', block: 'end', inline: 'end'}));
}

async function fillInputElement(elem: ElementInfo, text: string) {
	await focusElement(elem.handle);
	const page = getPageFromHandle(elem.handle)!;
	for (const key of text) {
		const randDelayDwellTime      = getRandomUpTo(KEY_PRESS_DWELL_TIME);
		const randDelayBetweenPresses = getRandomUpTo(DELAY_BETWEEN_KEYS);
		await elem.handle.type(key, {delay: randDelayDwellTime});
		await page.waitForTimeout(randDelayBetweenPresses);
	}
	await page.keyboard.press('Tab');  // to trigger blur
}

export async function fillPasswordField(elem: ElementInfo, password: string, log?: Logger) {
	try {
		await fillInputElement(elem, password);
	} catch (err) {
		log?.warn(`failed to fill password field ${JSON.stringify(elem.attrs)}`, err);
		return false;
	}
	log?.debug(`filled password field ${JSON.stringify(elem.attrs)}`);
	return true;
}


export async function fillEmailField(elem: ElementInfo, hostname: string, emailAddress: string, log?: Logger) {
	let emailSuffix = hostname;
	if (emailSuffix.startsWith('www.')) {
		emailSuffix = emailSuffix.substring(4, 4 + emailSuffix.length);
	}
	const [local, domain] = emailAddress.split('@');
	const emailToFill     = `${local}+${emailSuffix}@${domain}`;

	try {
		await fillInputElement(elem, emailToFill);
	} catch (err) {
		log?.warn(`failed to fill email field ${JSON.stringify(elem.attrs)}`, err);
		return false;
	}
	log?.debug(`filled email field ${JSON.stringify(elem.attrs)}`);
	return true;
}

export async function submitField(elem: ElementInfo, log?: Logger) {
	log?.debug(`submitting field ${JSON.stringify(elem.attrs)}`);
	try {
		await focusElement(elem.handle);
		const page = getPageFromHandle(elem.handle)!;
		await page.keyboard.press('Enter');

	} catch (err) {
		log?.warn(`failed to submit field ${JSON.stringify(elem.attrs)}`, err);
		return false;
	}
	return true;
}
