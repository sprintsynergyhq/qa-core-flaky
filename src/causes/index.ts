import type { Attempt, AttemptError, TestRecord } from '../model.js';
import { stripAnsi } from '../report-path.js';
import { environmentMatches } from './environment.js';
import { hasSelectorEvidence, selectorMatches } from './selectors.js';
import { alreadyExistsMatch, orderMatch, readReceived } from './test-data.js';
import { isNearTimeout, timingMatches } from './timing.js';
import type { Cause, CauseFinding, ClassifyOptions, RuleMatch } from './types.js';

export type { Cause, CauseFinding, ClassifyOptions, Confidence, OrderDependencyHook } from './types.js';

const RULE_ORDER = [
  'SEL-STRICT',
  'SEL-NOTFOUND',
  'SEL-UNRESOLVED',
  'SEL-ZERO',
  'ENV-NET',
  'ENV-HTTP5XX',
  'ENV-BROWSER',
  'TIM-EXPECT-TIMEOUT',
  'TIM-TEST-TIMEOUT',
  'TIM-INTERCEPT',
  'TIM-NEAR-TIMEOUT',
  'DATA-VALUE-DRIFT',
  'DATA-ALREADY-EXISTS',
  'DATA-ORDER',
  'UNK-NONE',
  'UNK-EMPTY',
] as const;

const CAUSE_BY_RULE: Readonly<Record<string, Cause>> = {
  'SEL-STRICT': 'selectors',
  'SEL-NOTFOUND': 'selectors',
  'SEL-UNRESOLVED': 'selectors',
  'SEL-ZERO': 'selectors',
  'ENV-NET': 'environment',
  'ENV-HTTP5XX': 'environment',
  'ENV-BROWSER': 'environment',
  'TIM-EXPECT-TIMEOUT': 'timing',
  'TIM-TEST-TIMEOUT': 'timing',
  'TIM-INTERCEPT': 'timing',
  'TIM-NEAR-TIMEOUT': 'timing',
  'DATA-VALUE-DRIFT': 'test-data',
  'DATA-ALREADY-EXISTS': 'test-data',
  'DATA-ORDER': 'test-data',
  'UNK-NONE': 'unknown',
  'UNK-EMPTY': 'unknown',
};

const CONFIDENCE_RANK: Readonly<Record<CauseFinding['confidence'], number>> = {
  high: 0,
  medium: 1,
  low: 2,
};

const CAUSE_RANK: Readonly<Record<Cause, number>> = {
  selectors: 0,
  environment: 1,
  timing: 2,
  'test-data': 3,
  unknown: 4,
};

/** Rules that describe one locator miss. Matching together is still one signal. */
const SELECTOR_MISS_GROUP = ['SEL-NOTFOUND', 'SEL-ZERO', 'SEL-UNRESOLVED'] as const;

/** A test timeout is already past the near-timeout line, so the pair is one signal. */
const TEST_TIMEOUT_GROUP = ['TIM-TEST-TIMEOUT', 'TIM-NEAR-TIMEOUT'] as const;

const SOURCE_FRAME_LINE = /^[ \t]*(?:>[ \t]*)?\d+[ \t]*\|/;
const CARET_LINE = /^[ \t]*\|[ \t]*\^/;
const LINE_COL_ENDING = /:\d+:\d+$/;
const JUNIT_HEADER_LINE = /^\s*\[[^\]]+\]\s*\u203A.*(?:\u2500|-{3})/;

type Hit = {
  ruleId: string;
  cause: Cause;
  attemptIndex: number;
  evidence: string[];
};

/**
 * Read one test record and return the likely causes.
 *
 * Message and stack are both read. A failed attempt with no error text
 * becomes one Unknown finding (`UNK-EMPTY`) and does not throw.
 * Findings are sorted by confidence, then by selectors, environment, timing,
 * test-data. The same input returns the same array.
 */
export function classifyCauses(record: TestRecord, options: ClassifyOptions = {}): CauseFinding[] {
  const failed = failedAttempts(record);
  if (failed.length === 0) {
    if (record.outcome === 'failed' || record.outcome === 'flaky') return [unknownFinding('UNK-EMPTY', [])];
    return [];
  }

  const hits: Hit[] = [];
  const samples: { attemptIndex: number; key: string; receivedLine: string }[] = [];

  failed.forEach((attempt, attemptIndex) => {
    const errors = attempt.errors ?? [];
    for (const error of errors) {
      const texts = errorTexts(error).map((text) => filterCauseLines(text));
      if (texts.every((text) => text.trim().length === 0)) continue;
      collectErrorHits(hits, attemptIndex, texts);
      for (const text of texts) {
        const sample = readReceived(text);
        if (sample) samples.push({ attemptIndex, key: sample.key, receivedLine: sample.receivedLine });
      }
    }
    if (isNearTimeout(attempt.durationMs, options.testTimeoutMs)) {
      hits.push({
        ruleId: 'TIM-NEAR-TIMEOUT',
        cause: 'timing',
        attemptIndex,
        evidence: [],
      });
    }
  });

  hits.push(...valueDrift(samples));

  const orderEvidence = [...builtinOrderEvidence(record), ...hookEvidence(record, options)];
  if (orderEvidence.length > 0) {
    hits.push({
      ruleId: 'DATA-ORDER',
      cause: 'test-data',
      attemptIndex: 0,
      evidence: orderEvidence,
    });
  }

  if (hits.length === 0) {
    if (failed.every((attempt) => !attemptHasText(attempt))) return [unknownFinding('UNK-EMPTY', [])];
    return [unknownFinding('UNK-NONE', unknownEvidence(failed))];
  }

  const findings = findingsFromHits(hits, failed.length);
  addUnknownEvidenceWhenNearTimeoutOnly(findings, failed);
  return findings;
}

function failedAttempts(record: TestRecord): Attempt[] {
  return record.attempts
    .filter((attempt) => attempt.status === 'failed' || attempt.status === 'timedOut' || attempt.status === 'interrupted')
    .slice()
    .sort((left, right) => left.retry - right.retry);
}

function errorTexts(error: AttemptError): string[] {
  const texts: string[] = [];
  const message = prepareCauseText(error.message ?? '');
  const stack = prepareCauseText(error.stack ?? '');
  if (message.trim().length > 0) texts.push(message);
  if (stack.trim().length > 0 && stack !== message) texts.push(stack);
  return texts;
}

/** ANSI codes are removed and every CR line ending becomes LF before the rules run. */
function prepareCauseText(text: string): string {
  return normalizeNewlines(stripAnsi(text));
}

/**
 * `\r\n`, a lone `\r`, and `\r\r\n` all become `\n`.
 * The pattern is one pass, so a long run of CR characters stays linear.
 */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function attemptHasText(attempt: Attempt): boolean {
  return (attempt.errors ?? []).some((error) => errorTexts(error).length > 0);
}

function collectErrorHits(hits: Hit[], attemptIndex: number, texts: readonly string[]): void {
  const selectorEvidence = texts.some((text) => hasSelectorEvidence(text));
  for (const text of texts) {
    for (const match of selectorMatches(text)) pushHit(hits, attemptIndex, match);
    for (const match of environmentMatches(text, selectorEvidence)) pushHit(hits, attemptIndex, match);
    for (const match of timingMatches(text, false)) pushHit(hits, attemptIndex, match);
    const already = alreadyExistsMatch(text);
    if (already) pushHit(hits, attemptIndex, already);
  }
}

function pushHit(hits: Hit[], attemptIndex: number, match: RuleMatch): void {
  const cause = CAUSE_BY_RULE[match.ruleId];
  if (!cause) return;
  const existing = hits.find((hit) => hit.attemptIndex === attemptIndex && hit.ruleId === match.ruleId);
  if (!existing) {
    hits.push({
      ruleId: match.ruleId,
      cause,
      attemptIndex,
      evidence: match.evidence.filter((item) => item.length > 0),
    });
    return;
  }
  for (const item of match.evidence) {
    if (item.length > 0 && !existing.evidence.includes(item)) existing.evidence.push(item);
  }
}

function valueDrift(samples: { attemptIndex: number; key: string; receivedLine: string }[]): Hit[] {
  const groups = new Map<string, { attemptIndex: number; receivedLine: string }[]>();
  for (const sample of samples) {
    const group = groups.get(sample.key) ?? [];
    group.push({ attemptIndex: sample.attemptIndex, receivedLine: sample.receivedLine });
    groups.set(sample.key, group);
  }
  const hits: Hit[] = [];
  for (const group of groups.values()) {
    const distinct: string[] = [];
    for (const item of group) {
      if (!distinct.includes(item.receivedLine)) distinct.push(item.receivedLine);
    }
    if (distinct.length < 2) continue;
    const attemptIndexes = [...new Set(group.map((item) => item.attemptIndex))];
    attemptIndexes.forEach((attemptIndex, index) => {
      hits.push({
        ruleId: 'DATA-VALUE-DRIFT',
        cause: 'test-data',
        attemptIndex,
        evidence: index === 0 ? distinct : [],
      });
    });
  }
  return hits;
}

/** Order evidence from rerun modes. These lines are produced by the signal, so they are not substrings of the error. */
function builtinOrderEvidence(record: TestRecord): string[] {
  return orderMatch(record)?.evidence ?? [];
}

function hookEvidence(record: TestRecord, options: ClassifyOptions): string[] {
  const hook = options.orderDependency;
  if (!hook) return [];
  try {
    const returned = hook(record) ?? [];
    const evidence: string[] = [];
    for (const line of returned) {
      if (typeof line !== 'string' || line.length === 0) continue;
      const clipped = line.length > 300 ? line.slice(0, 300) : line;
      if (!corpusIncludes(record, clipped)) continue;
      if (!evidence.includes(clipped)) evidence.push(clipped);
    }
    return evidence;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'The hook threw.';
    const note = `debug: order dependency hook failed: ${detail.replaceAll('\n', ' ').trim()}`;
    options.debugNotes?.push(note);
    return [];
  }
}

function corpusIncludes(record: TestRecord, needle: string): boolean {
  const wanted = prepareCauseText(needle);
  if (wanted.length === 0) return false;
  for (const attempt of record.attempts) {
    for (const error of attempt.errors ?? []) {
      if (prepareCauseText(error.message ?? '').includes(wanted)) return true;
      if (prepareCauseText(error.stack ?? '').includes(wanted)) return true;
    }
  }
  return false;
}

function unknownEvidence(attempts: readonly Attempt[]): string[] {
  const evidence: string[] = [];
  for (const attempt of attempts) {
    for (const error of attempt.errors ?? []) {
      for (const text of errorTexts(error)) {
        const readable = filterCauseLines(text);
        const expected = lineOf(readable, /^[ \t]*Expected:[ \t]*.+$/);
        const received = lineOf(readable, /^[ \t]*Received:[ \t]*.+$/);
        const expectedSubstring = lineOf(readable, /^[ \t]*Expected substring:[ \t]*.+$/);
        const receivedString = lineOf(readable, /^[ \t]*Received string:[ \t]*.+$/);
        if (expected || received || expectedSubstring || receivedString) {
          pushEvidence(evidence, expected);
          pushEvidence(evidence, received);
          pushEvidence(evidence, expectedSubstring);
          pushEvidence(evidence, receivedString);
          continue;
        }
        const first = readable.split('\n').find((line) => line.trim().length > 0);
        if (first !== undefined) {
          pushEvidence(evidence, clipEvidenceLine(first));
          continue;
        }
        // A stack frame is not a cause, but it is still evidence when the
        // error has no other line. `at /home/alice:12:3` is quoted here.
        const frame = text.split('\n').find((line) => line.trim().length > 0);
        pushEvidence(evidence, frame === undefined ? undefined : clipEvidenceLine(frame));
      }
    }
  }
  return evidence;
}

/**
 * Drop lines that quote the test instead of the failure.
 * Line endings are normalized first (`\r\n`, a lone `\r`, and `\r\r\n`).
 * Source frames (`  21 | test(...)` and `> 21 |`), the caret line (`|   ^`),
 * `at` stack frames, and the JUnit `[project] › ...` header are removed.
 * Quoted evidence does not contain `\r`.
 */
function filterCauseLines(text: string): string {
  return prepareCauseText(text)
    .split('\n')
    .filter((line) => !isIgnoredCauseLine(line))
    .join('\n');
}

function isIgnoredCauseLine(line: string): boolean {
  return (
    SOURCE_FRAME_LINE.test(line) ||
    CARET_LINE.test(line) ||
    isStackFrameLine(line) ||
    JUNIT_HEADER_LINE.test(line)
  );
}

/**
 * A stack frame starts with `at` and a space or a tab.
 * It ends in `:line:col`, or in parentheses whose text is a location.
 * Nested parentheses are allowed, as in
 * `at seedDuplicate (eval at x (/w/a.ts:1:2), <anonymous>:1:1)`.
 * Prose such as `at least one row is a duplicate (see log)` stays.
 * The parenthesis scan is one reverse pass.
 */
function isStackFrameLine(line: string): boolean {
  const trimmed = line.trim();
  if (!/^at[ \t]/.test(trimmed)) return false;
  if (LINE_COL_ENDING.test(trimmed)) return true;
  if (!trimmed.endsWith(')')) return false;
  const inside = matchingParenInside(trimmed);
  if (inside === undefined) return false;
  return isFrameLocation(inside);
}

function matchingParenInside(value: string): string | undefined {
  let depth = 0;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const ch = value[index];
    if (ch === ')') {
      depth += 1;
      continue;
    }
    if (ch !== '(') continue;
    depth -= 1;
    if (depth === 0) return value.slice(index + 1, -1);
  }
  return undefined;
}

function isFrameLocation(inside: string): boolean {
  if (/:\d+:\d+/.test(inside)) return true;
  if (inside.includes('/') || inside.includes('\\')) return true;
  const compact = inside.trim();
  return compact === 'native' || compact === '<anonymous>';
}

function clipEvidenceLine(line: string): string {
  return line.length > 300 ? line.slice(0, 300) : line;
}

function lineOf(text: string, pattern: RegExp): string | undefined {
  const flags = pattern.flags.includes('m') ? pattern.flags : `${pattern.flags}m`;
  const match = new RegExp(pattern.source, flags.replaceAll('g', '')).exec(text);
  if (!match) return undefined;
  const start = text.lastIndexOf('\n', Math.max(0, match.index - 1)) + 1;
  let end = text.indexOf('\n', match.index);
  if (end === -1) end = text.length;
  const line = text.slice(start, end);
  return line.length > 300 ? line.slice(0, 300) : line;
}

function pushEvidence(evidence: string[], line: string | undefined): void {
  if (!line || line.length === 0 || evidence.includes(line)) return;
  evidence.push(line);
}

/**
 * A lone near-timeout finding has no error line of its own.
 * Keep the Unknown evidence so that text is not dropped.
 */
function addUnknownEvidenceWhenNearTimeoutOnly(findings: CauseFinding[], failed: readonly Attempt[]): void {
  if (findings.length !== 1) return;
  const only = findings[0];
  if (!only || only.ruleIds.length !== 1 || only.ruleIds[0] !== 'TIM-NEAR-TIMEOUT') return;
  for (const line of unknownEvidence(failed)) pushEvidence(only.evidence, line);
}

function unknownFinding(ruleId: 'UNK-NONE' | 'UNK-EMPTY', evidence: string[]): CauseFinding {
  return {
    cause: 'unknown',
    confidence: 'low',
    evidence,
    ruleIds: [ruleId],
  };
}

function findingsFromHits(hits: Hit[], failedCount: number): CauseFinding[] {
  const causes = new Set<Cause>();
  for (const hit of hits) causes.add(hit.cause);
  const findings: CauseFinding[] = [];
  for (const cause of causes) {
    const causeHits = hits.filter((hit) => hit.cause === cause);
    const ruleIds = RULE_ORDER.filter((ruleId) => causeHits.some((hit) => hit.ruleId === ruleId));
    const evidence: string[] = [];
    for (const ruleId of ruleIds) {
      const ordered = causeHits
        .filter((hit) => hit.ruleId === ruleId)
        .slice()
        .sort((left, right) => left.attemptIndex - right.attemptIndex);
      for (const hit of ordered) {
        for (const item of hit.evidence) pushEvidence(evidence, item);
      }
    }
    findings.push({
      cause,
      confidence: confidenceFor(ruleIds, causeHits, failedCount),
      evidence,
      ruleIds: [...ruleIds],
    });
  }
  findings.sort((left, right) => {
    const byConfidence = CONFIDENCE_RANK[left.confidence] - CONFIDENCE_RANK[right.confidence];
    if (byConfidence !== 0) return byConfidence;
    return CAUSE_RANK[left.cause] - CAUSE_RANK[right.cause];
  });
  return findings;
}

function confidenceFor(ruleIds: readonly string[], hits: readonly Hit[], failedCount: number): CauseFinding['confidence'] {
  const strong = ruleIds.filter((ruleId) => ruleId !== 'TIM-NEAR-TIMEOUT');
  if (strong.length === 0) return 'low';
  if (independentRuleCount(ruleIds, hits) >= 2) return 'high';
  const ruleId = strong[0];
  if (!ruleId) return 'low';
  const seen = new Set(hits.filter((hit) => hit.ruleId === ruleId).map((hit) => hit.attemptIndex));
  if (failedCount >= 2 && seen.size === failedCount) return 'high';
  return 'medium';
}

/**
 * Rules count as independent when their evidence lines differ and they are
 * not in the same group. `SEL-NOTFOUND`, `SEL-ZERO`, and `SEL-UNRESOLVED`
 * are one group. `TIM-TEST-TIMEOUT` and `TIM-NEAR-TIMEOUT` are one group.
 */
function independentRuleCount(ruleIds: readonly string[], hits: readonly Hit[]): number {
  const evidenceByRule = new Map<string, Set<string>>();
  for (const ruleId of ruleIds) {
    const lines = new Set<string>();
    for (const hit of hits) {
      if (hit.ruleId !== ruleId) continue;
      for (const line of hit.evidence) lines.add(line);
    }
    evidenceByRule.set(ruleId, lines);
  }
  const selected: string[] = [];
  for (const ruleId of ruleIds) {
    const independent = selected.every((other) => rulesAreIndependent(ruleId, other, evidenceByRule));
    if (independent) selected.push(ruleId);
  }
  return selected.length;
}

function rulesAreIndependent(
  left: string,
  right: string,
  evidenceByRule: ReadonlyMap<string, Set<string>>,
): boolean {
  if (sameDependentGroup(left, right)) return false;
  const leftLines = evidenceByRule.get(left);
  const rightLines = evidenceByRule.get(right);
  if (!leftLines || !rightLines) return true;
  for (const line of leftLines) {
    if (rightLines.has(line)) return false;
  }
  return true;
}

function sameDependentGroup(left: string, right: string): boolean {
  if ((SELECTOR_MISS_GROUP as readonly string[]).includes(left) && (SELECTOR_MISS_GROUP as readonly string[]).includes(right)) {
    return true;
  }
  return (TEST_TIMEOUT_GROUP as readonly string[]).includes(left) && (TEST_TIMEOUT_GROUP as readonly string[]).includes(right);
}
