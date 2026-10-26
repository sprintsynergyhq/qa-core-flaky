#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { classifyCauses } from './causes/index.js';
import type { CauseFinding } from './causes/types.js';
import type { ParseResult, RerunMode, TestRecord } from './model.js';
import { detectFormat } from './parsers/detect.js';
import { parseJunit } from './parsers/junit.js';
import { parsePlaywrightJson } from './parsers/playwright-json.js';
import { homeMarks, redactHomeText, runnableConfigPath } from './report-path.js';
import { redactParseResult } from './redact.js';
import { writeReportPair } from './report/pair.js';
import { executePlan, guardPipe, isStoppedRun } from './rerun/run.js';
import { formatCap, planReruns } from './rerun/plan.js';
import { renderTriageMarkdown } from './report/markdown.js';
import { buildTriageReport, renderTriageJson } from './report/json.js';

/**
 * qa-core-flaky command line.
 *
 *   qa-core-flaky parse <report> [--format json|junit] [--commit <sha>]
 *                     [--branch <name>] [--run-id <id>] [--root <dir>]
 *                     [--out <file>] [--redact]
 *   qa-core-flaky causes <report> [--format json|junit] [--json]
 *                     [--test-timeout <ms>] [--root <dir>] [--out <file>]
 *   qa-core-flaky triage <report...> [--out-dir <dir>] [--json]
 *                     [--fail-on findings|never] [--timestamp] [--root <dir>]
 *   qa-core-flaky rerun --from <report.json> [--times 5] [--retries <n>]
 *                     [--modes repeat,isolated] [--config <playwright.config>]
 *                     [--only <id>] [--max-tests 20] [--commit <sha>]
 *                     [--root <dir>] [--out-dir <dir>]
 *
 * parse and causes exit 0 on success and 1 on error.
 * triage exits 0 when the report has no entries, 2 when it has entries
 * (unless --fail-on never), and 1 on a tool error.
 * rerun uses the same exit codes as triage after the new attempts are merged.
 * A stop signal exits 130 for SIGINT, 143 for SIGTERM, or 129 for SIGHUP,
 * writes no triage report, and prints no stack.
 * The cap and each Playwright command go to stderr. The triage report goes
 * to stdout. Error text is one line on stderr.
 */

const HELP = `qa-core-flaky <command> [options]

Commands:
  parse <report>     Print normalized test records as JSON
  causes <report>    Print likely causes for each failed or flaky test
  triage <report...> Write a triage report as JSON and Markdown
  rerun              Rerun failing tests and write a triage report

Options:
  --format <json|junit>       Force the report format instead of detecting it
  --commit <sha>              Store this commit SHA on every record in this command.
                              A blank value is ignored. A Playwright JSON report
                              also reads config.metadata.gitCommit when this is omitted.
  --branch <name>             Store this branch name on every record
  --run-id <id>               Store this run id on every record
  --redact                    parse: hide home usernames in the printed records
  --out <file>                parse, causes: write the output to this file
  --out-dir <dir>             triage: write triage.json and triage.md here.
                              Do not use a directory under /proc. Creating one
                              can hang (a Node bug) and this command does not
                              probe /proc.
  --json                      causes: print a JSON array. triage: also print JSON
  --fail-on <findings|never>  triage: exit 2 when there are entries (default findings)
  --timestamp                 triage: include generatedAt. Output then changes every run
  --test-timeout <ms>         Test timeout for the near-timeout rule
  --root <dir>                JUnit: project root used to make paths relative.
                              Playwright JSON already stores config.rootDir, so
                              this flag is ignored for a JSON report.
  --from <report>             rerun: Playwright JSON, JUnit, or parse JSON
  --times <n>                 rerun: repeat and isolated count (default 5, from 1 to 20)
  --retries <n>               rerun: Playwright --retries (default 0, from 0 to 10).
                              0 keeps a first-attempt failure visible. A retry
                              inside the rerun can hide that failure and record a pass.
  --modes <list>              rerun: repeat, isolated, in-order (default repeat,isolated).
                              A mode cannot be listed twice.
  --config <file>             rerun: Playwright config passed to the test command.
                              The next step prints a project-relative path.
  --only <id>                 rerun: limit to this test id. Repeat for more than one.
  --max-tests <n>             rerun: how many failing tests to keep (default 20, from 1 to 50).
                              The plan allows at most 400 commands.
  -h, --help                  Show this help
  --version                   Print the version
`;

type FlagValues = {
  help?: boolean;
  version?: boolean;
  format?: string;
  commit?: string;
  branch?: string;
  'run-id'?: string;
  out?: string;
  'out-dir'?: string;
  json?: boolean;
  'fail-on'?: string;
  timestamp?: boolean;
  'test-timeout'?: string;
  redact?: boolean;
  root?: string;
  from?: string;
  times?: string;
  retries?: string;
  modes?: string;
  config?: string;
  only?: string[];
  'max-tests'?: string;
};

function main(): void {
  guardPipe(process.stdout);
  guardPipe(process.stderr);
  try {
    const pending = run(process.argv.slice(2));
    if (pending instanceof Promise) {
      pending.catch((error: unknown) => {
        if (error instanceof ExitRequest) return;
        if (isStoppedRun(error)) {
          process.exitCode = error.exitCode;
          return;
        }
        const message = error instanceof Error ? error.message : 'Could not rerun';
        process.stderr.write(`${oneLine(message)}\n`);
        process.exitCode = 1;
      });
    }
  } catch (error) {
    if (error instanceof ExitRequest) return;
    throw error;
  }
}

function run(args: readonly string[]): void | Promise<void> {
  let values: FlagValues;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
        format: { type: 'string' },
        commit: { type: 'string' },
        branch: { type: 'string' },
        'run-id': { type: 'string' },
        out: { type: 'string' },
        'out-dir': { type: 'string' },
        json: { type: 'boolean' },
        'fail-on': { type: 'string' },
        timestamp: { type: 'boolean' },
        'test-timeout': { type: 'string' },
        redact: { type: 'boolean' },
        root: { type: 'string' },
        from: { type: 'string' },
        times: { type: 'string' },
        retries: { type: 'string' },
        modes: { type: 'string' },
        config: { type: 'string' },
        only: { type: 'string', multiple: true },
        'max-tests': { type: 'string' },
      },
    }));
  } catch (error) {
    fail(oneLine(error instanceof Error ? error.message : 'Could not parse arguments'));
  }

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }

  const [command, ...rest] = positionals;
  if (command === undefined) fail('Usage: qa-core-flaky <parse|causes|triage|rerun> <report>');
  if (command === 'rerun') return runRerun(rest, values);
  if (command === 'triage') {
    assertNoRerunFlags(values);
    runTriage(rest, values);
    return;
  }
  const [reportPath, ...extra] = rest;
  if (reportPath === undefined || extra.length > 0) {
    fail('Usage: qa-core-flaky <parse|causes> <report>');
  }
  if (command !== 'parse' && command !== 'causes') {
    fail(`Unknown command ${command}`);
  }
  assertNoRerunFlags(values);
  if (values['out-dir'] !== undefined || values['fail-on'] !== undefined || values.timestamp === true) {
    fail('That option is only valid for triage');
  }

  const format = readFormat(values.format);
  const text = readReport(reportPath);
  const meta = {
    commitSha: values.commit,
    branch: values.branch,
    runId: values['run-id'],
  };

  let body: string;
  try {
    const selected = format ?? detectFormat(text, reportPath);
    const parsed =
      selected === 'json' ? parsePlaywrightJson(text, reportPath, meta) : parseJunit(text, reportPath, junitMeta(values, meta));
    const result = command === 'parse' && values.redact === true ? redactParseResult(parsed) : parsed;
    body =
      command === 'parse'
        ? `${JSON.stringify(result, null, 2)}\n`
        : formatCauses(result, readTimeout(values['test-timeout']), values.json === true);
  } catch (error) {
    if (error instanceof ExitRequest) throw error;
    fail(oneLine(error instanceof Error ? error.message : 'Could not parse the report'));
  }

  writeOutput(values.out, body);
}

function runTriage(reportPaths: readonly string[], values: FlagValues): void {
  if (reportPaths.length === 0) fail('Usage: qa-core-flaky triage <report...> [--out-dir <dir>]');
  if (values.out !== undefined) fail('--out is not used by triage. Use --out-dir.');
  const format = readFormat(values.format);
  const failOn = readFailOn(values['fail-on']);
  const meta = {
    commitSha: values.commit,
    branch: values.branch,
    runId: values['run-id'],
  };
  const records: TestRecord[] = [];
  for (const loaded of loadUniqueReports(reportPaths)) {
    try {
      const selected = format ?? detectFormat(loaded.text, loaded.reportPath);
      const result =
        selected === 'json'
          ? parsePlaywrightJson(loaded.text, loaded.reportPath, meta)
          : parseJunit(loaded.text, loaded.reportPath, junitMeta(values, meta));
      records.push(...result.records);
    } catch (error) {
      if (error instanceof ExitRequest) throw error;
      fail(oneLine(error instanceof Error ? error.message : 'Could not parse the report'));
    }
  }

  const report = buildTriageReport(records, {
    testTimeoutMs: readTimeout(values['test-timeout']),
    timestamp: values.timestamp === true ? new Date().toISOString() : undefined,
  });
  const json = renderTriageJson(report);
  const markdown = renderTriageMarkdown(report);
  if (values['out-dir'] !== undefined) {
    writeTriagePair(values['out-dir'], json, markdown);
  }
  if (values['out-dir'] === undefined || values.json === true) {
    process.stdout.write(values.json === true ? json : markdown);
  }
  const code = failOn === 'never' || report.entries.length === 0 ? 0 : 2;
  if (code !== 0) process.exitCode = code;
}

async function runRerun(extra: readonly string[], values: FlagValues): Promise<void> {
  if (extra.length > 0 || values.from === undefined) {
    fail('Usage: qa-core-flaky rerun --from <report.json>');
  }
  if (values.out !== undefined) fail('--out is not used by rerun. Use --out-dir.');
  if (values.redact === true) fail('--redact is only valid for parse');
  const reportPath = values.from;
  let records: TestRecord[];
  try {
    records = loadRerunSource(reportPath, values);
  } catch (error) {
    if (error instanceof ExitRequest) throw error;
    fail(oneLine(error instanceof Error ? error.message : 'Could not parse the report'));
  }
  let plan;
  try {
    plan = planReruns(records, {
      only: values.only,
      maxTests: readOptionalPositive(values['max-tests'], 'max-tests'),
      times: readOptionalPositive(values.times, 'times'),
      retries: readOptionalCount(values.retries, 'retries', 10),
      modes: readModesFlag(values.modes),
      config: values.config ? runnableConfigPath(values.config, process.cwd()) : undefined,
    });
  } catch (error) {
    if (error instanceof ExitRequest) throw error;
    const detail = error instanceof Error ? error.message : 'Could not plan the rerun';
    fail(redactHomeText(oneLine(detail)));
  }
  process.stderr.write(`${formatCap(plan.cap)}\n`);
  let merged = records;
  if (plan.runs.length > 0) {
    try {
      merged = await executePlan({
        records,
        plan,
        cwd: process.cwd(),
        commitSha: values.commit,
        print: (line) => {
          process.stderr.write(`${line}\n`);
        },
      });
    } catch (error) {
      if (error instanceof ExitRequest) throw error;
      if (isStoppedRun(error)) {
        process.exitCode = error.exitCode;
        return;
      }
      const detail = error instanceof Error ? error.message : 'The rerun failed';
      fail(redactHomeText(oneLine(detail)));
    }
  }
  if (values.config) {
    const configFile = runnableConfigPath(values.config, process.cwd());
    merged = merged.map((record) => ({
      ...record,
      source: { ...record.source, configFile },
    }));
  }
  const report = buildTriageReport(merged, {
    testTimeoutMs: readTimeout(values['test-timeout']),
    timestamp: values.timestamp === true ? new Date().toISOString() : undefined,
  });
  const json = renderTriageJson(report);
  const markdown = renderTriageMarkdown(report);
  if (values['out-dir'] !== undefined) writeTriagePair(values['out-dir'], json, markdown);
  if (values['out-dir'] === undefined || values.json === true) {
    process.stdout.write(values.json === true ? json : markdown);
  }
  const failOn = readFailOn(values['fail-on']);
  const code = failOn === 'never' || report.entries.length === 0 ? 0 : 2;
  if (code !== 0) process.exitCode = code;
}

function assertNoRerunFlags(values: FlagValues): void {
  if (
    values.from !== undefined ||
    values.times !== undefined ||
    values.retries !== undefined ||
    values.modes !== undefined ||
    values.config !== undefined ||
    values.only !== undefined ||
    values['max-tests'] !== undefined
  ) {
    fail('That option is only valid for rerun');
  }
}

function loadRerunSource(reportPath: string, values: FlagValues): TestRecord[] {
  const text = readReport(reportPath);
  const meta = {
    commitSha: values.commit,
    branch: values.branch,
    runId: values['run-id'],
  };
  if (text.trimStart().startsWith('{')) {
    let data: unknown;
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      fail(`Invalid JSON in report ${reportPath}`);
    }
    if (isParseResult(data)) return applyMeta(data.records, values);
    if (isTriageDocument(data)) {
      fail('rerun cannot read a triage report. Pass the Playwright report, the JUnit report, or the JSON from parse.');
    }
  }
  const format = readFormat(values.format);
  const selected = format ?? detectFormat(text, reportPath);
  const parsed =
    selected === 'json' ? parsePlaywrightJson(text, reportPath, meta) : parseJunit(text, reportPath, junitMeta(values, meta));
  return parsed.records;
}

function isParseResult(value: unknown): value is ParseResult {
  if (!isPlainObject(value)) return false;
  return value.schemaVersion === 1 && Array.isArray(value.records);
}

function isTriageDocument(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return value.schemaVersion === 1 && Array.isArray(value.entries) && !Array.isArray(value.records);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function applyMeta(records: readonly TestRecord[], values: FlagValues): TestRecord[] {
  return records.map((record) => {
    const source = { ...record.source };
    if (values.commit) source.commitSha = values.commit;
    if (values.branch) source.branch = values.branch;
    if (values['run-id']) source.runId = values['run-id'];
    return { ...record, source };
  });
}

function readModesFlag(value: string | undefined): RerunMode[] | undefined {
  if (value === undefined) return undefined;
  const modes = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const allowed: readonly RerunMode[] = ['repeat', 'isolated', 'in-order'];
  const picked: RerunMode[] = [];
  for (const mode of modes) {
    if (!allowed.includes(mode as RerunMode)) {
      fail(`Unknown mode ${mode}. Expected repeat, isolated, or in-order.`);
    }
    if (picked.includes(mode as RerunMode)) fail(`Duplicate mode ${mode}`);
    picked.push(mode as RerunMode);
  }
  return picked;
}

function junitMeta(
  values: FlagValues,
  meta: { commitSha?: string; branch?: string; runId?: string },
): { commitSha?: string; branch?: string; runId?: string; rootDir?: string } {
  const root = values.root?.trim();
  if (!root) return meta;
  return { ...meta, rootDir: root };
}

/** A whole number from 0 to `max`, or undefined when the flag is omitted. */
function readOptionalCount(value: string | undefined, name: string, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) fail(`${name} must be a whole number from 0 to ${max}. Got ${value}.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > max) {
    fail(`${name} must be a whole number from 0 to ${max}. Got ${value}.`);
  }
  return parsed;
}

function readOptionalPositive(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) fail(`${name} must be a positive integer. Got ${value}.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${name} must be a positive integer. Got ${value}.`);
  return parsed;
}

function readFailOn(value: string | undefined): 'findings' | 'never' {
  if (value === undefined || value === 'findings') return 'findings';
  if (value === 'never') return 'never';
  fail(`Unknown --fail-on value ${value}. Expected findings or never.`);
}

/**
 * Write both triage files, or leave the previous pair in place.
 * Both bodies are written to temp names first. If either write fails, the
 * temp names are removed and the previous files stay. A destination that is
 * not a regular file, such as a directory named triage.json, is left as it
 * is. When both destinations are missing or are files, they are moved aside,
 * the temp names are renamed into place, and the copies are removed. If the
 * second rename fails, the previous files are moved back. A new file created
 * in an empty directory is removed, so the pair is not left half written.
 * A directory under /proc is not detected here. Node can hang while creating
 * one, which is documented on --out-dir instead of probed.
 */
function writeTriagePair(dir: string, json: string, markdown: string): void {
  if (dir.trim() === '') fail('The output directory is empty.');
  try {
    writeReportPair(dir, json, markdown);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    fail(`Cannot write ${dir}: ${oneLine(detail)}`);
  }
}

function formatCauses(result: ParseResult, testTimeoutMs: number | undefined, asJson: boolean): string {
  const rows = result.records
    .filter((record) => record.outcome === 'failed' || record.outcome === 'flaky')
    .map((record) => {
      const findings = classifyCauses(record, testTimeoutMs === undefined ? {} : { testTimeoutMs });
      const titleRaw = record.titlePath[record.titlePath.length - 1] ?? record.id;
      const marks = homeMarks([
        record.id,
        titleRaw,
        record.file,
        ...findings.flatMap((finding) => finding.evidence),
      ]);
      return {
        id: redactHomeText(record.id, marks),
        findings: findings.map((finding) => ({
          ...finding,
          evidence: finding.evidence.map((line) => redactHomeText(line, marks)),
        })),
      };
    });
  if (asJson) return `${JSON.stringify(rows, null, 2)}\n`;
  return formatCauseText(rows);
}

function formatCauseText(rows: { id: string; findings: CauseFinding[] }[]): string {
  if (rows.length === 0) return '';
  const blocks = rows.map((row) => {
    const lines = [row.id];
    for (const finding of row.findings) {
      lines.push(`  ${finding.cause} ${finding.confidence} ${finding.ruleIds.join(', ')}`);
      for (const item of finding.evidence) lines.push(`    ${item}`);
    }
    return lines.join('\n');
  });
  return `${blocks.join('\n\n')}\n`;
}

/**
 * Read each report once.
 * `realpath` makes `./report`, an absolute path, and a symlink one file.
 * A second path with the same bytes is dropped too, so a copy is not a second run.
 * The error names the path the user typed when the file cannot be resolved.
 */
function loadUniqueReports(reportPaths: readonly string[]): { text: string; reportPath: string }[] {
  const seenPaths = new Set<string>();
  const seenHashes = new Set<string>();
  const loaded: { text: string; reportPath: string }[] = [];
  for (const original of reportPaths) {
    let real: string;
    try {
      real = fs.realpathSync(original);
    } catch (error) {
      failRead(original, error);
    }
    if (seenPaths.has(real)) continue;
    seenPaths.add(real);
    const text = readReport(original);
    const hash = normalizedReportHash(text);
    if (seenHashes.has(hash)) continue;
    seenHashes.add(hash);
    loaded.push({ text, reportPath: original });
  }
  return loaded;
}

/**
 * Identity of a report's contents.
 * Newlines are LF, and trailing newlines are removed. JSON is parsed and
 * written again with `JSON.stringify`, so a pretty copy and a compact copy
 * of one document match. A CRLF copy matches too. A second file with that
 * same normalized content is treated as a copy, including a real second run
 * whose bytes normalize to the same text.
 */
function normalizedReportHash(text: string): string {
  const lf = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  let body = lf;
  try {
    body = JSON.stringify(JSON.parse(lf) as unknown);
  } catch {
    body = lf;
  }
  return createHash('sha256').update(body).digest('hex');
}

function readReport(reportPath: string): string {
  try {
    return fs.readFileSync(reportPath, 'utf8');
  } catch (error) {
    failRead(reportPath, error);
  }
}

function failRead(reportPath: string, error: unknown): never {
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'unknown error';
  fail(`Cannot read report ${reportPath}: ${code}`);
}

function readTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) {
    fail(`Test timeout must be a positive number of milliseconds. Got ${value}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    fail(`Test timeout must be a positive number of milliseconds. Got ${value}.`);
  }
  return parsed;
}

function readFormat(value: string | undefined): 'json' | 'junit' | undefined {
  if (value === undefined) return undefined;
  if (value === 'json' || value === 'junit') return value;
  fail(`Unknown format ${value}. Expected json or junit.`);
}

function writeOutput(out: string | undefined, body: string): void {
  if (out === undefined) {
    process.stdout.write(body);
    return;
  }
  try {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, body);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    fail(`Cannot write ${out}: ${oneLine(detail)}`);
  }
}

function readVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.resolve(here, '../package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
  return pkg.version ?? '0.0.0';
}

function oneLine(message: string): string {
  return message.replaceAll('\n', ' ').trim();
}

class ExitRequest extends Error {
  constructor() {
    super('exit');
    this.name = 'ExitRequest';
  }
}

function fail(message: string): never {
  try {
    process.stderr.write(`${oneLine(message)}\n`);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : '';
    if (code !== 'EPIPE' && code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error;
  }
  process.exitCode = 1;
  throw new ExitRequest();
}

main();
