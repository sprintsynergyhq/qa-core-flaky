import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DETACH_CHILDREN, rerunChildEnv, stopChildTree } from '../rerun/run.js';

/** Flags this tool must never put on a heal command line. */
export const FORBIDDEN_HEAL_ARGS = ['--apply', '--yes', '--no-verify'] as const;

const DEFAULT_TIMEOUT_MS = 60_000;

export type HealCommandResult = {
  /** Arguments after the heal program name. `npx` is not included. */
  args: readonly string[];
  /** Full argv passed to the child, including `qa-core-heal` when npx is used. */
  argv: readonly string[];
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
};

/**
 * Resolve the heal program.
 * `QA_CORE_HEAL_BIN` selects a program, which tests use.
 * Otherwise the command is `npx qa-core-heal`.
 */
export function healCommand(args: readonly string[]): { command: string; argv: string[] } {
  assertHealArgsAllowed(args);
  const override = process.env.QA_CORE_HEAL_BIN?.trim();
  if (override) {
    if (override.endsWith('.mjs') || override.endsWith('.js')) {
      return { command: process.execPath, argv: [override, ...args] };
    }
    return { command: override, argv: [...args] };
  }
  return { command: 'npx', argv: ['--no-install', 'qa-core-heal', ...args] };
}

/** Throw before spawn when a forbidden flag is present. */
export function assertHealArgsAllowed(args: readonly string[]): void {
  for (const arg of args) {
    if (isForbidden(arg)) {
      throw new Error(`Refusing to pass ${arg} to qa-core-heal.`);
    }
  }
}

export function healTimeoutMs(): number {
  const raw = process.env.QA_CORE_HEAL_TIMEOUT_MS?.trim();
  if (!raw || !/^[1-9]\d*$/.test(raw)) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_TIMEOUT_MS;
  if (parsed > 120_000) return 120_000;
  return parsed;
}

/**
 * Whole seconds for heal's `--run-timeout`, one second under the flaky wait.
 * A wait under two seconds cannot be expressed as a positive whole number
 * that is still shorter, so the flag is omitted.
 */
export function runTimeoutSeconds(timeoutMs: number): number | null {
  const seconds = Math.floor(timeoutMs / 1000) - 1;
  if (!Number.isSafeInteger(seconds) || seconds < 1) return null;
  return seconds;
}

const healStop = {
  child: null as ChildProcess | null,
  tempDir: null as string | null,
};
let healStopHandlersOn = false;
let healStopInProgress = false;

function onHealStop(signal: NodeJS.Signals): void {
  if (healStopInProgress) return;
  healStopInProgress = true;
  const child = healStop.child;
  const dir = healStop.tempDir;
  void (async () => {
    if (child) {
      try {
        await stopChildTree(child);
      } catch {
        // The folder is still removed.
      }
    }
    removeHealTemp(dir);
    process.exit(signal === 'SIGTERM' ? 143 : 130);
  })();
}

/** Remember the heal child so a later interrupt can kill its process group. */
export function bindHealChild(child: ChildProcess | null): void {
  healStop.child = child;
}

/** Remember the temporary findings folder so an interrupt can remove it. */
export function bindHealTempDir(dir: string | null): void {
  healStop.tempDir = dir;
}

/** Handle SIGINT and SIGTERM for the current heal run. A second call does nothing. */
export function installHealStopHandlers(): void {
  if (healStopHandlersOn) return;
  process.on('SIGINT', onHealStop);
  process.on('SIGTERM', onHealStop);
  healStopHandlersOn = true;
}

/** Drop the interrupt handlers. Later commands are not tied to this heal run. */
export function removeHealStopHandlers(): void {
  if (!healStopHandlersOn) return;
  process.off('SIGINT', onHealStop);
  process.off('SIGTERM', onHealStop);
  healStopHandlersOn = false;
  healStop.child = null;
  healStop.tempDir = null;
  healStopInProgress = false;
}

/** Run heal without a shell. The child is killed when the timeout fires. */
export function runHealCommand(args: readonly string[], timeoutMs: number = healTimeoutMs()): Promise<HealCommandResult> {
  const { command, argv } = healCommand(args);
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
    const ownedTemp = healStop.tempDir ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-flaky-heal-'));
    if (ownedTemp) bindHealTempDir(ownedTemp);
    const tempRoot = healStop.tempDir ?? os.tmpdir();
    const child = spawn(command, argv, {
      shell: false,
      windowsHide: true,
      env: rerunChildEnv(tempRoot),
      // A new process group so the timeout can kill grandchildren. Not on
      // Windows, where it opens a console window and taskkill /T is used.
      detached: DETACH_CHILDREN,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      // A timeout or a stop signal owns the kill and the folder removal.
      // Walking after a clean exit would miss a descendant that was already reparented.
      if (timedOut || healStopInProgress) return;
      if (healStop.child === child) bindHealChild(null);
      releaseOwned();
      finish({ args, argv, command, exitCode, stdout, stderr, timedOut });
    });
  });
}

function removeHealTemp(dir: string | null): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // The folder is already gone.
  }
}

function isForbidden(arg: string): boolean {
  if ((FORBIDDEN_HEAL_ARGS as readonly string[]).includes(arg)) return true;
  return FORBIDDEN_HEAL_ARGS.some((flag) => arg.startsWith(`${flag}=`));
}
