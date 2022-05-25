import {BoundingBox, ElementHandle, Frame, JSHandle, Page} from 'puppeteer';
import {GlobalNames} from './FieldsCollector';
import {XPathChain, XPathChainResult} from './inject/main';
import TypedArray = NodeJS.TypedArray;

// Regexes are taken from:
// https://searchfox.org/mozilla-central/rev/5e70cd673a0ba0ad19b662c1cf656e0823781596/toolkit/components/passwordmgr/NewPasswordModel.jsm#105-109
const loginRegex                     = /login|log in|log on|log-on|Войти|sign in|sigin|sign\/in|sign-in|sign on|sign-on|ورود|登录|Přihlásit se|Přihlaste|Авторизоваться|Авторизация|entrar|ログイン|로그인|inloggen|Συνδέσου|accedi|ログオン|Giriş Yap|登入|connecter|connectez-vous|Connexion|Вход/i;
const loginFormAttrRegex             = /login|log in|log on|log-on|sign in|sigin|sign\/in|sign-in|sign on|sign-on/i;
const registerStringRegex            = /create[a-zA-Z\s]+account|Zugang anlegen|Angaben prüfen|Konto erstellen|register|sign up|ثبت نام|登録|注册|cadastr|Зарегистрироваться|Регистрация|Bellige alynmak|تسجيل|ΕΓΓΡΑΦΗΣ|Εγγραφή|Créer mon compte|Mendaftar|가입하기|inschrijving|Zarejestruj się|Deschideți un cont|Создать аккаунт|ร่วม|Üye Ol|registr|new account|ساخت حساب کاربری|Schrijf je/i;
const registerActionRegex            = /register|signup|sign-up|create-account|account\/create|join|new_account|user\/create|sign\/up|membership\/create/i;
const registerFormAttrRegex          = /signup|join|register|regform|registration|new_user|AccountCreate|create_customer|CreateAccount|CreateAcct|create-account|reg-form|newuser|new-reg|new-form|new_membership/i;
const loginRegexExtra                = /log_in|logon|log_on|signin|sign_in|sign_up|signon|sign_on|Aanmelden/i;
const combinedLoginLinkRegexLooseSrc = [loginRegex.source, loginFormAttrRegex.source, registerStringRegex.source, registerActionRegex.source, registerFormAttrRegex.source, loginRegexExtra.source].join('|');
const combinedLoginLinkRegexExactSrc = '^' + combinedLoginLinkRegexLooseSrc.replace(/\|/g, '$|^') + '$';

export function stripHash(url: string | URL): string {
	return url.toString().match(/^[^#]*/)![0];
}

/** @return `true` if `key` was newly added to `map`, `false` if it was already present */
export function trySet<K, V>(map: Map<K, V>, key: K, value: V): boolean {
	return trySetWith(map, key, () => value);
}

/** @return `true` if `key` was newly added to `map`, `false` if it was already present */
export function trySetWith<K, V>(map: Map<K, V>, key: K, getValue: () => V): boolean {
	if (map.has(key)) return false;
	map.set(key, getValue());
	return true;
}

/** Add `map(element)` for each element in `items` to `seen` and return elements that were not in `seen` before */
export function filterUniqBy<ItemType, FilterType>(items: ItemType[], seen: Set<FilterType>,
                                                   map: (item: ItemType) => FilterType): ItemType[] {
	return items.filter(item => tryAdd(seen, map(item)));
}

/** @return `true` if `value` was newly added to `set`, `false` if it was already present */
export function tryAdd<T>(set: Set<T>, value: T): boolean {
	if (set.has(value)) return false;
	set.add(value);
	return true;
}

// puppeteer does not actually export its classes, so we cannot use instanceof and instead need this stupid stuff
/** Checks if `obj` is exactly of type `className` (not derived) */
export function isOfType(obj: unknown, className: string): boolean {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
	return Object.getPrototypeOf(obj)?.constructor?.name === className;
}

export function getPageFromHandle(handle: JSHandle): Page | null {
	const frame = handle.executionContext().frame();
	return frame ? getPageFromFrame(frame) : null;
}

export function getPageFromFrame(frame: Frame): Page {
	return frame._frameManager.page();  //XXX Replace with stable version if ever available
}

export type UnwrappedHandle<T> = T extends string | boolean | number | null | undefined | bigint
	  ? T
	  : T extends Element
			? ElementHandle<T>
			: T extends (infer V)[]
				  ? UnwrappedHandle<V>[]
				  : T extends Node | RegExp | Date | Map<unknown, unknown> | Set<unknown> | WeakMap<object, unknown> | WeakSet<object>
						| Iterator<unknown> | Generator | Error | Promise<unknown> | TypedArray | ArrayBuffer | DataView
						? JSHandle<T>
						: T extends object
							  ? { [K in keyof T]: UnwrappedHandle<T[K]> }
							  : unknown;

/**
 * Like {@link JSHandle#jsonValue}, but retains some non-serializable objects as {@link JSHandle}s
 */
export async function unwrapHandle<T>(handle: JSHandle<T>): Promise<UnwrappedHandle<T>> {
	return await unwrapHandleConservative(handle, () => true) as UnwrappedHandle<T>;
}

export type UnwrappedHandleConservative<T> = T extends string | boolean | number | null | undefined | bigint
	  ? T
	  : T extends Element
			? ElementHandle<T>
			: T extends (infer V)[]
				  ? UnwrappedHandleConservative<V>[]
				  : T extends Node | RegExp | Date | Map<unknown, unknown> | Set<unknown> | WeakMap<object, unknown> | WeakSet<object>
						| Iterator<unknown> | Generator | Error | Promise<unknown> | TypedArray | ArrayBuffer | DataView
						? JSHandle<T>
						: T extends object
							  ? { [K in keyof T]: UnwrappedHandleConservative<T[K]> } | JSHandle<T>
							  : unknown;

/**
 * Like {@link JSHandle#jsonValue}, but retains non-serializable objects as {@link JSHandle}s
 */
export async function unwrapHandleConservative<T>(handle: JSHandle<T>, shouldUnwrap: (className: string) => boolean = className => ['Object', 'Proxy'].includes(className)):
	  Promise<UnwrappedHandleConservative<T>> {
	//XXX Replace _remoteObject with stable version if ever available

	if (['function', 'symbol', 'bigint'].includes(handle._remoteObject.type))
		return handle as UnwrappedHandleConservative<T>;

	if (handle._remoteObject.type === 'object') {
		if ([undefined, 'proxy'].includes(handle._remoteObject.subtype)) {
			if (shouldUnwrap(handle._remoteObject.className!))
				return Object.fromEntries(await Promise.all([...await handle.getProperties()]
					  .map(async ([k, v]) => [k, await unwrapHandleConservative(v, shouldUnwrap)]))) as UnwrappedHandleConservative<T>;
		} else {
			if (handle._remoteObject.subtype === 'null')
				return null as UnwrappedHandleConservative<T>;
			if (handle._remoteObject.subtype === 'array')
				return await Promise.all([...await handle.getProperties()]
					  .map(async ([, v]) => await unwrapHandleConservative(v, shouldUnwrap))) as UnwrappedHandleConservative<T>;
		}
		return (handle.asElement() ?? handle) as UnwrappedHandleConservative<T>;

	} else
		return (handle._remoteObject.type === 'undefined'
			  ? undefined
			  : handle._remoteObject.value
			  ?? (handle._remoteObject.unserializableValue
					? eval(handle._remoteObject.unserializableValue)
					: await handle.jsonValue())) as UnwrappedHandleConservative<T>;
}

async function findLoginLinksByCoords(frame: Frame): Promise<ElementHandle[]> {
	const listHandle = await frame.evaluateHandle<JSHandle<Element[]>>(() => {
		const MAX_COORD_BASED_LINKS = 5;
		const MEDIAN_LOGIN_LINK_X   = 1113,
		      MEDIAN_LOGIN_LINK_Y   = 64.5;

		function distanceFromLoginLinkMedianPoint(elem: Element) {
			const rect    = elem.getBoundingClientRect();
			const centerX = rect.x + rect.width / 2;
			const centerY = rect.y + rect.height / 2;
			return Math.sqrt(
				  (centerX - MEDIAN_LOGIN_LINK_X) ** 2 +
				  (centerY - MEDIAN_LOGIN_LINK_Y) ** 2);
		}

		const allElements = [...document.querySelectorAll('a,button')];
		allElements.sort((a, b) => distanceFromLoginLinkMedianPoint(a) - distanceFromLoginLinkMedianPoint(b));
		return allElements.slice(0, MAX_COORD_BASED_LINKS);
	});
	return unwrapHandle(listHandle);
}

export async function findLoginLinks(frame: Frame, exactMatch = false): Promise<ElementHandle[]> {
	const loginRegexSrc = exactMatch ? combinedLoginLinkRegexExactSrc : combinedLoginLinkRegexLooseSrc;
	const listHandle    = await frame.evaluateHandle<JSHandle<Element[]>>((loginRegexSrc: string) => {
		const loginRegex  = new RegExp(loginRegexSrc, 'i');
		const allElements = [...document.querySelectorAll('a,span,button,div')];

		return allElements.filter(el => (
			  el instanceof HTMLElement && (
					loginRegex.test(el.innerText) ||
					loginRegex.test(el.title) ||
					(el instanceof HTMLAnchorElement || el instanceof HTMLAreaElement) && loginRegex.test(el.href)
			  ) ||
			  el instanceof SVGAElement && loginRegex.test(el.href.baseVal) ||
			  el.ariaLabel && loginRegex.test(el.ariaLabel) ||
			  loginRegex.test(el.id) ||
			  el.getAttribute('name')?.match(loginRegex) ||
			  (el instanceof SVGElement && el.className instanceof SVGAnimatedString
					? loginRegex.test(el.className.baseVal) : loginRegex.test(el.className))
		));
	}, loginRegexSrc);
	return unwrapHandle(listHandle);
}

/** Does not search in Shadow DOM, but {@link import('./inject/main').getNodeByXPathChain} is broken for that anyway... */
export async function getLoginLinks(frame: Frame, matchTypes: Set<LinkMatchType>):
	  Promise<ElementInfo<LinkElementAttrs>[]> {
	const links: ElementInfo<LinkElementAttrs>[] = [];
	const seenXPathChains                        = new Set<string>();

	async function addNew(elems: ElementHandle[], matchType: LinkMatchType) {
		const infos = filterUniqBy(await Promise.all(elems.map(async handle => ({
			handle, attrs: {
				...await getElementAttrs(handle),
				linkMatchType: matchType,
			},
		}))), seenXPathChains, ({attrs: {xpathChain}}) => xpathChain.join(' '));

		function isButtonOrLink(tagName: string) {
			return ['BUTTON', 'A'].includes(tagName);
		}

		infos.sort(({attrs: a}, {attrs: b}) =>
			  (isButtonOrLink(b.tagName) ? 1 : 0) - (isButtonOrLink(a.tagName) ? 1 : 0)
			  || (b.onTop ? 1 : 0) - (a.onTop ? 1 : 0)
			  || (b.inView ? 1 : 0) - (a.inView ? 1 : 0));
		links.push(...infos);
	}

	if (matchTypes.has('exact'))
		await addNew(await findLoginLinks(frame, true), 'exact');
	if (matchTypes.has('loose'))
		await addNew(await findLoginLinks(frame, false), 'loose');
	if (matchTypes.has('coords'))
		await addNew(await findLoginLinksByCoords(frame), 'coords');
	return links;
}

export async function getElementInfoFromAttrs(attrs: ElementAttrs, frame: Frame): Promise<ElementInfo | null> {
	const handle = (await getNodeByXPathChain(attrs.xpathChain, frame))?.node;
	return (handle ?? null) && {handle: handle as ElementHandle, attrs};
}

export async function getNodeByXPathChain(xpathChain: XPathChain, frame: Frame): Promise<{ node: JSHandle<Node>, unique: boolean } | null> {
	return await unwrapHandle(await frame.evaluateHandle<JSHandle<XPathChainResult | null>>(
		  (xpathChain: XPathChain) => window[GlobalNames.INJECTED]!.getNodeByXPathChain(xpathChain), xpathChain));
}

/** @return Stack starting with this frame, going up */
export function getFrameStack(frame: Frame): Frame[] {
	const frames: Frame[]      = [];
	let curFrame: Frame | null = frame;
	do {
		frames.push(curFrame);
		curFrame = curFrame.parentFrame();
	} while (curFrame);
	return frames;
}

export async function getElementAttrs(handle: ElementHandle): Promise<ElementAttrs> {
	const inView         = await handle.isIntersectingViewport();
	const boundingBox    = await handle.boundingBox();
	const elAttrsPartial = await handle.evaluate(el => ({
		id: el.id,
		tagName: el.nodeName,
		class: el.className,

		innerText: el instanceof HTMLElement ? el.innerText : el.textContent || '',
		name: el.getAttribute('name'),
		type: el.getAttribute('type'),
		href: el.getAttribute('href'),
		ariaLabel: el.ariaLabel,
		placeholder: el.getAttribute('placeholder'),

		onTop: window[GlobalNames.INJECTED]!.isOnTop(el),

		xpathChain: window[GlobalNames.INJECTED]!.formXPathChain(el),
	}));
	return {
		...elAttrsPartial,
		frameStack: getFrameStack(handle.executionContext().frame()!).map(f => f.url()),
		inView,
		boundingBox,
	};
}

export function removeNewLines(str: string) {
	return str.replace(/[\n\r]+/g, ' ');
}

export interface ElementAttrs {
	/** Starting with the bottom frame, going up */
	frameStack: string[];

	id: string;
	tagName: string;
	class: string;

	innerText: string;

	name: string | null;
	type: string | null;
	href: string | null;
	ariaLabel: string | null;
	placeholder: string | null;

	onTop: boolean;
	inView: boolean;
	boundingBox: BoundingBox | null;

	xpathChain: XPathChain;
}

export interface FathomElementAttrs extends ElementAttrs {
	score: number;
}

export interface FieldElementAttrs extends ElementAttrs {
	fieldType: FieldType;
	filled?: boolean;
}

export interface LinkElementAttrs extends ElementAttrs {
	linkMatchType: LinkMatchType;
}

export type FieldType = 'email' | 'password';
export type LinkMatchType = 'exact' | 'loose' | 'coords';

export interface ElementInfo<AttrsType extends ElementAttrs = ElementAttrs, ElementType extends Element = Element> {
	handle: ElementHandle<ElementType>;
	attrs: AttrsType;
}
