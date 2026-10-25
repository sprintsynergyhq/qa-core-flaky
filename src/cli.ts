#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { classifyCauses } from './causes/index.js';
import type { CauseFinding } from './causes/types.js';
import type { ParseResult, TestRecord } from './model.js';
import { detectFormat } from './parsers/detect.js';
import { parseJunit } from './parsers/junit.js';
import { parsePlaywrightJson } from './parsers/playwright-json.js';
import { renderTriageMarkdown } from './report/markdown.js';
import { buildTriageReport, renderTriageJson } from './report/json.js';

/**
 * qa-core-flaky command line.
 *
 *   qa-core-flaky parse <report> [--format json|junit] [--commit <sha>]
 *                     [--branch <name>] [--run-id <id>] [--out <file>]
 *   qa-core-flaky causes <report> [--format json|junit] [--json]
 *                     [--test-timeout <ms>] [--out <file>]
 *   qa-core-flaky triage <report...> [--out-dir <dir>] [--json]
 *                     [--fail-on findings|never] [--timestamp]
 *
 * parse and causes exit 0 on success and 1 on error.
 * triage exits 0 when the report has no entries, 2 when it has entries
 * (unless --fail-on never), and 1 on a tool error.
 * Error text is one line on stderr.
 */

const HELP = `qa-core-flaky <command> [options]

Commands:
  parse <report>     Print normalized test records as JSON
  causes <report>    Print likely causes for each failed or flaky test
  triage <report...> Write a triage report as JSON and Markdown

Options:
  --format <json|junit>       Force the report format instead of detecting it
  --commit <sha>              Store this commit SHA on every record
  --branch <name>             Store this branch name on every record
  --run-id <id>               Store this run id on every record
  --out <file>                parse, causes: write the output to this file
  --out-dir <dir>             triage: write triage.json and triage.md here
  --json                      causes: print a JSON array. triage: also print JSON
  --fail-on <findings|never>  triage: exit 2 when there are entries (default findings)
  --timestamp                 triage: include generatedAt. Output then changes every run
  --test-timeout <ms>         Test timeout for the near-timeout rule
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
};

function main(): void {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    if (error instanceof ExitRequest) return;
    throw error;
  }
}

function run(args: readonly string[]): void {
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
  if (command === undefined) fail('Usage: qa-core-flaky <parse|causes|triage> <report>');
  if (command === 'triage') {
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
    const result =
      selected === 'json' ? parsePlaywrightJson(text, reportPath, meta) : parseJunit(text, reportPath, meta);
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
  for (const reportPath of reportPaths) {
    const text = readReport(reportPath);
    try {
      const selected = format ?? detectFormat(text, reportPath);
      const result =
        selected === 'json' ? parsePlaywrightJson(text, reportPath, meta) : parseJunit(text, reportPath, meta);
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
    writeNamed(values['out-dir'], 'triage.json', json);
    writeNamed(values['out-dir'], 'triage.md', markdown);
  }
  if (values['out-dir'] === undefined || values.json === true) {
    process.stdout.write(values.json === true ? json : markdown);
  }
  const code = failOn === 'never' || report.entries.length === 0 ? 0 : 2;
  if (code !== 0) process.exitCode = code;
}

function readFailOn(value: string | undefined): 'findings' | 'never' {
  if (value === undefined || value === 'findings') return 'findings';
  if (value === 'never') return 'never';
  fail(`Unknown --fail-on value ${value}. Expected findings or never.`);
}

function writeNamed(dir: string, name: string, body: string): void {
  if (dir.trim() === '') fail('The output directory is empty.');
  writeOutput(path.join(dir, name), body);
}

function formatCauses(result: ParseResult, testTimeoutMs: number | undefined, asJson: boolean): string {
  const rows = result.records
    .filter((record) => record.outcome === 'failed' || record.outcome === 'flaky')
    .map((record) => ({
      id: record.id,
      findings: classifyCauses(record, testTimeoutMs === undefined ? {} : { testTimeoutMs }),
    }));
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

function readReport(reportPath: string): string {
  try {
    return fs.readFileSync(reportPath, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    fail(`Cannot read report ${reportPath}: ${oneLine(detail)}`);
  }
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
  process.stderr.write(`${oneLine(message)}\n`);
  process.exitCode = 1;
  throw new ExitRequest();
}

main();
