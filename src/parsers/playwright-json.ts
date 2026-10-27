import { disambiguateHomeFiles, makeTestId } from '../id.js';
import type {
  Attempt,
  AttemptError,
  AttemptStatus,
  Attachment,
  Outcome,
  ParseResult,
  SourceInfo,
  TestRecord,
} from '../model.js';
import { stripLeadingBom } from './detect.js';
import { normalizeSlashes, relativizeText, runnableConfigPath, stripAnsi, toPortablePath } from '../report-path.js';

const ATTEMPT_STATUSES: readonly AttemptStatus[] = [
  'passed',
  'failed',
  'timedOut',
  'skipped',
  'interrupted',
];

const EXPECTED_STATUSES: readonly TestRecord['expectedStatus'][] = [
  'passed',
  'failed',
  'skipped',
  'timedOut',
  'interrupted',
];

type JsonObject = Record<string, unknown>;

/**
 * Parse a Playwright JSON report into the normalized model.
 *
 * Keeps every result as an attempt, sorted by retry. Does not throw when
 * the report has extra fields this parser does not use. Throws when `text`
 * is not JSON or the document has no `suites` array. The thrown message
 * includes `reportPath`.
 */
export function parsePlaywrightJson(
  text: string,
  reportPath: string,
  meta?: Partial<SourceInfo>,
  cwd?: string,
): ParseResult {
  const data = parseJson(text, reportPath);
  const suites = data.suites;
  if (!Array.isArray(suites)) {
    throw new Error(`Report ${reportPath} has no suites array`);
  }

  const rootDir = readRootDir(data);
  const warnings: string[] = [];
  const records: TestRecord[] = [];
  const rawFiles: string[] = [];
  // The config path is relative to the triage working directory. `rootDir`
  // is the test directory when the config sets `testDir`, and a path
  // relative to that directory climbs with `..`.
  const source = buildSource(reportPath, meta, readGitCommit(data), readConfigFile(data, cwd), cwd);

  for (const suite of suites) {
    walkSuite(suite, [], undefined, undefined, rootDir, source, reportPath, records, rawFiles, warnings);
  }

  return {
    schemaVersion: 1,
    records: disambiguateHomeFiles(records, rawFiles),
    warnings,
  };
}

function parseJson(text: string, reportPath: string): JsonObject {
  const source = stripLeadingBom(text);
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new Error(`Invalid JSON in report ${reportPath}`);
  }
  if (!isObject(value)) {
    throw new Error(`Report ${reportPath} has no suites array`);
  }
  return value;
}

function buildSource(
  reportPath: string,
  meta: Partial<SourceInfo> | undefined,
  gitCommit: string | undefined,
  configFile: string | undefined,
  cwd: string | undefined,
): SourceInfo {
  const source: SourceInfo = {
    format: 'playwright-json',
    reportPath,
  };
  if (meta?.runId !== undefined) source.runId = meta.runId;
  const commit = typeof meta?.commitSha === 'string' && meta.commitSha.length > 0 ? meta.commitSha : gitCommit;
  if (commit) source.commitSha = commit;
  if (meta?.branch !== undefined) source.branch = meta.branch;
  if (meta?.createdAt !== undefined) source.createdAt = meta.createdAt;
  const config = meta?.configFile ?? configFile;
  if (config) source.configFile = runnableConfigPath(config, cwd);
  return source;
}

function readConfigFile(data: JsonObject, cwd: string | undefined): string | undefined {
  const config = data.config;
  if (!isObject(config)) return undefined;
  const file = config.configFile;
  if (typeof file !== 'string') return undefined;
  const trimmed = file.trim();
  if (trimmed === '' || trimmed === '.') return undefined;
  return runnableConfigPath(trimmed, cwd);
}

/** Playwright JSON stores the commit on `config.metadata.gitCommit`, or on the top-level metadata. */
function readGitCommit(data: JsonObject): string | undefined {
  const spots: unknown[] = [data.metadata];
  if (isObject(data.config)) spots.push(data.config.metadata);
  for (const spot of spots) {
    if (!isObject(spot)) continue;
    const sha = spot.gitCommit;
    if (typeof sha === 'string' && sha.trim().length > 0) return sha.trim();
  }
  return undefined;
}

function readRootDir(data: JsonObject): string | undefined {
  const config = data.config;
  if (!isObject(config)) return undefined;
  const rootDir = config.rootDir;
  if (typeof rootDir !== 'string' || rootDir === '' || rootDir === '.') return undefined;
  const normalized = normalizeSlashes(rootDir).replace(/\/$/, '');
  if (normalized === '' || normalized === '.') return undefined;
  return normalized;
}

function walkSuite(
  suite: unknown,
  titleStack: string[],
  inheritedFile: string | undefined,
  inheritedRaw: string | undefined,
  rootDir: string | undefined,
  source: SourceInfo,
  reportPath: string,
  records: TestRecord[],
  rawFiles: string[],
  warnings: string[],
): void {
  if (!isObject(suite)) return;

  const suiteRaw = asString(suite.file) ?? inheritedRaw;
  const suiteFile = toPortablePath(asString(suite.file), rootDir, warnings) ?? inheritedFile;
  const suiteTitle = asString(suite.title) ?? '';
  const nextStack = isFileSuiteTitle(suiteTitle, suiteFile, suite)
    ? titleStack
    : [...titleStack, suiteTitle];

  const specs = suite.specs;
  if (Array.isArray(specs)) {
    for (const spec of specs) {
      readSpec(spec, nextStack, suiteFile, suiteRaw, rootDir, source, reportPath, records, rawFiles, warnings);
    }
  }

  const children = suite.suites;
  if (Array.isArray(children)) {
    for (const child of children) {
      walkSuite(child, nextStack, suiteFile, suiteRaw, rootDir, source, reportPath, records, rawFiles, warnings);
    }
  }
}

function readSpec(
  spec: unknown,
  titleStack: string[],
  inheritedFile: string | undefined,
  inheritedRaw: string | undefined,
  rootDir: string | undefined,
  source: SourceInfo,
  reportPath: string,
  records: TestRecord[],
  rawFiles: string[],
  warnings: string[],
): void {
  if (!isObject(spec)) return;

  const specTitle = asString(spec.title) ?? '';
  const titlePath = [...titleStack, specTitle];
  const raw = asString(spec.file) ?? inheritedRaw ?? '';
  const file = toPortablePath(asString(spec.file), rootDir, warnings) ?? inheritedFile ?? '';
  const line = asLine(spec.line);
  const tests = spec.tests;
  if (!Array.isArray(tests)) return;

  for (const test of tests) {
    if (!isObject(test)) continue;
    const project = projectName(test.projectName);
    const id = makeTestId(file, project, titlePath);
    const results = Array.isArray(test.results) ? test.results : [];
    if (results.length === 0) {
      warnings.push(`No results for ${id}`);
    }

    const attempts = results
      .filter(isObject)
      .map((result) => readAttempt(result, rootDir, warnings))
      .sort((left, right) => left.retry - right.retry);

    const record: TestRecord = {
      id,
      file,
      project,
      titlePath,
      expectedStatus: expectedStatus(test.expectedStatus, id, reportPath, warnings),
      outcome: mapOutcome(test.status, attempts, id, reportPath, warnings),
      attempts,
      source,
    };
    if (line !== undefined) record.line = line;
    records.push(record);
    rawFiles.push(raw);
  }
}

function readAttempt(result: JsonObject, rootDir: string | undefined, warnings: string[]): Attempt {
  const status = attemptStatus(result.status);
  const attempt: Attempt = {
    retry: typeof result.retry === 'number' ? result.retry : 0,
    status,
    durationMs: typeof result.duration === 'number' ? result.duration : 0,
    errors: readErrors(result, rootDir, warnings),
    attachments: readAttachments(result.attachments, rootDir, warnings),
  };
  if (typeof result.workerIndex === 'number') attempt.workerIndex = result.workerIndex;
  if (typeof result.startTime === 'string') attempt.startTime = result.startTime;
  return attempt;
}

function readErrors(result: JsonObject, rootDir: string | undefined, warnings: string[]): AttemptError[] {
  const raw = Array.isArray(result.errors)
    ? result.errors
    : result.error !== undefined
      ? [result.error]
      : [];
  const errors: AttemptError[] = [];
  for (const item of raw) {
    const error = readError(item, rootDir, warnings);
    if (error) errors.push(error);
  }
  return errors;
}

function readError(item: unknown, rootDir: string | undefined, warnings: string[]): AttemptError | undefined {
  if (typeof item === 'string') {
    return { message: relativizeText(stripAnsi(item), rootDir, warnings) };
  }
  if (!isObject(item)) return undefined;
  const message = stripAnsi(asString(item.message) ?? '');
  const error: AttemptError = { message };
  const stack = asString(item.stack);
  if (stack !== undefined) error.stack = relativizeText(stripAnsi(stack), rootDir, warnings);
  const location = readLocation(item.location, rootDir, warnings);
  if (location) error.location = location;
  return { ...error, message: relativizeText(message, rootDir, warnings) };
}

function readLocation(
  value: unknown,
  rootDir: string | undefined,
  warnings: string[],
): AttemptError['location'] | undefined {
  if (!isObject(value)) return undefined;
  const file = asString(value.file);
  const line = value.line;
  const column = value.column;
  if (file === undefined || typeof line !== 'number' || typeof column !== 'number') return undefined;
  return {
    file: toPortablePath(file, rootDir, warnings) ?? '',
    line,
    column,
  };
}

function readAttachments(value: unknown, rootDir: string | undefined, warnings: string[]): Attachment[] {
  if (!Array.isArray(value)) return [];
  const attachments: Attachment[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const name = asString(item.name) ?? '';
    const contentType = asString(item.contentType) ?? '';
    const attachment: Attachment = { name, contentType };
    const filePath = asString(item.path);
    if (filePath !== undefined) {
      const portable = toPortablePath(filePath, rootDir, warnings);
      if (portable !== undefined) attachment.path = portable;
    }
    attachments.push(attachment);
  }
  return attachments;
}

/**
 * Map a Playwright test status onto the normalized outcome.
 * Unknown statuses become `failed` and add a warning. An `expected` test
 * whose every result was skipped becomes `skipped`.
 */
function mapOutcome(
  status: unknown,
  attempts: readonly Attempt[],
  id: string,
  reportPath: string,
  warnings: string[],
): Outcome {
  if (status === 'flaky') return 'flaky';
  if (status === 'unexpected') return 'failed';
  if (status === 'skipped') return 'skipped';
  if (status === 'expected') {
    if (attempts.length > 0 && attempts.every((attempt) => attempt.status === 'skipped')) {
      return 'skipped';
    }
    return 'passed';
  }
  warnings.push(`Unknown test status ${String(status)} for ${id} in ${reportPath}`);
  return 'failed';
}

function expectedStatus(
  value: unknown,
  id: string,
  reportPath: string,
  warnings: string[],
): TestRecord['expectedStatus'] {
  if (isExpectedStatus(value)) return value;
  warnings.push(`Unknown expectedStatus ${String(value)} for ${id} in ${reportPath}`);
  return 'passed';
}

function attemptStatus(value: unknown): AttemptStatus {
  if (isAttemptStatus(value)) return value;
  return 'failed';
}

function projectName(value: unknown): string {
  if (typeof value !== 'string') return 'default';
  const trimmed = value.trim();
  return trimmed === '' ? 'default' : trimmed;
}

/**
 * The file suite's title is the spec path, and Playwright 1.60.0 gives that
 * suite line 0. A describe has a source line. Its title stays in the path
 * even when the title equals the spec file name.
 */
function isFileSuiteTitle(title: string, file: string | undefined, suite: JsonObject): boolean {
  if (title === '') return true;
  const line = suite.line;
  if (typeof line === 'number' && line > 0) return false;
  if (!file) return false;
  const normalizedTitle = title.replaceAll('\\', '/');
  const base = file.split('/').pop() ?? file;
  return normalizedTitle === file || normalizedTitle === base;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asLine(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAttemptStatus(value: unknown): value is AttemptStatus {
  return typeof value === 'string' && ATTEMPT_STATUSES.some((status) => status === value);
}

function isExpectedStatus(value: unknown): value is TestRecord['expectedStatus'] {
  return typeof value === 'string' && EXPECTED_STATUSES.some((status) => status === value);
}
