import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Attempt, TestRecord } from '../model.js';
import { parsePlaywrightJson } from '../parsers/playwright-json.js';
import { redactHomeText } from '../report-path.js';
import { commitFor, mergeRerunRecords, tagRerunAttempts } from './merge.js';
import { exactFileArg, formatPrintedCommand, type PlannedRun, type RerunPlan } from './plan.js';
import { shellQuote } from './quote.js';

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
 * `windowsHide` keeps a detached child from opening a console window on Windows.
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
    windowsHide: true,
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
      const shown = formatPrintedCommand(args, record);
      safePrint(
        input.print,
        input.runner ? shown : `${printedLauncher(input.cwd, flagValue(args, '--config'))} ${shown}`,
      );
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
  // A spec under testDir is not in the working directory. Check the local
  // binary before that lookup, so a missing install is reported as itself.
  if (requireFile && !config) playwrightCli(cwd);
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

const ROOT_CHILD_SCRIPT = [
  "const common = await import('playwright/lib/common');",
  'const file = process.env.QA_CORE_FLAKY_CONFIG;',
  "if (typeof file !== 'string' || file === '') process.exit(0);",
  'const loaded = await common.configLoader?.loadConfigFromFile?.(file);',
  'const root = loaded?.config?.rootDir;',
  "if (typeof root === 'string' && root !== '') process.stdout.write('QA_CORE_ROOT ' + root + '\\n');",
].join('\n');

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
    const configDir = path.dirname(resolvedConfig);
    // The spec is under testDir, which is not the folder where triage ran.
    // Playwright has to load before that root is known. A missing install
    // is not a missing test file.
    if (!findPlaywrightCli(configDir)) throw missingPlaywrightError(configDir);
    const loaded = await loadRootDir(resolvedConfig, cacheRoot);
    if (loaded) roots.push(loaded);
    roots.push(configDir);
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
  // The parent must not import Playwright. The first import chooses
  // `playwright-transform-cache` from `PWTEST_CACHE_DIR` or the real temp
  // directory, and a later change of those variables does not move it.
  // A child loads the config with those variables pointed at this directory,
  // so the cache is removed with the rerun directory.
  const owned = cacheRoot === undefined;
  const dir = cacheRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-flaky-root-'));
  try {
    fs.mkdirSync(dir, { recursive: true });
    const root = await readRootDirFromChild(configFile, dir);
    if (!root) return undefined;
    rootCache.set(configFile, root);
    return root;
  } catch {
    return undefined;
  } finally {
    if (owned) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
    }
  }
}

function readRootDirFromChild(configFile: string, cacheDir: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', ROOT_CHILD_SCRIPT], {
      // Node resolves `playwright/lib/common` from this directory and its
      // parents. That is the config folder, not the triage folder, so a kit
      // that holds node_modules still loads when triage ran in the parent.
      cwd: path.dirname(configFile),
      detached: true,
      windowsHide: true,
      env: {
        ...process.env,
        QA_CORE_FLAKY_CONFIG: configFile,
        PWTEST_CACHE_DIR: path.join(cacheDir, 'playwright-transform-cache'),
        TMPDIR: cacheDir,
        TMP: cacheDir,
        TEMP: cacheDir,
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      killChildGroup(child);
      setTimeout(() => finish(undefined), 1000);
    }, 20_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.on('error', () => finish(undefined));
    child.on('close', () => {
      const line = out
        .split(/\r?\n/)
        .map((item) => item.trim())
        .find((item) => item.startsWith('QA_CORE_ROOT '));
      const root = line?.slice('QA_CORE_ROOT '.length).trim();
      finish(root && root.length > 0 ? root : undefined);
    });
  });
}

function killChildGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // The child has already exited.
    }
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

/**
 * Playwright's own JavaScript entry points, in lookup order. The rerun runs
 * them with the Node that runs this tool. It does not start the
 * `node_modules/.bin/playwright` shim, because that file is a shell script
 * on Windows, and Node refuses to start `playwright.cmd` without a shell.
 * A shell would read `^`, `$`, and `|` in the filters.
 */
export const PLAYWRIGHT_CLI_PATHS: readonly (readonly string[])[] = [
  ['playwright', 'cli.js'],
  ['@playwright/test', 'cli.js'],
];

function cliInFolder(dir: string): string | undefined {
  for (const parts of PLAYWRIGHT_CLI_PATHS) {
    const file = path.join(dir, 'node_modules', ...parts);
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // Not installed in this folder.
    }
  }
  return undefined;
}

/**
 * Playwright's `cli.js` in `startDir`, then each parent, the same way Node
 * resolves a package. `playwright/cli.js` is checked before
 * `@playwright/test/cli.js` in each folder. Stops at the filesystem root.
 */
export function findPlaywrightCli(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    const cli = cliInFolder(dir);
    if (cli) return cli;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function missingPlaywrightError(start: string): Error {
  const modules = path.join(start, 'node_modules');
  return new Error(
    redactHomeText(
      `Local Playwright was not found in ${modules}. The rerun looks for playwright/cli.js and @playwright/test/cli.js. Install @playwright/test in this project before rerun.`,
    ),
  );
}

/**
 * With `--config`, start at the config folder and walk parents, the same way
 * Node resolves a package. Without `--config`, look only in the working directory.
 */
export function playwrightCli(cwd: string, config?: string): string {
  if (!config) {
    const start = path.resolve(cwd);
    const cli = cliInFolder(start);
    if (!cli) throw missingPlaywrightError(start);
    return cli;
  }
  const start = path.dirname(path.resolve(cwd, config));
  const cli = findPlaywrightCli(start);
  if (!cli) throw missingPlaywrightError(start);
  return cli;
}

/**
 * The launcher a person reads in front of each printed command.
 * `npx playwright test` when Playwright is installed in the working
 * directory, because `npx` finds it there on every OS. Otherwise `node` and
 * the path to Playwright's `cli.js`, relative to the working directory, so a
 * kit that keeps `node_modules` in a subfolder still has a command that runs.
 * The process itself is started with the same Node and `cli.js` either way.
 */
export function printedLauncher(cwd: string, config?: string): string {
  let cli: string;
  try {
    cli = playwrightCli(cwd, config);
  } catch {
    return 'npx playwright test';
  }
  const local = path.join(path.resolve(cwd), 'node_modules') + path.sep;
  if (cli.startsWith(local)) return 'npx playwright test';
  const relative = path.relative(path.resolve(cwd), cli).split(path.sep).join('/');
  return `node ${shellQuote(redactHomeText(relative))} test`;
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
    let cli: string;
    try {
      cli = playwrightCli(cwd, flagValue(args, '--config'));
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Local Playwright was not found.'));
      return;
    }
    // Node runs Playwright's cli.js directly on every OS. No shell and no shim.
    const child = launchRerunChild({ command: process.execPath, args: [cli, 'test', ...args], cwd, dir });
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

/**
 * Signal one spawned child, then every descendant.
 * Descendants are collected before the signal. Each one is signaled, and so
 * is its process group, so a grandchild that called setsid still stops.
 * On macOS and Windows the proc walk is empty, and only this child's group
 * is signaled, which is the same cleanup the rerun path uses there.
 * pid 1 and a negative broadcast are not this child. `kill(-1)` signals every process.
 * A caller-supplied pid may not be the spawned child, and walking it would
 * signal unrelated processes.
 */
export function signalTree(pid: number, signal: NodeJS.Signals, child?: ChildProcess): number[] {
  if (!Number.isInteger(pid) || pid <= 1) return [];
  const tracked = child?.pid === pid ? descendantPids(pid) : [];
  signalPid(pid, signal);
  for (const extra of tracked) signalPid(extra, signal);
  return tracked;
}

/** SIGKILL the child, its group, and descendants in other groups, then wait until they are gone. */
export async function stopChildTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || pid <= 1) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    return;
  }
  let tracked = signalTree(pid, 'SIGKILL', child);
  const gone = await waitUntilGone(pid, SIGNAL_WAIT_MS, child, tracked);
  if (!gone) {
    tracked = [...new Set([...tracked, ...signalTree(pid, 'SIGKILL', child)])];
    await waitUntilGone(pid, SIGNAL_WAIT_MS, child, tracked);
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // This pid is not a process group, or the group is already gone.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // The process is already gone.
  }
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
