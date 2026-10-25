import { classifyCauses } from '../causes/index.js';
import type { Cause, CauseFinding } from '../causes/types.js';
import { suggestFix } from '../fixes/templates.js';
import type { TestRecord } from '../model.js';
import { decideVerdict, VERDICT_ORDER } from '../verdict.js';
import type { TriageEntry, TriageReport } from './schema.js';

export type BuildTriageOptions = {
  /** ISO time. Omit it and the report has no timestamp. */
  timestamp?: string;
  /** Forwarded to cause classification for the near-timeout rule. */
  testTimeoutMs?: number;
};

/**
 * Build one triage report from normalized records.
 * Records that share an id are one test. Passed and skipped tests are left out.
 * Entry order is verdict order, then id. The same records always build the same text.
 */
export function buildTriageReport(records: readonly TestRecord[], options: BuildTriageOptions = {}): TriageReport {
  const byId = new Map<string, TestRecord[]>();
  for (const record of records) {
    const list = byId.get(record.id);
    if (list) list.push(record);
    else byId.set(record.id, [record]);
  }

  const entries: TriageEntry[] = [];
  for (const group of byId.values()) {
    if (!group.some((record) => record.outcome === 'failed' || record.outcome === 'flaky')) continue;
    entries.push(buildEntry(group, options.testTimeoutMs));
  }

  entries.sort((left, right) => {
    const byVerdict = VERDICT_ORDER.indexOf(left.verdict) - VERDICT_ORDER.indexOf(right.verdict);
    if (byVerdict !== 0) return byVerdict;
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
  });

  const report: TriageReport = {
    schemaVersion: 1,
    entries,
  };
  if (options.timestamp !== undefined) report.generatedAt = options.timestamp;
  return report;
}

/** JSON text for a triage report, with a trailing newline. */
export function renderTriageJson(report: TriageReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function buildEntry(group: readonly TestRecord[], testTimeoutMs: number | undefined): TriageEntry {
  const base = group[0];
  if (!base) {
    throw new Error('Cannot build a triage entry without a record');
  }
  const attempts = group.flatMap((record) => record.attempts);
  const merged: TestRecord = {
    ...base,
    outcome: group.some((record) => record.outcome === 'failed')
      ? 'failed'
      : group.some((record) => record.outcome === 'flaky')
        ? 'flaky'
        : base.outcome,
    attempts,
  };
  const classifyOptions = testTimeoutMs === undefined ? {} : { testTimeoutMs };
  const findings = classifyCauses(merged, classifyOptions);
  const decision = decideVerdict(group, findings, classifyOptions);
  const causes = orderCauses(findings, decision.cause);
  const evidence = flattenEvidence(causes, decision.note);
  const failed = attempts.filter(
    (attempt) => attempt.status === 'failed' || attempt.status === 'timedOut' || attempt.status === 'interrupted',
  ).length;
  const passed = attempts.filter((attempt) => attempt.status === 'passed').length;
  const title = base.titlePath[base.titlePath.length - 1] ?? base.id;

  return {
    id: base.id,
    verdict: decision.verdict,
    confidence: decision.confidence,
    ruleId: decision.ruleId,
    signals: decision.signals,
    causes,
    evidence,
    attempts: {
      total: attempts.length,
      failed,
      passed,
      sameCommit: decision.signals.some((signal) => signal.kind === 'same-code-flip'),
    },
    history: {
      runsSeen: group.length,
      firstFailingCommit: null,
    },
    suggestedFix: suggestFix(decision.ruleIds),
    healProposal: null,
    nextStep: `Review the suggested fix. To see the test again, run: qa-core-flaky rerun ${JSON.stringify(base.file)} -g ${JSON.stringify(title)} --times 10`,
    note: decision.note,
    llm: null,
    review: {
      status: 'Needs Review',
      reviewer: null,
      decision: null,
    },
  };
}

function orderCauses(findings: readonly CauseFinding[], cause: Cause | null): CauseFinding[] {
  if (cause === null) return [...findings];
  const first = findings.filter((finding) => finding.cause === cause);
  const rest = findings.filter((finding) => finding.cause !== cause);
  if (first.length === 0) return [...findings];
  return [...first, ...rest];
}

function flattenEvidence(findings: readonly CauseFinding[], note: string | null): string[] {
  const evidence: string[] = [];
  for (const finding of findings) {
    for (const line of finding.evidence) {
      if (line.length > 0 && !evidence.includes(line)) evidence.push(line);
    }
  }
  if (evidence.length === 0 && note) evidence.push(note);
  return evidence;
}
