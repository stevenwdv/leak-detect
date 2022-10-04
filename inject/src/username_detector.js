/* File taken from https://mozilla.github.io/fathom/zoo.html#login-forms
 * Modified to remove next button detection and training features and to add detectUsernameInputs */

import {dom, out, rule, ruleset, score, type} from 'fathom-web';
import {euclidean} from 'fathom-web/clusters';
import {ancestors, isVisible, min} from 'fathom-web/utilsForFrontend';


const loginAttrRegex = /login|log-in|log_in|signon|sign-on|sign_on|signin|sign-in|sign_in|username/gi;  // no 'user-name' or 'user_name' found in first 20 training samples
const registerRegex  = /create|register|reg|sign up|signup|join|new/gi;

/**
 * Return a rule with a score equal to the number of keyword occurrences on
 * the fnode.
 *
 * Small unbucketed numbers seem to train similarly to a bucket using >= for
 * number.
 */
function keywordCountRule(inType, keywordRegex, baseName) {
	return rule(type(inType), score(fnode => numAttrMatches(keywordRegex, fnode.element)),  // === drops accuracy on first 20 training samples from 95% to 70%.
		  {name: baseName});
}

/**
 * Return the <hN> element Euclidean-wise above and center-point-
 * nearest the given element, null if there is none.
 */
function closestHeaderAbove(element) {  // TODO: Impose a distance limit?
	const body = element.ownerDocument.body;
	if (body !== null) {
		const headers = Array.from(body.querySelectorAll('h1,h2,h3,h4,h5,h6'));
		if (headers.length) {
			headers.filter(h => isAbove(h, element));
			return min(headers, h => euclidean(h, element));
		}
	}
	return null;
}

/**
 * Return whether element A is non-overlappingly above B: that is,
 * A's bottom is above or equal to B's top.
 */
function isAbove(a, b) {
	return a.getBoundingClientRect().bottom <= b.getBoundingClientRect().top;
}

/**
 * Return the number of registration keywords found on buttons in
 * the same form as the username element.
 */
function numRegistrationKeywordsOnButtons(usernameElement) {
	let num    = 0;
	const form = ancestorForm(usernameElement);
	if (form !== null) {
		for (const button of Array.from(form.querySelectorAll('button'))) {
			num += numAttrOrContentMatches(registerRegex, button);
		}
		for (const input of Array.from(form.querySelectorAll('input[type=submit],input[type=button]'))) {
			num += numAttrMatches(registerRegex, input);
		}
	}
	return num;
}

function first(iterable, defaultValue = null) {
	for (const i of iterable) {
		return i;
	}
	return defaultValue;
}

function* filter(iterable, predicate) {
	for (const i of iterable) {
		if (predicate(i)) {
			yield i;
		}
	}
}

function ancestorForm(element) {
	// TODO: Could probably be turned into upUntil(el, pred or selector), to go with plain up().
	return first(filter(ancestors(element), e => e.tagName === 'FORM'));
}

/**
 * Return the number of matches to a selector within a parent
 * element. Obey my convention of null meaning nothing returned,
 * for functions expected to return 1 or 0 elements.
 */
function numSelectorMatches(element, selector) {
	// TODO: Could generalize to within(element, predicate or selector).length.
	//console.log('ELE, QSA:', (element === null) ? null : typeof element, (element === null) ? null : element.tagName, element.querySelectorAll);
	// element is a non-null thing whose qsa prop is undefined.
	return (element === null) ? 0 : element.querySelectorAll(selector).length;
}

/**
 * Return the number of occurrences of a string or regex in another
 * string.
 */
function numRegexMatches(regex, string) {
	return (string.match(regex) || []).length;  // Optimization: split() benchmarks faster.
}

/**
 * Return the number of matches to the given regex in the attribute
 * values of the given element.
 */
function numAttrMatches(regex, element, attrs = []) {
	const attributes = attrs.length === 0 ? Array.from(element.attributes).map(a => a.name) : attrs;
	let num          = 0;
	for (let i = 0; i < attributes.length; i++) {
		const attr = element.getAttribute(attributes[i]);
		// If the attribute is an array, apply the scoring function to each element
		if (attr) {
			if (Array.isArray(attr)) {
				for (const eachValue of attr) {
					num += numRegexMatches(regex, eachValue);
				}
			} else {
				num += numRegexMatches(regex, attr);
			}
		}
	}
	return num;
}

function numContentMatches(regex, element) {
	if (element === null) {
		return 0;
	}
	return numRegexMatches(regex, element.innerText);
}

function numAttrOrContentMatches(regex, element) {
	return numContentMatches(regex, element) + numAttrMatches(regex, element);
}

/**
 * Return a ruleset that finds username fields.
 */
function makeRuleset() {
	const coeffs = [  // [rule name, coefficient]
		['emailKeywords', 0.3606211543083191],
		['loginKeywords', 5.311713218688965],
		['headerRegistrationKeywords', -1.6875461339950562],
		['buttonRegistrationKeywordsGte1', -2.22440767288208],
		['formPasswordFieldsGte2', -6.207341194152832],
		['formTextFields', -1.3702701330184937],
	];

	const rules = ruleset([
			  rule(dom('input[type=email],input[type=text],input[type=""],input:not([type])').when(isVisible), type('username')),

			  // Look at "login"-like keywords on the <input>:
			  // TODO: If slow, lay down the count as a note.
			  keywordCountRule('username', loginAttrRegex, 'loginKeywords'),

			  // Look at "email"-like keywords on the <input>:
			  keywordCountRule('username', /email/gi, 'emailKeywords'),

			  // Maybe also try the 2 closest headers, within some limit.
			  rule(type('username'), score(fnode => numContentMatches(registerRegex, closestHeaderAbove(fnode.element))), {name: 'headerRegistrationKeywords'}),

			  // If there is a Create or Join or Sign Up button in the form,
			  // it's probably an account creation form, not a login one.
			  // TODO: This is O(n * m). In a Prolog solution, we would first find all the forms, then characterize them as Sign-In-having or not, etc.:
			  // signInForm(F) :- tagName(F, 'form'), hasSignInButtons(F).
			  // Then this rule would say: contains(F, U), signInForm(F).
			  rule(type('username'), score(fnode => numRegistrationKeywordsOnButtons(fnode.element) >= 1), {name: 'buttonRegistrationKeywordsGte1'}),

			  // If there is more than one password field, it's more likely a sign-up form.
			  rule(type('username'), score(fnode => numSelectorMatches(ancestorForm(fnode.element), 'input[type=password]') >= 2), {name: 'formPasswordFieldsGte2'}),

			  // Login forms are short. Many fields smells like a sign-up form or payment form.
			  rule(type('username'), score(fnode => numSelectorMatches(ancestorForm(fnode.element), 'input[type=text]')), {name: 'formTextFields'}),

			  rule(type('username'), out('username')),
		  ],
		  coeffs,
		  [['username', -2.7013704776763916]]);

	return rules;
}

export function* detectUsernameInputs(domRoot) {
	// Fix for querySelectorAllDeep with SVG documents
	if (!(domRoot.ownerDocument ?? domRoot).head) return;

	// Fix incorrect Prototype.js implementation
	let theirArrayFrom = Array.from;
	Array.from         = it => [...it];
	let theirReduce    = Array.prototype.reduce;
	if (Array.prototype.reduce.length === 0)
		Array.prototype.reduce = function(...args) {
			return [...this].reverse().reduceRight(...args);
		};

	try {
		const detectedInputs = makeRuleset().against(domRoot).get('username');
		for (const input of detectedInputs) {
			const score = input.scoreFor('username');
			if (score > .5) yield {elem: input.element, score};
		}
	} finally {
		Array.from             = theirArrayFrom;
		Array.prototype.reduce = theirReduce;
	}
}
