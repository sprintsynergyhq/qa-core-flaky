import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HealProposal } from '../report/schema.js';
import type { HealFinding, HealFindingsDocument } from './findings.js';
import {
  COMPAT_LABEL,
  errorProposal,
  proposalFromCompatRow,
  proposalFromContractRow,
  skippedProposal,
  unavailableProposal,
  UNAVAILABLE_LINE,
  type HealResultRow,
} from './proposal.js';
import { healTimeoutMs, runHealCommand, type HealCommandResult } from './run.js';

export type HealSession = {
  /** Proposals keyed by the raw record id. */
  proposals: Map<string, HealProposal>;
  /** One line for stderr. Omitted when heal returned a usable dry run. */
  notice?: string;
};

/**
 * Ask qa-core-heal for a dry run and merge one proposal per finding.
 * A missing program yields `unavailable`. A handoff of none stays `skipped-by-gate`.
 * This function never passes `--apply`, `--yes`, or `--no-verify`.
 */
export async function collectHealProposals(input: {
  document: HealFindingsDocument;
  recordIndex: ReadonlyMap<string, HealFinding>;
  findingsText: string;
  findingsPath?: string;
}): Promise<HealSession> {
  const timeoutMs = healTimeoutMs();
  const probe = await runHealCommand(['capabilities', '--json'], timeoutMs);
  if (isMissing(probe)) return unavailableSession(input.recordIndex);
  if (probe.timedOut) return timeoutSession(input, '');
  const caps = readFindingsContract(probe.stdout);
  if (probe.exitCode === 0 && caps.findings === 1) {
    return runContract(input, timeoutMs);
  }
  const versionProbe = await runHealCommand(['--version'], timeoutMs);
  if (versionProbe.timedOut) return timeoutSession(input, caps.version);
  if (isMissing(versionProbe) || versionProbe.exitCode !== 0) return unavailableSession(input.recordIndex);
  const version = firstLine(versionProbe.stdout) || caps.version || '0.3.x';
  return runCompat(input, version, timeoutMs);
}

/** Read a findings contract version from `capabilities --json` stdout. */
export function readFindingsContract(stdout: string): { findings: number | null; version: string } {
  const parsed = extractJson(stdout);
  if (!isObject(parsed)) return { findings: null, version: '' };
  return { findings: contractVersion(parsed), version: toolVersion(parsed) };
}

async function runContract(
  input: { document: HealFindingsDocument; recordIndex: ReadonlyMap<string, HealFinding>; findingsText: string; findingsPath?: string },
  timeoutMs: number,
): Promise<HealSession> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-flaky-heal-'));
  try {
    const findingsPath = input.findingsPath ? path.resolve(input.findingsPath) : path.join(dir, 'heal-findings.json');
    if (input.findingsPath) {
      fs.mkdirSync(path.dirname(findingsPath), { recursive: true });
    }
    fs.writeFileSync(findingsPath, input.findingsText);
    const resultsPath = path.join(dir, 'heal-results.json');
    const eligible = input.document.findings.filter((finding) => finding.handoff.mode !== 'none');
    const args = ['--findings', findingsPath, '--results', resultsPath];
    if (eligible.length === 1) {
      const only = eligible[0];
      if (only) args.push('--test', only.titlePath[only.titlePath.length - 1] ?? only.testId);
    }
    const run = await runHealCommand(args, timeoutMs);
    if (run.timedOut) return timeoutSession(input, '');
    if (isMissing(run)) return unavailableSession(input.recordIndex);
    if (!fs.existsSync(resultsPath)) {
      return errorSession(input, '', 'qa-core-heal did not write a results file.');
    }
    const parsed = parseResults(fs.readFileSync(resultsPath, 'utf8'));
    if (!parsed) {
      return errorSession(input, '', 'qa-core-heal wrote a results file that does not match the contract.');
    }
    const byFinding = new Map<string, HealProposal>();
    for (const row of parsed.rows) {
      if (typeof row.findingId !== 'string' || byFinding.has(row.findingId)) continue;
      byFinding.set(row.findingId, proposalFromContractRow(row, parsed.version, parsed.mode));
    }
    const proposals = new Map<string, HealProposal>();
    for (const [recordId, finding] of input.recordIndex) {
      proposals.set(recordId, proposalFor(finding, byFinding, parsed.version));
    }
    if (run.exitCode !== 0 && [...byFinding.values()].every((item) => item.status === 'error')) {
      return { proposals, notice: 'qa-core-heal exited with an error. The proposal status is error.' };
    }
    return { proposals };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function runCompat(
  input: { document: HealFindingsDocument; recordIndex: ReadonlyMap<string, HealFinding> },
  version: string,
  timeoutMs: number,
): Promise<HealSession> {
  const byFile = new Map<string, HealFinding[]>();
  for (const finding of input.document.findings) {
    if (finding.handoff.mode === 'none') continue;
    const list = byFile.get(finding.file) ?? [];
    list.push(finding);
    byFile.set(finding.file, list);
  }
  const byFinding = new Map<string, HealProposal>();
  let notice: string | undefined;
  for (const [file, group] of byFile) {
    const run = await runHealCommand([file, '--dry-run', '--json'], timeoutMs);
    if (run.timedOut) {
      notice = 'qa-core-heal timed out.';
      for (const finding of group) {
        byFinding.set(
          finding.findingId,
          errorProposal(version, 'qa-core-heal timed out.', COMPAT_LABEL, {
            code: 'timeout',
            message: 'qa-core-heal timed out.',
          }),
        );
      }
      continue;
    }
    if (isMissing(run)) return unavailableSession(input.recordIndex);
    const rows = parseCompatRows(run.stdout);
    if (run.exitCode !== 0 && rows.length === 0) {
      notice = 'qa-core-heal exited with an error. The proposal status is error.';
      for (const finding of group) {
        byFinding.set(finding.findingId, errorProposal(version, 'qa-core-heal exited with an error.', COMPAT_LABEL));
      }
      continue;
    }
    for (const finding of group) {
      const full = finding.titlePath.join(' > ');
      const last = finding.titlePath[finding.titlePath.length - 1] ?? full;
      const hits = rows.filter((row) => titlesMatch(row, full, last, finding.file));
      if (hits.length !== 1) {
        const explanation =
          hits.length === 0
            ? 'qa-core-heal did not return a result for this test.'
            : 'qa-core-heal returned more than one row for this test.';
        byFinding.set(finding.findingId, errorProposal(version, explanation, COMPAT_LABEL));
        continue;
      }
      const row = hits[0];
      if (row) byFinding.set(finding.findingId, proposalFromCompatRow(row, version));
    }
  }
  const proposals = new Map<string, HealProposal>();
  for (const [recordId, finding] of input.recordIndex) {
    proposals.set(recordId, proposalFor(finding, byFinding, version, COMPAT_LABEL));
  }
  return notice ? { proposals, notice } : { proposals };
}

function proposalFor(
  finding: HealFinding,
  byFinding: ReadonlyMap<string, HealProposal>,
  toolVersion: string,
  label?: string,
): HealProposal {
  if (finding.handoff.mode === 'none') return skippedProposal(toolVersion, finding.handoff.reason);
  return (
    byFinding.get(finding.findingId) ??
    errorProposal(toolVersion, 'qa-core-heal did not return a result for this test.', label)
  );
}

function unavailableSession(recordIndex: ReadonlyMap<string, HealFinding>): HealSession {
  const proposals = new Map<string, HealProposal>();
  for (const recordId of recordIndex.keys()) proposals.set(recordId, unavailableProposal());
  return { proposals, notice: UNAVAILABLE_LINE };
}

function timeoutSession(
  input: { recordIndex: ReadonlyMap<string, HealFinding> },
  toolVersion: string,
): HealSession {
  const proposals = new Map<string, HealProposal>();
  for (const [recordId, finding] of input.recordIndex) {
    if (finding.handoff.mode === 'none') {
      proposals.set(recordId, skippedProposal(toolVersion, finding.handoff.reason));
      continue;
    }
    proposals.set(
      recordId,
      errorProposal(toolVersion, 'qa-core-heal timed out.', undefined, {
        code: 'timeout',
        message: 'qa-core-heal timed out.',
      }),
    );
  }
  return { proposals, notice: 'qa-core-heal timed out.' };
}

function errorSession(
  input: { recordIndex: ReadonlyMap<string, HealFinding> },
  toolVersion: string,
  explanation: string,
): HealSession {
  const proposals = new Map<string, HealProposal>();
  for (const [recordId, finding] of input.recordIndex) {
    if (finding.handoff.mode === 'none') {
      proposals.set(recordId, skippedProposal(toolVersion, finding.handoff.reason));
      continue;
    }
    proposals.set(recordId, errorProposal(toolVersion, explanation));
  }
  return { proposals, notice: 'qa-core-heal exited with an error. The proposal status is error.' };
}

function parseResults(text: string): { version: string; mode: string; rows: HealResultRow[] } | null {
  const parsed = extractJson(text);
  if (!isObject(parsed)) return null;
  if (parsed.schema !== 'qa-core.heal-results' || parsed.schemaVersion !== 1) return null;
  if (!isObject(parsed.tool) || parsed.tool.name !== 'qa-core-heal') return null;
  if (typeof parsed.tool.version !== 'string' || parsed.tool.version.trim().length === 0) return null;
  if (parsed.mode !== 'dry-run' && parsed.mode !== 'apply') return null;
  if (!Array.isArray(parsed.results)) return null;
  const rows = parsed.results.filter(isObject) as HealResultRow[];
  return { version: parsed.tool.version.trim(), mode: parsed.mode, rows };
}

function parseCompatRows(stdout: string): HealResultRow[] {
  const parsed = extractJson(stdout);
  const list = Array.isArray(parsed)
    ? parsed
    : isObject(parsed) && Array.isArray(parsed.results)
      ? parsed.results
      : isObject(parsed) && Array.isArray(parsed.tests)
        ? parsed.tests
        : [];
  return list.filter(isObject).map((row) => {
    const title = firstText(row.title, row.name, row.test, row.testTitle);
    return { ...row, title: title || undefined };
  });
}

function titlesMatch(row: HealResultRow, full: string, last: string, file: string): boolean {
  const title = row.title ?? '';
  if (title !== full && title !== last) return false;
  if (typeof row.file === 'string' && row.file.trim().length > 0 && !samePath(row.file, file)) return false;
  return true;
}

function samePath(left: string, right: string): boolean {
  const a = left.replace(/\\/g, '/');
  const b = right.replace(/\\/g, '/');
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function contractVersion(data: Record<string, unknown>): number | null {
  if (data.findingsContract === 1 || data.findingsSchemaVersion === 1) return 1;
  const contracts = data.contracts;
  if (!isObject(contracts)) return null;
  if (contracts.findings === 1) return 1;
  if (isObject(contracts.findings) && contracts.findings.schemaVersion === 1) return 1;
  return null;
}

function toolVersion(data: Record<string, unknown>): string {
  if (isObject(data.tool) && typeof data.tool.version === 'string') return data.tool.version.trim();
  if (typeof data.version === 'string') return data.version.trim();
  return '';
}

function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const list = text.indexOf('[');
  const open = start === -1 ? list : list === -1 ? start : Math.min(start, list);
  if (open < 0) return null;
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (end <= open) return null;
  try {
    return JSON.parse(text.slice(open, end + 1)) as unknown;
  } catch {
    return null;
  }
}

function isMissing(result: HealCommandResult): boolean {
  if (result.spawnError === 'ENOENT') return true;
  const stderr = result.stderr.toLowerCase();
  if (stderr.includes('could not determine executable')) return true;
  if (stderr.includes('404') && stderr.includes('qa-core-heal')) return true;
  return false;
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((item) => item.trim().length > 0) ?? '';
  return line.trim().replace(/^v(?=\d)/, '').slice(0, 40);
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return '';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
