import { spawn } from 'node:child_process';

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
  return { command: 'npx', argv: ['qa-core-heal', ...args] };
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
  if (!Number.isSafeInteger(parsed) || parsed > 120_000) return DEFAULT_TIMEOUT_MS;
  return parsed;
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
    const child = spawn(command, argv, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < 200_000) stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 20_000) stderr += chunk;
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
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
      finish({ args, argv, command, exitCode, stdout, stderr, timedOut });
    });
  });
}

function isForbidden(arg: string): boolean {
  if ((FORBIDDEN_HEAL_ARGS as readonly string[]).includes(arg)) return true;
  return FORBIDDEN_HEAL_ARGS.some((flag) => arg.startsWith(`${flag}=`));
}
