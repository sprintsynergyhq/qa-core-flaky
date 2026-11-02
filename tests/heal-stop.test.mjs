import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  HEAL_STOP_SIGNALS,
  HEAL_TEMP_PREFIX,
  bindHealChild,
  bindHealTempDir,
  healStopExitCode,
  installHealStopHandlers,
  onHealProcessExit,
  removeHealStopHandlers,
  removeHealTemp,
  stopHealRun,
  stoppedBySignal,
} from '../dist/heal/run.js';

// What a stop signal does during `triage --heal`. Abdul Rafay found on
// Windows that Ctrl+C left %TEMP%\qa-core-flaky-heal-* behind, sometimes with
// a browser profile and a heal trace inside.

const cli = path.resolve('dist/cli.js');
const fake = path.resolve('tests/fake-heal.mjs');
const recorded = path.resolve('demo/saucedemo/reports/recorded-seed-443.json');

function keepTemp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A folder shaped like the one Abdul found: a browser profile and a heal trace under tmp. */
function healTempLike(root) {
  const dir = fs.mkdtempSync(path.join(root, HEAL_TEMP_PREFIX));
  const profile = path.join(dir, 'tmp', 'playwright_chromiumdev_profile-abc', 'Default');
  const trace = path.join(dir, 'tmp', 'qa-core-heal-out-xyz', 'first', 'cart-chromium');
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(trace, { recursive: true });
  fs.writeFileSync(path.join(profile, 'Cookies'), 'session');
  fs.writeFileSync(path.join(trace, 'trace.zip'), Buffer.alloc(1024, 1));
  fs.writeFileSync(path.join(dir, 'heal-findings.json'), '{}');
  return dir;
}

function reset() {
  removeHealStopHandlers();
}

test('stop signals map to exit codes, and Ctrl+Break exits like Ctrl+C', () => {
  assert.equal(healStopExitCode('SIGINT'), 130);
  assert.equal(healStopExitCode('SIGBREAK'), 130);
  assert.equal(healStopExitCode('SIGTERM'), 143);
  assert.equal(healStopExitCode('SIGHUP'), 129);
  assert.deepEqual([...HEAL_STOP_SIGNALS], ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']);
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  test(`${signal}: the stop handler stops the child tree first, then removes the folder, then exits`, async (t) => {
    t.after(reset);
    const root = keepTemp(t, 'heal-stop-unit-');
    const dir = healTempLike(root);
    const child = { pid: 424242 };
    const steps = [];
    bindHealChild(child);
    bindHealTempDir(dir);
    const code = await stopHealRun(signal, {
      stopTree: async (got) => {
        assert.equal(got, child);
        assert.equal(fs.existsSync(dir), true, 'the folder is removed only after the tree is stopped');
        steps.push('stop');
      },
      exit: (value) => steps.push(`exit ${value}`),
    });
    assert.equal(code, healStopExitCode(signal));
    assert.deepEqual(steps, ['stop', `exit ${healStopExitCode(signal)}`]);
    assert.equal(fs.existsSync(dir), false, dir);
  });
}

test('a second stop signal while the first is running does nothing', async (t) => {
  t.after(reset);
  const root = keepTemp(t, 'heal-stop-twice-');
  const dir = healTempLike(root);
  bindHealChild({ pid: 424242 });
  bindHealTempDir(dir);
  let release;
  const exits = [];
  const first = stopHealRun('SIGINT', {
    stopTree: () => new Promise((resolve) => (release = resolve)),
    exit: (value) => exits.push(value),
  });
  assert.equal(await stopHealRun('SIGINT', { exit: (value) => exits.push(value) }), null);
  release();
  assert.equal(await first, 130);
  assert.deepEqual(exits, [130]);
  assert.equal(fs.existsSync(dir), false);
});

test('the folder is removed when stopping the tree fails or hangs', async (t) => {
  t.after(reset);
  const root = keepTemp(t, 'heal-stop-fail-');
  const failed = healTempLike(root);
  bindHealChild({ pid: 424242 });
  bindHealTempDir(failed);
  assert.equal(
    await stopHealRun('SIGINT', {
      stopTree: async () => {
        throw new Error('taskkill failed');
      },
      exit: () => {},
    }),
    130,
  );
  assert.equal(fs.existsSync(failed), false);
  reset();
  const hung = healTempLike(root);
  bindHealChild({ pid: 424242 });
  bindHealTempDir(hung);
  const started = Date.now();
  assert.equal(await stopHealRun('SIGTERM', { stopTree: () => new Promise(() => {}), exit: () => {}, killWaitMs: 200 }), 143);
  assert.ok(Date.now() - started < 5_000);
  assert.equal(fs.existsSync(hung), false);
});

test('cleanup removes only qa-core-flaky-heal-* folders and never test files or reports', (t) => {
  const root = keepTemp(t, 'heal-stop-guard-');
  const tests = path.join(root, 'tests');
  const reports = path.join(root, 'reports');
  fs.mkdirSync(tests);
  fs.mkdirSync(reports);
  fs.writeFileSync(path.join(tests, 'cart.spec.ts'), 'test');
  fs.writeFileSync(path.join(reports, 'run-1.json'), '{}');
  assert.equal(removeHealTemp(tests), false);
  assert.equal(removeHealTemp(reports), false);
  assert.equal(removeHealTemp(root), false);
  assert.equal(removeHealTemp(`${HEAL_TEMP_PREFIX}relative`), false);
  assert.equal(removeHealTemp(null), true);
  assert.equal(fs.readFileSync(path.join(tests, 'cart.spec.ts'), 'utf8'), 'test');
  assert.equal(fs.readFileSync(path.join(reports, 'run-1.json'), 'utf8'), '{}');
  assert.equal(removeHealTemp(path.join(root, `${HEAL_TEMP_PREFIX}missing`)), true);
});

test('cleanup asks for retries so a Windows file lock does not leave the folder behind', (t) => {
  const root = keepTemp(t, 'heal-stop-retry-');
  const dir = healTempLike(root);
  let seen;
  assert.equal(
    removeHealTemp(dir, (target, options) => {
      seen = options;
      fs.rmSync(target, options);
    }),
    true,
  );
  assert.equal(seen.recursive, true);
  assert.equal(seen.force, true);
  assert.ok(seen.maxRetries >= 5, JSON.stringify(seen));
  assert.ok(seen.retryDelay >= 50, JSON.stringify(seen));
});

test('a folder that stays locked is removed again when the process exits', (t) => {
  t.after(reset);
  const root = keepTemp(t, 'heal-stop-exit-');
  const dir = healTempLike(root);
  const busy = () => {
    throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
  };
  assert.equal(removeHealTemp(dir, busy), false);
  assert.equal(fs.existsSync(dir), true);
  onHealProcessExit();
  assert.equal(fs.existsSync(dir), false);
  const bound = healTempLike(root);
  bindHealTempDir(bound);
  onHealProcessExit();
  assert.equal(fs.existsSync(bound), false);
});

test('the stop handlers cover SIGINT, SIGTERM, SIGHUP, SIGBREAK, and exit, and are removed after the run', (t) => {
  t.after(reset);
  const before = Object.fromEntries([...HEAL_STOP_SIGNALS, 'exit'].map((name) => [name, process.listenerCount(name)]));
  installHealStopHandlers();
  installHealStopHandlers();
  for (const signal of HEAL_STOP_SIGNALS) assert.equal(process.listenerCount(signal), before[signal] + 1, signal);
  const exitAfterInstall = process.listenerCount('exit');
  assert.ok(exitAfterInstall <= before.exit + 1);
  removeHealStopHandlers();
  for (const signal of HEAL_STOP_SIGNALS) assert.equal(process.listenerCount(signal), before[signal], signal);
  installHealStopHandlers();
  assert.equal(process.listenerCount('exit'), exitAfterInstall, 'the exit handler is added once');
});

// Integration: the real CLI with a slow stand-in heal that holds a browser
// profile and a trace open. TMPDIR, TMP, and TEMP point at a private folder,
// so any qa-core-flaky-heal-* left behind is easy to see.

async function interruptTriage(t, { healSigint }) {
  const root = keepTemp(t, 'heal-stop-cli-');
  const tmp = path.join(root, 'tmp');
  const outDir = path.join(root, 'handoff');
  const note = path.join(root, 'note');
  fs.mkdirSync(tmp);
  const reportCopy = path.join(root, 'run-1.json');
  fs.copyFileSync(recorded, reportCopy);
  const reportBytes = fs.readFileSync(reportCopy);
  const child = spawn(process.execPath, [cli, 'triage', reportCopy, '--out-dir', outDir, '--heal', '--fail-on', 'never'], {
    env: {
      ...process.env,
      TMPDIR: tmp,
      TMP: tmp,
      TEMP: tmp,
      QA_CORE_HEAL_BIN: fake,
      FAKE_HEAL_MODE: 'slow-browser',
      FAKE_HEAL_SIGINT: healSigint,
      FAKE_HEAL_TEMP_NOTE: note,
      QA_CORE_HEAL_TIMEOUT_MS: '60000',
    },
    detached: true,
    stdio: 'ignore',
  });
  const pids = () => (fs.existsSync(note) ? fs.readFileSync(note, 'utf8').split('\n') : []);
  t.after(() => {
    for (const pid of [child.pid, Number(pids()[2]), Number(pids()[4])]) {
      if (!pid) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && pids().length < 5) await new Promise((resolve) => setTimeout(resolve, 30));
  const [flakyDir, healOut, writerPid, profile, healPid] = pids();
  assert.ok(flakyDir && healOut && profile && healPid, 'the stand-in did not reach the findings command');
  assert.equal(path.dirname(flakyDir), tmp);
  assert.equal(path.basename(flakyDir).startsWith(HEAL_TEMP_PREFIX), true, flakyDir);
  assert.equal(profile.startsWith(path.join(flakyDir, 'tmp') + path.sep), true, profile);
  assert.equal(healOut.startsWith(path.join(flakyDir, 'tmp') + path.sep), true, healOut);
  // Let the browser stand-in write for a moment, like Ctrl+C 10 to 15 seconds in.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const started = Date.now();
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  if (healSigint === 'exit') {
    // A Windows console sends Ctrl+C to every process in it, heal included.
    // Heal can exit before this tool sees its own SIGINT.
    process.kill(Number(healPid), 'SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  process.kill(child.pid, 'SIGINT');
  const code = await exited;
  const seconds = (Date.now() - started) / 1000;
  const left = fs.readdirSync(tmp).filter((name) => name.startsWith(HEAL_TEMP_PREFIX));
  assert.deepEqual(left, [], `left in TEMP: ${left.join(', ')}`);
  assert.equal(fs.existsSync(flakyDir), false, flakyDir);
  assert.throws(() => process.kill(Number(writerPid), 0), 'the browser stand-in still runs');
  assert.deepEqual(fs.readFileSync(reportCopy), reportBytes, 'the input report changed');
  assert.ok(seconds < 10, `took ${seconds} s to stop`);
  return { code, outDir };
}

test('Ctrl+C during triage --heal with a slow heal leaves no qa-core-flaky-heal-* folder', { skip: process.platform === 'win32' }, async (t) => {
  const { code, outDir } = await interruptTriage(t, { healSigint: 'ignore' });
  assert.equal(code, 130);
  assert.equal(fs.existsSync(path.join(outDir, 'triage.json')), false, 'no report is written after a stop');
});

test('Ctrl+C that reaches heal first, as on a Windows console, leaves no folder and writes no report', { skip: process.platform === 'win32' }, async (t) => {
  const { code, outDir } = await interruptTriage(t, { healSigint: 'exit' });
  assert.equal(code, 130);
  assert.equal(fs.existsSync(path.join(outDir, 'triage.json')), false, 'no report is written after a stop');
});

test('heal exit codes and signals that mean it was stopped', () => {
  for (const code of [130, 143, 129, 0xc000013a]) assert.equal(stoppedBySignal(code, null), true, String(code));
  for (const code of [0, 1, 2, 3, null]) assert.equal(stoppedBySignal(code, null), false, String(code));
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) assert.equal(stoppedBySignal(null, signal), true, signal);
  assert.equal(stoppedBySignal(null, 'SIGKILL'), false);
});
