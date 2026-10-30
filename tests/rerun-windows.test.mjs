import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { exactFileArg, executePlan, formatPrintedCommand, planReruns } from '../dist/index.js';
import { findPlaywrightCli, playwrightCli, printedLauncher } from '../dist/rerun/run.js';

// Playwright 1.60.0's own file filter code: the same functions `npx playwright test` uses.
const require = createRequire(import.meta.url);
const pwUtil = require('playwright/lib/util');

const SEP = '[\\\\/]';

/** Match a file filter argument the way Playwright 1.60.0 does. */
function playwrightMatches(arg, file, line) {
  const parsed = pwUtil.parseLocationArg(arg);
  const matcher = pwUtil.createFileMatcher(pwUtil.forceRegExp(parsed.file));
  return matcher(file) && (parsed.line === null || parsed.line === line);
}

function failing(title, file = 'tests/a.spec.ts') {
  return {
    id: `${file}::chromium::${title}`,
    file,
    project: 'chromium',
    titlePath: [title],
    expectedStatus: 'passed',
    outcome: 'failed',
    attempts: [
      { retry: 0, status: 'failed', durationMs: 5, errors: [{ message: 'Error: gave up' }], attachments: [] },
    ],
    source: { format: 'playwright-json', reportPath: 'fixture.json' },
  };
}

function writeFakeCli(file, argvFile) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const report = path.resolve('fixtures/reports/rerun/repeat-pass.json');
  fs.writeFileSync(
    file,
    [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv));`,
      `process.stdout.write(fs.readFileSync(${JSON.stringify(report)}, 'utf8'));`,
    ].join('\n'),
  );
}

test('a Windows file filter matches the native path and the forward slash path in Playwright', () => {
  const native = 'C:\\Users\\bob\\saucedemo-flaky-kit\\tests\\flaky-order.spec.ts';
  const arg = exactFileArg(native);
  assert.equal(arg, `/^C:${SEP}Users${SEP}bob${SEP}saucedemo-flaky-kit${SEP}tests${SEP}flaky-order\\.spec\\.ts$/`);
  assert.equal(playwrightMatches(arg, native), true);
  assert.equal(playwrightMatches(arg, native.replaceAll('\\', '/')), true);
  assert.equal(playwrightMatches(arg, native.replace('flaky-order.spec.ts', 'flaky-orderXspec.ts')), false);
  assert.equal(playwrightMatches(arg, `${native}x`), false);
  assert.equal(playwrightMatches(arg, `D:\\old\\${native.slice(3)}`), false);
  // The same path written with forward slashes builds the same filter.
  assert.equal(exactFileArg(native.replaceAll('\\', '/')), arg);
});

test('a Windows file filter keeps the line and matches only that line', () => {
  const native = 'C:\\Users\\bob\\kit\\tests\\a.spec.ts';
  const arg = exactFileArg(native, 12);
  assert.match(arg, /\$\/:12$/);
  assert.equal(pwUtil.parseLocationArg(arg).line, 12);
  assert.equal(playwrightMatches(arg, native, 12), true);
  assert.equal(playwrightMatches(arg, native, 13), false);
});

test('UNC, extended, and special character Windows paths become exact filters', () => {
  const unc = '\\\\server\\share\\kit\\a.spec.ts';
  const uncArg = exactFileArg(unc);
  assert.equal(uncArg.startsWith(`/^${SEP}${SEP}server${SEP}share`), true, uncArg);
  assert.equal(playwrightMatches(uncArg, unc), true);
  const extended = '\\\\?\\C:\\Users\\bob\\kit\\a.spec.ts';
  assert.equal(playwrightMatches(exactFileArg(extended), extended), true);
  const weird = 'C:\\Users\\bob\\we ird[1]+(x)\\m.spec.ts';
  const weirdArg = exactFileArg(weird);
  assert.match(weirdArg, /\\\[1\\\]\\\+\\\(x\\\)/);
  assert.equal(playwrightMatches(weirdArg, weird), true);
  assert.equal(playwrightMatches(weirdArg, 'C:\\Users\\bob\\we ird1x\\m.spec.ts'), false);
});

test('a POSIX file filter is unchanged', () => {
  assert.equal(exactFileArg('/home/bob/p/a.spec.ts'), String.raw`/^\/home\/bob\/p\/a\.spec\.ts$/`);
  assert.equal(exactFileArg('/home/bob/p/a.spec.ts', 3), String.raw`/^\/home\/bob\/p\/a\.spec\.ts$/:3`);
  assert.equal(exactFileArg('/tmp/a\\b.spec.ts'), String.raw`/^\/tmp\/a\\b\.spec\.ts$/`);
  assert.equal(playwrightMatches(exactFileArg('/home/bob/p/a.spec.ts'), '/home/bob/p/a.spec.ts'), true);
});

test('a printed Windows file filter hides the home and keeps every escape', () => {
  const native = 'C:\\Users\\bob\\saucedemo-flaky-kit\\tests\\flaky-order.spec.ts';
  for (const line of [undefined, 7]) {
    const arg = exactFileArg(native, line);
    const printed = formatPrintedCommand(['--retries', '0', '--', arg]);
    const tail = line === undefined ? '' : `:${line}`;
    assert.equal(
      printed,
      `'--retries' '0' '--' '/^<home>${SEP}saucedemo-flaky-kit${SEP}tests${SEP}flaky-order\\.spec\\.ts$/${tail}'`,
    );
    assert.equal(printed.includes('bob'), false);
    assert.equal(printed.includes('/.spec/.ts'), false);
  }
  const unc = formatPrintedCommand(['--', exactFileArg('\\\\srv\\c$\\Users\\bob\\a.spec.ts')]);
  assert.equal(unc.includes('bob'), false, unc);
  assert.match(unc, /<home>/);
  const extended = formatPrintedCommand(['--', exactFileArg('\\\\?\\C:\\Users\\bob\\a.spec.ts')]);
  assert.equal(extended.includes('bob'), false, extended);
  const other = formatPrintedCommand(['--', exactFileArg('D:\\work\\kit\\a.spec.ts')]);
  assert.equal(other, `'--' '/^D:${SEP}work${SEP}kit${SEP}a\\.spec\\.ts$/'`);
});

test('the rerun finds playwright/cli.js and does not need node_modules/.bin', () => {
  const kit = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-flaky-cli-'));
  try {
    // A .bin shim alone is not enough. Windows cannot start it.
    fs.mkdirSync(path.join(kit, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(kit, 'node_modules', '.bin', 'playwright'), '#!/bin/sh\n');
    assert.equal(findPlaywrightCli(kit), undefined);
    assert.throws(() => playwrightCli(kit), /Local Playwright was not found in .*node_modules\. The rerun looks for playwright\/cli\.js/);

    const fallback = path.join(kit, 'node_modules', '@playwright', 'test', 'cli.js');
    fs.mkdirSync(path.dirname(fallback), { recursive: true });
    fs.writeFileSync(fallback, '');
    assert.equal(playwrightCli(kit), fallback);

    const main = path.join(kit, 'node_modules', 'playwright', 'cli.js');
    fs.mkdirSync(path.dirname(main), { recursive: true });
    fs.writeFileSync(main, '');
    assert.equal(playwrightCli(kit), main);
    assert.equal(printedLauncher(kit), 'npx playwright test');
  } finally {
    fs.rmSync(kit, { recursive: true, force: true });
  }
});

test('with --config the CLI is found in the config folder or a parent, and the launcher stays runnable', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-flaky-cli-parent-'));
  try {
    const kit = path.join(parent, 'saucedemo-flaky-kit');
    const cli = path.join(kit, 'node_modules', 'playwright', 'cli.js');
    fs.mkdirSync(path.join(kit, 'nested'), { recursive: true });
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, '');
    assert.equal(playwrightCli(parent, 'saucedemo-flaky-kit/playwright.config.ts'), cli);
    assert.equal(playwrightCli(parent, 'saucedemo-flaky-kit/nested/playwright.config.ts'), cli);
    // Without --config only the working directory is used.
    assert.throws(() => playwrightCli(parent), /Local Playwright was not found/);
    assert.equal(
      printedLauncher(parent, 'saucedemo-flaky-kit/playwright.config.ts'),
      "node 'saucedemo-flaky-kit/node_modules/playwright/cli.js' test",
    );
    assert.equal(printedLauncher(kit, 'playwright.config.ts'), 'npx playwright test');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('the default runner starts cli.js with this Node, and prints npx playwright test', async () => {
  const kit = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-flaky-spawn-'));
  const argvFile = path.join(kit, 'argv.json');
  try {
    fs.mkdirSync(path.join(kit, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(kit, 'tests', 'a.spec.ts'), 'test\n');
    const cli = path.join(kit, 'node_modules', 'playwright', 'cli.js');
    writeFakeCli(cli, argvFile);
    const item = failing('same value');
    const plan = planReruns([item], { times: 5, modes: ['repeat'] });
    const lines = [];
    const merged = await executePlan({ records: [item], plan, cwd: kit, print: (line) => lines.push(line) });
    const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
    assert.equal(fs.realpathSync(argv[0]), fs.realpathSync(process.execPath));
    assert.equal(fs.realpathSync(argv[1]), fs.realpathSync(cli));
    assert.equal(argv[2], 'test');
    assert.equal(argv.includes('--repeat-each=5') || argv.includes('--repeat-each'), true, argv.join(' '));
    const filter = argv.at(-1);
    assert.equal(playwrightMatches(filter, path.join(kit, 'tests', 'a.spec.ts')), true, filter);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].startsWith('npx playwright test '), true, lines[0]);
    assert.equal(lines[0].includes('.bin'), false, lines[0]);
    const rerun = merged[0].attempts.filter((row) => row.rerun);
    assert.equal(rerun.length, 5);
    assert.equal(rerun.every((row) => row.status === 'passed'), true);
  } finally {
    fs.rmSync(kit, { recursive: true, force: true });
  }
});

test('rerun children are not detached on Windows and are started with windowsHide', () => {
  const source = fs.readFileSync('dist/rerun/run.js', 'utf8');
  assert.equal(source.match(/detached: DETACH_CHILDREN,\s+windowsHide: true,/g)?.length, 2);
  assert.equal(source.includes('detached: true'), false);
  assert.equal(source.includes("export const DETACH_CHILDREN = process.platform !== 'win32';"), true);
  assert.equal(source.includes("'.bin'"), false);
  const heal = fs.readFileSync('dist/heal/run.js', 'utf8');
  assert.equal(heal.includes('detached: DETACH_CHILDREN,'), true);
  assert.equal(heal.includes('detached: true'), false);
});

test('Windows cleanup waits for taskkill on the whole tree', () => {
  const source = fs.readFileSync('dist/rerun/run.js', 'utf8');
  assert.equal(source.match(/await taskkillTree\(pid\)/g)?.length, 2);
  assert.equal(source.includes("['/T', '/F', '/PID', String(pid)]"), true);
});
