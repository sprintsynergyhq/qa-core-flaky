import { classifyCauses } from './causes/index.js';
import type { Cause, CauseFinding, Confidence } from './causes/types.js';
import type { Attempt, TestRecord } from './model.js';
import type { VerdictName, VerdictSignal } from './report/schema.js';
import { normalizeErrorSignature } from './signature.js';

/**
 * Report order. Entries are sorted by this order, then by id.
 * `likely-real-bug` means a likely real bug. It does not mean confirmed.
 */
export const VERDICT_ORDER: readonly VerdictName[] = [
  'likely-real-bug',
  'flaky',
  'broken-test',
  'environment-issue',
  'needs-more-runs',
];

/** The decision for one test id. */
export type Verdict = {
  /** Selected verdict. */
  verdict: VerdictName;
  /** High when the decision row and the primary cause are both high, unless there are fewer than 3 attempts. */
  confidence: Confidence;
  /** Decision-table row, such as `LIKELY-REAL-BUG`. */
  ruleId: string;
  /** Primary cause used for the row. Null when the test has no cause finding. */
  cause: Cause | null;
  /** Rule ids of that primary cause, in cause-rule order. */
  ruleIds: string[];
  /**
   * Cause findings from the code version that selected the verdict.
   * Other versions stay in the signals, not in this list.
   */
  findings: CauseFinding[];
  /** Signals that were present. Order is fixed. */
  signals: VerdictSignal[];
  /** Set for a `test.fail()` pass, or when the failures have no error text. Otherwise null. */
  note: string | null;
};

const CONSISTENT_DETAIL = 'All attempts on this code failed with one error signature.';
const FLIP_DETAIL = 'At least one pass and one fail share the same code.';
const UNEXPECTED_NOTE = 'This test uses test.fail() and it passed. The expected failure did not happen.';
const NO_ERROR_NOTE = 'The report has no error text for these attempts.';

type CodeGroup = {
  key: string;
  attempts: Attempt[];
  failed: Attempt[];
  passed: Attempt[];
  signatures: string[];
  consistent: boolean;
};

/**
 * Choose one verdict for every record that shares a test id.
 *
 * When the records use one code key, `causes` is the classification for that
 * test. When they use more than one code key, each key is classified from
 * its own attempts.
 *
 * Rows are applied in the order documented in docs/verdicts.md.
 * A broken test, an environment issue, or a likely real bug outranks a
 * same-code flip. The result lists both signals when both are present.
 */
export function decideVerdict(
  records: readonly TestRecord[],
  causes: readonly CauseFinding[],
  options: { testTimeoutMs?: number } = {},
): Verdict {
  const groups = codeGroups(collapseRunRecords(records));
  const attemptCount = groups.reduce((sum, group) => sum + group.passed.length + group.failed.length, 0);
  const flips = groups.filter((group) => group.passed.length > 0 && group.failed.length > 0);
  // A later code group that only passes means the earlier consistent failure
  // is not the current verdict. Same-code flips are unchanged: a pass and a
  // fail on one SHA are already one group.
  const consistent = groups.filter((group) => group.consistent && !laterPassSupersedes(groups, group));
  const failedTotal = groups.reduce((sum, group) => sum + group.failed.length, 0);
  const passedTotal = groups.reduce((sum, group) => sum + group.passed.length, 0);
  const signatureCount = new Set(groups.flatMap((group) => group.signatures)).size;

  const findingsFor = (group: CodeGroup | undefined): CauseFinding[] => {
    if (!group) return [];
    if (groups.length === 1) return [...causes];
    return classifyGroup(records, group, options.testTimeoutMs);
  };

  const flipSha = commitOf(flips[0]);
  const broken = consistent.find((group) => isBrokenTest(findingsFor(group)));
  if (broken) {
    return finish(
      'broken-test',
      'BROKEN-TEST',
      'high',
      findingsFor(broken),
      flips.length > 0,
      false,
      attemptCount,
      emptyNote(broken),
      false,
      undefined,
      false,
      false,
      commitOf(broken),
      flipSha,
    );
  }

  const environment = consistent.find((group) => findingsFor(group)[0]?.cause === 'environment');
  if (environment) {
    return finish(
      'environment-issue',
      'ENVIRONMENT-ISSUE',
      'high',
      findingsFor(environment),
      flips.length > 0,
      false,
      attemptCount,
      emptyNote(environment),
      false,
      undefined,
      false,
      false,
      commitOf(environment),
      flipSha,
    );
  }

  const realBug = consistent.find((group) => isLikelyRealBug(findingsFor(group), group));
  if (realBug) {
    return finish(
      'likely-real-bug',
      'LIKELY-REAL-BUG',
      'high',
      findingsFor(realBug),
      flips.length > 0,
      false,
      attemptCount,
      emptyNote(realBug),
      false,
      undefined,
      false,
      false,
      commitOf(realBug),
      flipSha,
    );
  }

  if (flips.length > 0) {
    const flip = flips[0];
    return finish(
      'flaky',
      'FLAKY',
      'high',
      findingsFor(flip),
      false,
      false,
      attemptCount,
      emptyNote(flip),
      true,
      undefined,
      false,
      false,
      undefined,
      commitOf(flip),
    );
  }

  if (failedTotal === 1 || (passedTotal === 0 && signatureCount > 1)) {
    const failedGroup = groups.find((group) => group.failed.length > 0);
    const detail =
      failedTotal === 1
        ? 'Only one failed attempt. One failure is not enough for a stronger verdict.'
        : 'The failures do not share one error signature, and there is no pass.';
    return finish(
      'needs-more-runs',
      'NEEDS-MORE-RUNS',
      'low',
      findingsFor(failedGroup),
      false,
      true,
      attemptCount,
      emptyNote(failedGroup),
      false,
      detail,
      false,
      false,
      commitOf(failedGroup),
    );
  }

  if (unexpectedPass(records)) {
    return finish(
      'needs-more-runs',
      'UNEXPECTED-PASS',
      'low',
      findingsFor(groups[0]),
      false,
      false,
      attemptCount,
      UNEXPECTED_NOTE,
      false,
      undefined,
      true,
    );
  }

  const repeated = consistent.find((group) => group.failed.length >= 2);
  if (repeated) {
    const findings = findingsFor(repeated);
    return finish(
      'needs-more-runs',
      'NEEDS-MORE-RUNS',
      'low',
      findings,
      false,
      false,
      attemptCount,
      emptyNote(repeated),
      false,
      unmatchedDetail(findings),
      false,
      true,
      commitOf(repeated),
    );
  }

  return finish(
    'needs-more-runs',
    'NEEDS-MORE-RUNS',
    'low',
    findingsFor(groups[0]),
    false,
    true,
    attemptCount,
    emptyNote(groups[0]),
    false,
    'These attempts do not match a stronger verdict.',
    false,
    false,
    commitOf(groups[0]),
  );
}

function isBrokenTest(findings: readonly CauseFinding[]): boolean {
  const primary = findings[0];
  return primary?.cause === 'selectors' && primary.ruleIds.includes('SEL-NOTFOUND');
}

function isLikelyRealBug(findings: readonly CauseFinding[], group: CodeGroup): boolean {
  if (group.failed.length < 2) return false;
  if (hasNoErrorText(group)) return false;
  return findings[0]?.cause === 'unknown';
}

function hasNoErrorText(group: CodeGroup): boolean {
  return group.failed.length > 0 && group.failed.every((attempt) => !attemptHasErrorText(attempt));
}

function attemptHasErrorText(attempt: Attempt): boolean {
  for (const error of attempt.errors ?? []) {
    if ((error.message ?? '').trim().length > 0) return true;
    if ((error.stack ?? '').trim().length > 0) return true;
  }
  return false;
}

function emptyNote(group: CodeGroup | undefined): string | null {
  if (!group || !hasNoErrorText(group)) return null;
  return NO_ERROR_NOTE;
}

function commitOf(group: CodeGroup | undefined): string | undefined {
  if (!group?.key.startsWith('sha:')) return undefined;
  const sha = group.key.slice(4);
  return sha.length > 0 ? sha : undefined;
}

function labelSignal(detail: string, sha: string | undefined): string {
  if (!sha) return detail;
  return detail.replace('on this code', `on commit ${sha}`).replace('share the same code', `share commit ${sha}`);
}

function unmatchedDetail(findings: readonly CauseFinding[]): string {
  const primary = findings[0];
  if (!primary) {
    return `${CONSISTENT_DETAIL} The cause is not a broken test, an environment issue, or a likely real bug.`;
  }
  const rules = primary.ruleIds.join(', ');
  return `${CONSISTENT_DETAIL} The primary cause is ${primary.cause} (${rules}), which is not a broken test, an environment issue, or a likely real bug.`;
}

function unexpectedPass(records: readonly TestRecord[]): boolean {
  const attempts = records.flatMap((record) => record.attempts);
  const failed = attempts.some(isFailStatus);
  const passed = attempts.some((attempt) => attempt.status === 'passed');
  if (failed || !passed) return false;
  return records.some((record) => record.expectedStatus === 'failed');
}

function finish(
  verdict: VerdictName,
  ruleId: string,
  ruleConfidence: 'high' | 'low',
  findings: readonly CauseFinding[],
  flip: boolean,
  insufficient: boolean,
  attemptCount: number,
  note: string | null,
  forceFlip = false,
  insufficientDetail = 'Not enough evidence for a stronger verdict.',
  unexpected = false,
  consistentOverride = false,
  consistentSha?: string,
  flipSha?: string,
): Verdict {
  const primary = findings[0];
  const consistent = verdict === 'broken-test' || verdict === 'environment-issue' || verdict === 'likely-real-bug' || consistentOverride;
  const signals: VerdictSignal[] = [];
  if (consistent) {
    const detail = consistentOverride ? insufficientDetail : CONSISTENT_DETAIL;
    signals.push({ kind: 'consistent-failure', detail: labelSignal(detail, consistentSha) });
  }
  if (flip || forceFlip || verdict === 'flaky') {
    signals.push({ kind: 'same-code-flip', detail: labelSignal(FLIP_DETAIL, flipSha) });
  }
  if (insufficient) signals.push({ kind: 'insufficient-evidence', detail: insufficientDetail });
  if (unexpected) signals.push({ kind: 'unexpected-pass', detail: UNEXPECTED_NOTE });

  let confidence: Confidence;
  if (attemptCount < 3) confidence = 'low';
  else if (ruleConfidence === 'high' && primary?.confidence === 'high') confidence = 'high';
  else confidence = 'medium';

  return {
    verdict,
    confidence,
    ruleId,
    cause: primary?.cause ?? null,
    ruleIds: primary ? [...primary.ruleIds] : [],
    findings: [...findings],
    signals,
    note,
  };
}

function codeGroups(records: readonly TestRecord[]): CodeGroup[] {
  const order: string[] = [];
  const buckets = new Map<string, Attempt[]>();
  for (const record of records) {
    const key = codeKey(record);
    const existing = buckets.get(key);
    if (existing) {
      existing.push(...record.attempts);
      continue;
    }
    order.push(key);
    buckets.set(key, [...record.attempts]);
  }
  return order.map((key) => {
    const attempts = buckets.get(key) ?? [];
    const failed = attempts.filter(isFailStatus);
    const passed = attempts.filter((attempt) => attempt.status === 'passed');
    const signatures = unique(failed.map(attemptSignature));
    return {
      key,
      attempts,
      failed,
      passed,
      signatures,
      consistent: passed.length === 0 && failed.length > 0 && signatures.length === 1,
    };
  });
}

function laterPassSupersedes(groups: readonly CodeGroup[], group: CodeGroup): boolean {
  const index = groups.indexOf(group);
  return groups.slice(index + 1).some((later) => later.failed.length === 0 && later.passed.length > 0);
}

/**
 * One code version.
 * A commit SHA is the key when the record has one. Otherwise a run id is
 * the key. With neither, the report path with `.json`, `.xml`, or
 * `.junit.xml` removed is the key, so one run's JSON and JUnit files are
 * one group.
 */
export function runIdentity(record: TestRecord): string {
  const sha = record.source.commitSha;
  if (typeof sha === 'string' && sha.length > 0) return `sha:${sha}`;
  const runId = record.source.runId;
  if (typeof runId === 'string' && runId.length > 0) return `run:${runId}`;
  return `stem:${reportStem(record.source.reportPath)}`;
}

/** `a.json`, `a.xml`, and `a.junit.xml` share a stem. */
export function reportStem(reportPath: string): string {
  return reportPath.replace(/\\/g, '/').replace(/\.junit\.xml$/i, '').replace(/\.xml$/i, '').replace(/\.json$/i, '');
}

/**
 * Drop a repeated report, and drop a JUnit record when the same test id
 * already has a Playwright JSON record for that run. JSON keeps every
 * retry. Counting both would double the attempts and split the run.
 */
export function collapseRunRecords(records: readonly TestRecord[]): TestRecord[] {
  const seen = new Set<string>();
  const unique: TestRecord[] = [];
  for (const record of records) {
    const marker = `${record.id}\0${record.source.format}\0${record.source.reportPath}`;
    if (seen.has(marker)) continue;
    seen.add(marker);
    unique.push(record);
  }
  const jsonRuns = new Set(
    unique
      .filter((record) => record.source.format === 'playwright-json')
      .map((record) => `${record.id}\0${runIdentity(record)}`),
  );
  return unique.filter((record) => {
    if (record.source.format !== 'junit') return true;
    return !jsonRuns.has(`${record.id}\0${runIdentity(record)}`);
  });
}

function codeKey(record: TestRecord): string {
  return runIdentity(record);
}

function classifyGroup(
  records: readonly TestRecord[],
  group: CodeGroup,
  testTimeoutMs: number | undefined,
): CauseFinding[] {
  const base = records[0];
  if (!base) return [];
  return classifyCauses(
    {
      ...base,
      outcome: group.failed.length > 0 ? 'failed' : base.outcome,
      attempts: group.attempts,
    },
    testTimeoutMs === undefined ? {} : { testTimeoutMs },
  );
}

function attemptSignature(attempt: Attempt): string {
  const parts: string[] = [];
  for (const error of attempt.errors ?? []) {
    const message = error.message ?? '';
    const stack = error.stack ?? '';
    if (message.length > 0) parts.push(message);
    if (stack.length > 0 && stack !== message) parts.push(stack);
  }
  return normalizeErrorSignature(parts.join('\n').replace(/\r\n?/g, '\n'));
}

function isFailStatus(attempt: Attempt): boolean {
  return attempt.status === 'failed' || attempt.status === 'timedOut' || attempt.status === 'interrupted';
}

function unique(values: readonly string[]): string[] {
  const seen: string[] = [];
  for (const value of values) {
    if (!seen.includes(value)) seen.push(value);
  }
  return seen;
}
