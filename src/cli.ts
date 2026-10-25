#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { detectFormat } from './parsers/detect.js';
import { parseJunit } from './parsers/junit.js';
import { parsePlaywrightJson } from './parsers/playwright-json.js';

/**
 * qa-core-flaky command line.
 *
 *   qa-core-flaky parse <report> [--format json|junit] [--commit <sha>]
 *                     [--branch <name>] [--run-id <id>] [--out <file>]
 *
 * Exit 0 on success. Exit 1 on error, with a one-line message on stderr.
 */

const HELP = `qa-core-flaky parse <report> [options]

Read a Playwright JSON report or a JUnit XML report and print normalized test records as JSON.

Options:
  --format <json|junit>  Force the report format instead of detecting it
  --commit <sha>         Store this commit SHA on every record
  --branch <name>        Store this branch name on every record
  --run-id <id>          Store this run id on every record
  --out <file>           Write the JSON to this file instead of stdout
  -h, --help             Show this help
  --version              Print the version
`;

function main(): void {
  let values: {
    help?: boolean;
    version?: boolean;
    format?: string;
    commit?: string;
    branch?: string;
    'run-id'?: string;
    out?: string;
  };
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
  if (command === undefined) {
    fail('Usage: qa-core-flaky parse <report>');
  }
  if (command !== 'parse') {
    fail(`Unknown command ${command}`);
  }
  if (reportPath === undefined) {
    fail('Usage: qa-core-flaky parse <report>');
  }
  if (extra.length > 0) {
    fail('Usage: qa-core-flaky parse <report>');
  }

  const format = readFormat(values.format);

  let text: string;
  try {
    text = fs.readFileSync(reportPath, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    fail(`Cannot read report ${reportPath}: ${oneLine(detail)}`);
  }

  let json: string;
  try {
    const meta = {
      commitSha: values.commit,
      branch: values.branch,
      runId: values['run-id'],
    };
    const selected = format ?? detectFormat(text, reportPath);
    const result =
      selected === 'json' ? parsePlaywrightJson(text, reportPath, meta) : parseJunit(text, reportPath, meta);
    json = `${JSON.stringify(result, null, 2)}\n`;
  } catch (error) {
    fail(oneLine(error instanceof Error ? error.message : 'Could not parse the report'));
  }

  if (values.out !== undefined) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
      fs.writeFileSync(values.out, json);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      fail(`Cannot write ${values.out}: ${oneLine(detail)}`);
    }
    return;
  }

  process.stdout.write(json);
}

function readFormat(value: string | undefined): 'json' | 'junit' | undefined {
  if (value === undefined) return undefined;
  if (value === 'json' || value === 'junit') return value;
  fail(`Unknown format ${value}. Expected json or junit.`);
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
