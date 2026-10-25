import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestRecord } from '../model.js';
import { parsePlaywrightJson } from '../parsers/playwright-json.js';
import { redactHomeText } from '../report-path.js';
import { commitFor, mergeRerunRecords, tagRerunAttempts } from './merge.js';
import { formatPrintedCommand, type PlannedRun, type RerunPlan } from './plan.js';

/** Signals that stop a rerun. The child process group is killed before the temp directory is removed. */
export const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

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
  kill?: (pid: number) => void;
};

/**
 * Kill the child process group, then delete the temp directory.
 * A kill that throws still deletes the directory.
 */
export function releaseRun(state: ReleaseState): void {
  if (state.pid !== undefined) {
    const kill = state.kill ?? killProcessGroup;
    try {
      kill(state.pid);
    } catch {
      // The directory is still removed.
    }
  }
  if (state.dir) fs.rmSync(state.dir, { recursive: true, force: true });
}

/** Call `release`, then re-raise the signal. Tests pass their own re-raise. */
export function onStopSignal(
  signal: NodeJS.Signals,
  release: () => void,
  reraise: (signal: NodeJS.Signals) => void,
): void {
  release();
  reraise(signal);
}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The process is already gone.
    }
  }
}

/**
 * Run the plan, parse each JSON report, and merge the attempts into `records`.
 * The temp directory is removed on success, on failure, and on stop signals.
 * `runner` is for tests. The default runner is `npx playwright test` only.
 */
export async function executePlan(input: {
  records: readonly TestRecord[];
  plan: RerunPlan;
  cwd: string;
  commitSha?: string;
  print: (line: string) => void;
  runner?: CommandRunner;
}): Promise<TestRecord[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-flaky-rerun-'));
  const state: ReleaseState = { dir };
  const handlers = new Map<NodeJS.Signals, () => void>();
  const useSignals = input.runner === undefined;
  if (useSignals) {
    for (const signal of STOP_SIGNALS) {
      const handler = () => {
        onStopSignal(signal, () => releaseRun(state), (raised) => {
          process.removeListener(raised, handler);
          process.kill(process.pid, raised);
        });
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
  }
  const runner = input.runner ?? defaultRunner;
  let merged = input.records.map((record) => ({ ...record, attempts: [...record.attempts] }));
  try {
    for (const run of input.plan.runs) {
      const outputDir = path.join(dir, `out-${run.mode}-${run.runIndex}-${safeName(run.testId ?? run.file)}`);
      fs.mkdirSync(outputDir, { recursive: true });
      const args = withOutput(run.args, outputDir);
      const record = input.records.find((item) => item.id === run.testId) ?? input.records.find((item) => item.file === run.file);
      input.print(formatPrintedCommand(args, record));
      const stdoutFile = path.join(dir, `report-${run.mode}-${run.runIndex}-${safeName(run.testId ?? run.file)}.json`);
      const result = await runner(args, input.cwd, stdoutFile, (pid) => {
        state.pid = pid;
      });
      state.pid = undefined;
      if (!fs.existsSync(stdoutFile)) {
        const detail = redactHomeText(oneLine(result.stderr || 'Playwright wrote no JSON report'));
        throw new Error(detail || 'Playwright wrote no JSON report');
      }
      const text = fs.readFileSync(stdoutFile, 'utf8');
      let parsed;
      try {
        parsed = parsePlaywrightJson(text, stdoutFile);
      } catch (error) {
        const detail = redactHomeText(oneLine(error instanceof Error ? error.message : 'Could not parse the rerun report'));
        throw new Error(detail || 'Could not parse the rerun report');
      }
      const wanted = run.testId;
      const picked = wanted ? parsed.records.filter((item) => item.id === wanted) : parsed.records;
      const commit = run.commitSha ?? commitFor(input.records, wanted ?? picked[0]?.id ?? '', input.commitSha);
      const tagged = tagRerunAttempts(picked, run.mode, run.runIndex, commit);
      merged = mergeRerunRecords(merged, tagged);
    }
    return merged;
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    releaseRun(state);
    state.dir = undefined;
  }
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

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40);
}

function oneLine(message: string): string {
  return message.replaceAll('\n', ' ').trim();
}

function defaultRunner(
  args: readonly string[],
  cwd: string,
  stdoutFile: string,
  setPid: (pid: number) => void,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn('npx', ['playwright', 'test', ...args], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid !== undefined) setPid(child.pid);
    const stdout = fs.createWriteStream(stdoutFile);
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
