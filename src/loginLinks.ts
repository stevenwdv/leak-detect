import {ElementHandle, Frame} from 'puppeteer';
import {filterUniqBy} from './utils';
import {ElementInfo, getElementAttrs, LinkElementAttrs, LinkMatchType} from './pageUtils';
import {evaluateHandle, unwrapHandle} from './puppeteerUtils';

/** Does not search in Shadow DOM */
export async function getLoginLinks(frame: Frame, matchTypes: Set<LinkMatchType>):
	  Promise<ElementInfo<LinkElementAttrs>[]> {
	const links: ElementInfo<LinkElementAttrs>[] = [];
	const seenSelectors                          = new Set<string>();

	async function addNew(elems: ElementHandle[], matchType: LinkMatchType) {
		const infos = filterUniqBy(await Promise.all(elems.map(async handle => ({
			handle, attrs: {
				...await getElementAttrs(handle),
				linkMatchType: matchType,
			},
		}))), seenSelectors, ({attrs: {selectorChain}}) => selectorChain.join('>>>'));

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

async function findLoginLinksByCoords(frame: Frame): Promise<ElementHandle[]> {
	const listHandle = await evaluateHandle(frame, () => {
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
	const listHandle    = await evaluateHandle(frame, (loginRegexSrc: string) => {
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
