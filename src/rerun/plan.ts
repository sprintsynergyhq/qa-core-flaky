import type { RerunMode, TestRecord } from '../model.js';
import { homeMarks, redactHomeText } from '../report-path.js';
import { escapeRegex, shellQuote } from './quote.js';

export type PlanOptions = {
  /** Ids the caller named. An id that is not in the report is refused. */
  only?: readonly string[];
  /** How many failing tests to keep. Default 20. */
  maxTests?: number;
  /** How many times repeat and isolated run each test. Default 5. */
  times?: number;
  /** Default is repeat and isolated. */
  modes?: readonly RerunMode[];
  /** Playwright config passed through as `--config`. */
  config?: string;
  /** Directory Playwright should use for artifacts. The caller owns cleanup. */
  outputDir?: string;
};

export type PlannedRun = {
  mode: RerunMode;
  /** Set for repeat and isolated. Omitted for an in-order file run. */
  testId?: string;
  file: string;
  /** Arguments after `npx playwright test`. An array, never a shell string. */
  args: string[];
  /** 0-based index of this invocation inside the mode for this test or file. */
  runIndex: number;
  /** Commit on the record this run came from, when it has one. */
  commitSha?: string;
};

export type RunCap = {
  maxTests: number;
  times: number;
  modes: RerunMode[];
  failing: number;
  selected: number;
  /** How many `npx playwright test` commands the plan will run. */
  commands: number;
};

export type RerunPlan = {
  tests: TestRecord[];
  runs: PlannedRun[];
  cap: RunCap;
};

const DEFAULT_TIMES = 5;
const DEFAULT_MAX_TESTS = 20;
const DEFAULT_MODES: readonly RerunMode[] = ['repeat', 'isolated'];
const MODE_NAMES: readonly RerunMode[] = ['repeat', 'isolated', 'in-order'];

/**
 * Choose failing tests and the Playwright argument arrays that rerun them.
 * Passing tests are skipped. `--only` may name a passing test, and that test
 * is skipped. An id that is not in the report throws.
 * Selection order is the order of first appearance in `records`.
 */
export function planReruns(records: readonly TestRecord[], options: PlanOptions = {}): RerunPlan {
  const times = readPositive(options.times, DEFAULT_TIMES, 'times');
  const maxTests = readPositive(options.maxTests, DEFAULT_MAX_TESTS, 'max-tests');
  const modes = readModes(options.modes);
  const known = new Map<string, TestRecord[]>();
  for (const record of records) {
    const list = known.get(record.id) ?? [];
    list.push(record);
    known.set(record.id, list);
  }
  if (options.only) {
    for (const id of options.only) {
      if (!findRecord(records, id)) {
        throw new Error(`Unknown test id ${id}`);
      }
    }
  }
  const failing: TestRecord[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    const group = known.get(record.id) ?? [record];
    const failed = group.some((item) => item.outcome === 'failed' || item.outcome === 'flaky');
    if (!failed) continue;
    if (options.only && !options.only.some((id) => matchesOnly(record, id))) continue;
    failing.push(record);
  }
  const selected = failing.slice(0, maxTests);
  const runs = buildRuns(selected, modes, times, options.config, options.outputDir);
  return {
    tests: selected,
    runs,
    cap: {
      maxTests,
      times,
      modes: [...modes],
      failing: failing.length,
      selected: selected.length,
      commands: runs.length,
    },
  };
}

export function formatCap(cap: RunCap): string {
  return `Cap: max-tests ${cap.maxTests}, times ${cap.times}, modes ${cap.modes.join(',')}. Selected ${cap.selected} of ${cap.failing} failing tests. Commands ${cap.commands}.`;
}

/**
 * One Playwright invocation.
 * Repeat uses `--repeat-each`. Isolated repeats the invocation `times` times
 * with `-g`. In-order runs the file once with no `-g`. Every mode uses
 * `--retries 0` and `--workers 1`. `--update-snapshots` is never set.
 */
export function buildPlaywrightArgs(input: {
  file: string;
  title?: string;
  mode: RerunMode;
  times: number;
  config?: string;
  project?: string;
  outputDir?: string;
}): string[] {
  const args: string[] = [];
  if (input.config) args.push('--config', input.config);
  args.push('--retries', '0', '--workers', '1', '--reporter', 'json');
  if (input.mode === 'repeat') args.push('--repeat-each', String(input.times));
  // Playwright 1.60.0 declares `--project <project-name...>`. A separate
  // value would swallow the file filter that follows. One `--project=name`
  // argument keeps the file as a positional test filter.
  if (input.project && input.project !== 'default') args.push(`--project=${input.project}`);
  if (input.outputDir) args.push('--output', input.outputDir);
  args.push(escapeRegex(input.file));
  // Playwright 1.60.0 matches `-g` against the file title, describe titles,
  // and the test title joined by spaces. `$` keeps the match at the end of
  // that string. The title is escaped first, so `$` is the anchor.
  if (input.title !== undefined) args.push('-g', `${escapeRegex(input.title)}$`);
  if (args.includes('--update-snapshots') || args.includes('-u')) {
    throw new Error('Refusing to pass --update-snapshots');
  }
  return args;
}

/**
 * The command a person can copy. Homes are redacted. When redaction changes
 * the `-g` title, the printed command omits `-g` and says the title was redacted.
 * The process still receives the raw title.
 */
export function formatPrintedCommand(args: readonly string[], record?: TestRecord): string {
  const raw = ['npx', 'playwright', 'test', ...args].map((part) => shellQuote(part)).join(' ');
  const marks = record ? marksFor(record) : undefined;
  const printed = marks ? redactHomeText(raw, marks) : redactHomeText(raw);
  const grepAt = args.indexOf('-g');
  const title = grepAt === -1 ? undefined : args[grepAt + 1];
  const titleChanged = title !== undefined && marks !== undefined && redactHomeText(title, marks) !== title;
  if (!titleChanged) return printed;
  if (grepAt === -1) return printed;
  const kept = args.filter((part, index) => part !== '-g' && args[index - 1] !== '-g');
  const again = ['npx', 'playwright', 'test', ...kept].map((part) => shellQuote(part)).join(' ');
  const shown = marks ? redactHomeText(again, marks) : redactHomeText(again);
  return `${shown} (the title was redacted, so -g is omitted here)`;
}

export function shellCommand(reportPath: string, id: string): string {
  return `qa-core-flaky rerun --from ${shellQuote(reportPath)} --only ${shellQuote(id)}`;
}

function buildRuns(
  tests: readonly TestRecord[],
  modes: readonly RerunMode[],
  times: number,
  config: string | undefined,
  outputDir: string | undefined,
): PlannedRun[] {
  const runs: PlannedRun[] = [];
  for (const mode of modes) {
    if (mode === 'in-order') {
      const seen = new Set<string>();
      for (const record of tests) {
        if (seen.has(record.file)) continue;
        seen.add(record.file);
        assertRunnableFile(record.file);
        runs.push({
          mode,
          file: record.file,
          runIndex: 0,
          commitSha: record.source.commitSha,
          args: buildPlaywrightArgs({
            file: record.file,
            mode,
            times,
            config,
            project: record.project,
            outputDir,
          }),
        });
      }
      continue;
    }
    for (const record of tests) {
      assertRunnableFile(record.file);
      const title = record.titlePath.join(' ');
      const copies = mode === 'isolated' ? times : 1;
      for (let runIndex = 0; runIndex < copies; runIndex += 1) {
        runs.push({
          mode,
          testId: record.id,
          file: record.file,
          runIndex,
          commitSha: record.source.commitSha,
          args: buildPlaywrightArgs({
            file: record.file,
            title,
            mode,
            times,
            config,
            project: record.project,
            outputDir,
          }),
        });
      }
    }
  }
  return runs;
}

function assertRunnableFile(file: string): void {
  if (file.includes('<home') || file.includes('<file~') || file.includes('<text:')) {
    throw new Error(`Cannot rerun ${file} because the file path was redacted`);
  }
}

function readPositive(value: number | undefined, fallback: number, name: string): number {
  const picked = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(picked) || picked < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return picked;
}

function readModes(modes: readonly RerunMode[] | undefined): RerunMode[] {
  const picked = modes === undefined ? [...DEFAULT_MODES] : [...modes];
  if (picked.length === 0) throw new Error('At least one mode is required');
  for (const mode of picked) {
    if (!MODE_NAMES.includes(mode)) throw new Error(`Unknown mode ${mode}`);
  }
  return picked;
}

function findRecord(records: readonly TestRecord[], id: string): TestRecord | undefined {
  return records.find((record) => matchesOnly(record, id));
}

function matchesOnly(record: TestRecord, id: string): boolean {
  if (record.id === id) return true;
  return redactHomeText(record.id, marksFor(record)) === id;
}

function marksFor(record: TestRecord) {
  return homeMarks([record.id, record.titlePath.join(' '), record.file]);
}
