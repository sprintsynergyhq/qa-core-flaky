import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DETACH_CHILDREN, rerunChildEnv, stopChildTree } from '../rerun/run.js';

/** Flags this tool must never put on a heal command line. */
export const FORBIDDEN_HEAL_ARGS = ['--apply', '--yes', '--no-verify'] as const;

/**
 * The default wait for the whole heal step: the capabilities probe and the
 * findings command share it. In a Windows test with qa-core-heal 0.7.2 and
 * one locator finding, heal alone took about 47 seconds and the heal step
 * about 57 seconds, so the old 60 second default sometimes timed out.
 */
export const DEFAULT_HEAL_TIMEOUT_MS = 180_000;

/** The largest wait `QA_CORE_HEAL_TIMEOUT_MS` can set: 10 minutes, the same as heal's own default. */
export const MAX_HEAL_TIMEOUT_MS = 600_000;

export type HealCommandResult = {
  /** Arguments after the heal program name. `node`, the heal script, and `npx` are not included. */
  args: readonly string[];
  /** Full argv passed to the child: the heal script and the arguments, or `--no-install qa-core-heal` and the arguments when npx is used. Empty when nothing was started. */
  argv: readonly string[];
  /** The program that was started. Empty when nothing was started. */
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
};

/**
 * Where the heal program came from.
 * `env`: `QA_CORE_HEAL_BIN`.
 * `local`: `node_modules/qa-core-heal` in the working directory or a parent.
 * `npx`: `npx --no-install qa-core-heal`, only on macOS and Linux.
 * `missing`: nothing is started, and the status is `unavailable`.
 */
export type HealCommandSource = 'env' | 'local' | 'npx' | 'missing';

export type HealCommand = { command: string; argv: string[]; source: HealCommandSource };

/**
 * The `qa-core-heal` script inside `node_modules/qa-core-heal`, found in
 * `startDir` or the nearest parent, the same way Node resolves a package.
 * The first folder that holds `node_modules/qa-core-heal/package.json` decides.
 * The script is the package `bin` (a string, or the `qa-core-heal` key of an
 * object). It must be a file inside the package folder.
 */
export function findHealCli(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    const pkgDir = path.join(dir, 'node_modules', 'qa-core-heal');
    const manifest = path.join(pkgDir, 'package.json');
    if (isFile(manifest)) return healBinIn(pkgDir, manifest);
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function healBinIn(pkgDir: string, manifest: string): string | undefined {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(manifest, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const pkg = data as { name?: unknown; bin?: unknown };
  if (pkg.name !== 'qa-core-heal') return undefined;
  let bin: unknown = pkg.bin;
  if (typeof bin === 'object' && bin !== null && !Array.isArray(bin)) {
    bin = (bin as Record<string, unknown>)['qa-core-heal'];
  }
  if (typeof bin !== 'string' || bin.trim().length === 0) return undefined;
  const file = path.resolve(pkgDir, bin);
  if (!inside(pkgDir, file) || !isFile(file)) return undefined;
  try {
    // A link inside the package folder must not point outside it.
    if (!inside(fs.realpathSync(pkgDir), fs.realpathSync(file))) return undefined;
  } catch {
    return undefined;
  }
  return file;
}

function inside(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the heal program. Nothing is ever started from a shell.
 * 1. `QA_CORE_HEAL_BIN` selects a program, which tests use. A path that ends
 *    in `.js` or `.mjs` is run with this Node. On Windows a `.cmd` or `.bat`
 *    path is not started, because Node does not start those without a shell.
 * 2. Otherwise `node_modules/qa-core-heal` in `cwd` or a parent: its `bin`
 *    script is run with this Node, on every OS. The `.bin` shims are not used.
 * 3. Otherwise, on macOS and Linux, `npx --no-install qa-core-heal`. On
 *    Windows `npx` is `npx.cmd`, which Node does not start without a shell,
 *    so nothing is started and the status is `unavailable`.
 */
export function healCommand(
  args: readonly string[],
  options: { cwd?: string; platform?: NodeJS.Platform } = {},
): HealCommand {
  assertHealArgsAllowed(args);
  const platform = options.platform ?? process.platform;
  const override = process.env.QA_CORE_HEAL_BIN?.trim();
  if (override) {
    if (override.endsWith('.mjs') || override.endsWith('.js')) {
      return { command: process.execPath, argv: [override, ...args], source: 'env' };
    }
    if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(override)) {
      return { command: '', argv: [], source: 'missing' };
    }
    return { command: override, argv: [...args], source: 'env' };
  }
  const cli = findHealCli(options.cwd ?? process.cwd());
  if (cli) return { command: process.execPath, argv: [cli, ...args], source: 'local' };
  if (platform === 'win32') return { command: '', argv: [], source: 'missing' };
  return { command: 'npx', argv: ['--no-install', 'qa-core-heal', ...args], source: 'npx' };
}

/** Throw before spawn when a forbidden flag is present. */
export function assertHealArgsAllowed(args: readonly string[]): void {
  for (const arg of args) {
    if (isForbidden(arg)) {
      throw new Error(`Refusing to pass ${arg} to qa-core-heal.`);
    }
  }
}

/**
 * The wait for the whole heal step, in milliseconds.
 * `QA_CORE_HEAL_TIMEOUT_MS` sets it. A value that is not a positive whole
 * number gives the default. A value above the maximum is clamped to it.
 */
export function healTimeoutMs(): number {
  const raw = process.env.QA_CORE_HEAL_TIMEOUT_MS?.trim();
  if (!raw || !/^[1-9]\d*$/.test(raw)) return DEFAULT_HEAL_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_HEAL_TIMEOUT_MS;
  if (parsed > MAX_HEAL_TIMEOUT_MS) return MAX_HEAL_TIMEOUT_MS;
  return parsed;
}

/**
 * Time kept back from heal's `--run-timeout` so heal can stop its last
 * Playwright run, write its results file, and exit before flaky stops it.
 * Heal's budget covers its child Playwright runs. Starting Node, the work
 * heal does in its own process, and stopping a process tree with
 * `taskkill /T` on Windows come on top. The reserve is 10 percent of the wait, at least 1 second and at most
 * 15 seconds.
 */
export function healExitReserveMs(timeoutMs: number): number {
  return Math.min(15_000, Math.max(1_000, Math.floor(timeoutMs / 10)));
}

/**
 * Whole seconds for heal's `--run-timeout`: the time left in the flaky wait,
 * less the exit reserve, rounded down. With the 180 second default this is
 * about 165 seconds. A wait under two seconds leaves no positive whole number
 * of seconds, so the flag is omitted.
 */
export function runTimeoutSeconds(timeoutMs: number): number | null {
  if (!Number.isFinite(timeoutMs)) return null;
  const seconds = Math.floor((timeoutMs - healExitReserveMs(timeoutMs)) / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 1) return null;
  return seconds;
}

/** Every temporary heal folder this tool makes starts with this name. Cleanup removes nothing else. */
export const HEAL_TEMP_PREFIX = 'qa-core-flaky-heal-';

/**
 * Signals that stop a heal run. Ctrl+C is SIGINT on every OS. On Windows,
 * Ctrl+Break is SIGBREAK and closing the console window is SIGHUP.
 * Node can listen for SIGBREAK on macOS and Linux too, but nothing sends it there.
 */
export const HEAL_STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const;

/** Exit status after a stop signal. Ctrl+C and Ctrl+Break both exit 130. */
export function healStopExitCode(signal: NodeJS.Signals): number {
  if (signal === 'SIGTERM') return 143;
  if (signal === 'SIGHUP') return 129;
  return 130;
}

/** The longest wait for the child tree to stop after a stop signal, before the folder is removed anyway. */
export const HEAL_STOP_KILL_WAIT_MS = 10_000;

/**
 * Retries for removing the temporary heal folder. On Windows a browser or
 * Playwright process that was just stopped can hold files open for a moment,
 * so the first delete can fail with EBUSY or EPERM. Node waits 100 ms more on
 * each try, about 5.5 seconds in total.
 */
const REMOVE_RETRIES = { maxRetries: 10, retryDelay: 100 } as const;

/** How long to wait for this process's own stop signal after heal exits as if interrupted. */
export const INTERRUPTED_CHILD_WAIT_MS = 1_000;

/** Windows reports a process ended by Ctrl+C with STATUS_CONTROL_C_EXIT. */
const WINDOWS_CTRL_C_EXIT = 0xc000013a;

/**
 * True when heal ended the way a stop signal ends it: exit code 130, 143,
 * or 129 (heal's own signal handler), the Windows Ctrl+C status, or a
 * SIGINT, SIGTERM, SIGHUP, or SIGBREAK signal.
 */
export function stoppedBySignal(exitCode: number | null, signal: NodeJS.Signals | null): boolean {
  if (signal !== null) return (HEAL_STOP_SIGNALS as readonly string[]).includes(signal);
  return exitCode === 130 || exitCode === 143 || exitCode === 129 || exitCode === WINDOWS_CTRL_C_EXIT;
}

const healStop = {
  child: null as ChildProcess | null,
  tempDir: null as string | null,
};
let healStopHandlersOn = false;
let healStopInProgress = false;
let healExitHandlerOn = false;
/** Folders a delete could not remove yet. The exit handler tries them again. */
const leftoverHealTemps = new Set<string>();

function onHealStop(signal: NodeJS.Signals): void {
  void stopHealRun(signal);
}

export type HealStopDeps = {
  /** Stops the child and its descendants. The default is `stopChildTree`. */
  stopTree?: (child: ChildProcess) => Promise<void>;
  /** Ends the process. The default is `process.exit`. */
  exit?: (code: number) => void;
  /** The longest wait for `stopTree`. */
  killWaitMs?: number;
};

/**
 * What a stop signal does during a heal run: stop the heal child and every
 * descendant (`taskkill /T /F` on Windows, the process groups elsewhere),
 * then remove the temporary heal folder synchronously, with retries for
 * Windows file locks, then exit 130 for Ctrl+C. Only a folder whose name
 * starts with `qa-core-flaky-heal-` is removed, so test files and reports
 * are never touched. A second signal while this runs does nothing.
 * Resolves with the exit code, or null when a stop was already running.
 */
export async function stopHealRun(signal: NodeJS.Signals, deps: HealStopDeps = {}): Promise<number | null> {
  if (healStopInProgress) return null;
  healStopInProgress = true;
  const child = healStop.child;
  const dir = healStop.tempDir;
  const stopTree = deps.stopTree ?? stopChildTree;
  if (child) {
    try {
      await withinMs(stopTree(child), deps.killWaitMs ?? HEAL_STOP_KILL_WAIT_MS);
    } catch {
      // The folder is still removed.
    }
    // The tree is stopped. The exit handler must not kill this pid again.
    if (healStop.child === child) bindHealChild(null);
  }
  removeHealTemp(dir);
  const code = healStopExitCode(signal);
  (deps.exit ?? ((value: number) => process.exit(value)))(code);
  return code;
}

function withinMs(job: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // Keep this timer referenced. If stopping the tree hangs, the stop must
    // still finish and exit with the right code.
    const timer = setTimeout(resolve, ms);
    job.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Last cleanup when the process exits for any reason, for example an
 * uncaught error or a `process.exit` elsewhere. Only synchronous work runs
 * here: a child that is still running is stopped with `taskkill /T /F` on
 * Windows or SIGKILL to its process group elsewhere, then the bound folder
 * and any folder an earlier delete could not remove are removed.
 */
export function onHealProcessExit(): void {
  const child = healStop.child;
  if (child && child.exitCode === null && child.signalCode === null) killTreeSync(child);
  const dirs = new Set(leftoverHealTemps);
  if (healStop.tempDir) dirs.add(healStop.tempDir);
  for (const dir of dirs) removeHealTemp(dir);
}

function killTreeSync(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true, timeout: 5_000 });
    } catch {
      // The process has already exited.
    }
    return;
  }
  if (DETACH_CHILDREN) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The group has already exited.
    }
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // The process has already exited.
  }
}

/** Remember the heal child so a later interrupt can kill its process group. */
export function bindHealChild(child: ChildProcess | null): void {
  healStop.child = child;
}

/** Remember the temporary findings folder so an interrupt can remove it. */
export function bindHealTempDir(dir: string | null): void {
  healStop.tempDir = dir;
}

/**
 * Handle SIGINT, SIGTERM, SIGHUP, and SIGBREAK for the current heal run, and
 * add a one-time exit handler for leftovers. A second call does nothing.
 */
export function installHealStopHandlers(): void {
  if (!healExitHandlerOn) {
    process.on('exit', onHealProcessExit);
    healExitHandlerOn = true;
  }
  if (healStopHandlersOn) return;
  for (const signal of HEAL_STOP_SIGNALS) process.on(signal, onHealStop);
  healStopHandlersOn = true;
}

/** Drop the interrupt handlers. Later commands are not tied to this heal run. */
export function removeHealStopHandlers(): void {
  if (healStopHandlersOn) {
    for (const signal of HEAL_STOP_SIGNALS) process.off(signal, onHealStop);
    healStopHandlersOn = false;
  }
  healStop.child = null;
  healStop.tempDir = null;
  healStopInProgress = false;
}

/** Run heal without a shell. The child is killed when the timeout fires. */
export function runHealCommand(args: readonly string[], timeoutMs: number = healTimeoutMs()): Promise<HealCommandResult> {
  const { command, argv, source } = healCommand(args);
  if (source === 'missing') {
    // Reads as not installed, so the status is `unavailable`.
    return Promise.resolve({ args, argv, command, exitCode: null, stdout: '', stderr: '', timedOut: false, spawnError: 'ENOENT' });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: HealCommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const ownedTemp = healStop.tempDir ? null : fs.mkdtempSync(path.join(os.tmpdir(), HEAL_TEMP_PREFIX));
    if (ownedTemp) bindHealTempDir(ownedTemp);
    const tempRoot = healStop.tempDir ?? os.tmpdir();
    let child: ChildProcess;
    try {
      child = spawn(command, argv, {
        shell: false,
        windowsHide: true,
        env: rerunChildEnv(tempRoot),
        // A new process group so the timeout can kill grandchildren. Not on
        // Windows, where it opens a console window and taskkill /T is used.
        detached: DETACH_CHILDREN,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      // Node throws instead of emitting `error` for some programs, such as a
      // `.cmd` file on Windows. The run reports a spawn error and does not crash.
      if (ownedTemp) {
        if (healStop.tempDir === ownedTemp) bindHealTempDir(null);
        removeHealTemp(ownedTemp);
      }
      const code = (error as NodeJS.ErrnoException).code;
      finish({ args, argv, command, exitCode: null, stdout, stderr, timedOut: false, spawnError: code ?? 'spawn failed' });
      return;
    }
    bindHealChild(child);
    const releaseOwned = () => {
      if (!ownedTemp) return;
      if (healStop.tempDir === ownedTemp) bindHealTempDir(null);
      removeHealTemp(ownedTemp);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void (async () => {
        await stopChildTree(child);
        if (healStop.child === child) bindHealChild(null);
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        releaseOwned();
        finish({ args, argv, command, exitCode: null, stdout, stderr, timedOut: true });
      })();
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < 200_000) stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 20_000) stderr += chunk;
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (healStop.child === child) bindHealChild(null);
      releaseOwned();
      finish({
        args,
        argv,
        command,
        exitCode: null,
        stdout,
        stderr,
        timedOut: false,
        spawnError: error.code ?? error.message,
      });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      // A timeout or a stop signal owns the kill and the folder removal.
      // Walking after a clean exit would miss a descendant that was already reparented.
      if (timedOut || healStopInProgress) return;
      if (healStop.child === child) bindHealChild(null);
      const done = () => {
        if (healStopInProgress) return;
        releaseOwned();
        finish({ args, argv, command, exitCode, stdout, stderr, timedOut });
      };
      // On a Windows console, Ctrl+C reaches heal too, and heal can exit
      // before this process sees its own SIGINT. Wait a moment for that
      // signal so the stop handler, not the report, decides what happens.
      if (stoppedBySignal(exitCode, signal)) setTimeout(done, INTERRUPTED_CHILD_WAIT_MS);
      else done();
    });
  });
}

/**
 * Remove a temporary heal folder synchronously, with retries for Windows file
 * locks. Only an absolute path whose last part starts with
 * `qa-core-flaky-heal-` is removed. Anything else is left alone. Never throws.
 * Returns true when the folder is gone. A folder that is still there is
 * tried again when the process exits.
 */
export function removeHealTemp(dir: string | null, rm: typeof fs.rmSync = fs.rmSync): boolean {
  if (!dir) return true;
  if (!path.isAbsolute(dir) || !path.basename(dir).startsWith(HEAL_TEMP_PREFIX)) return false;
  try {
    rm(dir, { recursive: true, force: true, ...REMOVE_RETRIES });
  } catch {
    // Checked below.
  }
  let gone: boolean;
  try {
    gone = !fs.existsSync(dir);
  } catch {
    gone = false;
  }
  if (gone) leftoverHealTemps.delete(dir);
  else leftoverHealTemps.add(dir);
  return gone;
}

function isForbidden(arg: string): boolean {
  if ((FORBIDDEN_HEAL_ARGS as readonly string[]).includes(arg)) return true;
  return FORBIDDEN_HEAL_ARGS.some((flag) => arg.startsWith(`${flag}=`));
}
