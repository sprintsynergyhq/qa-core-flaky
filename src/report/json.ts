import { classifyCauses } from '../causes/index.js';
import type { Cause, CauseFinding } from '../causes/types.js';
import { suggestFix } from '../fixes/templates.js';
import type { Attempt, RerunMode, TestRecord } from '../model.js';
import { homeMarks, redactHomeText, runnableConfigPath } from '../report-path.js';
import { maskDatabaseUserinfo, maskTokenText } from '../heal/redact.js';
import { shellCommand } from '../rerun/plan.js';
import { collapseRunRecords, decideVerdict, VERDICT_ORDER } from '../verdict.js';
import type { HealProposal, RerunCounts, TriageAttempts, TriageEntry, TriageReport } from './schema.js';

export type BuildTriageOptions = {
  /** ISO time. Omit it and the report has no timestamp. */
  timestamp?: string;
  /** Forwarded to cause classification for the near-timeout rule. */
  testTimeoutMs?: number;
  /**
   * Proposals keyed by the raw record id.
   * Omit the map and every entry keeps `healProposal` null.
   */
  healProposals?: ReadonlyMap<string, HealProposal>;
  /**
   * Hide home usernames. Default true.
   * Token-like strings are hidden either way.
   */
  redact?: boolean;
  /**
   * Program prefix for the rerun sentence.
   * Default `qa-core-flaky`. The CLI passes the command that started this process.
   */
  rerunProgram?: string;
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
  const hideHomes = options.redact !== false;
  const program = options.rerunProgram ?? 'qa-core-flaky';
  for (const group of byId.values()) {
    if (!group.some((record) => record.outcome === 'failed' || record.outcome === 'flaky')) continue;
    const recordId = group[0]?.id ?? '';
    entries.push(buildEntry(group, options.testTimeoutMs, options.healProposals?.get(recordId) ?? null, hideHomes, program));
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

function buildEntry(
  group: readonly TestRecord[],
  testTimeoutMs: number | undefined,
  healProposal: HealProposal | null,
  hideHomes: boolean,
  program: string,
): TriageEntry {
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
  ]);
  const redact = (value: string) => {
    const masked = maskTokenText(maskDatabaseUserinfo(value));
    return hideHomes ? redactHomeText(masked, marks) : masked;
  };
  const evidence = rawEvidence.map((line) => redact(line));
  const causes = ordered.map((finding) => ({
    ...finding,
    evidence: finding.evidence.map((line) => redact(line)),
  }));
  const counted = attempts.filter((attempt) => attempt.status !== 'unselectable');
  const failed = counted.filter(isFailStatus).length;
  const passed = counted.filter((attempt) => attempt.status === 'passed').length;
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
    attempts: attemptCounts(counted, failed, passed, decision.signals.some((signal) => signal.kind === 'same-code-flip'), reruns),
    history: {
      runsSeen: records.length,
      firstFailingCommit: null,
    },
    suggestedFix: suggestFix(decision.ruleIds),
    healProposal,
    nextStep: nextStepText(reportPath, id, configFile, singleRunAllFailed(records, attempts), program),
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
    const ran = rows.filter((attempt) => attempt.status !== 'unselectable');
    const notRun = rows.length - ran.length;
    if (ran.length === 0 && notRun === 0) continue;
    const counts: RerunCounts = {
      total: ran.length,
      failed: ran.filter(isFailStatus).length,
      passed: ran.filter((attempt) => attempt.status === 'passed').length,
    };
    if (notRun > 0) counts.notRun = notRun;
    if (mode === 'repeat') reruns.repeat = counts;
    else if (mode === 'isolated') reruns.isolated = counts;
    else reruns['in-order'] = counts;
    any = true;
  }
  return any ? reruns : undefined;
}

/**
 * N is the number of rerun attempts that ran. An unselectable command is
 * not a run and does not block the sentence. A ran attempt that did not
 * pass omits the sentence.
 */
function rerunObservation(attempts: readonly Attempt[]): string | undefined {
  const rows = attempts.filter((attempt) => attempt.rerun !== undefined && attempt.status !== 'unselectable');
  if (rows.length === 0) return undefined;
  if (rows.some((attempt) => attempt.status !== 'passed')) return undefined;
  return `no flake observed in ${rows.length} runs`;
}

function isFailStatus(attempt: Attempt): boolean {
  return attempt.status === 'failed' || attempt.status === 'timedOut' || attempt.status === 'interrupted';
}

const SINGLE_RUN_HINT =
  'Every attempt in this one run failed. Triage several runs with the same --commit before you rely on this verdict. ';

/**
 * One record, no rerun attempts, and every counted attempt failed.
 * A pass, a second report, or a rerun means the verdict already has more
 * than this one run, so the hint stays off.
 */
function singleRunAllFailed(records: readonly TestRecord[], attempts: readonly Attempt[]): boolean {
  if (records.length !== 1) return false;
  if (attempts.some((attempt) => attempt.rerun !== undefined)) return false;
  const counted = attempts.filter((attempt) => attempt.status !== 'unselectable');
  const failed = counted.filter(isFailStatus).length;
  const passed = counted.filter((attempt) => attempt.status === 'passed').length;
  return passed === 0 && failed > 0;
}

function nextStepText(
  reportPath: string,
  id: string,
  configFile: string | undefined,
  hint: boolean,
  program: string,
): string {
  const configArg = configFile ? runnableConfigPath(configFile) : undefined;
  const prefix = hint ? `Review the suggested fix. ${SINGLE_RUN_HINT}` : 'Review the suggested fix. ';
  return `${prefix}To see the test again, run: ${shellCommand(reportPath, id, configArg, program)}`;
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
