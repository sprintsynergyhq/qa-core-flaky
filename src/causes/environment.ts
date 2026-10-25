import type { RuleMatch } from './types.js';
import { isQuotedContextLine, lineContaining } from './text.js';

const NET = /net::ERR_[A-Z0-9_]+|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up/;

/**
 * An HTTP status from 500 to 599. A bare number is not enough: `5000ms` and
 * an expected value of 512 do not match. The status needs a status word, an
 * HTTP reason phrase, or an `apiRequestContext` error.
 */
const HTTP_5XX =
  /\b(?:status(?:\s+code)?|HTTP\/\d(?:\.\d)?)\s*[:=]?\s*5\d\d\b|\b5\d\d\s+(?:Internal Server Error|Not Implemented|Bad Gateway|Service Unavailable|Gateway Timeout|HTTP Version Not Supported)\b|apiRequestContext\.\w+:\s*5\d\d\b/i;

const LAUNCH = /browserType\.launch/;
const CLOSED = /Target page, context or browser has been closed/;

/**
 * Environment rules.
 * `selectorEvidence` is true when this same text also matches a selector rule.
 * A closed browser that still has locator evidence is not `ENV-BROWSER`.
 */
export function environmentMatches(text: string, selectorEvidence: boolean): RuleMatch[] {
  const hits: RuleMatch[] = [];
  const net = lineContaining(text, NET, isQuotedContextLine);
  if (net) hits.push({ ruleId: 'ENV-NET', evidence: [net] });

  const http = lineContaining(text, HTTP_5XX, isQuotedContextLine);
  if (http) hits.push({ ruleId: 'ENV-HTTP5XX', evidence: [http] });

  if (LAUNCH.test(text) || (CLOSED.test(text) && !selectorEvidence)) {
    const evidence = lineContaining(text, LAUNCH) ?? lineContaining(text, CLOSED);
    if (evidence) hits.push({ ruleId: 'ENV-BROWSER', evidence: [evidence] });
  }
  return hits;
}
