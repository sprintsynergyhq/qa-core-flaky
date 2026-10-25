import { classifyCauses } from '../causes/index.js';
import type { Cause, CauseFinding } from '../causes/types.js';
import { suggestFix } from '../fixes/templates.js';
import type { Attempt, RerunMode, TestRecord } from '../model.js';
import { homeMarks, redactHomeText } from '../report-path.js';
import { shellCommand } from '../rerun/plan.js';
import { collapseRunRecords, decideVerdict, VERDICT_ORDER } from '../verdict.js';
import type { RerunCounts, TriageAttempts, TriageEntry, TriageReport } from './schema.js';

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
  assignDisplayIds(entries);

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
  const records = collapseRunRecords(group);
  const base = records[0];
  if (!base) {
    throw new Error('Cannot build a triage entry without a record');
  }
  const attempts = records.flatMap((record) => record.attempts);
  const merged: TestRecord = {
    ...base,
    outcome: records.some((record) => record.outcome === 'failed')
      ? 'failed'
      : records.some((record) => record.outcome === 'flaky')
        ? 'flaky'
        : base.outcome,
    attempts,
  };
  const classifyOptions = testTimeoutMs === undefined ? {} : { testTimeoutMs };
  const findings = classifyCauses(merged, classifyOptions);
  const decision = decideVerdict(records, findings, classifyOptions);
  const ordered = orderCauses(decision.findings, decision.cause);
  // Dedupe the original lines first. Number homes from the id, then the
  // title and file, then the evidence, so the id stays the same when only
  // the error text changes. Later usernames are `<home~2>`, `<home~3>`.
  const rawEvidence = flattenEvidence(ordered, decision.note);
  const titleRaw = base.titlePath[base.titlePath.length - 1] ?? base.id;
  const configFile = base.source.configFile;
  const marks = homeMarks([
    base.id,
    titleRaw,
    base.file,
    ...rawEvidence,
    ...ordered.flatMap((finding) => finding.evidence),
    ...(configFile ? [configFile] : []),
  ]);
  const redact = (value: string) => redactHomeText(value, marks);
  const evidence = rawEvidence.map((line) => redact(line));
  const causes = ordered.map((finding) => ({
    ...finding,
    evidence: finding.evidence.map((line) => redact(line)),
  }));
  const failed = attempts.filter(isFailStatus).length;
  const passed = attempts.filter((attempt) => attempt.status === 'passed').length;
  const id = redact(base.id);
  const reportPath = redact(base.source.reportPath);
  const reruns = rerunCounts(attempts);
  const observation = rerunObservation(attempts);

  const entry: TriageEntry = {
    id,
    verdict: decision.verdict,
    confidence: decision.confidence,
    ruleId: decision.ruleId,
    signals: decision.signals,
    causes,
    evidence,
    attempts: attemptCounts(attempts, failed, passed, decision.signals.some((signal) => signal.kind === 'same-code-flip'), reruns),
    history: {
      runsSeen: records.length,
      firstFailingCommit: null,
    },
    suggestedFix: suggestFix(decision.ruleIds),
    healProposal: null,
    nextStep: `Review the suggested fix. To see the test again, run: ${shellCommand(reportPath, id, configFile ? redact(configFile) : undefined)}`,
    note: decision.note,
    llm: null,
    review: {
      status: 'Needs Review',
      reviewer: null,
      decision: null,
    },
  };
  if (observation) entry.observation = observation;
  return entry;
}

function attemptCounts(
  attempts: readonly Attempt[],
  failed: number,
  passed: number,
  sameCommit: boolean,
  reruns: TriageAttempts['reruns'],
): TriageAttempts {
  const counts: TriageAttempts = {
    total: attempts.length,
    failed,
    passed,
    sameCommit,
  };
  if (reruns) counts.reruns = reruns;
  return counts;
}

const RERUN_MODES: readonly RerunMode[] = ['repeat', 'isolated', 'in-order'];

function rerunCounts(attempts: readonly Attempt[]): TriageAttempts['reruns'] {
  const reruns: NonNullable<TriageAttempts['reruns']> = {};
  let any = false;
  for (const mode of RERUN_MODES) {
    const rows = attempts.filter((attempt) => attempt.rerun?.mode === mode);
    if (rows.length === 0) continue;
    const counts: RerunCounts = {
      total: rows.length,
      failed: rows.filter(isFailStatus).length,
      passed: rows.filter((attempt) => attempt.status === 'passed').length,
    };
    if (mode === 'repeat') reruns.repeat = counts;
    else if (mode === 'isolated') reruns.isolated = counts;
    else reruns['in-order'] = counts;
    any = true;
  }
  return any ? reruns : undefined;
}

/** N is the number of rerun attempts. The sentence is omitted when one of them failed. */
function rerunObservation(attempts: readonly Attempt[]): string | undefined {
  const rows = attempts.filter((attempt) => attempt.rerun !== undefined);
  if (rows.length === 0) return undefined;
  if (rows.some((attempt) => attempt.status !== 'passed')) return undefined;
  return `no flake observed in ${rows.length} runs`;
}

function isFailStatus(attempt: Attempt): boolean {
  return attempt.status === 'failed' || attempt.status === 'timedOut' || attempt.status === 'interrupted';
}

function orderCauses(findings: readonly CauseFinding[], cause: Cause | null): CauseFinding[] {
  if (cause === null) return [...findings];
  const first = findings.filter((finding) => finding.cause === cause);
  const rest = findings.filter((finding) => finding.cause !== cause);
  if (first.length === 0) return [...findings];
  return [...first, ...rest];
}

/**
 * Ids that differ only by a username redact to one string. Keep every entry.
 * The first id in report order stays as redacted. The next ones gain
 * ` (2)`, ` (3)`, which is not the username.
 */
function assignDisplayIds(entries: TriageEntry[]): void {
  const seen = new Map<string, number>();
  for (const entry of entries) {
    const count = seen.get(entry.id) ?? 0;
    seen.set(entry.id, count + 1);
    if (count > 0) entry.id = `${entry.id} (${count + 1})`;
  }
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
