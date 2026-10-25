#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { classifyCauses } from './causes/index.js';
import type { CauseFinding } from './causes/types.js';
import type { ParseResult } from './model.js';
import { detectFormat } from './parsers/detect.js';
import { parseJunit } from './parsers/junit.js';
import { parsePlaywrightJson } from './parsers/playwright-json.js';

/**
 * qa-core-flaky command line.
 *
 *   qa-core-flaky parse <report> [--format json|junit] [--commit <sha>]
 *                     [--branch <name>] [--run-id <id>] [--out <file>]
 *   qa-core-flaky causes <report> [--format json|junit] [--json]
 *                     [--test-timeout <ms>] [--out <file>]
 *
 * Exit 0 on success. Exit 1 on error, with a one-line message on stderr.
 */

const HELP = `qa-core-flaky <command> [options]

Commands:
  parse <report>    Print normalized test records as JSON
  causes <report>   Print likely causes for each failed or flaky test

Options:
  --format <json|junit>  Force the report format instead of detecting it
  --commit <sha>         parse: store this commit SHA on every record
  --branch <name>        parse: store this branch name on every record
  --run-id <id>          parse: store this run id on every record
  --out <file>           Write the output to this file instead of stdout
  --json                 causes: print a JSON array of { id, findings }
  --test-timeout <ms>    causes: test timeout for the near-timeout rule
  -h, --help             Show this help
  --version              Print the version
`;

type FlagValues = {
  help?: boolean;
  version?: boolean;
  format?: string;
  commit?: string;
  branch?: string;
  'run-id'?: string;
  out?: string;
  json?: boolean;
  'test-timeout'?: string;
};

function main(): void {
  let values: FlagValues;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: process.argv.slice(2),
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
        json: { type: 'boolean' },
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

  const [command, reportPath, ...extra] = positionals;
  if (command === undefined || reportPath === undefined || extra.length > 0) {
    fail('Usage: qa-core-flaky <parse|causes> <report>');
  }
  if (command !== 'parse' && command !== 'causes') {
    fail(`Unknown command ${command}`);
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
    fail(oneLine(error instanceof Error ? error.message : 'Could not parse the report'));
  }

  writeOutput(values.out, body);
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

function fail(message: string): never {
  process.stderr.write(`${oneLine(message)}\n`);
  process.exit(1);
}

main();
