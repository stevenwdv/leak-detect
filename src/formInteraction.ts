import {ElementHandle} from 'puppeteer';
import {getPageFromHandle} from './puppeteerUtils';

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

async function fillInputElement(elem: ElementHandle, text: string, options: FillTimesMs) {
	await focusElement(elem, options.clickDwell);
	const page = getPageFromHandle(elem)!;
	for (const key of text) {
		await elem.type(key, {delay: getRandomUpTo(options.keyDwell)});
		await page.waitForTimeout(getRandomUpTo(options.betweenKeys));
	}
	await page.keyboard.press('Tab');  // Trigger blur
}

export async function fillPasswordField(elem: ElementHandle, password: string, options: FillTimesMs) {
	await fillInputElement(elem, password, options);
}


export async function fillEmailField(
	  elem: ElementHandle, hostname: string, emailAddress: string, options: FillTimesMs) {
	let emailSuffix = hostname;
	if (emailSuffix.startsWith('www.')) {
		emailSuffix = emailSuffix.substring(4, 4 + emailSuffix.length);
	}
	const [local, domain] = emailAddress.split('@') as [string, string];
	const emailToFill     = `${local}+${emailSuffix}@${domain}`;

	await fillInputElement(elem, emailToFill, options);
}

export async function submitField(elem: ElementHandle, clickDwellTimeMs: number) {
	await focusElement(elem, clickDwellTimeMs);
	const page = getPageFromHandle(elem)!;
	await page.keyboard.press('Enter');
}

export interface FillTimesMs {
	clickDwell: number;
	keyDwell: number;
	betweenKeys: number;
}
