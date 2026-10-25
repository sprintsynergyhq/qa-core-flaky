import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Attempt, TestRecord } from '../model.js';
import { parsePlaywrightJson } from '../parsers/playwright-json.js';
import { redactHomeText } from '../report-path.js';
import { commitFor, mergeRerunRecords, tagRerunAttempts } from './merge.js';
import { exactFileArg, formatPrintedCommand, type PlannedRun, type RerunPlan } from './plan.js';

/** Signals that stop a rerun. The child process group is killed before the temp directory is removed. */
export const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** How long to wait after SIGTERM before SIGKILL. */
export const SIGNAL_WAIT_MS = 300;

/** Exit status for a stop signal: 128 plus the signal number. No stack is printed. */
export const SIGNAL_EXIT: Readonly<Record<(typeof STOP_SIGNALS)[number], number>> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
};

/** Thrown after cleanup when a stop signal ends the plan. The report is not written. */
export class StoppedRun extends Error {
  readonly signal: NodeJS.Signals;
  readonly exitCode: number;

  constructor(signal: NodeJS.Signals) {
    super(`Stopped by ${signal}`);
    this.name = 'StoppedRun';
    this.signal = signal;
    this.exitCode = SIGNAL_EXIT[signal as (typeof STOP_SIGNALS)[number]] ?? 1;
  }
}

export function isStoppedRun(error: unknown): error is StoppedRun {
  return error instanceof StoppedRun;
}

const guardedPipes = new WeakSet<object>();

export type CommandResult = {
  code: number | null;
  stderr: string;
};

export type CommandRunner = (
  args: readonly string[],
  cwd: string,
  stdoutFile: string,
  setPid: (pid: number) => void,
) => Promise<CommandResult>;

export type ReleaseState = {
  pid?: number;
  dir?: string;
  /** The direct child, when this process spawned it. Cleanup waits for `close`. */
  child?: ChildProcess;
  kill?: (pid: number) => void | Promise<void>;
  /** Set synchronously on a stop signal. The plan starts nothing further and prints nothing further. */
  stopping?: boolean;
  stopSignal?: NodeJS.Signals;
  /** One in-flight cleanup. A second call awaits this same promise. */
  release?: Promise<void>;
};

/**
 * Ignore EPIPE on a stream. A reader such as `head` closes the pipe, and
 * an unhandled error would exit before the child is killed.
 */
export function guardPipe(stream: NodeJS.EventEmitter): void {
  if (guardedPipes.has(stream)) return;
  guardedPipes.add(stream);
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
  });
}

/** Child temp files go under `dir/tmp`, so deleting `dir` removes them. */
export function rerunChildEnv(dir: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  return { ...base, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
}

/**
 * Kill the child process group, then delete the temp directory.
 * SIGTERM is sent first. After `SIGNAL_WAIT_MS`, SIGKILL follows.
 * A second call awaits the same cleanup. `ENOENT` and `ENOTEMPTY` from
 * the delete are not thrown. A kill that throws still deletes the directory.
 */
export function releaseRun(state: ReleaseState): Promise<void> {
  if (state.release) return state.release;
  const pid = state.pid;
  const dir = state.dir;
  const child = state.child;
  const kill = state.kill ?? ((id: number) => killProcessGroup(id, child));
  state.pid = undefined;
  state.dir = undefined;
  state.child = undefined;
  const job = (async () => {
    if (pid !== undefined) {
      try {
        await kill(pid);
      } catch {
        // The directory is still removed.
      }
    }
    if (dir) await removeTree(dir);
  })();
  state.release = job;
  return job;
}

/** Call `release`, then re-raise the signal. Tests pass their own re-raise. */
export async function onStopSignal(
  signal: NodeJS.Signals,
  release: () => void | Promise<void>,
  reraise: (signal: NodeJS.Signals) => void,
): Promise<void> {
  await release();
  reraise(signal);
}

export async function killProcessGroup(pid: number, child?: ChildProcess): Promise<void> {
  const tracked = signalTree(pid, 'SIGTERM', child);
  const gone = await waitUntilGone(pid, SIGNAL_WAIT_MS, child, tracked);
  if (!gone) {
    tracked.push(...signalTree(pid, 'SIGKILL', child));
    await waitUntilGone(pid, SIGNAL_WAIT_MS, child, tracked);
  }
}

/**
 * Spawn a detached child with temp env inside `dir`.
 * The caller owns stdout piping and cleanup.
 */
export function launchRerunChild(input: {
  command: string;
  args: readonly string[];
  cwd: string;
  dir: string;
  stdout?: 'pipe' | 'ignore';
}): ChildProcess {
  return spawn(input.command, input.args, {
    cwd: input.cwd,
    env: rerunChildEnv(input.dir),
    detached: true,
    stdio: ['ignore', input.stdout ?? 'pipe', 'pipe'],
  });
}

/**
 * Run the plan, parse each JSON report, and merge the attempts into `records`.
 * The temp directory is removed on success, on failure, and on stop signals.
 * `runner` is for tests. The default runner is the local Playwright binary only.
 */
export async function executePlan(input: {
  records: readonly TestRecord[];
  plan: RerunPlan;
  cwd: string;
  commitSha?: string;
  print: (line: string) => void;
  runner?: CommandRunner;
}): Promise<TestRecord[]> {
  guardPipe(process.stdout);
  guardPipe(process.stderr);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-flaky-rerun-'));
  const state: ReleaseState = { dir };
  const handlers = new Map<NodeJS.Signals, () => void>();
  const useSignals = input.runner === undefined;
  if (useSignals) {
    for (const signal of STOP_SIGNALS) {
      const handler = () => {
        if (state.stopping) return;
        state.stopping = true;
        state.stopSignal = signal;
        void releaseRun(state).catch(() => {
          // Cleanup errors must not become a stack trace. The exit code is the signal.
        });
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
  }
  const runner =
    input.runner ??
    ((args, cwd, stdoutFile, setPid) => defaultRunner(args, cwd, stdoutFile, setPid, dir, state));
  let merged = input.records.map((record) => ({ ...record, attempts: [...record.attempts] }));
  try {
    let commandIndex = 0;
    for (const run of input.plan.runs) {
      if (state.stopping) break;
      const outputDir = path.join(dir, `out-${commandIndex}`);
      const stdoutFile = path.join(dir, `report-${commandIndex}.json`);
      commandIndex += 1;
      fs.mkdirSync(outputDir, { recursive: true });
      const args = await prepareArgs(
        run,
        withOutput(run.args, outputDir),
        input.cwd,
        input.runner === undefined,
        dir,
      );
      if (state.stopping) break;
      const record =
        input.records.find((item) => item.id === run.testId) ??
        input.records.find((item) => item.file === run.file && item.project === run.project);
      safePrint(input.print, formatPrintedCommand(args, record, input.runner ? [] : launcherPrefix(input.cwd)));
      if (state.stopping) break;
      let result: CommandResult;
      try {
        result = await runner(args, input.cwd, stdoutFile, (pid) => {
          state.pid = pid;
        });
      } catch (error) {
        if (state.stopping) break;
        throw error;
      }
      state.pid = undefined;
      if (state.stopping) break;
      if (!fs.existsSync(stdoutFile) || fs.statSync(stdoutFile).size === 0) {
        throw new Error(failureLine(result, 'Playwright wrote no JSON report.'));
      }
      const text = fs.readFileSync(stdoutFile, 'utf8');
      let parsed;
      try {
        parsed = parsePlaywrightJson(text, 'rerun-report.json');
      } catch (error) {
        const why = error instanceof Error ? error.message : 'Could not parse the rerun report';
        throw new Error(failureLine(result, why));
      }
      if (state.stopping) break;
      let picked: TestRecord[];
      try {
        picked = selectRecords(run, parsed.records, input.plan.cap.times);
      } catch (error) {
        const why = error instanceof Error ? error.message : 'The rerun report did not match the requested test';
        const reason = failureLine(result, `Could not select this test. ${why}`);
        safePrint(input.print, reason);
        merged = recordUnselectable(merged, run, input.plan, reason);
        continue;
      }
      const commit = run.commitSha ?? commitFor(input.records, run.testId ?? picked[0]?.id ?? '', input.commitSha);
      const tagged = tagRerunAttempts(picked, run.mode, run.runIndex, commit);
      merged = mergeRerunRecords(merged, tagged);
    }
  } catch (error) {
    // A signal can land while this command is finishing. Do not report that
    // failure, and do not replace the signal exit with this error.
    if (!state.stopping) throw error;
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    try {
      await releaseRun(state);
    } catch (error) {
      if (!state.stopping) throw error;
    }
  }
  if (state.stopping && state.stopSignal) throw new StoppedRun(state.stopSignal);
  return merged;
}

function recordUnselectable(
  merged: TestRecord[],
  run: PlannedRun,
  plan: RerunPlan,
  reason: string,
): TestRecord[] {
  const message = redactHomeText(reason);
  const attempt: Attempt = {
    retry: 0,
    status: 'unselectable',
    durationMs: 0,
    errors: [{ message }],
    attachments: [],
    rerun: { mode: run.mode, runIndex: run.runIndex },
  };
  const selected = new Set(plan.tests.map((record) => record.id));
  const ids = new Set<string>();
  if (run.testId) ids.add(run.testId);
  else {
    for (const record of merged) {
      if (record.file === run.file && record.project === run.project && selected.has(record.id)) ids.add(record.id);
    }
  }
  if (ids.size === 0) return merged;
  return merged.map((record) => {
    if (!ids.has(record.id)) return record;
    return { ...record, attempts: [...record.attempts, { ...attempt, errors: [{ message }] }] };
  });
}

function safePrint(print: (line: string) => void, line: string): void {
  try {
    print(line);
  } catch (error) {
    if (!isPipe(error)) throw error;
  }
}

function isPipe(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = error.code;
  return code === 'EPIPE' || code === 'ERR_STREAM_PREMATURE_CLOSE';
}

async function prepareArgs(
  run: PlannedRun,
  args: string[],
  cwd: string,
  requireFile: boolean,
  rerunDir: string,
): Promise<string[]> {
  const copy = [...args];
  const at = copy.lastIndexOf('--');
  if (at === -1 || copy[at + 1] === undefined) return copy;
  const config = flagValue(copy, '--config');
  const absolute = await resolveProjectFile(run.file, cwd, config, path.join(rerunDir, 'tmp'));
  if (!absolute) {
    if (requireFile) {
      throw new Error(redactHomeText(`Cannot find test file ${run.file} under the Playwright project.`));
    }
    return copy;
  }
  const line = run.mode === 'in-order' ? undefined : run.line;
  copy[at + 1] = exactFileArg(absolute, line);
  return copy;
}

const rootCache = new Map<string, string>();
let playwrightLoaded = false;

export async function resolveProjectFile(
  file: string,
  cwd: string,
  config?: string,
  cacheRoot?: string,
): Promise<string | undefined> {
  const normalized = file.replaceAll('\\', '/');
  if (path.isAbsolute(file)) return fs.existsSync(file) ? path.resolve(file) : undefined;
  const roots: string[] = [];
  if (config) {
    const resolvedConfig = path.resolve(cwd, config);
    const loaded = await loadRootDir(resolvedConfig, cacheRoot);
    if (loaded) roots.push(loaded);
    roots.push(path.dirname(resolvedConfig));
  }
  roots.push(path.resolve(cwd));
  const seen = new Set<string>();
  for (const root of roots) {
    if (seen.has(root)) continue;
    seen.add(root);
    const candidate = path.resolve(root, normalized);
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
    const rel = path.relative(root, candidate).split(path.sep).join('/');
    if (rel === normalized) return candidate;
  }
  return undefined;
}

async function loadRootDir(configFile: string, cacheRoot?: string): Promise<string | undefined> {
  const cached = rootCache.get(configFile);
  if (cached) return cached;
  // Playwright chooses `playwright-transform-cache-<uid>` when its module
  // is first loaded, from `PWTEST_CACHE_DIR` or `os.tmpdir()`. Point that
  // at the rerun directory so the parent does not leave the cache in the
  // real temp directory. A process that already loaded Playwright keeps
  // the directory chosen by that first load.
  const redirect = cacheRoot !== undefined && !playwrightLoaded;
  const saved = redirect ? snapshotTempEnv() : undefined;
  if (redirect && cacheRoot) {
    fs.mkdirSync(cacheRoot, { recursive: true });
    process.env.PWTEST_CACHE_DIR = path.join(cacheRoot, 'playwright-transform-cache');
    process.env.TMPDIR = cacheRoot;
    process.env.TMP = cacheRoot;
    process.env.TEMP = cacheRoot;
  }
  try {
    const specifier: string = 'playwright/lib/common';
    const common = (await import(specifier)) as {
      configLoader?: { loadConfigFromFile?: (file: string) => Promise<{ config?: { rootDir?: string } }> };
    };
    playwrightLoaded = true;
    const loaded = await common.configLoader?.loadConfigFromFile?.(configFile);
    const root = loaded?.config?.rootDir;
    if (typeof root !== 'string' || root === '') return undefined;
    rootCache.set(configFile, root);
    return root;
  } catch {
    return undefined;
  } finally {
    if (saved) restoreTempEnv(saved);
  }
}

function snapshotTempEnv(): NodeJS.ProcessEnv {
  return {
    PWTEST_CACHE_DIR: process.env.PWTEST_CACHE_DIR,
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
  };
}

function restoreTempEnv(saved: NodeJS.ProcessEnv): void {
  for (const key of ['PWTEST_CACHE_DIR', 'TMPDIR', 'TMP', 'TEMP'] as const) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function flagValue(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  return args[at + 1];
}

/**
 * Isolated and repeat must come back as exactly the requested id.
 * In-order must come back as that file and project only.
 * A missing id is an error. Extra tests are an error. Nothing is merged on failure.
 */
export function selectRecords(run: PlannedRun, records: readonly TestRecord[], times: number): TestRecord[] {
  if (run.mode === 'in-order') {
    const foreign = records.filter((record) => record.file !== run.file || record.project !== run.project);
    if (foreign.length > 0) {
      throw new Error(redactHomeText(selectionError(run, records, 'also ran another file or project')));
    }
    if (records.length === 0) {
      throw new Error(redactHomeText(selectionError(run, records, 'ran no tests')));
    }
    return [...records];
  }
  const wanted = run.testId ?? '';
  const ids = [...new Set(records.map((record) => record.id))];
  if (ids.length !== 1 || ids[0] !== wanted) {
    throw new Error(redactHomeText(selectionError(run, records, 'did not run exactly that test')));
  }
  const attempts = records.reduce((sum, record) => sum + record.attempts.length, 0);
  const expected = run.mode === 'repeat' ? times : 1;
  if (attempts !== expected) {
    throw new Error(
      redactHomeText(
        `${run.mode} rerun of ${wanted} expected ${expected} attempts and found ${attempts}.`,
      ),
    );
  }
  return [...records];
}

function selectionError(run: PlannedRun, records: readonly TestRecord[], why: string): string {
  const ids = records.map((record) => record.id);
  const target = run.testId ?? `${run.file} (${run.project})`;
  const found = ids.length === 0 ? 'no tests' : ids.join(', ');
  return `${run.mode} rerun of ${target} ${why}. The report had ${found}.`;
}

function failureLine(result: CommandResult, detail: string): string {
  const code = result.code === null ? 'none' : String(result.code);
  const tail = redactHomeText(stderrTail(result.stderr));
  const head = redactHomeText(detail.replaceAll('\n', ' ').trim());
  return tail ? `${head} Playwright exited with code ${code}. ${tail}` : `${head} Playwright exited with code ${code}.`;
}

function stderrTail(stderr: string): string {
  const text = stderr.replace(/\r\n?/g, '\n').trim();
  if (text === '') return '';
  const lines = text.split('\n').slice(-8).join(' ');
  return lines.length > 500 ? lines.slice(-500) : lines;
}

function withOutput(args: readonly string[], outputDir: string): string[] {
  const copy = [...args];
  const existing = copy.indexOf('--output');
  if (existing !== -1 && copy[existing + 1] !== undefined) {
    copy[existing + 1] = outputDir;
    return copy;
  }
  const reporter = copy.indexOf('--reporter');
  const at = reporter === -1 ? 0 : reporter + 2;
  copy.splice(at, 0, '--output', outputDir);
  return copy;
}

function launcherPrefix(cwd: string): string[] {
  return [playwrightBin(cwd), 'test'];
}

function playwrightBin(cwd: string): string {
  const bin = path.join(cwd, 'node_modules', '.bin', 'playwright');
  if (!fs.existsSync(bin)) {
    throw new Error(redactHomeText(`Local Playwright was not found at ${bin}. Install playwright in this project before rerun.`));
  }
  return bin;
}

function defaultRunner(
  args: readonly string[],
  cwd: string,
  stdoutFile: string,
  setPid: (pid: number) => void,
  dir: string,
  state: ReleaseState,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let bin: string;
    try {
      bin = playwrightBin(cwd);
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Local Playwright was not found.'));
      return;
    }
    const child = launchRerunChild({ command: bin, args: ['test', ...args], cwd, dir });
    state.child = child;
    if (child.pid !== undefined) setPid(child.pid);
    const stdout = fs.createWriteStream(stdoutFile);
    const ignorePipe = (error: NodeJS.ErrnoException) => {
      if (isPipe(error)) return;
    };
    stdout.on('error', ignorePipe);
    child.stdout?.on('error', ignorePipe);
    child.stderr?.on('error', ignorePipe);
    child.stdout?.pipe(stdout);
    const chunks: Buffer[] = [];
    let size = 0;
    child.stderr?.on('data', (chunk: Buffer) => {
      if (size > 8000) return;
      chunks.push(chunk);
      size += chunk.length;
    });
    child.on('error', (error) => {
      stdout.end();
      reject(error);
    });
    child.on('close', (code) => {
      stdout.end(() => {
        resolve({ code, stderr: Buffer.concat(chunks).toString('utf8') });
      });
    });
  });
}

function signalTree(pid: number, signal: NodeJS.Signals, child?: ChildProcess): number[] {
  // pid 1 and a negative broadcast are not this child. `kill(-1)` signals every process.
  // Descendants are collected only for the child this run spawned. A caller-supplied
  // pid may not be that child, and walking it would signal unrelated processes.
  if (!Number.isInteger(pid) || pid <= 1) return [];
  const tracked = child?.pid === pid ? descendantPids(pid) : [];
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process is already gone.
    }
  }
  for (const extra of tracked) {
    try {
      process.kill(extra, signal);
    } catch {
      // That process is already gone, or it is not ours.
    }
  }
  return tracked;
}

function descendantPids(root: number): number[] {
  if (process.platform !== 'linux') return [];
  const children = new Map<number, number[]>();
  let names: string[];
  try {
    names = fs.readdirSync('/proc');
  } catch {
    return [];
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const id = Number(name);
    try {
      const text = fs.readFileSync(`/proc/${name}/status`, 'utf8');
      const match = /^PPid:\s+(\d+)/m.exec(text);
      const parent = match ? Number(match[1]) : 0;
      const list = children.get(parent) ?? [];
      list.push(id);
      children.set(parent, list);
    } catch {
      // The process exited while we were reading.
    }
  }
  const out: number[] = [];
  const stack = [...(children.get(root) ?? [])];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined || seen.has(next) || next <= 1) continue;
    seen.add(next);
    out.push(next);
    stack.push(...(children.get(next) ?? []));
  }
  return out;
}

function groupAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    // ESRCH means the group is gone. EPERM is not our child.
    const code = errnoCode(error);
    return code !== 'ESRCH' && code !== 'EPERM';
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) !== 'ESRCH' && errnoCode(error) !== 'EPERM';
  }
}

function errnoCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) return '';
  const code = error.code;
  return typeof code === 'string' ? code : '';
}

function childClosed(child: ChildProcess | undefined): Promise<void> {
  if (!child) return Promise.resolve();
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    child.once('close', done);
    if (child.exitCode !== null || child.signalCode !== null) {
      child.removeListener('close', done);
      resolve();
    }
  });
}

function waitUntilGone(
  pid: number,
  ms: number,
  child: ChildProcess | undefined,
  tracked: readonly number[],
): Promise<boolean> {
  let closed = child === undefined || child.exitCode !== null || child.signalCode !== null;
  if (!closed && child) {
    void childClosed(child).then(() => {
      closed = true;
    });
  }
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const groupGone = !groupAlive(pid);
      const treeGone = tracked.every((id) => !pidAlive(id));
      if (closed && groupGone && treeGone) {
        resolve(true);
        return;
      }
      if (Date.now() - start >= ms) {
        resolve(false);
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

async function removeTree(dir: string): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
      return;
    } catch (error) {
      last = error;
      const code = errnoCode(error);
      if (code === 'ENOENT') return;
      if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') throw error;
      await delay(50);
    }
  }
  const code = errnoCode(last);
  if (code === 'ENOENT' || code === 'ENOTEMPTY') return;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
