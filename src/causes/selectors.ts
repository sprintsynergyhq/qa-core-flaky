import type { RuleMatch } from './types.js';
import { lineContaining } from './text.js';

const STRICT = /strict mode violation/;
const NOT_FOUND = /element\(s\) not found/;
const WAITING = /waiting for (?:locator\(|getBy[A-Za-z]+\()/;
const RESOLVED_ZERO = /locator resolved to 0 elements/;
const RESOLVED_REAL = /locator resolved to </;
const RESOLVED_SOME = /locator resolved to [1-9]\d* elements/;
const TIMEOUT_EXCEEDED = /Timeout \d+ms exceeded/;
const TEST_TIMEOUT = /Test timeout of \d+ms exceeded/;
const ZERO_MATCHER =
  /(?:expect\(locator\)\.(?:toHaveCount|toBeVisible|toBeAttached)\(|Expect "(?:toHaveCount|toBeVisible|toBeAttached)")/;

/**
 * Selector rules. A resolved locator with the wrong value is not a match.
 * See docs/causes.md.
 */
export function selectorMatches(text: string): RuleMatch[] {
  const hits: RuleMatch[] = [];
  const strict = lineContaining(text, STRICT);
  if (strict) hits.push({ ruleId: 'SEL-STRICT', evidence: [strict] });

  const notFound = lineContaining(text, NOT_FOUND);
  if (notFound) hits.push({ ruleId: 'SEL-NOTFOUND', evidence: [notFound] });

  if (unresolved(text)) {
    const evidence = lineContaining(text, RESOLVED_ZERO) ?? lineContaining(text, WAITING);
    if (evidence) hits.push({ ruleId: 'SEL-UNRESOLVED', evidence: [evidence] });
  }

  if (zeroElements(text)) {
    const evidence =
      lineContaining(text, RESOLVED_ZERO) ??
      lineContaining(text, NOT_FOUND) ??
      lineContaining(text, /Received:\s*0\b/);
    if (evidence) hits.push({ ruleId: 'SEL-ZERO', evidence: [evidence] });
  }

  return hits;
}

/** True when any selector rule matches. Environment uses this to ignore a closed browser. */
export function hasSelectorEvidence(text: string): boolean {
  return selectorMatches(text).length > 0;
}

/**
 * `resolved to 0 elements`, or a locator wait that hit a timeout with no
 * resolution line. A strict mode hit is not unresolved: the locator resolved
 * to more than one element.
 */
function unresolved(text: string): boolean {
  if (RESOLVED_ZERO.test(text)) return true;
  if (STRICT.test(text)) return false;
  if (RESOLVED_REAL.test(text) || RESOLVED_SOME.test(text)) return false;
  if (!WAITING.test(text)) return false;
  return TIMEOUT_EXCEEDED.test(text) || TEST_TIMEOUT.test(text);
}

/** `toHaveCount`, `toBeVisible`, or `toBeAttached` reporting zero elements. */
function zeroElements(text: string): boolean {
  if (!ZERO_MATCHER.test(text)) return false;
  if (NOT_FOUND.test(text) || RESOLVED_ZERO.test(text)) return true;
  return /toHaveCount/.test(text) && /Received:\s*0\b/.test(text);
}
