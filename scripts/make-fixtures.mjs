/**
 * Regenerate the Playwright JSON and JUnit fixtures from one run.
 *
 * Runs:
 *   npx playwright test --config fixtures/pw-project/playwright.config.ts
 *
 * The Playwright process is expected to exit non-zero, because some fixture
 * tests fail on purpose. That exit code is ignored when both reports were
 * written. Volatile fields are then replaced so the committed files do not
 * change between runs:
 *   - startTime strings and JUnit timestamp attributes become
 *     1970-01-01T00:00:00.000Z
 *   - duration numbers and JUnit time attributes become 0
 *   - workerIndex and parallelIndex become 0
 *   - metadata objects become {}
 *   - absolute paths under the project, the repo, the home directory, or
 *     the temp directory become relative
 *   - a JUnit hostname attribute is replaced only when it equals this
 *     machine's hostname. Playwright 1.60.0 writes the project name there
 *     (chromium in this fixture), and that value is left as-is
 *   - ANSI escape codes are removed
 *   - repeated locator-log counts ("12 ×") become a fixed "1 ×" line,
 *     including the indented line under them, because the count and its
 *     spacing change from run to run
 *
 * After the Playwright reports are written, the script also regenerates
 * fixtures/reports/golden/heal-findings-saucedemo.json and
 * fixtures/reports/golden/heal-findings-saucedemo-junit.json by running
 * triage --heal-findings on the recorded SauceDemo reports. That step
 * uses dist/cli.js and builds it first when the file is missing.
 *
 * Run this from the repository root. It needs the Playwright browser
 * installed locally. Tests and CI do not run it.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const jsonReportPath = path.join(repoRoot, 'fixtures/reports/pw-1.60.0-outcomes.json');
const junitReportPath = path.join(repoRoot, 'fixtures/reports/pw-1.60.0-outcomes.junit.xml');
const START_TIME = '1970-01-01T00:00:00.000Z';
const ANSI_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

fs.mkdirSync(path.dirname(jsonReportPath), { recursive: true });

const result = spawnSync(
  'npx',
  ['playwright', 'test', '--config', 'fixtures/pw-project/playwright.config.ts'],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    env: playwrightEnv(),
  },
);

if (!fs.existsSync(jsonReportPath) || !fs.existsSync(junitReportPath)) {
  const code = typeof result.status === 'number' ? result.status : 1;
  console.error('Playwright did not write both reports.');
  process.exit(code === 0 ? 1 : code);
}

const report = JSON.parse(fs.readFileSync(jsonReportPath, 'utf8'));
const rootDir = typeof report?.config?.rootDir === 'string' ? report.config.rootDir : '';
const prefixes = uniquePrefixes([rootDir, repoRoot, os.homedir(), os.tmpdir()]);
const sanitized = walk(report, prefixes);
fs.writeFileSync(jsonReportPath, `${JSON.stringify(sanitized, null, 2)}\n`);

const xml = sanitizeJunit(fs.readFileSync(junitReportPath, 'utf8'), prefixes);
fs.writeFileSync(junitReportPath, xml.endsWith('\n') ? xml : `${xml}\n`);

writeHealGoldens();

function writeHealGoldens() {
  const cli = path.join(repoRoot, 'dist/cli.js');
  if (!fs.existsSync(cli)) {
    const built = spawnSync(process.execPath, [path.join(repoRoot, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    if (built.status !== 0) process.exit(built.status === null ? 1 : built.status);
  }
  const jobs = [
    ['demo/saucedemo/reports/recorded-seed-443.json', 'fixtures/reports/golden/heal-findings-saucedemo.json'],
    ['demo/saucedemo/reports/recorded-seed-443.junit.xml', 'fixtures/reports/golden/heal-findings-saucedemo-junit.json'],
  ];
  for (const [report, out] of jobs) {
    const result = spawnSync(process.execPath, [cli, 'triage', report, '--heal-findings', out, '--fail-on', 'never'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    if (result.status !== 0) process.exit(result.status === null ? 1 : result.status);
  }
}

function sanitizeJunit(xml, prefixes) {
  let out = sanitizeString(xml, prefixes);
  out = out.replace(/\btimestamp="[^"]*"/g, `timestamp="${START_TIME}"`);
  out = out.replace(/\btime="[^"]*"/g, 'time="0"');
  const host = os.hostname();
  if (host) {
    const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`hostname="${escaped}"`, 'g'), 'hostname="localhost"');
  }
  return out;
}

function walk(node, prefixes) {
  if (Array.isArray(node)) {
    return node.map((item) => walk(item, prefixes));
  }
  if (!node || typeof node !== 'object') {
    return typeof node === 'string' ? sanitizeString(node, prefixes) : node;
  }
  const out = {};
  for (const [key, child] of Object.entries(node)) {
    if (key === 'startTime' && typeof child === 'string') {
      out[key] = START_TIME;
      continue;
    }
    if (key === 'duration' && typeof child === 'number') {
      out[key] = 0;
      continue;
    }
    if ((key === 'workerIndex' || key === 'parallelIndex') && typeof child === 'number') {
      out[key] = 0;
      continue;
    }
    if (key === 'metadata' && child && typeof child === 'object') {
      out[key] = {};
      continue;
    }
    out[key] = walk(child, prefixes);
  }
  return out;
}

function sanitizeString(value, prefixes) {
  let out = value.replace(ANSI_PATTERN, '');
  out = out.replace(
    /[ \t]*[0-9]+ \u00D7 (locator resolved to [^\n]+)\n[ \t]*- /g,
    '    1 \u00D7 $1\n       - ',
  );
  for (const prefix of prefixes) {
    out = out.split(`${prefix}/`).join('');
    out = out.split(`${prefix}\\`).join('');
    if (out === prefix) out = '.';
  }
  return out;
}

function playwrightEnv() {
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  return env;
}

function uniquePrefixes(candidates) {
  const normalized = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue;
    const trimmed = candidate.replace(/[\\/]+$/, '');
    if (trimmed === '' || trimmed === '.') continue;
    normalized.push(trimmed);
  }
  return [...new Set(normalized)].sort((left, right) => right.length - left.length);
}
