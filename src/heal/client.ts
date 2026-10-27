import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HealProposal } from '../report/schema.js';
import { renderHealFindings, type HealFinding, type HealFindingsDocument } from './findings.js';
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
  /** Playwright `testDir` and `rootDir` values from the reports, in that order. */
  specRoots?: readonly string[];
}): Promise<HealSession> {
  try {
    return await collectHealProposalsInner(input);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Refusing to pass ')) {
      return errorSession(input, '', error.message);
    }
    throw error;
  }
}

async function collectHealProposalsInner(input: {
  document: HealFindingsDocument;
  recordIndex: ReadonlyMap<string, HealFinding>;
  findingsText: string;
  findingsPath?: string;
  specRoots?: readonly string[];
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
  input: {
    document: HealFindingsDocument;
    recordIndex: ReadonlyMap<string, HealFinding>;
    specRoots?: readonly string[];
  },
  timeoutMs: number,
): Promise<HealSession> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-flaky-heal-'));
  try {
    const findingsPath = path.join(dir, 'heal-findings.json');
    const facing = healFacingDocument(input.document, input.specRoots ?? [], process.cwd());
    fs.writeFileSync(findingsPath, renderHealFindings(facing));
    const resultsPath = path.join(dir, 'heal-results.json');
    const args = ['--findings', findingsPath, '--results', resultsPath, '--dry-run'];
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
  input: { document: HealFindingsDocument; recordIndex: ReadonlyMap<string, HealFinding>; specRoots?: readonly string[] },
  version: string,
  timeoutMs: number,
): Promise<HealSession> {
  const byFile = new Map<string, HealFinding[]>();
  for (const finding of input.document.findings) {
    if (finding.handoff.mode === 'none') continue;
    const file = safeSpecArg(healSpecPath(finding.file, input.specRoots ?? [], process.cwd()));
    const list = byFile.get(file) ?? [];
    list.push(finding);
    byFile.set(file, list);
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
      const hits = rows.filter((row) => titlesMatch(row, full, last));
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
  if (finding.handoff.mode === 'none') return skippedProposal(toolVersion, finding.handoff.reason, label);
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

/** Turn heal 0.3.x stdout into result rows. `verdicts` and `locators` are the real shape. */
export function rowsFromCompatStdout(stdout: string): HealResultRow[] {
  return parseCompatRows(stdout);
}

function parseCompatRows(stdout: string): HealResultRow[] {
  const parsed = extractJson(stdout);
  if (Array.isArray(parsed)) return parsed.filter(isObject).map(normalizeLegacyRow);
  if (!isObject(parsed)) return [];
  if (Array.isArray(parsed.verdicts)) return rowsFromVerdicts(parsed);
  const list = Array.isArray(parsed.results) ? parsed.results : Array.isArray(parsed.tests) ? parsed.tests : [];
  return list.filter(isObject).map(normalizeLegacyRow);
}

function rowsFromVerdicts(data: Record<string, unknown>): HealResultRow[] {
  const locators = Array.isArray(data.locators) ? data.locators.filter(isObject) : [];
  const rows: HealResultRow[] = [];
  for (const item of data.verdicts as unknown[]) {
    if (!isObject(item)) continue;
    const spec = firstText(item.spec, item.file);
    const title = firstText(item.testTitle, item.title);
    const classification = firstText(item.classification);
    const message = firstText(item.message);
    if (item.healApplied === true) {
      rows.push({
        file: spec,
        title,
        status: 'error',
        explanation: 'qa-core-heal reported an applied change during a dry run.',
      });
      continue;
    }
    if (classification === 'non-locator') {
      rows.push({ file: spec, title, status: 'not-locator', strategy: 'none', explanation: message });
      continue;
    }
    const before = typeof item.before === 'string' ? item.before : '';
    const after = typeof item.after === 'string' && item.after.length > 0 ? item.after : '';
    const locator = locators.find((row) => samePath(firstText(row.file), spec) && row.old === before);
    if (classification === 'locator' && after.length > 0) {
      const line = (locator ? integerAtLeast1(locator.line) : null) ?? 1;
      const changeFile = spec || (locator ? firstText(locator.file) : '');
      rows.push({
        file: spec,
        title,
        status: 'proposed',
        strategy: 'locator-heal',
        explanation: message,
        changes: [
          {
            file: changeFile,
            startLine: line,
            endLine: line,
            before,
            after,
          },
        ],
      });
      continue;
    }
    const reason = locator ? firstText(locator.reason, locator.message) : '';
    rows.push({
      file: spec,
      title,
      status: 'refused',
      message: reason || message,
      reason: reason || message,
    });
  }
  return rows;
}

function normalizeLegacyRow(row: Record<string, unknown>): HealResultRow {
  const title = firstText(row.title, row.name, row.test, row.testTitle);
  return { ...row, title: title || undefined };
}

function integerAtLeast1(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
  return value;
}

/**
 * Join one compat row to a finding inside a single spec run.
 * `spec` on the verdict is the file that holds the locator. A page object
 * lives in a different file from the spec that was run, so the path is not
 * a join key. Two rows with the same title are left unmatched by the caller.
 */
function titlesMatch(row: HealResultRow, full: string, last: string): boolean {
  const title = row.title ?? '';
  return title === full || title === last;
}

function samePath(left: string, right: string): boolean {
  const a = left.replace(/\\/g, '/');
  const b = right.replace(/\\/g, '/');
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function contractOne(value: unknown): boolean {
  if (value === 1) return true;
  if (Array.isArray(value)) return value.includes(1);
  if (isObject(value) && value.schemaVersion === 1) return true;
  return false;
}

function contractVersion(data: Record<string, unknown>): number | null {
  if (data.findingsContract === 1 || data.findingsSchemaVersion === 1) return 1;
  const contracts = data.contracts;
  if (!isObject(contracts)) return null;
  if (!contractOne(contracts.findings) || !contractOne(contracts.results)) return null;
  return 1;
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
  if (stderr.includes('canceled due to missing packages')) return true;
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

/**
 * Spec directories from a Playwright JSON report.
 * Project `testDir` values come first, then `config.rootDir`.
 */
export function specRootsFromReport(text: string): string[] {
  if (!text.trimStart().startsWith('{')) return [];
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    return [];
  }
  if (!isObject(data) || !isObject(data.config)) return [];
  const roots: string[] = [];
  if (Array.isArray(data.config.projects)) {
    for (const project of data.config.projects) {
      if (isObject(project) && typeof project.testDir === 'string') roots.push(project.testDir);
    }
  }
  if (typeof data.config.rootDir === 'string') roots.push(data.config.rootDir);
  return roots;
}

/**
 * A spec path heal can open from `cwd`.
 * The report path is used when that file exists. Otherwise each root
 * (testDir, then rootDir) is joined in front of it.
 */
export function healSpecPath(file: string, roots: readonly string[], cwd: string): string {
  const normalized = file.replaceAll('\\', '/');
  if (normalized.length === 0) return normalized;
  if (pathExists(cwd, normalized)) return relativeToCwd(cwd, normalized);
  for (const root of roots) {
    const cleaned = root.replaceAll('\\', '/').replace(/\/+$/, '');
    if (cleaned === '' || cleaned === '.') continue;
    const joined = `${cleaned}/${normalized}`.replace(/\/{2,}/g, '/');
    if (pathExists(cwd, joined)) return relativeToCwd(cwd, joined);
  }
  return normalized;
}

function healFacingDocument(
  document: HealFindingsDocument,
  roots: readonly string[],
  cwd: string,
): HealFindingsDocument {
  return {
    ...document,
    findings: document.findings.map((finding) => ({
      ...finding,
      file: healSpecPath(finding.file, roots, cwd),
      project: finding.project === 'default' ? '' : finding.project,
      errorLocation: finding.errorLocation
        ? { ...finding.errorLocation, file: healSpecPath(finding.errorLocation.file, roots, cwd) }
        : null,
    })),
  };
}

function safeSpecArg(file: string): string {
  return file.startsWith('-') ? `./${file}` : file;
}

function pathExists(cwd: string, file: string): boolean {
  const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
  try {
    return fs.existsSync(abs);
  } catch {
    return false;
  }
}

function relativeToCwd(cwd: string, file: string): string {
  const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
  let relative = path.relative(cwd, abs);
  if (relative === '') relative = path.basename(abs);
  return relative.split(path.sep).join('/');
}
