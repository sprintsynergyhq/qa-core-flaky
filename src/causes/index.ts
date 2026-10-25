import type { Attempt, AttemptError, TestRecord } from '../model.js';
import { environmentMatches } from './environment.js';
import { hasSelectorEvidence, selectorMatches } from './selectors.js';
import { alreadyExistsMatch, readReceived } from './test-data.js';
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
      const texts = errorTexts(error);
      if (texts.length === 0) continue;
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

  const orderEvidence = hookEvidence(record, options);
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

  return findingsFromHits(hits, failed.length);
}

function failedAttempts(record: TestRecord): Attempt[] {
  return record.attempts
    .filter((attempt) => attempt.status === 'failed' || attempt.status === 'timedOut' || attempt.status === 'interrupted')
    .slice()
    .sort((left, right) => left.retry - right.retry);
}

function errorTexts(error: AttemptError): string[] {
  const texts: string[] = [];
  const message = error.message ?? '';
  const stack = error.stack ?? '';
  if (message.trim().length > 0) texts.push(message);
  if (stack.trim().length > 0 && stack !== message) texts.push(stack);
  return texts;
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

function hookEvidence(record: TestRecord, options: ClassifyOptions): string[] {
  const hook = options.orderDependency;
  if (!hook) return [];
  const returned = hook(record) ?? [];
  const evidence: string[] = [];
  for (const line of returned) {
    if (typeof line !== 'string' || line.length === 0) continue;
    const clipped = line.length > 300 ? line.slice(0, 300) : line;
    if (!corpusIncludes(record, clipped)) continue;
    if (!evidence.includes(clipped)) evidence.push(clipped);
  }
  return evidence;
}

function corpusIncludes(record: TestRecord, needle: string): boolean {
  for (const attempt of record.attempts) {
    for (const error of attempt.errors ?? []) {
      if ((error.message ?? '').includes(needle)) return true;
      if ((error.stack ?? '').includes(needle)) return true;
    }
  }
  return false;
}

function unknownEvidence(attempts: readonly Attempt[]): string[] {
  const evidence: string[] = [];
  for (const attempt of attempts) {
    for (const error of attempt.errors ?? []) {
      for (const text of errorTexts(error)) {
        const expected = lineOf(text, /^Expected:\s*.+$/);
        const received = lineOf(text, /^Received:\s*.+$/);
        if (expected || received) {
          pushEvidence(evidence, expected);
          pushEvidence(evidence, received);
          continue;
        }
        const first = text.split('\n').find((line) => line.trim().length > 0);
        pushEvidence(evidence, first);
      }
    }
  }
  return evidence;
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
  if (ruleIds.length >= 2) return 'high';
  const ruleId = strong[0];
  if (!ruleId) return 'low';
  const seen = new Set(hits.filter((hit) => hit.ruleId === ruleId).map((hit) => hit.attemptIndex));
  if (failedCount >= 2 && seen.size === failedCount) return 'high';
  return 'medium';
}
