import type { TestRecord } from '../model.js';

/** Likely cause of a failing test. `unknown` means no rule matched. */
export type Cause = 'selectors' | 'timing' | 'test-data' | 'environment' | 'unknown';

/**
 * How strongly the quoted evidence supports the cause.
 * `high` means two or more independent rules of that cause matched, or the
 * same strong rule matched on every failed attempt when there are two or more.
 * Rules that quote the same line are not independent. `SEL-NOTFOUND`,
 * `SEL-ZERO`, and `SEL-UNRESOLVED` are one group. `TIM-TEST-TIMEOUT` and
 * `TIM-NEAR-TIMEOUT` are one group.
 * `medium` means one strong rule matched, but not on every failed attempt.
 * `low` means the only match is a weak rule.
 */
export type Confidence = 'high' | 'medium' | 'low';

/** One likely cause, with the rule ids that matched and the quoted evidence. */
export type CauseFinding = {
  /** Cause name. */
  cause: Cause;
  /** Confidence for this cause. */
  confidence: Confidence;
  /** Exact substrings of the error text. Each one is at most 300 characters. */
  evidence: string[];
  /** Stable rule ids that produced this finding, in rule-table order. */
  ruleIds: string[];
};

/**
 * Options for `classifyCauses`.
 * `testTimeoutMs` is the test timeout, when the caller knows it.
 * `orderDependency` is the PR 6 hook. It returns evidence substrings when a
 * failure depends on test order. The default hook returns none.
 */
export type ClassifyOptions = {
  /** Test timeout in milliseconds. Used only by the near-timeout rule. */
  testTimeoutMs?: number;
  /** PR 6 hook. Return evidence substrings, or an empty list. */
  orderDependency?: OrderDependencyHook;
};

/** Returns evidence lines when a failure depends on test order. PR 6 fills this in. */
export type OrderDependencyHook = (record: TestRecord) => string[];

/** A single rule match inside one error text. */
export type RuleMatch = {
  /** Stable rule id, such as `SEL-STRICT`. */
  ruleId: string;
  /** Exact substrings that justify the match. */
  evidence: string[];
};
