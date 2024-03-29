/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* File taken from https://github.com/mozilla/fx-private-relay-add-on/blob/2022.5.18.515/src/js/other-websites/email_detector.js
 * Changes are marked with #LD-CHANGE */

//#LD-CHANGE
import {querySelectorAllDeep} from 'query-selector-shadow-dom';

//#LD-CHANGE use ESM syntax and export detectEmailInputs
import {dom, out, rule, ruleset, score, type, utils} from 'fathom-web';

export {detectEmailInputs};

const {isVisible} = utils;

/**
 * Return the number of occurrences of a string or regex in another
 * string.
 */
function numRegexMatches(regex, string) {
    if (string === null) {
        return 0;
    }
    return (string.match(regex) || []).length;  // Optimization: split() benchmarks faster.
}

/**
 * Returns true if at least one attribute of `element` (from a given list of
 * attributes `attrs`) match `regex`. Use a regex that matches the entire line
 * to test only exact matches.
 */
function attrsMatch(element, attrs, regex) {
    let result = false;
    for (const attr of attrs) {
        result = result || regex.test(element.getAttribute(attr));
    }
    return result;
}

/**
 * Tries to find a <label> element in the form containing `element` and return
 * the number of matches for the given regex in its inner text.
 */
function labelForInputMatches(element, regex) {
    // First check for labels correctly associated with the <input> element
    for (const label of Array.from(element.labels)) {
        const numFound = numRegexMatches(regex, label.innerText);
        if (numFound > 0) return true;
    }

    // Then check for a common mistake found in the training set: using the
    // <input>'s `name` attribute instead of its `id` to associate with a label
    const form = element.form;
    if (element.name.length > 0 && form !== null) { // look at nearby elements in general, not just in parent form?
        for (const label of Array.from(form.getElementsByTagName('label'))) {
            if (label.htmlFor.length > 0 && (label.htmlFor === element.name)) {
                const numFound = numRegexMatches(regex, label.innerText);
                if (numFound > 0) return true;
            }
        }
    }

    return false;
}

const emailRegex          = /email|e-mail/gi;
const emailRegexMatchLine = /^(email|e-mail)$/i;

const email_detector_ruleset = ruleset([
          // Inputs that could be email fields:
          rule(dom('input[type=text],input[type=""],input:not([type])').when(isVisible), type('email')),

          // Look for exact matches of "email"-like keywords in some attributes of the <input>
          rule(
                type('email'),
                score(fnode => attrsMatch(fnode.element, ['id', 'name', 'autocomplete'], emailRegexMatchLine)),
                {name: 'inputAttrsMatchEmailExactly'},
          ),

          // Count matches of "email"-like keywords in some attributes of the <input>
          rule(
                type('email'),
                score(fnode => attrsMatch(fnode.element, ['placeholder', 'aria-label'], emailRegex)),
                {name: 'inputPlaceholderMatchesEmail'},
          ),

          // If there's a corresponding <label> for this input, count its inner text matches for "email"-like keywords
          rule(
                type('email'),
                score(fnode => labelForInputMatches(fnode.element, emailRegex)),
                {name: 'labelForInputMatchesEmail'},
          ),

          rule(type('email'), out('email')),
      ],
      new Map([
          ['inputAttrsMatchEmailExactly', 9.416913986206055],
          ['inputPlaceholderMatchesEmail', 6.740292072296143],
          ['labelForInputMatchesEmail', 10.197700500488281],
      ]),
      [['email', -3.907843589782715]],
);

// It looks like ESLint doesn't recognise generator functions as global,
// so we ignore this rule here.
// Also, this function is defined as global in the ESLint config _because_ it is created here,
// so it's not actually a redeclaration.
// eslint-disable-next-line no-unused-vars, no-redeclare
function* detectEmailInputs(domRoot) {
    //#LD-CHANGE Fix for querySelectorAllDeep with SVG documents
    if (!(domRoot.ownerDocument ?? domRoot).head) return;

    //#LD-CHANGE Fix incorrect Prototype.js implementation
    let theirArrayFrom = Array.from;
    Array.from         = it => [...it];
    let theirReduce    = Array.prototype.reduce;
    if (Array.prototype.reduce.length === 0)
        Array.prototype.reduce = function(...args) {
            return [...this].reverse().reduceRight(...args);
        };

    try {
        // First return <input type='email'>
        //#LD-CHANGE use querySelectorAllDeep
        const typeEmailInputs = Array.from(querySelectorAllDeep('input[type=\'email\']'));
        for (const input of typeEmailInputs) {
            //#LD-CHANGE yield score
            yield {elem: input, score: 2};
        }

        // Then run ruleset and return detected fields
        const detectedInputs = email_detector_ruleset.against(domRoot).get('email');
        for (const input of detectedInputs) {
            //#LD-CHANGE yield score
            const score = input.scoreFor('email');
            if (score > 0.5) {
                yield {elem: input.element, score};
            }
        }
    } finally {
        //#LD-CHANGE
        Array.from             = theirArrayFrom;
        Array.prototype.reduce = theirReduce;
    }
}
