import type { RuleMatch } from './types.js';
import { lineContaining } from './text.js';

const TIMEOUT_EXCEEDED = /Timeout \d+ms exceeded/;
const TEST_TIMEOUT = /Test timeout of \d+ms exceeded/;
const INTERCEPT_PHRASE = 'intercepts pointer events';
const SOURCE_FRAME_LINE = /^[ \t]*(?:>[ \t]*)?\d+[ \t]*\|/;
const RESOLVED_REAL = /locator resolved to </;
const STATE_MATCHER =
  /(?:expect\(locator\)\.(?:toBeVisible|toBeHidden|toBeEnabled|toBeDisabled)\(|Expect "(?:toBeVisible|toBeHidden|toBeEnabled|toBeDisabled)")/;

/**
 * Timing rules. `nearTimeout` is decided by the caller from duration and the
 * known test timeout. It adds `TIM-NEAR-TIMEOUT` with no evidence line,
 * because the duration is not always present in the error text.
 */
export function timingMatches(text: string, nearTimeout: boolean): RuleMatch[] {
  const hits: RuleMatch[] = [];
  if (expectTimedOut(text)) {
    const evidence =
      lineContaining(text, TIMEOUT_EXCEEDED) ??
      lineContaining(text, /unexpected value "[^"]*"/) ??
      lineContaining(text, /Received:\s*\S+/) ??
      lineContaining(text, /expect\(locator\)\.(?:toBeVisible|toBeHidden|toBeEnabled|toBeDisabled)/);
    if (evidence) hits.push({ ruleId: 'TIM-EXPECT-TIMEOUT', evidence: [evidence] });
  }

  const testTimeout = lineContaining(text, TEST_TIMEOUT);
  if (testTimeout) hits.push({ ruleId: 'TIM-TEST-TIMEOUT', evidence: [testTimeout] });

  const slow = slowLoadMatch(text);
  if (slow) hits.push(slow);

  const intercept = interceptEvidence(text);
  if (intercept) hits.push({ ruleId: 'TIM-INTERCEPT', evidence: [intercept] });

  if (nearTimeout) hits.push({ ruleId: 'TIM-NEAR-TIMEOUT', evidence: [] });
  return hits;
}

/**
 * An expect whose locator resolved to a real element, and that then timed out.
 * `Timeout 2000ms exceeded` is the action form. Playwright 1.60.0 state
 * asserts (`toBeVisible` and the related matchers) instead print `Timeout: 400ms`
 * plus `locator resolved to <...>`. A value mismatch such as `toHaveText`
 * is not this rule.
 */
const NAV_SLOW =
  /page\.goto:\s*Timeout\s+\d+ms exceeded|Navigation timeout of \d+ms exceeded|navigating to .+waiting until "(?:load|domcontentloaded|networkidle)"|page was still loading|page never loaded/i;

/**
 * The page had not finished loading.
 * A navigation or load timeout is enough. `element(s) not found` after a
 * wait longer than 1000ms is the same signal when the locator never resolved
 * to a real element: the page was still loading, as with a slow first paint.
 * A miss of 1000ms or less stays a selector finding. That includes a 400ms
 * miss and the recorded typo locator, which uses `Timeout: 1000ms`.
 */
export function pageStillLoading(text: string): boolean {
  if (NAV_SLOW.test(text)) return true;
  if (/locator resolved to </.test(text)) return false;
  if (!/element\(s\) not found|locator resolved to 0 elements/.test(text)) return false;
  const timeout = /(?:Timeout:\s*|Timeout\s+|with timeout\s+|Test timeout of\s+)(\d+)ms/.exec(text);
  const ms = timeout?.[1];
  if (ms === undefined) return false;
  return Number(ms) > 1000;
}

function slowLoadMatch(text: string): RuleMatch | undefined {
  if (!pageStillLoading(text)) return undefined;
  const evidence =
    lineContaining(text, /page\.goto:\s*Timeout|Navigation timeout|navigating to /) ??
    lineContaining(text, /Timeout:\s*\d+ms|Timeout \d+ms exceeded|Test timeout of \d+ms exceeded/) ??
    lineContaining(text, /element\(s\) not found/) ??
    lineContaining(text, /locator resolved to 0 elements/);
  if (!evidence) return undefined;
  return { ruleId: 'TIM-SLOW-LOAD', evidence: [evidence] };
}

function expectTimedOut(text: string): boolean {
  if (/element\(s\) not found/.test(text)) return false;
  if (/locator resolved to 0 elements/.test(text)) return false;
  if (/strict mode violation/.test(text)) return false;
  if (!RESOLVED_REAL.test(text)) return false;
  if (TIMEOUT_EXCEEDED.test(text) && /expect\(locator\)|Expect "/.test(text)) return true;
  if (!STATE_MATCHER.test(text)) return false;
  return /Timeout:\s*\d+ms/.test(text) || /with timeout \d+ms/.test(text);
}

/**
 * Call-log line only, checked per line. A source frame such as
 * `44 | test('intercepts pointer events'` is not the signal. A single long
 * line is an `includes` check, not a pattern that walks the whole token.
 */
function interceptEvidence(text: string): string | undefined {
  for (const line of text.split('\n')) {
    if (SOURCE_FRAME_LINE.test(line)) continue;
    const at = line.indexOf(INTERCEPT_PHRASE);
    if (at === -1) continue;
    if (line.length <= 300) return line;
    const from = Math.max(0, Math.min(at, line.length - 300));
    return line.slice(from, from + 300);
  }
  return undefined;
}

/** True when the attempt duration is at least 90 percent of a known timeout. */
export function isNearTimeout(durationMs: number, testTimeoutMs: number | undefined): boolean {
  if (testTimeoutMs === undefined || !Number.isFinite(testTimeoutMs) || testTimeoutMs <= 0) return false;
  if (!Number.isFinite(durationMs) || durationMs < 0) return false;
  return durationMs * 10 >= testTimeoutMs * 9;
}
