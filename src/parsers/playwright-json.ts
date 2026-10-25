import { makeTestId } from '../id.js';
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

/** CSI and single-character ANSI escapes used by Playwright error text. */
const ANSI_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

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
): ParseResult {
  const data = parseJson(text, reportPath);
  const suites = data.suites;
  if (!Array.isArray(suites)) {
    throw new Error(`Report ${reportPath} has no suites array`);
  }

  const rootDir = readRootDir(data);
  const warnings: string[] = [];
  const records: TestRecord[] = [];
  const source = buildSource(reportPath, meta);

  for (const suite of suites) {
    walkSuite(suite, [], undefined, rootDir, source, reportPath, records, warnings);
  }

  return {
    schemaVersion: 1,
    records,
    warnings,
  };
}

function parseJson(text: string, reportPath: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Invalid JSON in report ${reportPath}`);
  }
  if (!isObject(value)) {
    throw new Error(`Report ${reportPath} has no suites array`);
  }
  return value;
}

function buildSource(reportPath: string, meta?: Partial<SourceInfo>): SourceInfo {
  const source: SourceInfo = {
    format: 'playwright-json',
    reportPath,
  };
  if (meta?.runId !== undefined) source.runId = meta.runId;
  if (meta?.commitSha !== undefined) source.commitSha = meta.commitSha;
  if (meta?.branch !== undefined) source.branch = meta.branch;
  if (meta?.createdAt !== undefined) source.createdAt = meta.createdAt;
  return source;
}

function readRootDir(data: JsonObject): string | undefined {
  const config = data.config;
  if (!isObject(config)) return undefined;
  const rootDir = config.rootDir;
  if (typeof rootDir !== 'string' || rootDir === '' || rootDir === '.') return undefined;
  return stripTrailingSlash(rootDir.replaceAll('\\', '/'));
}

function walkSuite(
  suite: unknown,
  titleStack: string[],
  inheritedFile: string | undefined,
  rootDir: string | undefined,
  source: SourceInfo,
  reportPath: string,
  records: TestRecord[],
  warnings: string[],
): void {
  if (!isObject(suite)) return;

  const suiteFile = relativePath(asString(suite.file), rootDir) ?? inheritedFile;
  const suiteTitle = asString(suite.title) ?? '';
  const nextStack = isFileSuiteTitle(suiteTitle, suiteFile)
    ? titleStack
    : [...titleStack, suiteTitle];

  const specs = suite.specs;
  if (Array.isArray(specs)) {
    for (const spec of specs) {
      readSpec(spec, nextStack, suiteFile, rootDir, source, reportPath, records, warnings);
    }
  }

  const children = suite.suites;
  if (Array.isArray(children)) {
    for (const child of children) {
      walkSuite(child, nextStack, suiteFile, rootDir, source, reportPath, records, warnings);
    }
  }
}

function readSpec(
  spec: unknown,
  titleStack: string[],
  inheritedFile: string | undefined,
  rootDir: string | undefined,
  source: SourceInfo,
  reportPath: string,
  records: TestRecord[],
  warnings: string[],
): void {
  if (!isObject(spec)) return;

  const specTitle = asString(spec.title) ?? '';
  const titlePath = [...titleStack, specTitle];
  const file = relativePath(asString(spec.file), rootDir) ?? inheritedFile ?? '';
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
      .map((result) => readAttempt(result, rootDir))
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
  }
}

function readAttempt(result: JsonObject, rootDir: string | undefined): Attempt {
  const status = attemptStatus(result.status);
  const attempt: Attempt = {
    retry: typeof result.retry === 'number' ? result.retry : 0,
    status,
    durationMs: typeof result.duration === 'number' ? result.duration : 0,
    errors: readErrors(result, rootDir),
    attachments: readAttachments(result.attachments, rootDir),
  };
  if (typeof result.workerIndex === 'number') attempt.workerIndex = result.workerIndex;
  if (typeof result.startTime === 'string') attempt.startTime = result.startTime;
  return attempt;
}

function readErrors(result: JsonObject, rootDir: string | undefined): AttemptError[] {
  const raw = Array.isArray(result.errors)
    ? result.errors
    : result.error !== undefined
      ? [result.error]
      : [];
  const errors: AttemptError[] = [];
  for (const item of raw) {
    const error = readError(item, rootDir);
    if (error) errors.push(error);
  }
  return errors;
}

function readError(item: unknown, rootDir: string | undefined): AttemptError | undefined {
  if (typeof item === 'string') {
    return { message: stripAnsi(item) };
  }
  if (!isObject(item)) return undefined;
  const message = stripAnsi(asString(item.message) ?? '');
  const error: AttemptError = { message };
  const stack = asString(item.stack);
  if (stack !== undefined) error.stack = relativizeText(stripAnsi(stack), rootDir);
  const location = readLocation(item.location, rootDir);
  if (location) error.location = location;
  return { ...error, message: relativizeText(message, rootDir) };
}

function readLocation(
  value: unknown,
  rootDir: string | undefined,
): AttemptError['location'] | undefined {
  if (!isObject(value)) return undefined;
  const file = asString(value.file);
  const line = value.line;
  const column = value.column;
  if (file === undefined || typeof line !== 'number' || typeof column !== 'number') return undefined;
  return {
    file: relativePath(file, rootDir) ?? file.replaceAll('\\', '/'),
    line,
    column,
  };
}

function readAttachments(value: unknown, rootDir: string | undefined): Attachment[] {
  if (!Array.isArray(value)) return [];
  const attachments: Attachment[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const name = asString(item.name) ?? '';
    const contentType = asString(item.contentType) ?? '';
    const attachment: Attachment = { name, contentType };
    const filePath = asString(item.path);
    if (filePath !== undefined) {
      attachment.path = relativePath(filePath, rootDir) ?? filePath.replaceAll('\\', '/');
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

function isFileSuiteTitle(title: string, file: string | undefined): boolean {
  if (title === '') return true;
  if (!file) return false;
  const normalizedTitle = title.replaceAll('\\', '/');
  const base = file.split('/').pop() ?? file;
  return normalizedTitle === file || normalizedTitle === base;
}

function relativePath(file: string | undefined, rootDir: string | undefined): string | undefined {
  if (file === undefined) return undefined;
  const normalized = stripTrailingSlash(file.replaceAll('\\', '/'));
  if (!rootDir) return normalized;
  if (normalized === rootDir) return '';
  if (normalized.startsWith(`${rootDir}/`)) return normalized.slice(rootDir.length + 1);
  return normalized;
}

function relativizeText(text: string, rootDir: string | undefined): string {
  if (!rootDir || !text.includes(rootDir)) return text;
  return text.split(`${rootDir}/`).join('').split(rootDir).join('.');
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
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
