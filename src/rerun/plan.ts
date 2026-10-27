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
  /**
   * Playwright `--retries`. Default 0. A retry inside the rerun can hide a
   * first-attempt failure and record a pass. Pass the CI retry count when
   * that is what you want to measure.
   */
  retries?: number;
  /** Directory Playwright should use for artifacts. The caller owns cleanup. */
  outputDir?: string;
};

export type PlannedRun = {
  mode: RerunMode;
  /** Set for repeat and isolated. Omitted for an in-order file run. */
  testId?: string;
  file: string;
  project: string;
  /**
   * Spec line, only when that line is unique for this file and project in
   * the report. Isolated and repeat then use `file:line`. A shared line is
   * omitted and `-g` is used instead.
   */
  line?: number;
  /** Arguments after the Playwright binary. An array, never a shell string. */
  args: string[];
  /** 0-based index of this invocation inside the mode for this test or file. */
  runIndex: number;
  /** Commit on the record this run came from, when it has one. */
  commitSha?: string;
};

export type RunCap = {
  maxTests: number;
  times: number;
  /** Playwright `--retries` for every command. Default 0. */
  retries: number;
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

/**
 * Safety caps. Defaults stay inside these limits.
 * `--times` 5 and `--max-tests` 20 with repeat and isolated is 120 commands.
 */
export const RERUN_LIMITS = {
  times: 20,
  maxTests: 50,
  retries: 10,
  commands: 400,
} as const;

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
  const times = readPositive(options.times, DEFAULT_TIMES, 'times', RERUN_LIMITS.times);
  const maxTests = readPositive(options.maxTests, DEFAULT_MAX_TESTS, 'max-tests', RERUN_LIMITS.maxTests);
  const retries = readRetries(options.retries);
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
  const runs = buildRuns(records, selected, modes, times, retries, options.config, options.outputDir);
  if (runs.length > RERUN_LIMITS.commands) {
    throw new Error(
      `The plan has ${runs.length} commands. The limit is ${RERUN_LIMITS.commands}. Lower --times or --max-tests.`,
    );
  }
  return {
    tests: selected,
    runs,
    cap: {
      maxTests,
      times,
      retries,
      modes: [...modes],
      failing: failing.length,
      selected: selected.length,
      commands: runs.length,
    },
  };
}

export function formatCap(cap: RunCap): string {
  return `Cap: max-tests ${cap.maxTests}, times ${cap.times}, retries ${cap.retries}, modes ${cap.modes.join(',')}. Selected ${cap.selected} of ${cap.failing} failing tests. Commands ${cap.commands}.`;
}

/**
 * One Playwright invocation.
 * Repeat uses `--repeat-each`. Isolated repeats the invocation `times` times.
 * In-order runs the file once with no title filter. Every mode uses
 * `--retries` (default 0) and `--workers 1`. `--update-snapshots` is never set.
 * Pass `line` only when that line is unique for the file and project.
 * `file:line` then selects that location. Otherwise `-g` is a fully
 * anchored, case-sensitive pattern over the project, the file, and the
 * title path, with room for trailing tags. A newline in a title is the
 * escape `\\n` inside that pattern.
 */
export function buildPlaywrightArgs(input: {
  file: string;
  titlePath?: readonly string[];
  line?: number;
  mode: RerunMode;
  times: number;
  /** Playwright `--retries`. Omitted means 0. */
  retries?: number;
  config?: string;
  project?: string;
  outputDir?: string;
}): string[] {
  const project = input.project ?? '';
  if (project.includes('*') || project.includes('?')) {
    throw new Error(`Project name ${project} contains a wildcard. Pass the exact project name.`);
  }
  const args: string[] = [];
  if (input.config) args.push('--config', input.config);
  const retries = input.retries ?? 0;
  args.push('--retries', String(retries), '--workers', '1', '--reporter', 'json');
  if (input.mode === 'repeat') args.push('--repeat-each', String(input.times));
  // Playwright 1.60.0 declares `--project <project-name...>`. One
  // `--project=name` argument keeps the following file filter positional.
  // A project named `default` is still passed. Playwright treats `*` as a
  // wildcard, so a name with `*` or `?` is refused above.
  if (project !== '') args.push(`--project=${project}`);
  if (input.outputDir) args.push('--output', input.outputDir);
  const useLine = input.line !== undefined && Number.isInteger(input.line) && input.line > 0;
  if (!useLine && input.titlePath && input.titlePath.length > 0 && project !== '') {
    args.push('-g', anchoredGrep(project, input.file, input.titlePath));
  }
  // `--` keeps a file name that starts with `-` from being read as an option.
  args.push('--', fileFilterArg(input.file, useLine ? input.line : undefined));
  if (args.includes('--update-snapshots') || args.includes('-u')) {
    throw new Error('Refusing to pass --update-snapshots');
  }
  return args;
}

/**
 * Case-sensitive grep for Playwright 1.60.0.
 * A value wrapped in slashes is compiled with those flags only, so this
 * pattern does not use `i`. The grep title is the project, the file, the
 * describe titles, the test title, and any tags, joined by spaces.
 * Tags may follow any of those parts. `^` and `$` keep `save` from matching
 * `autosave`, and a full path keeps `Outer child` from matching both a
 * describe child and a different test when the title paths differ.
 * A newline in a part is written as `\\n`. Playwright's `.` does not match
 * a newline, and a raw newline would keep this value from being read as
 * `/pattern/`.
 */
export function anchoredGrep(project: string, file: string, titlePath: readonly string[]): string {
  const parts = [project, file.replaceAll('\\', '/'), ...titlePath];
  const body = parts.map((part) => `${escapeSlash(part)}(?: @\\S+)*`).join(' ');
  return `/^${body}$/`;
}

/**
 * File filter. `line` selects that spec line. The pattern is anchored.
 * `executePlan` replaces a relative path with the absolute file when it
 * can resolve one, so `tests/login.spec.ts` does not also match
 * `old/tests/login.spec.ts`.
 */
export function fileFilterArg(file: string, line?: number): string {
  return exactFileArg(file.replaceAll('\\', '/'), line);
}

/** Exact path, anchored, with an optional `:line`. Slashes are escaped inside `/.../`. */
export function exactFileArg(filePath: string, line?: number): string {
  const wrapped = `/^${escapeSlash(filePath)}$/`;
  if (line === undefined) return wrapped;
  return `${wrapped}:${line}`;
}

/**
 * The command a person can copy. Every argument is redacted. The file
 * filter keeps the escapes the process received. Only the home segment
 * becomes `<home>`. When redaction changes the `-g` title, the printed
 * command omits `-g` and says the title was redacted. The process still
 * receives the raw title.
 */
export function formatPrintedCommand(
  args: readonly string[],
  record?: TestRecord,
  prefix: readonly string[] = [],
): string {
  const marks = record ? marksFor(record) : undefined;
  const redact = (value: string) => (marks ? redactHomeText(value, marks) : redactHomeText(value));
  const grepAt = args.indexOf('-g');
  const title = grepAt === -1 ? undefined : args[grepAt + 1];
  // The check opens `\/` on a copy so a home in the title is visible.
  // The printed argument stays escaped.
  const visibleTitle = title?.replaceAll('\\/', '/');
  const titleChanged = visibleTitle !== undefined && redact(visibleTitle) !== visibleTitle;
  const kept = titleChanged ? args.filter((part, index) => part !== '-g' && args[index - 1] !== '-g') : args;
  const shown = [...prefix, ...kept].map((part) => shellQuote(redact(part))).join(' ');
  if (!titleChanged) return shown;
  return `${shown} (the title was redacted, so -g is omitted here)`;
}

export function shellCommand(reportPath: string, id: string, configFile?: string): string {
  const parts = ['qa-core-flaky rerun', '--from', shellQuote(reportPath), '--only', shellQuote(id)];
  if (configFile) parts.push('--config', shellQuote(configFile));
  return parts.join(' ');
}

function escapeSlash(value: string): string {
  return escapeRegex(value)
    .replaceAll('/', '\\/')
    .replaceAll('\r\n', '\\n')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\n');
}

function buildRuns(
  records: readonly TestRecord[],
  tests: readonly TestRecord[],
  modes: readonly RerunMode[],
  times: number,
  retries: number,
  config: string | undefined,
  outputDir: string | undefined,
): PlannedRun[] {
  const lines = lineOwners(records);
  const runs: PlannedRun[] = [];
  for (const mode of modes) {
    if (mode === 'in-order') {
      const seen = new Set<string>();
      for (const record of tests) {
        const key = `${record.project}\0${record.file}`;
        if (seen.has(key)) continue;
        seen.add(key);
        assertRunnableFile(record.file);
        assertProject(record.project);
        runs.push({
          mode,
          file: record.file,
          project: record.project,
          runIndex: 0,
          commitSha: record.source.commitSha,
          args: buildPlaywrightArgs({
            file: record.file,
            mode,
            times,
            retries,
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
      assertProject(record.project);
      const line = uniqueLine(lines, record);
      const copies = mode === 'isolated' ? times : 1;
      for (let runIndex = 0; runIndex < copies; runIndex += 1) {
        runs.push({
          mode,
          testId: record.id,
          file: record.file,
          project: record.project,
          line,
          runIndex,
          commitSha: record.source.commitSha,
          args: buildPlaywrightArgs({
            file: record.file,
            titlePath: record.titlePath,
            line,
            mode,
            times,
            retries,
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

/**
 * `file:line` selects every test on that line, and every test in a describe
 * that starts on that line. Use it only when one report id has that file,
 * project, and line. A passing neighbor counts. Otherwise the plan uses `-g`.
 */
function lineOwners(records: readonly TestRecord[]): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const record of records) {
    if (!usableLine(record.line)) continue;
    const key = lineKey(record.project, record.file, record.line);
    const ids = owners.get(key) ?? new Set<string>();
    ids.add(record.id);
    owners.set(key, ids);
  }
  return owners;
}

function uniqueLine(owners: Map<string, Set<string>>, record: TestRecord): number | undefined {
  if (!usableLine(record.line)) return undefined;
  const ids = owners.get(lineKey(record.project, record.file, record.line));
  if (!ids || ids.size !== 1) return undefined;
  return record.line;
}

function lineKey(project: string, file: string, line: number): string {
  return `${project}\0${file.replaceAll('\\', '/')}\0${line}`;
}

function usableLine(line: number | undefined): line is number {
  return line !== undefined && Number.isInteger(line) && line > 0;
}

function assertRunnableFile(file: string): void {
  if (file.includes('<home') || file.includes('<file~') || file.includes('<text:')) {
    throw new Error(`Cannot rerun ${file} because the file path was redacted`);
  }
}

function assertProject(project: string): void {
  if (project.includes('*') || project.includes('?')) {
    throw new Error(`Project name ${project} contains a wildcard. Pass the exact project name.`);
  }
}

function readRetries(value: number | undefined): number {
  const picked = value === undefined ? 0 : value;
  if (!Number.isSafeInteger(picked) || picked < 0 || picked > RERUN_LIMITS.retries) {
    throw new Error(`retries must be from 0 to ${RERUN_LIMITS.retries}. Got ${String(value)}.`);
  }
  return picked;
}

function readPositive(value: number | undefined, fallback: number, name: string, max: number): number {
  const picked = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(picked) || picked < 1 || picked > max) {
    throw new Error(`${name} must be from 1 to ${max}. Got ${String(value)}.`);
  }
  return picked;
}

function readModes(modes: readonly RerunMode[] | undefined): RerunMode[] {
  const picked = modes === undefined ? [...DEFAULT_MODES] : [...modes];
  if (picked.length === 0) throw new Error('At least one mode is required');
  const seen = new Set<string>();
  for (const mode of picked) {
    if (!MODE_NAMES.includes(mode)) throw new Error(`Unknown mode ${mode}`);
    if (seen.has(mode)) throw new Error(`Duplicate mode ${mode}`);
    seen.add(mode);
  }
  return picked;
}

function findRecord(records: readonly TestRecord[], id: string): TestRecord | undefined {
  return records.find((record) => matchesOnly(record, id));
}

function matchesOnly(record: TestRecord, id: string): boolean {
  const marks = marksFor(record);
  const redacted = redactHomeText(record.id, marks);
  for (const form of onlyForms(id)) {
    if (record.id === form || redacted === form) return true;
  }
  return false;
}

/**
 * The Markdown next step writes a newline in the id as `\` and `n`.
 * `--only` accepts that pair, and a real newline, as the same id.
 */
function onlyForms(id: string): string[] {
  if (!id.includes('\\n') && !id.includes('\\r')) return [id];
  const unfolded = id.replaceAll('\\r\\n', '\n').replaceAll('\\n', '\n').replaceAll('\\r', '\n');
  return unfolded === id ? [id] : [id, unfolded];
}

function marksFor(record: TestRecord) {
  return homeMarks([record.id, record.titlePath.join(' '), record.file]);
}
