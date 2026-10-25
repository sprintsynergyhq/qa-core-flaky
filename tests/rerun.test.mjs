import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  anchoredGrep,
  buildPlaywrightArgs,
  buildTriageReport,
  classifyCauses,
  decideVerdict,
  exactFileArg,
  executePlan,
  formatCap,
  formatPrintedCommand,
  guardPipe,
  redactHomeText,
  launchRerunChild,
  mergeRerunRecords,
  onStopSignal,
  planReruns,
  releaseRun,
  renderTriageJson,
  renderTriageMarkdown,
  shellCommand,
  tagRerunAttempts,
} from '../dist/index.js';
import { EventEmitter } from 'node:events';

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

test('the argument builder is an array, anchors the title, and refuses snapshot updates', () => {
  const args = buildPlaywrightArgs({
    file: 'tests/a.spec.ts',
    titlePath: ['a.b (c)'],
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
  assert.equal(args.includes('--project=chromium'), true);
  assert.equal(args.includes('--project'), false);
  const grepAt = args.indexOf('-g');
  assert.equal(
    args[grepAt + 1],
    '/^chromium(?: @\\S+)* tests\\/a\\.spec\\.ts(?: @\\S+)* a\\.b \\(c\\)(?: @\\S+)*$/',
  );
  const dash = args.indexOf('--');
  assert.ok(dash > grepAt);
  assert.equal(args[dash + 1], '/^tests\\/a\\.spec\\.ts$/');
  assert.equal(args.at(-2), '--');

  const lined = buildPlaywrightArgs({
    file: 'tests/a.spec.ts',
    titlePath: ['a.b (c)'],
    line: 12,
    mode: 'isolated',
    times: 1,
    project: 'chromium',
  });
  assert.equal(lined.includes('-g'), false);
  assert.equal(lined.at(-2), '--');
  assert.equal(lined.at(-1), '/^tests\\/a\\.spec\\.ts$/:12');

  const repeat = buildPlaywrightArgs({
    file: 'tests/a.spec.ts',
    titlePath: ['same value'],
    mode: 'repeat',
    times: 5,
    project: 'default',
  });
  assert.equal(repeat.includes('--repeat-each'), true);
  assert.equal(repeat.includes('--project=default'), true);

  const ordered = buildPlaywrightArgs({
    file: 'tests/order.spec.ts',
    mode: 'in-order',
    times: 5,
    project: 'chromium',
  });
  assert.equal(ordered.includes('-g'), false);
  assert.equal(ordered.includes('--repeat-each'), false);
  assert.equal(ordered.includes('--retries'), true);
  assert.equal(ordered.at(-2), '--');
  assert.equal(ordered.at(-1), '/^tests\\/order\\.spec\\.ts$/');

  const dashed = buildPlaywrightArgs({
    file: '-weird.spec.ts',
    titlePath: ['t'],
    mode: 'isolated',
    times: 1,
    project: 'chromium',
  });
  const dashedAt = dashed.indexOf('--');
  assert.ok(dashedAt > dashed.indexOf('-g'));
  assert.equal(dashed[dashedAt + 1].includes('-weird'), true);
  assert.equal(dashed[dashedAt + 1].startsWith('/^'), true);

  assert.throws(
    () => buildPlaywrightArgs({ file: 'a.spec.ts', mode: 'repeat', times: 1, project: 'a*' }),
    /wildcard/,
  );
});

test('file:line is used only when the line is unique for the file and project', () => {
  const row = (title, line, outcome = 'failed') => {
    const item = record(title, [attempt(outcome === 'passed' ? 'passed' : 'failed', outcome === 'passed' ? undefined : VALUE)]);
    item.id = `each.spec.ts::chromium::${title}`;
    item.file = 'each.spec.ts';
    item.titlePath = [title];
    item.line = line;
    item.outcome = outcome;
    return item;
  };
  const shared = planReruns([row('row 1', 2), row('row 2', 2), row('row 3', 2)], {
    times: 1,
    modes: ['isolated'],
    only: ['each.spec.ts::chromium::row 1'],
  });
  assert.equal(shared.runs.length, 1);
  assert.equal(shared.runs[0].line, undefined);
  assert.equal(shared.runs[0].args.includes('-g'), true);
  assert.equal(shared.runs[0].args.at(-1).includes(':2'), false);

  const passing = row('neighbor', 4, 'passed');
  const blocked = planReruns([row('only', 4), passing], { times: 1, modes: ['isolated'] });
  assert.equal(blocked.runs.length, 1);
  assert.equal(blocked.runs[0].args.includes('-g'), true);

  const alone = row('only', 4);
  const otherLine = row('later', 9, 'passed');
  const unique = planReruns([alone, otherLine], { times: 1, modes: ['isolated'] });
  assert.equal(unique.runs[0].line, 4);
  assert.equal(unique.runs[0].args.includes('-g'), false);
  assert.equal(unique.runs[0].args.at(-1).endsWith(':4'), true);

  const firefox = row('only', 4);
  firefox.project = 'firefox';
  firefox.id = 'each.spec.ts::firefox::only';
  const byProject = planReruns([alone, firefox], { times: 1, modes: ['isolated'] });
  assert.equal(byProject.runs.every((run) => run.line === 4 && run.args.at(-1).endsWith(':4')), true);
});

test('a newline in a title is a newline escape in the grep', () => {
  const pattern = anchoredGrep('chromium', 'tests/a.spec.ts', ['row\n2']);
  assert.equal(pattern.includes('\n'), false);
  assert.match(pattern, /row\\n2/);
  const expression = new RegExp(pattern.slice(1, -1));
  assert.equal(expression.test('chromium tests/a.spec.ts row\n2'), true);
  assert.equal(expression.test('chromium tests/a.spec.ts row 2'), false);
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
  assert.equal(args.some((part) => part.includes('alice')), true);
  const printed = formatPrintedCommand(args, item);
  assert.equal(printed.includes("'-g'"), false);
  assert.match(printed, /the title was redacted, so -g is omitted here/);
  assert.equal(printed.includes('alice'), false);
});

test('a printed file filter hides a POSIX or Windows home', () => {
  const filters = [
    [String.raw`/^\/home\/bob\/p\/a\.spec\.ts$/:3`, String.raw`/^\/<home>\/p\/a\.spec\.ts$/:3`],
    [String.raw`/^\/home\/bob\/p\/a\.spec\.ts$/`, String.raw`/^\/<home>\/p\/a\.spec\.ts$/`],
    [String.raw`/^C:\/Users\/bob\/p\/a\.spec\.ts$/:3`, String.raw`/^<home>\/p\/a\.spec\.ts$/:3`],
    [String.raw`/^C:\/Users\/bob\/p\/a\.spec\.ts$/`, String.raw`/^<home>\/p\/a\.spec\.ts$/`],
  ];
  for (const [filter, expected] of filters) {
    const printed = formatPrintedCommand(['--retries', '0', '--', filter]);
    assert.equal(printed.includes('bob'), false, printed);
    assert.equal(printed.includes(`'${expected}'`), true, printed);
    assert.equal(printed.includes(expected.replaceAll('\\', '')), false);
  }
  const weird = exactFileArg('/home/bob/we ird[1]+(x)/m.spec.ts');
  const printedWeird = formatPrintedCommand(['--', weird]);
  const expectedWeird = weird.replace(String.raw`\/home\/bob\/`, String.raw`\/<home>\/`);
  assert.equal(printedWeird, `'--' '${expectedWeird}'`);
  assert.equal(printedWeird.includes('bob'), false);
  assert.match(printedWeird, /m\\\.spec\\\.ts/);
  assert.match(printedWeird, /\\\[1\\\]/);
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
  assert.equal(seen[0].includes('npx'), false);
  assert.match(seen[0], /--retries/);
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

test('stopping a rerun deletes the temp directory after the kill', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-flaky-stop-'));
  fs.writeFileSync(path.join(dir, 'note.txt'), 'x');
  let killed = 0;
  const state = {
    pid: 4242,
    dir,
    kill: () => {
      killed += 1;
      throw new Error('already gone');
    },
  };
  await Promise.all([releaseRun(state), releaseRun(state)]);
  assert.equal(killed, 1);
  assert.equal(fs.existsSync(dir), false);
  await releaseRun(state);
  assert.equal(killed, 1);

  const again = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-flaky-signal-'));
  let raised;
  await onStopSignal('SIGTERM', () => releaseRun({ dir: again }), (signal) => {
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
  source.line = 21;
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

test('anchored grep is case sensitive and allows trailing tags', () => {
  const save = compileGrep(anchoredGrep('chromium', 'tests/a.spec.ts', ['save']));
  assert.equal(save.test('chromium tests/a.spec.ts save'), true);
  assert.equal(save.test('chromium tests/a.spec.ts save @smoke'), true);
  assert.equal(save.test('chromium tests/a.spec.ts autosave'), false);
  const login = compileGrep(anchoredGrep('chromium', 'tests/login.spec.ts', ['Login']));
  assert.equal(login.test('chromium tests/login.spec.ts Login'), true);
  assert.equal(login.test('chromium tests/login.spec.ts login'), false);
  const grouped = compileGrep(anchoredGrep('chromium', 'tests/a.spec.ts', ['suite', 'save']));
  assert.equal(grouped.test('chromium tests/a.spec.ts suite @grp save @smoke'), true);
  assert.equal(grouped.test('chromium tests/a.spec.ts suite save'), true);
  const file = compileGrep(exactFileArg('/workspace/tests/login.spec.ts'));
  assert.equal(file.test('/workspace/tests/login.spec.ts'), true);
  assert.equal(file.test('/workspace/old/tests/login.spec.ts'), false);
});

test('the next step keeps a recorded config', () => {
  assert.equal(
    shellCommand('a.json', 'id', 'playwright.config.ts'),
    "qa-core-flaky rerun --from 'a.json' --only 'id' --config 'playwright.config.ts'",
  );
});

test('times, max-tests, command count, and duplicate modes are capped', () => {
  const item = record('same value', [attempt('failed', VALUE)]);
  assert.throws(() => planReruns([item], { times: 1000000 }), /times must be from 1 to 20\. Got 1000000/);
  assert.throws(() => planReruns([item], { maxTests: 1000000 }), /max-tests must be from 1 to 50\. Got 1000000/);
  assert.throws(() => planReruns([item], { modes: ['repeat', 'repeat'] }), /Duplicate mode repeat/);
  const many = Array.from({ length: 21 }, (_item, index) => record(`t${index}`, [attempt('failed', VALUE)]));
  assert.throws(
    () => planReruns(many, { times: 20, maxTests: 50, modes: ['isolated'] }),
    /The plan has 420 commands\. The limit is 400/,
  );
});

test('an isolated report that is not exactly the requested test is recorded and the rerun continues', async () => {
  const reader = orderReader();
  const other = record('other', [attempt('failed', 'Error: gave up')]);
  const plan = planReruns([reader, other], { times: 1, modes: ['isolated'] });
  let calls = 0;
  const merged = await executePlan({
    records: [reader, other],
    plan,
    cwd: process.cwd(),
    print: () => {},
    runner: async (_args, _cwd, stdoutFile) => {
      calls += 1;
      if (calls === 1) {
        fs.copyFileSync('fixtures/reports/rerun/in-order-pass.json', stdoutFile);
        return { code: 0, stderr: '' };
      }
      fs.writeFileSync(stdoutFile, oneResult('tests/a.spec.ts', 'other', 'failed'));
      return { code: 1, stderr: '' };
    },
  });
  assert.equal(calls, 2);
  const reason = merged.find((item) => item.id === reader.id).attempts.at(-1);
  assert.equal(reason.status, 'unselectable');
  assert.equal(reason.rerun.mode, 'isolated');
  assert.match(reason.errors[0].message, /Could not select this test/);
  assert.match(reason.errors[0].message, /did not run exactly that test/);
  assert.match(reason.errors[0].message, /Playwright exited with code 0/);
  const kept = merged.find((item) => item.id === other.id);
  assert.equal(kept.attempts.some((item) => item.rerun?.mode === 'isolated' && item.status === 'failed'), true);
  assert.equal(buildTriageReport(merged).entries.length >= 2, true);
});

test('a child that exits 0 after running nothing is recorded', async () => {
  const item = record('tagged', [attempt('failed', VALUE)]);
  const plan = planReruns([item], { times: 1, modes: ['isolated'] });
  const merged = await executePlan({
    records: [item],
    plan,
    cwd: process.cwd(),
    print: () => {},
    runner: async (_args, _cwd, stdoutFile) => {
      fs.writeFileSync(stdoutFile, '{"suites":[]}\n');
      return { code: 0, stderr: 'No tests found\n' };
    },
  });
  assert.equal(merged[0].attempts.at(-1).status, 'unselectable');
  const message = merged[0].attempts.at(-1).errors[0].message;
  assert.match(message, /Could not select this test/);
  assert.match(message, /did not run exactly that test/);
  assert.match(message, /Playwright exited with code 0/);
  assert.match(message, /No tests found/);
  assert.equal(buildTriageReport(merged).entries.length, 1);
});

test('a wrong attempt count is recorded and the original attempts stay', async () => {
  const item = record('same value', [attempt('failed', VALUE)]);
  const plan = planReruns([item], { times: 2, modes: ['repeat'] });
  const merged = await executePlan({
    records: [item],
    plan,
    cwd: process.cwd(),
    print: () => {},
    runner: copyRunner('fixtures/reports/rerun/repeat-pass.json'),
  });
  assert.equal(merged[0].attempts[0].rerun, undefined);
  assert.equal(merged[0].attempts.at(-1).status, 'unselectable');
  assert.match(merged[0].attempts.at(-1).errors[0].message, /expected 2 attempts/);
  assert.equal(merged[0].attempts.at(-1).rerun.mode, 'repeat');
});

test('an unselectable rerun does not change the verdict or the cause', () => {
  const original = record('same value', [attempt('failed', VALUE), attempt('failed', VALUE, 1), attempt('failed', VALUE, 2)], {
    commitSha: 'abc',
  });
  const before = buildTriageReport([original]);
  const onlyGap = record('same value', [...original.attempts], { commitSha: 'abc' });
  for (let index = 0; index < 3; index += 1) {
    onlyGap.attempts.push(
      attempt('unselectable', 'Could not select this test. isolated rerun did not run exactly that test.', 0, {
        mode: 'isolated',
        runIndex: index,
      }),
    );
  }
  const gapOnlyReport = buildTriageReport([onlyGap]);
  assert.equal(gapOnlyReport.entries[0].verdict, before.entries[0].verdict);
  assert.equal(gapOnlyReport.entries[0].ruleId, before.entries[0].ruleId);
  assert.equal(JSON.stringify(gapOnlyReport.entries[0].causes), JSON.stringify(before.entries[0].causes));
  assert.equal(gapOnlyReport.entries[0].observation, undefined);
  assert.equal(gapOnlyReport.entries[0].attempts.total, 3);
  assert.match(renderTriageMarkdown(gapOnlyReport), /isolated not run 3: could not select/);
  const withGap = record('same value', [...original.attempts], { commitSha: 'abc' });
  for (let index = 0; index < 3; index += 1) {
    withGap.attempts.push(
      attempt('unselectable', 'Could not select this test. isolated rerun did not run exactly that test.', 0, {
        mode: 'isolated',
        runIndex: index,
      }),
    );
  }
  withGap.attempts.push(attempt('passed', undefined, 0, { mode: 'in-order', runIndex: 0 }));
  const passedOnly = record('same value', [...original.attempts, attempt('passed', undefined, 0, { mode: 'in-order', runIndex: 0 })], {
    commitSha: 'abc',
  });
  const gapReport = buildTriageReport([withGap]);
  const passedReport = buildTriageReport([passedOnly]);
  assert.equal(gapReport.entries[0].verdict, passedReport.entries[0].verdict);
  assert.equal(gapReport.entries[0].ruleId, passedReport.entries[0].ruleId);
  assert.equal(gapReport.entries[0].causes[0]?.cause, passedReport.entries[0].causes[0]?.cause);
  assert.equal(JSON.stringify(gapReport.entries[0].causes), JSON.stringify(passedReport.entries[0].causes));
  assert.equal(gapReport.entries[0].causes.some((finding) => finding.ruleIds.includes('DATA-ORDER')), false);
  const markdown = renderTriageMarkdown(gapReport);
  assert.match(markdown, /isolated not run 3: could not select/);
  assert.equal(markdown.includes('DATA-ORDER'), false);
  assert.equal(before.entries[0].verdict, 'likely-real-bug');
  const observed = record(
    'same value',
    [
      attempt('failed', VALUE),
      attempt('passed', undefined, 0, { mode: 'isolated', runIndex: 0 }),
      attempt('passed', undefined, 0, { mode: 'isolated', runIndex: 1 }),
      attempt('unselectable', 'Could not select this test.', 0, { mode: 'isolated', runIndex: 2 }),
    ],
    { commitSha: 'abc' },
  );
  const observedReport = buildTriageReport([observed]);
  assert.equal(observedReport.entries[0].observation, 'no flake observed in 2 runs');
  assert.match(renderTriageMarkdown(observedReport), /isolated total 2, failed 0, passed 2; isolated not run 1: could not select/);
  assert.equal(observedReport.entries[0].attempts.total, 3);
});

test('only accepts a newline written as a backslash n', () => {
  const item = record('line\nbreak', [attempt('failed', VALUE)]);
  const escaped = item.id.replaceAll('\n', '\\n');
  const plan = planReruns([item], { only: [escaped], modes: ['isolated'], times: 1 });
  assert.equal(plan.tests.length, 1);
  assert.equal(plan.tests[0].id, item.id);
  const markdown = renderTriageMarkdown(buildTriageReport([item]));
  const next = markdown.split('\n').find((line) => line.includes('qa-core-flaky rerun'));
  assert.match(next, /line\\nbreak/);
});

test('a selection failure hides a home and still runs the next test', async () => {
  const item = record('reads /home/bob/data.csv', [attempt('failed', VALUE)]);
  const other = record('other', [attempt('failed', 'Error: gave up')]);
  const plan = planReruns([item, other], { times: 1, modes: ['isolated'] });
  const lines = [];
  let calls = 0;
  const merged = await executePlan({
    records: [item, other],
    plan,
    cwd: process.cwd(),
    print: (line) => lines.push(line),
    runner: async (_args, _cwd, stdoutFile) => {
      calls += 1;
      if (calls === 1) {
        fs.writeFileSync(stdoutFile, '{"suites":[]}\n');
        return { code: 0, stderr: 'No tests found in /home/bob/data.csv\n' };
      }
      fs.writeFileSync(stdoutFile, oneResult('tests/a.spec.ts', 'other', 'failed'));
      return { code: 1, stderr: '' };
    },
  });
  const reason = merged.find((entry) => entry.id === item.id).attempts.at(-1).errors[0].message;
  assert.equal(reason.includes('bob'), false);
  assert.match(reason, /<home>/);
  assert.match(reason, /Could not select this test/);
  assert.equal(lines.join('\n').includes('bob'), false);
  assert.equal(merged.find((entry) => entry.id === other.id).attempts.some((attemptRow) => attemptRow.rerun), true);
});

test('printed paths and errors do not contain the username from the title', async () => {
  const item = record('reads /home/bob/data.csv', [attempt('failed', VALUE)]);
  const plan = planReruns([item], { times: 1, modes: ['isolated'] });
  const seen = [];
  await assert.rejects(
    executePlan({
      records: [item],
      plan,
      cwd: process.cwd(),
      print: (line) => seen.push(line),
      runner: async (args, _cwd, stdoutFile) => {
        assert.match(path.basename(stdoutFile), /^report-\d+\.json$/);
        assert.equal(stdoutFile.includes('bob'), false);
        assert.equal(stdoutFile.includes('data.csv'), false);
        const output = args[args.indexOf('--output') + 1];
        assert.match(path.basename(output), /^out-\d+$/);
        assert.equal(output.includes('bob'), false);
        fs.writeFileSync(stdoutFile, '{');
        return { code: 1, stderr: 'Error: cannot open /home/bob/data.csv\n' };
      },
    }),
    (error) => {
      assert.equal(error.message.includes('bob'), false);
      assert.match(error.message, /<home>/);
      assert.match(error.message, /Playwright exited with code 1/);
      assert.match(error.message, /rerun-report\.json/);
      assert.equal(error.message.includes('reads_home_bob'), false);
      return true;
    },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].includes('bob'), false);
  assert.match(seen[0], /the title was redacted, so -g is omitted here/);
});

test('a missing local Playwright is reported as itself', async () => {
  const item = record('same value', [attempt('failed', VALUE)]);
  const plan = planReruns([item], { times: 1, modes: ['repeat'] });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-flaky-nopw-'));
  fs.mkdirSync(path.join(cwd, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'tests', 'a.spec.ts'), 'test\n');
  try {
    await assert.rejects(
      executePlan({
        records: [item],
        plan,
        cwd,
        print: () => {},
      }),
      /Local Playwright was not found/,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('EPIPE during print still removes the temp directory', async () => {
  const item = record('same value', [attempt('failed', VALUE)]);
  const plan = planReruns([item], { times: 5, modes: ['repeat'] });
  let dir;
  const broken = new Error('broken pipe');
  broken.code = 'EPIPE';
  await executePlan({
    records: [item],
    plan,
    cwd: process.cwd(),
    print: () => {
      throw broken;
    },
    runner: async (_args, _cwd, stdoutFile) => {
      dir = path.dirname(stdoutFile);
      fs.copyFileSync('fixtures/reports/rerun/repeat-pass.json', stdoutFile);
      return { code: 0, stderr: '' };
    },
  });
  assert.equal(fs.existsSync(dir), false);

  const stream = new EventEmitter();
  guardPipe(stream);
  stream.emit('error', broken);
});

test('a stop signal leaves no profile and no child', { skip: process.platform !== 'linux' }, async () => {
  const parentTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-flaky-parent-'));
  const saved = {
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
  };
  try {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const dir = fs.mkdtempSync(path.join(parentTmp, 'rerun-'));
      const script = path.join(dir, 'hold.mjs');
      const pidFile = path.join(parentTmp, 'pids.txt');
      fs.writeFileSync(script, HOLD_SCRIPT);
      process.env.TMPDIR = parentTmp;
      process.env.TMP = parentTmp;
      process.env.TEMP = parentTmp;
      process.env.PID_FILE = pidFile;
      let child;
      try {
      child = launchRerunChild({
        command: process.execPath,
        args: [script],
        cwd: dir,
        dir,
      });
      if (saved.TMPDIR === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved.TMPDIR;
      if (saved.TMP === undefined) delete process.env.TMP;
      else process.env.TMP = saved.TMP;
      if (saved.TEMP === undefined) delete process.env.TEMP;
      else process.env.TEMP = saved.TEMP;
      delete process.env.PID_FILE;
      await waitFor(() => fs.existsSync(pidFile) && profileCount(path.join(dir, 'tmp')) > 0);
      const pids = fs.readFileSync(pidFile, 'utf8').trim().split('\n').map((line) => Number(line));
      fs.rmSync(pidFile, { force: true });
      assert.equal(pids.length, 2);
      assert.equal(pids.every((pid) => Number.isInteger(pid) && pid > 0), true);
      assert.equal(typeof child.pid, 'number');
      await onStopSignal(signal, () => releaseRun({ pid: child.pid, dir }), () => {});
      await waitForClose(child);
      await waitFor(() => pids.every((pid) => !fs.existsSync(`/proc/${pid}`)));
      assert.equal(fs.existsSync(dir), false);
      assert.deepEqual(fs.readdirSync(parentTmp), []);
      for (const pid of pids) {
        assert.equal(fs.existsSync(`/proc/${pid}`), false, `pid ${pid} still in /proc after ${signal}`);
      }
      } finally {
        if (child?.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            // The process group is already gone.
          }
        }
      }
    }
  } finally {
    if (saved.TMPDIR === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved.TMPDIR;
    if (saved.TMP === undefined) delete process.env.TMP;
    else process.env.TMP = saved.TMP;
    if (saved.TEMP === undefined) delete process.env.TEMP;
    else process.env.TEMP = saved.TEMP;
    delete process.env.PID_FILE;
    fs.rmSync(parentTmp, { recursive: true, force: true });
  }
});

const HOLD_SCRIPT = `import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    process.exit(0);
  });
}
const tmp = process.env.TMPDIR;
fs.mkdirSync(path.join(tmp, 'playwright_chromiumdev_profile-' + process.pid), { recursive: true });
const out = path.join(tmp, 'out-0');
fs.mkdirSync(out, { recursive: true });
const artifact = path.join(out, 'error-context.md');
const grand = spawn(process.execPath, ['-e', 'const fs=require("node:fs"); const path=require("node:path"); for (const signal of ["SIGINT","SIGTERM","SIGHUP"]) process.on(signal, () => {}); const file=process.env.ARTIFACT; setInterval(() => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, String(Date.now())); } catch (error) {} }, 15);'], {
  detached: false,
  stdio: 'ignore',
  env: { ...process.env, ARTIFACT: artifact },
});
fs.writeFileSync(process.env.PID_FILE, process.pid + '\\n' + grand.pid + '\\n');
setInterval(() => {}, 1000);
`;

function oneResult(file, title, status) {
  return `${JSON.stringify({
    config: { rootDir: '.' },
    suites: [
      {
        title: file,
        file,
        specs: [
          {
            title,
            ok: status === 'passed',
            tests: [
              {
                projectName: 'chromium',
                expectedStatus: 'passed',
                status: status === 'passed' ? 'expected' : 'unexpected',
                results: [
                  {
                    retry: 0,
                    status,
                    duration: 3,
                    errors: status === 'failed' ? [{ message: 'Error: gave up' }] : [],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  })}\n`;
}

function compileGrep(pattern) {
  assert.equal(pattern.startsWith('/'), true);
  assert.equal(pattern.endsWith('/'), true);
  return new RegExp(pattern.slice(1, -1));
}

function orderReader() {
  return {
    id: 'tests/order.spec.ts::chromium::order reader expects the marker',
    file: 'tests/order.spec.ts',
    project: 'chromium',
    titlePath: ['order reader expects the marker'],
    expectedStatus: 'passed',
    outcome: 'failed',
    attempts: [attempt('failed', 'Error: marker missing')],
    source: { format: 'playwright-json', reportPath: 'order.json', commitSha: 'abc' },
  };
}

function profileCount(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((name) => name.startsWith('playwright_chromiumdev_profile-')).length;
}

function waitFor(ready, ms = 2000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (ready()) {
        resolve();
        return;
      }
      if (Date.now() - start > ms) {
        reject(new Error('timed out waiting for the child'));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

test(
  'a stop signal during a browser run leaves no files and no processes',
  { skip: process.env.QA_CORE_FLAKY_SIGNALS !== '1' || process.platform !== 'linux', timeout: 600_000 },
  async () => {
    const signals = [
      ['SIGINT', 130],
      ['SIGTERM', 143],
      ['SIGHUP', 129],
    ];
    for (const [signal, code] of signals) {
      for (let time = 0; time < 5; time += 1) {
        await runSignalProbe(signal, code);
      }
    }
  },
);

async function runSignalProbe(signal, expected) {
  const privateTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-flaky-sigtmp-'));
  const project = path.join(process.cwd(), `.signal-probe-${process.pid}-${signal}`);
  const stdout = [];
  const stderr = [];
  let child;
  try {
    fs.rmSync(project, { recursive: true, force: true });
    fs.mkdirSync(path.join(project, 'tests'), { recursive: true });
    const spec = [
      "import { test } from '@playwright/test';",
      "import fs from 'node:fs';",
      '',
      "test('slow artifact', async ({ page }, testInfo) => {",
      "  await page.setContent('<main>slow</main>');",
      "  const file = testInfo.outputPath('error-context.md');",
      '  fs.mkdirSync(testInfo.outputDir, { recursive: true });',
      "  fs.writeFileSync(file, 'context');",
      '  const timer = setInterval(() => {',
      '    try { fs.writeFileSync(file, String(Date.now())); } catch (error) {}',
      '  }, 20);',
      '  try {',
      '    await page.waitForTimeout(25000);',
      '  } finally {',
      '    clearInterval(timer);',
      '  }',
      '});',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(project, 'tests', 'slow.spec.ts'), spec);
    const config = [
      "import { defineConfig, devices } from '@playwright/test';",
      'export default defineConfig({',
      '  retries: 0,',
      '  workers: 1,',
      '  timeout: 60000,',
      "  testMatch: ['**/slow.spec.ts'],",
      "  outputDir: 'test-results',",
      '  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],',
      '});',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(project, 'playwright.config.ts'), config);
    const reportPath = path.join(project, 'report.json');
    fs.writeFileSync(
      reportPath,
      `${JSON.stringify({
        config: { rootDir: project },
        suites: [
          {
            title: 'tests/slow.spec.ts',
            file: 'tests/slow.spec.ts',
            specs: [
              {
                title: 'slow artifact',
                ok: false,
                line: 4,
                tests: [
                  {
                    projectName: 'chromium',
                    expectedStatus: 'passed',
                    status: 'unexpected',
                    results: [{ retry: 0, status: 'failed', duration: 1, errors: [{ message: 'Error: slow' }] }],
                  },
                ],
              },
            ],
          },
        ],
      })}\n`,
    );
    const configPath = path.join(project, 'playwright.config.ts');
    child = spawn(
      process.execPath,
      [
        path.join(process.cwd(), 'dist', 'cli.js'),
        'rerun',
        '--from',
        reportPath,
        '--only',
        'tests/slow.spec.ts::chromium::slow artifact',
        '--modes',
        'isolated',
        '--times',
        '1',
        '--config',
        configPath,
        '--fail-on',
        'never',
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TMPDIR: privateTmp,
          TMP: privateTmp,
          TEMP: privateTmp,
          NODE_DISABLE_COMPILE_CACHE: '1',
        },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout.on('data', (chunk) => stdout.push(chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')));
    await waitFor(() => findNamed(privateTmp, 'error-context.md'), 40000);
    await delayMs(200);
    process.kill(child.pid, signal);
    const status = await waitExit(child, 20000);
    const err = stderr.join('');
    assert.equal(status, expected, `${signal} exit ${status}\n${err}\n${stdout.join('')}`);
    assert.equal(err.includes('ENOTEMPTY'), false, err);
    assert.equal(err.includes('Playwright wrote no JSON report'), false, err);
    assert.equal(/at releaseRun|UnhandledPromiseRejection|Error: ENOTEMPTY/.test(err), false, err);
    assert.equal(stdout.join('').includes('schemaVersion'), false);
    await waitFor(() => !fs.existsSync(`/proc/${child.pid}`) && pidsUsing(privateTmp).length === 0, 5000);
    assert.deepEqual(fs.readdirSync(privateTmp), []);
    assert.deepEqual(pidsUsing(privateTmp), []);
  } finally {
    if (child?.pid) {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        // The rerun process is already gone.
      }
      for (const pid of pidsUsing(privateTmp)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // That process is already gone.
        }
      }
    }
    fs.rmSync(privateTmp, { recursive: true, force: true, maxRetries: 5 });
    fs.rmSync(project, { recursive: true, force: true, maxRetries: 5 });
  }
}

function findNamed(dir, name) {
  if (!fs.existsSync(dir)) return false;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === name) return true;
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
    }
  }
  return false;
}

function pidsUsing(dir) {
  if (process.platform !== 'linux') return [];
  const found = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cwd = fs.readlinkSync(`/proc/${name}/cwd`);
      const cmd = fs.readFileSync(`/proc/${name}/cmdline`).toString('utf8');
      if (cwd.startsWith(dir) || cmd.includes(dir)) found.push(Number(name));
    } catch {
      // The process exited, or its cwd is not readable.
    }
  }
  return found;
}

function waitExit(child, ms) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rerun still running')), ms);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function delayMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child still running')), 2000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
