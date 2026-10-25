import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildPlaywrightArgs,
  buildTriageReport,
  classifyCauses,
  decideVerdict,
  executePlan,
  formatCap,
  formatPrintedCommand,
  mergeRerunRecords,
  onStopSignal,
  planReruns,
  releaseRun,
  renderTriageJson,
  renderTriageMarkdown,
  tagRerunAttempts,
} from '../dist/index.js';

const VALUE = 'Error: expect(locator).toHaveText(expected) failed\nExpected: "a"\nReceived: "b"';

function attempt(status, message, retry = 0, rerun) {
  const row = {
    retry,
    status,
    durationMs: 5,
    errors: message === undefined ? [] : [{ message }],
    attachments: [],
  };
  if (rerun) row.rerun = rerun;
  return row;
}

function record(title, attempts, source = {}) {
  const failed = attempts.some((item) => item.status === 'failed' || item.status === 'timedOut');
  const passed = attempts.some((item) => item.status === 'passed');
  return {
    id: `tests/a.spec.ts::chromium::${title}`,
    file: 'tests/a.spec.ts',
    project: 'chromium',
    titlePath: [title],
    expectedStatus: 'passed',
    outcome: failed && passed ? 'flaky' : failed ? 'failed' : 'passed',
    attempts,
    source: { format: 'playwright-json', reportPath: 'fixture.json', ...source },
  };
}

test('the plan skips passing tests and honors only and max-tests', () => {
  const failing = record('same value', [attempt('failed', VALUE)]);
  const second = record('other', [attempt('failed', 'Error: gave up')]);
  const passing = record('ok', [attempt('passed')]);
  passing.outcome = 'passed';
  const records = [passing, failing, second];

  const all = planReruns(records, { times: 2, maxTests: 20, modes: ['repeat'] });
  assert.deepEqual(all.tests.map((item) => item.id), [failing.id, second.id]);
  assert.equal(all.cap.selected, 2);
  assert.equal(all.cap.failing, 2);
  assert.equal(all.cap.commands, 2);
  assert.match(formatCap(all.cap), /Selected 2 of 2 failing tests/);

  const capped = planReruns(records, { maxTests: 1, modes: ['repeat'] });
  assert.deepEqual(capped.tests.map((item) => item.id), [failing.id]);

  const onlyPassing = planReruns(records, { only: [passing.id], modes: ['repeat'] });
  assert.equal(onlyPassing.tests.length, 0);
  assert.equal(onlyPassing.runs.length, 0);

  assert.throws(() => planReruns(records, { only: ['missing'] }), /Unknown test id missing/);
});

test('the argument builder is an array, escapes titles, and refuses snapshot updates', () => {
  const args = buildPlaywrightArgs({
    file: 'tests/a.spec.ts',
    title: 'a.b (c)',
    mode: 'isolated',
    times: 5,
    config: 'playwright.config.ts',
    project: 'chromium',
  });
  assert.ok(Array.isArray(args));
  assert.equal(args.includes('--update-snapshots'), false);
  assert.equal(args.includes('-u'), false);
  assert.deepEqual(args.slice(0, 8), [
    '--config',
    'playwright.config.ts',
    '--retries',
    '0',
    '--workers',
    '1',
    '--reporter',
    'json',
  ]);
  assert.equal(args.includes('--repeat-each'), false);
  assert.equal(args.at(-2), '-g');
  assert.equal(args.at(-1), 'a\\.b \\(c\\)$');
  assert.equal(args.includes('tests/a\\.spec\\.ts'), true);

  const repeat = buildPlaywrightArgs({
    file: 'tests/a.spec.ts',
    title: 'same value',
    mode: 'repeat',
    times: 5,
    project: 'default',
  });
  assert.equal(repeat.includes('--repeat-each'), true);
  assert.equal(repeat.includes('--project'), false);

  const ordered = buildPlaywrightArgs({
    file: 'tests/order.spec.ts',
    mode: 'in-order',
    times: 5,
    project: 'chromium',
  });
  assert.equal(ordered.includes('-g'), false);
  assert.equal(ordered.includes('--repeat-each'), false);
  assert.equal(ordered.includes('--retries'), true);
});

test('isolated runs one command per time and in-order runs the file once', () => {
  const first = record('same value', [attempt('failed', VALUE)]);
  const second = {
    ...record('other', [attempt('failed', 'Error: gave up')]),
    id: 'tests/a.spec.ts::chromium::other',
    file: 'tests/a.spec.ts',
  };
  const plan = planReruns([first, second], { times: 3, modes: ['repeat', 'isolated', 'in-order'] });
  const repeat = plan.runs.filter((run) => run.mode === 'repeat');
  const isolated = plan.runs.filter((run) => run.mode === 'isolated');
  const ordered = plan.runs.filter((run) => run.mode === 'in-order');
  assert.equal(repeat.length, 2);
  assert.equal(isolated.length, 6);
  assert.equal(ordered.length, 1);
  assert.equal(ordered[0].args.includes('-g'), false);
  assert.equal(plan.cap.commands, 9);
});

test('a redacted title is omitted from the printed command and kept in the args', () => {
  const item = record('open /home/alice/notes', [attempt('failed', VALUE)]);
  const plan = planReruns([item], { times: 1, modes: ['isolated'] });
  const args = plan.runs[0].args;
  assert.equal(args.includes('-g'), true);
  assert.equal(args.some((part) => part.includes('/home/alice/notes')), true);
  const printed = formatPrintedCommand(args, item);
  assert.equal(printed.includes("'-g'"), false);
  assert.match(printed, /the title was redacted, so -g is omitted here/);
  assert.equal(printed.includes('alice'), false);
});

test('a stored home file cannot be rerun', () => {
  const item = record('t', [attempt('failed', VALUE)]);
  item.file = '<home>/a.spec.ts';
  item.id = '<home>/a.spec.ts::chromium::t';
  assert.throws(() => planReruns([item], { modes: ['repeat'] }), /redacted/);
});

test('order disagreement is DATA-ORDER and the verdict is flaky', () => {
  const reader = {
    id: 'tests/order.spec.ts::chromium::order reader expects the marker',
    file: 'tests/order.spec.ts',
    project: 'chromium',
    titlePath: ['order reader expects the marker'],
    expectedStatus: 'passed',
    outcome: 'failed',
    attempts: [attempt('failed', 'Error: marker missing', 0, { mode: 'in-order', runIndex: 0 })],
    source: { format: 'playwright-json', reportPath: 'order.json', commitSha: 'abc' },
  };
  reader.attempts[0].status = 'passed';
  reader.attempts[0].errors = [];
  reader.attempts.push(attempt('failed', 'Error: marker missing', 0, { mode: 'isolated', runIndex: 0 }));
  reader.attempts.push(attempt('failed', 'Error: marker missing', 1, { mode: 'isolated', runIndex: 1 }));
  const findings = classifyCauses(reader);
  assert.equal(findings[0].cause, 'test-data');
  assert.equal(findings[0].ruleIds.includes('DATA-ORDER'), true);
  assert.match(findings[0].evidence[0], /in-order passed 1, isolated failed 2/);
  const decision = decideVerdict([reader], findings);
  assert.equal(decision.verdict, 'flaky');
  assert.equal(decision.cause, 'test-data');
});

test('five failing reruns of one signature become a likely real bug, and a pass becomes flaky', async () => {
  const original = record('same value', [attempt('failed', VALUE)], { commitSha: 'abc', reportPath: 'orig.json' });
  const failed = await executePlan({
    records: [original],
    plan: planReruns([original], { times: 5, modes: ['repeat'] }),
    cwd: process.cwd(),
    print: () => {},
    runner: copyRunner('fixtures/reports/rerun/repeat-fail.json'),
  });
  const failedReport = buildTriageReport(failed);
  assert.equal(failedReport.entries[0].verdict, 'likely-real-bug');
  assert.equal(failedReport.entries[0].attempts.reruns.repeat.failed, 5);
  assert.equal(/\bstable\b/i.test(renderTriageJson(failedReport) + renderTriageMarkdown(failedReport)), false);

  const passed = await executePlan({
    records: [original],
    plan: planReruns([original], { times: 5, modes: ['repeat'] }),
    cwd: process.cwd(),
    print: () => {},
    runner: copyRunner('fixtures/reports/rerun/repeat-pass.json'),
  });
  const passedReport = buildTriageReport(passed);
  assert.equal(passedReport.entries[0].verdict, 'flaky');
  assert.equal(passedReport.entries[0].observation, 'no flake observed in 5 runs');
  const text = renderTriageJson(passedReport) + renderTriageMarkdown(passedReport);
  assert.match(text, /no flake observed in 5 runs/);
  assert.equal(/\bstable\b/i.test(text), false);
  assert.match(text, /repeat total 5, failed 0, passed 5/);
});

test('recorded order outputs merge onto the reader and name DATA-ORDER', async () => {
  const reader = {
    id: 'tests/order.spec.ts::chromium::order reader expects the marker',
    file: 'tests/order.spec.ts',
    project: 'chromium',
    titlePath: ['order reader expects the marker'],
    expectedStatus: 'passed',
    outcome: 'failed',
    attempts: [attempt('failed', 'Error: marker missing')],
    source: { format: 'playwright-json', reportPath: 'order.json', commitSha: 'abc' },
  };
  const plan = planReruns([reader], { times: 1, modes: ['in-order', 'isolated'] });
  const seen = [];
  const merged = await executePlan({
    records: [reader],
    plan,
    cwd: process.cwd(),
    print: (line) => seen.push(line),
    runner: async (args, _cwd, stdoutFile) => {
      assert.ok(Array.isArray(args));
      assert.equal(args.includes('--update-snapshots'), false);
      const file = args.includes('-g')
        ? 'fixtures/reports/rerun/isolated-fail.json'
        : 'fixtures/reports/rerun/in-order-pass.json';
      fs.copyFileSync(file, stdoutFile);
      return { code: 1, stderr: '' };
    },
  });
  assert.equal(seen.length, plan.runs.length);
  assert.match(seen[0], /npx/);
  const report = buildTriageReport(merged);
  const entry = report.entries[0];
  assert.equal(entry.verdict, 'flaky');
  assert.equal(entry.causes[0].cause, 'test-data');
  assert.equal(entry.causes[0].ruleIds.includes('DATA-ORDER'), true);
  assert.equal(entry.attempts.reruns['in-order'].passed > 0, true);
  assert.equal(entry.attempts.reruns.isolated.failed, 1);
  assert.equal(/\bstable\b/i.test(renderTriageMarkdown(report)), false);
});

test('merge keeps original attempts and joins the same commit', () => {
  const original = record('same value', [attempt('failed', VALUE, 0)], { commitSha: 'abc' });
  const incoming = tagRerunAttempts(
    [record('same value', [attempt('passed', undefined, 0)], { commitSha: 'abc', reportPath: 'rerun.json' })],
    'repeat',
    0,
    'abc',
  );
  const merged = mergeRerunRecords([original], incoming);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].attempts.length, 2);
  assert.equal(merged[0].attempts[1].rerun.mode, 'repeat');
  assert.equal(merged[0].attempts[1].rerun.runIndex, 0);

  const otherCommit = tagRerunAttempts(
    [record('same value', [attempt('failed', VALUE, 0)], { commitSha: 'zzz', reportPath: 'other.json' })],
    'repeat',
    0,
    'zzz',
  );
  const split = mergeRerunRecords([original], otherCommit);
  assert.equal(split.length, 2);
});

test('stopping a rerun deletes the temp directory after the kill', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-flaky-stop-'));
  fs.writeFileSync(path.join(dir, 'note.txt'), 'x');
  let killed = 0;
  releaseRun({
    pid: 4242,
    dir,
    kill: () => {
      killed += 1;
      throw new Error('already gone');
    },
  });
  assert.equal(killed, 1);
  assert.equal(fs.existsSync(dir), false);

  const again = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-flaky-signal-'));
  let raised;
  onStopSignal('SIGTERM', () => releaseRun({ dir: again }), (signal) => {
    raised = signal;
  });
  assert.equal(raised, 'SIGTERM');
  assert.equal(fs.existsSync(again), false);
});

test('a rerun temp directory is removed when the command fails', async () => {
  const original = record('same value', [attempt('failed', VALUE)]);
  const plan = planReruns([original], { times: 1, modes: ['repeat'] });
  let dir;
  await assert.rejects(
    executePlan({
      records: [original],
      plan,
      cwd: process.cwd(),
      print: () => {},
      runner: async (_args, _cwd, stdoutFile, setPid) => {
        setPid(7);
        dir = path.dirname(stdoutFile);
        assert.equal(fs.existsSync(dir), true);
        throw new Error('playwright failed');
      },
    }),
  );
  assert.equal(fs.existsSync(dir), false);
});

test('live rerun of the local order pair', { skip: process.env.QA_CORE_FLAKY_LIVE !== '1' }, (t) => {
  const source = record('order reader expects the marker', [attempt('failed', 'Error: marker missing')]);
  source.file = 'tests/order.spec.ts';
  source.id = 'tests/order.spec.ts::chromium::order reader expects the marker';
  source.titlePath = ['order reader expects the marker'];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-flaky-live-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const from = path.join(dir, 'from.json');
  fs.writeFileSync(
    from,
    `${JSON.stringify({ schemaVersion: 1, records: [source], warnings: [] }, null, 2)}\n`,
  );
  const out = path.join(dir, 'out');
  const result = spawnSync(
    process.execPath,
    [
      'dist/cli.js',
      'rerun',
      '--from',
      from,
      '--config',
      'fixtures/pw-project/playwright.rerun.config.ts',
      '--modes',
      'in-order,isolated',
      '--times',
      '1',
      '--only',
      source.id,
      '--out-dir',
      out,
      '--fail-on',
      'never',
      '--commit',
      'live',
    ],
    { encoding: 'utf8', cwd: process.cwd() },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Cap:/);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'triage.json'), 'utf8'));
  const entry = report.entries[0];
  assert.equal(entry.verdict, 'flaky');
  assert.equal(entry.causes[0].ruleIds.includes('DATA-ORDER'), true);
});

function copyRunner(file) {
  return async (args, _cwd, stdoutFile, setPid) => {
    assert.ok(Array.isArray(args));
    assert.equal(args.includes('--output'), true);
    setPid(1);
    fs.copyFileSync(file, stdoutFile);
    return { code: 0, stderr: '' };
  };
}
