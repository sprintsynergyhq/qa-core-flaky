/**
 * Record one polite SauceDemo run and normalize the reports.
 *
 * Usage, from the repository root:
 *   npm run demo:record -- --seed 443
 *
 * The Playwright exit code is ignored when both reports exist, because the
 * seeded failures are intentional. Volatile fields are replaced with the
 * same rules as scripts/make-fixtures.mjs:
 *   - startTime strings and JUnit timestamp attributes become
 *     1970-01-01T00:00:00.000Z
 *   - duration numbers and JUnit time attributes become 0
 *   - workerIndex and parallelIndex become 0
 *   - metadata objects become {}
 *   - absolute paths under the project, the repo, the home directory, or
 *     the temp directory become relative
 *   - a JUnit hostname attribute is replaced only when it equals this
 *     machine's hostname. Playwright 1.60.0 writes the project name there,
 *     and that value is left as-is
 *   - ANSI escape codes are removed
 *   - repeated locator-log counts ("12 ×") become a fixed "1 ×" line,
 *     including the indented line under them
 *
 * The seed is the --seed argument. It is not read back from the environment
 * for the log line. FLAKE_RATE is set to 0.5 for this run.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    seed: { type: 'string' },
  },
  strict: true,
});

const seedText = values.seed ?? '';
if (!/^[0-9]+$/.test(seedText)) {
  console.error('Usage: npm run demo:record -- --seed <non-negative integer>');
  process.exit(1);
}

const repoRoot = path.resolve(import.meta.dirname, '..');
const liveJsonPath = path.join(repoRoot, 'demo/saucedemo/reports/live.json');
const liveJunitPath = path.join(repoRoot, 'demo/saucedemo/reports/live.junit.xml');
const recordedJsonPath = path.join(repoRoot, `demo/saucedemo/reports/recorded-seed-${seedText}.json`);
const recordedJunitPath = path.join(repoRoot, `demo/saucedemo/reports/recorded-seed-${seedText}.junit.xml`);
const START_TIME = '1970-01-01T00:00:00.000Z';
const ANSI_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

fs.mkdirSync(path.dirname(liveJsonPath), { recursive: true });
fs.rmSync(liveJsonPath, { force: true });
fs.rmSync(liveJunitPath, { force: true });

const env = playwrightEnv();
env.FLAKE_SEED = seedText;
env.FLAKE_RATE = '0.5';

console.log(`Recording SauceDemo with seed ${seedText}, one worker, retries 2.`);

const result = spawnSync(
  'npx',
  ['playwright', 'test', '--config', 'demo/saucedemo/playwright.config.ts'],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    env,
  },
);

if (!fs.existsSync(liveJsonPath) || !fs.existsSync(liveJunitPath)) {
  const code = typeof result.status === 'number' ? result.status : 1;
  console.error('Playwright did not write both reports.');
  process.exit(code === 0 ? 1 : code);
}

const report = JSON.parse(fs.readFileSync(liveJsonPath, 'utf8'));
const rootDir = typeof report?.config?.rootDir === 'string' ? report.config.rootDir : '';
const prefixes = uniquePrefixes([rootDir, repoRoot, os.homedir(), os.tmpdir()]);
const sanitized = walk(report, prefixes);
fs.writeFileSync(recordedJsonPath, `${JSON.stringify(sanitized, null, 2)}\n`);

const xml = sanitizeJunit(fs.readFileSync(liveJunitPath, 'utf8'), prefixes);
fs.writeFileSync(recordedJunitPath, xml.endsWith('\n') ? xml : `${xml}\n`);
fs.rmSync(liveJsonPath, { force: true });
fs.rmSync(liveJunitPath, { force: true });

console.log(`Wrote ${path.relative(repoRoot, recordedJsonPath)}`);
console.log(`Wrote ${path.relative(repoRoot, recordedJunitPath)}`);

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
