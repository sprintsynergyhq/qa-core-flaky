import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { makeTestId } from '../id.js';
import type { Attempt, AttemptError, Attachment, Outcome, ParseResult, SourceInfo, TestRecord } from '../model.js';
import { relativizeText, stripAnsi, toPortablePath } from '../report-path.js';

/**
 * Warning used when a JUnit file has one result per test.
 * Playwright 1.60.0's default junit reporter does this: retries are not
 * separate testcase elements.
 */
const NO_ATTEMPT_WARNING =
  'junit report has no per-attempt data; flaky detection needs the JSON report or reruns';

const NO_PROJECT_WARNING = 'JUnit report has no project name; used default';

/** Playwright joins describe titles with a space, U+203A, and a space. */
const PLAYWRIGHT_TITLE_SEPARATOR = ' \u203A ';

const ARRAY_TAGS = new Set([
  'testsuite',
  'testcase',
  'failure',
  'error',
  'skipped',
  'system-out',
  'system-err',
]);

const ATTACHMENT_PATTERN = /\[\[ATTACHMENT\|([^\]]+)\]\]/g;

type XmlNode = Record<string, unknown>;

/**
 * fast-xml-parser decodes the five XML entities (`lt`, `gt`, `amp`, `apos`,
 * `quot`) and nothing else. `htmlEntities` is off. A DOCTYPE is removed
 * before parse, so custom entities and external entity identifiers are not
 * registered and are not fetched. The parser is not given an external entity
 * map. Attribute values stay strings.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  htmlEntities: false,
  processEntities: { enabled: true },
  isArray: (tagName: string) => ARRAY_TAGS.has(tagName),
});

/**
 * Parse a JUnit XML report into the normalized model.
 *
 * One testcase becomes one record with one attempt. A `failure` or `error`
 * child is `failed`, a `skipped` child is `skipped`, and anything else is
 * `passed`. Throws when the XML is not well formed. The thrown message
 * includes `reportPath`.
 */
export function parseJunit(text: string, reportPath: string, meta?: Partial<SourceInfo>): ParseResult {
  const data = parseXml(text, reportPath);
  const suites = readRootSuites(data);
  if (suites.length === 0) {
    throw new Error(`Report ${reportPath} has no testsuite`);
  }

  const warnings: string[] = [];
  const records: TestRecord[] = [];
  const missingProject = { value: false };
  const source = buildSource(reportPath, meta);

  for (const suite of suites) {
    walkSuite(suite, undefined, source, records, warnings, missingProject);
  }

  const ordered = [NO_ATTEMPT_WARNING];
  if (missingProject.value) ordered.push(NO_PROJECT_WARNING);
  return {
    schemaVersion: 1,
    records,
    warnings: [...ordered, ...warnings],
  };
}

function parseXml(text: string, reportPath: string): unknown {
  const withoutDoctype = stripDoctype(text);
  const validation = XMLValidator.validate(withoutDoctype, { allowBooleanAttributes: true });
  if (validation !== true) {
    throw new Error(`Invalid XML in report ${reportPath}`);
  }
  try {
    return parser.parse(withoutDoctype) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Could not parse XML';
    throw new Error(`Invalid XML in report ${reportPath}: ${detail.replaceAll('\n', ' ').trim()}`);
  }
}

function buildSource(reportPath: string, meta?: Partial<SourceInfo>): SourceInfo {
  const source: SourceInfo = {
    format: 'junit',
    reportPath,
  };
  if (meta?.runId !== undefined) source.runId = meta.runId;
  if (meta?.commitSha !== undefined) source.commitSha = meta.commitSha;
  if (meta?.branch !== undefined) source.branch = meta.branch;
  if (meta?.createdAt !== undefined) source.createdAt = meta.createdAt;
  return source;
}

function readRootSuites(data: unknown): unknown[] {
  if (!isObject(data)) return [];
  if (data.testsuites !== undefined) {
    const suites: unknown[] = [];
    for (const root of asArray(data.testsuites)) {
      if (isObject(root)) suites.push(...asArray(root.testsuite));
    }
    return suites;
  }
  if (data.testsuite !== undefined) return asArray(data.testsuite);
  return [];
}

function walkSuite(
  suite: unknown,
  inheritedProject: string | undefined,
  source: SourceInfo,
  records: TestRecord[],
  warnings: string[],
  missingProject: { value: boolean },
): void {
  if (!isObject(suite)) return;
  const ownProject = readHostname(suite);
  const project = ownProject ?? inheritedProject;
  for (const testcase of asArray(suite.testcase)) {
    if (!isObject(testcase)) continue;
    if (!project) missingProject.value = true;
    records.push(readCase(testcase, project ?? 'default', source, warnings));
  }
  for (const child of asArray(suite.testsuite)) {
    walkSuite(child, project, source, records, warnings, missingProject);
  }
}

function readCase(
  testcase: XmlNode,
  project: string,
  source: SourceInfo,
  warnings: string[],
): TestRecord {
  const file = readFile(testcase, warnings);
  const titlePath = titlePathFromName(attr(testcase, 'name') ?? '');
  const failures = [...asArray(testcase.failure), ...asArray(testcase.error)];
  const failed = failures.length > 0;
  const skipped = testcase.skipped !== undefined;
  const outcome: Outcome = failed ? 'failed' : skipped ? 'skipped' : 'passed';
  const status = outcome === 'failed' ? 'failed' : outcome === 'skipped' ? 'skipped' : 'passed';
  const errors = readErrors(failures, warnings);
  const attempt: Attempt = {
    retry: 0,
    status,
    durationMs: durationMs(testcase),
    errors,
    attachments: readAttachments(testcase, warnings),
  };
  return {
    id: makeTestId(file, project, titlePath),
    file,
    project,
    titlePath,
    expectedStatus: 'passed',
    outcome,
    attempts: [attempt],
    source,
  };
}

function readFile(testcase: XmlNode, warnings: string[]): string {
  const fileAttr = attr(testcase, 'file');
  const classname = attr(testcase, 'classname');
  const chosen = fileAttr !== undefined && fileAttr.trim() !== '' ? fileAttr : (classname ?? '');
  return toPortablePath(chosen, undefined, warnings) ?? '';
}

function titlePathFromName(name: string): string[] {
  if (name.includes(PLAYWRIGHT_TITLE_SEPARATOR)) return name.split(PLAYWRIGHT_TITLE_SEPARATOR);
  if (name.includes(' > ')) return name.split(' > ');
  return name === '' ? [] : [name];
}

function readErrors(failures: unknown[], warnings: string[]): AttemptError[] {
  for (const failure of failures) {
    const error = readFailure(failure, warnings);
    if (error) return [error];
  }
  return [];
}

function readFailure(failure: unknown, warnings: string[]): AttemptError | undefined {
  const messageAttr = isObject(failure) ? attr(failure, 'message') : undefined;
  const message = relativizeText(stripAnsi(messageAttr ?? '').trim(), undefined, warnings);
  const stack = relativizeText(stripAnsi(textOf(failure)).trim(), undefined, warnings);
  if (!message && !stack) return undefined;
  if (!stack || stack === message) return { message: message || stack };
  if (!message) return { message: stack };
  return { message, stack };
}

function readAttachments(testcase: XmlNode, warnings: string[]): Attachment[] {
  const chunks = [...asArray(testcase['system-out']), ...asArray(testcase['system-err'])];
  const text = chunks.map((chunk) => textOf(chunk)).join('\n');
  const attachments: Attachment[] = [];
  for (const match of text.matchAll(ATTACHMENT_PATTERN)) {
    const raw = match[1] ?? '';
    const portable = toPortablePath(raw, undefined, warnings) ?? '';
    const name = portable.split('/').pop() || 'attachment';
    attachments.push({
      name,
      path: portable,
      contentType: '',
    });
  }
  return attachments;
}

function durationMs(testcase: XmlNode): number {
  const time = attr(testcase, 'time');
  if (time === undefined || time.trim() === '') return 0;
  const seconds = Number(time);
  if (!Number.isFinite(seconds)) return 0;
  return Math.round(seconds * 1000);
}

function readHostname(suite: XmlNode): string | undefined {
  const hostname = attr(suite, 'hostname');
  if (hostname === undefined) return undefined;
  const trimmed = hostname.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Drop a DOCTYPE that sits before the root element.
 *
 * Custom entities in that DOCTYPE would be expanded by the parser. External
 * identifiers are not fetched, and removing the declaration means they are
 * not read either. Failure text later in the file is left alone.
 */
function stripDoctype(xml: string): string {
  const start = xml.indexOf('<!DOCTYPE');
  if (start === -1) return xml;
  const root = indexOfRoot(xml);
  if (root !== -1 && start > root) return xml;
  let quote: string | undefined;
  let brackets = 0;
  for (let index = start + '<!DOCTYPE'.length; index < xml.length; index += 1) {
    const ch = xml[index];
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '[') brackets += 1;
    else if (ch === ']') brackets = Math.max(0, brackets - 1);
    else if (ch === '>' && brackets === 0) {
      return xml.slice(0, start) + xml.slice(index + 1);
    }
  }
  return xml;
}

function indexOfRoot(xml: string): number {
  const suites = xml.indexOf('<testsuites');
  const suite = xml.indexOf('<testsuite');
  if (suites === -1) return suite;
  if (suite === -1) return suites;
  return Math.min(suites, suite);
}

function attr(node: XmlNode, name: string): string | undefined {
  const value = node[`@_${name}`];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => textOf(item)).join('');
  if (isObject(value) && typeof value['#text'] === 'string') return value['#text'];
  return '';
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function isObject(value: unknown): value is XmlNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
