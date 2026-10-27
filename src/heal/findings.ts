import { createHash } from 'node:crypto';
import path from 'node:path';
import { classifyCauses } from '../causes/index.js';
import type { Cause, CauseFinding, Confidence } from '../causes/types.js';
import { makeTestId } from '../id.js';
import type { Attempt, AttemptError, TestRecord } from '../model.js';
import { homeMarks, isAbsolutePath, runnableConfigPath } from '../report-path.js';
import type { VerdictName } from '../report/schema.js';
import { normalizeErrorSignature } from '../signature.js';
import { collapseRunRecords, decideVerdict, VERDICT_ORDER } from '../verdict.js';
import { decideHandoff, type HandoffDecision } from './handoff.js';
import { FINDING_REDACTION_RULES, redactFindingText } from './redact.js';
import { quoteFailingSelector } from './selector.js';

const RULE_ID = /^(SEL|TIM|DATA|ENV|UNK)-[A-Z0-9-]+$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export type HealProjectFacts = {
  configPath: string | null;
  baseUrl: string | null;
  testIdAttribute: string | null;
  playwrightVersion: string | null;
};

export type HealCause = {
  cause: Cause;
  ruleIds: string[];
  confidence: Confidence;
  evidence: string[];
};

export type HealFinding = {
  findingId: string;
  testId: string;
  file: string;
  line: number | null;
  project: string;
  titlePath: string[];
  verdict: VerdictName;
  verdictConfidence: Confidence;
  primaryRuleId: string;
  causes: HealCause[];
  attempts: {
    total: number;
    failed: number;
    passed: number;
    sameCommit: boolean;
  };
  errorSignature: string;
  failingSelector: string | null;
  errorLocation: { file: string; line: number; column?: number } | null;
  handoff: HandoffDecision;
  review: { status: 'Needs Review' };
};

export type HealFindingsDocument = {
  schema: 'qa-core.heal-findings';
  schemaVersion: 1;
  tool: { name: 'qa-core-flaky'; version: string };
  generatedAt?: string;
  project: {
    configPath: string | null;
    baseUrl: string | null;
    testIdAttribute: string | null;
    playwrightVersion: string | null;
  };
  source: {
    triageSchemaVersion: 1;
    reports: string[];
    commit: string | null;
    runId?: string;
  };
  redaction: { applied: true; rules: readonly string[] };
  findings: HealFinding[];
};

export type BuildHealFindingsOptions = {
  /** Report paths in the order triage loaded them. */
  reports: readonly string[];
  /** Tool version written on the document. */
  version: string;
  /** Facts read from the raw reports. Null fields stay null. */
  project?: HealProjectFacts;
  /** Forwarded to cause classification for the near-timeout rule. */
  testTimeoutMs?: number;
  /** ISO time. Omit it and the file has no timestamp. */
  timestamp?: string;
  /** Working directory used to make report paths relative. */
  cwd?: string;
};

/**
 * Build a heal findings document from the same records triage uses.
 * Passed and skipped tests are left out. A likely real bug or an
 * environment issue has handoff `none`. The same records return the same
 * document when `timestamp` is omitted.
 */
export function buildHealFindings(
  records: readonly TestRecord[],
  options: BuildHealFindingsOptions,
): HealFindingsDocument {
  const cwd = options.cwd ?? process.cwd();
  const redact = (value: string) => redactFindingText(value);
  const byId = new Map<string, TestRecord[]>();
  for (const record of records) {
    const list = byId.get(record.id);
    if (list) list.push(record);
    else byId.set(record.id, [record]);
  }

  const findings: HealFinding[] = [];
  for (const group of byId.values()) {
    if (!group.some((record) => record.outcome === 'failed' || record.outcome === 'flaky')) continue;
    const finding = buildFinding(group, options.testTimeoutMs);
    if (finding) findings.push(finding);
  }

  findings.sort((left, right) => {
    const byVerdict = VERDICT_ORDER.indexOf(left.verdict) - VERDICT_ORDER.indexOf(right.verdict);
    if (byVerdict !== 0) return byVerdict;
    if (left.testId < right.testId) return -1;
    if (left.testId > right.testId) return 1;
    return 0;
  });
  assignDisplayIds(findings);

  const project = options.project ?? emptyFacts();
  const document: HealFindingsDocument = {
    schema: 'qa-core.heal-findings',
    schemaVersion: 1,
    tool: {
      name: 'qa-core-flaky',
      version: options.version.trim() || '0.0.0',
    },
    project: {
      configPath: resolveConfigPath(records, project, redact),
      baseUrl: project.baseUrl === null ? null : redact(project.baseUrl),
      testIdAttribute: project.testIdAttribute === null ? null : redact(project.testIdAttribute),
      playwrightVersion: project.playwrightVersion === null ? null : redact(project.playwrightVersion),
    },
    source: {
      triageSchemaVersion: 1,
      reports: options.reports.map((reportPath) => portableReportPath(reportPath, cwd, redact)),
      commit: sharedField(records, (record) => record.source.commitSha, redact),
    },
    redaction: {
      applied: true,
      rules: [...FINDING_REDACTION_RULES],
    },
    findings,
  };
  if (options.timestamp !== undefined && ISO_TIME.test(options.timestamp)) {
    document.generatedAt = options.timestamp;
  }
  const runId = sharedField(records, (record) => record.source.runId, redact);
  if (runId !== null) document.source.runId = runId;
  return document;
}

/** JSON text for a findings document, with a trailing newline. */
export function renderHealFindings(document: HealFindingsDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * First 12 hex characters of SHA-256 over the redacted file, project, and
 * full title path. The bytes are `JSON.stringify([file, project, titlePath])`.
 */
export function findingIdFor(file: string, project: string, titlePath: readonly string[]): string {
  const payload = JSON.stringify([file, project, [...titlePath]]);
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 12);
}

/**
 * Read project facts from a Playwright JSON report.
 * A JUnit report, or a JSON report with no `config` object, returns nulls.
 * `baseUrl` is the origin only. A path, query, user, or password is dropped.
 * This does not throw.
 */
export function readReportProjectFacts(text: string): HealProjectFacts {
  const empty = emptyFacts();
  if (!text.trimStart().startsWith('{')) return empty;
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    return empty;
  }
  if (!isObject(data) || !isObject(data.config)) return empty;
  const bases: string[] = [];
  const attributes: string[] = [];
  collectUse(data.config, bases, attributes, 0);
  return {
    configPath: stringOrNull(data.config.configFile),
    baseUrl: originOnly(bases.find((item) => item.trim().length > 0) ?? null),
    testIdAttribute: attributes.find((item) => item.trim().length > 0)?.trim() ?? null,
    playwrightVersion: stringOrNull(data.config.version),
  };
}

/** First non-null fact wins. Later reports fill only the gaps. */
export function mergeProjectFacts(list: readonly HealProjectFacts[]): HealProjectFacts {
  const merged = emptyFacts();
  for (const facts of list) {
    if (merged.configPath === null && facts.configPath) merged.configPath = facts.configPath;
    if (merged.baseUrl === null && facts.baseUrl) merged.baseUrl = facts.baseUrl;
    if (merged.testIdAttribute === null && facts.testIdAttribute) merged.testIdAttribute = facts.testIdAttribute;
    if (merged.playwrightVersion === null && facts.playwrightVersion) {
      merged.playwrightVersion = facts.playwrightVersion;
    }
  }
  return merged;
}

function buildFinding(group: readonly TestRecord[], testTimeoutMs: number | undefined): HealFinding | null {
  const records = collapseRunRecords(group);
  const base = records[0];
  if (!base) return null;
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
  const classified = classifyCauses(merged, classifyOptions);
  const decision = decideVerdict(records, classified, classifyOptions);
  const ordered = orderCauses(decision.findings, decision.cause);
  const titleRaw = base.titlePath[base.titlePath.length - 1] ?? base.id;
  const rawEvidence = flattenEvidence(ordered, decision.note);
  const marks = homeMarks([
    base.id,
    titleRaw,
    base.file,
    ...rawEvidence,
    ...ordered.flatMap((finding) => finding.evidence),
  ]);
  const redact = (value: string) => redactFindingText(value, marks);

  const file = forwardSlashes(redact(base.file));
  const storedFile = file.length > 0 ? file : '<path>';
  const project = redact(base.project);
  const titlePath = (base.titlePath.length > 0 ? base.titlePath : [titleRaw]).map((part) => redact(part));
  const causes = ordered
    .map((finding) => ({
      cause: finding.cause,
      ruleIds: finding.ruleIds.filter((ruleId) => RULE_ID.test(ruleId)),
      confidence: finding.confidence,
      evidence: finding.evidence.map((line) => clip(redact(line))).filter((line) => line.length > 0),
    }))
    .filter((finding) => finding.ruleIds.length > 0);
  if (causes.length === 0) {
    causes.push({ cause: 'unknown', ruleIds: ['UNK-EMPTY'], confidence: 'low', evidence: [] });
  }

  const primaryRuleId = causes[0]?.ruleIds[0] ?? 'UNK-NONE';
  const evidence = causes.flatMap((finding) => finding.evidence);
  const counted = attempts.filter((attempt) => attempt.status !== 'unselectable');
  if (counted.length < 1) return null;
  const failedAttempts = counted.filter(isFailStatus).slice().sort((left, right) => left.retry - right.retry);
  const quoted = quoteFailingSelector(failedAttempts.flatMap((attempt) => errorTexts(attempt)));
  const failingSelector = quoted === null ? null : emptyToNull(clip(redact(quoted)));

  const finding: HealFinding = {
    findingId: findingIdFor(storedFile, project, titlePath),
    testId: makeTestId(storedFile, project, titlePath),
    file: storedFile,
    line: specLine(base.line),
    project,
    titlePath,
    verdict: decision.verdict,
    verdictConfidence: decision.confidence,
    primaryRuleId,
    causes,
    attempts: {
      total: counted.length,
      failed: counted.filter(isFailStatus).length,
      passed: counted.filter((attempt) => attempt.status === 'passed').length,
      sameCommit: decision.signals.some((signal) => signal.kind === 'same-code-flip'),
    },
    errorSignature: errorSignature(failedAttempts, redact),
    failingSelector,
    errorLocation: readErrorLocation(failedAttempts, redact),
    handoff: decideHandoff({
      verdict: decision.verdict,
      primaryRuleId,
      ruleIds: causes.flatMap((finding) => finding.ruleIds),
      evidence,
    }),
    review: { status: 'Needs Review' },
  };
  return finding;
}

function errorTexts(attempt: Attempt): string[] {
  const texts: string[] = [];
  for (const error of attempt.errors ?? []) {
    if ((error.message ?? '').length > 0) texts.push(error.message);
    if (error.stack !== undefined && error.stack.length > 0) texts.push(error.stack);
  }
  return texts;
}

function errorSignature(attempts: readonly Attempt[], redact: (value: string) => string): string {
  const seen: string[] = [];
  for (const attempt of attempts) {
    const normalized = normalizeErrorSignature(rawSignature(attempt));
    const hidden = redact(normalized);
    if (hidden.length === 0 || seen.includes(hidden)) continue;
    seen.push(hidden);
  }
  const digest = createHash('sha256').update(seen.join('\n'), 'utf8').digest('hex');
  return `sha256:${digest}`;
}

function rawSignature(attempt: Attempt): string {
  const parts: string[] = [];
  for (const error of attempt.errors ?? []) {
    const message = error.message ?? '';
    const stack = error.stack ?? '';
    if (message.length > 0) parts.push(message);
    if (stack.length > 0 && stack !== message) parts.push(stack);
  }
  return parts.join('\n').replace(/\r\n?/g, '\n');
}

function readErrorLocation(
  attempts: readonly Attempt[],
  redact: (value: string) => string,
): HealFinding['errorLocation'] {
  for (const attempt of attempts) {
    for (const error of attempt.errors ?? []) {
      const location = locationOf(error, redact);
      if (location) return location;
    }
  }
  return null;
}

function locationOf(error: AttemptError, redact: (value: string) => string): HealFinding['errorLocation'] {
  const location = error.location;
  if (!location) return null;
  if (!Number.isInteger(location.line) || location.line < 1) return null;
  const file = forwardSlashes(redact(location.file));
  if (file.length === 0) return null;
  const next: { file: string; line: number; column?: number } = { file, line: location.line };
  if (Number.isInteger(location.column) && location.column >= 1) next.column = location.column;
  return next;
}

function resolveConfigPath(
  records: readonly TestRecord[],
  facts: HealProjectFacts,
  redact: (value: string) => string,
): string | null {
  for (const record of records) {
    const file = record.source.configFile;
    if (typeof file === 'string' && file.trim().length > 0) {
      return emptyToNull(forwardSlashes(redact(file)));
    }
  }
  if (!facts.configPath) return null;
  return emptyToNull(forwardSlashes(redact(runnableConfigPath(facts.configPath))));
}

function portableReportPath(reportPath: string, cwd: string, redact: (value: string) => string): string {
  const slashes = reportPath.replace(/\\/g, '/');
  let value = slashes;
  if (isAbsolutePath(slashes)) {
    const relative = path.relative(cwd, reportPath).replace(/\\/g, '/');
    if (relative.length > 0 && !relative.startsWith('..') && !isAbsolutePath(relative)) value = relative;
  }
  return emptyToNull(redact(value)) ?? '<path>';
}

function sharedField(
  records: readonly TestRecord[],
  read: (record: TestRecord) => string | undefined,
  redact: (value: string) => string,
): string | null {
  let seen: string | undefined;
  for (const record of records) {
    const raw = read(record);
    const cleaned = typeof raw === 'string' && raw.trim().length > 0 ? redact(raw.trim()) : '';
    if (seen === undefined) seen = cleaned;
    else if (seen !== cleaned) return null;
  }
  if (!seen) return null;
  return seen;
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

function assignDisplayIds(findings: HealFinding[]): void {
  const seen = new Map<string, number>();
  for (const finding of findings) {
    const count = seen.get(finding.testId) ?? 0;
    seen.set(finding.testId, count + 1);
    if (count > 0) finding.testId = `${finding.testId} (${count + 1})`;
  }
}

function specLine(line: number | undefined): number | null {
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) return null;
  return line;
}

function isFailStatus(attempt: Attempt): boolean {
  return attempt.status === 'failed' || attempt.status === 'timedOut' || attempt.status === 'interrupted';
}

function forwardSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function clip(value: string): string {
  return value.length > 300 ? value.slice(0, 300) : value;
}

function emptyToNull(value: string): string | null {
  return value.length > 0 ? value : null;
}

function emptyFacts(): HealProjectFacts {
  return {
    configPath: null,
    baseUrl: null,
    testIdAttribute: null,
    playwrightVersion: null,
  };
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function originOnly(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.origin;
}

function collectUse(node: unknown, bases: string[], attributes: string[], depth: number): void {
  if (depth > 8) return;
  if (Array.isArray(node)) {
    for (const item of node) collectUse(item, bases, attributes, depth + 1);
    return;
  }
  if (!isObject(node)) return;
  if (typeof node.baseURL === 'string') bases.push(node.baseURL);
  if (typeof node.testIdAttribute === 'string') attributes.push(node.testIdAttribute);
  if (node.use !== undefined) collectUse(node.use, bases, attributes, depth + 1);
  if (Array.isArray(node.projects)) collectUse(node.projects, bases, attributes, depth + 1);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
