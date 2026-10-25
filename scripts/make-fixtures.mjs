/**
 * Regenerate fixtures/reports/pw-1.60.0-outcomes.json.
 *
 * Runs:
 *   npx playwright test --config fixtures/pw-project/playwright.config.ts
 *
 * The Playwright process is expected to exit non-zero, because some fixture
 * tests fail on purpose. That exit code is ignored when the JSON report was
 * written. Volatile fields are then replaced so the committed file does not
 * change between runs:
 *   - startTime strings become 1970-01-01T00:00:00.000Z
 *   - duration numbers become 0
 *   - workerIndex and parallelIndex become 0
 *   - metadata objects become {}
 *   - absolute paths under the project, the repo, the home directory, or
 *     the temp directory become relative
 *   - ANSI escape codes are removed
 *   - repeated locator-log counts ("12 ×") become a fixed "1 ×" line,
 *     including the indented line under them, because the count and its
 *     spacing change from run to run
 *
 * Run this from the repository root. It needs the Playwright browser
 * installed locally. Tests and CI do not run it.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const reportPath = path.join(repoRoot, 'fixtures/reports/pw-1.60.0-outcomes.json');
const START_TIME = '1970-01-01T00:00:00.000Z';
const ANSI_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

fs.mkdirSync(path.dirname(reportPath), { recursive: true });

const result = spawnSync(
  'npx',
  ['playwright', 'test', '--config', 'fixtures/pw-project/playwright.config.ts'],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    env: playwrightEnv(),
  },
);

if (!fs.existsSync(reportPath)) {
  const code = typeof result.status === 'number' ? result.status : 1;
  console.error('Playwright did not write the JSON report.');
  process.exit(code === 0 ? 1 : code);
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const sanitized = sanitizeReport(report, repoRoot);
fs.writeFileSync(reportPath, `${JSON.stringify(sanitized, null, 2)}\n`);

function sanitizeReport(value, root) {
  const rootDir = typeof value?.config?.rootDir === 'string' ? value.config.rootDir : '';
  const prefixes = uniquePrefixes([rootDir, root, os.homedir(), os.tmpdir()]);
  return walk(value, prefixes);
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
