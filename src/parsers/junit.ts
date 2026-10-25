import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { disambiguateHomeFiles, makeTestId } from '../id.js';
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
 * Entity expansion is off, so a DOCTYPE cannot define an entity the parser
 * will expand. Only a DOCTYPE in the prolog is removed, which also means an
 * external identifier there is not read. A DOCTYPE after the root element is
 * left in place. Attribute values and ordinary element text decode the five
 * predefined XML entities (`lt`, `gt`, `amp`, `apos`, `quot`) and numeric
 * character references whose code point is a legal XML 1.0 character
 * (`&#65;`, `&#x42;`). A reference the grammar rejects, including a hex
 * reference with an uppercase `X` (`&#X41;`), does not fail the report. It
 * stays as the original reference text. A reference to a forbidden character,
 * such as `&#0;`, also stays as the original reference text. CDATA stays
 * literal. HTML entities stay literal. Attribute values stay strings.
 */
const CDATA_KEY = '#cdata';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  htmlEntities: false,
  processEntities: false,
  preserveOrder: true,
  cdataPropName: CDATA_KEY,
  isArray: (tagName: string) => ARRAY_TAGS.has(tagName),
});

const NAMED_XML_ENTITIES: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  apos: "'",
  quot: '"',
};

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
  const rawFiles: string[] = [];
  const missingProject = { value: false };
  const source = buildSource(reportPath, meta);

  for (const suite of suites) {
    walkSuite(suite, undefined, source, records, rawFiles, warnings, missingProject);
  }

  const ordered = [NO_ATTEMPT_WARNING];
  if (missingProject.value) ordered.push(NO_PROJECT_WARNING);
  return {
    schemaVersion: 1,
    records: disambiguateHomeFiles(records, rawFiles),
    warnings: [...ordered, ...warnings],
  };
}

function parseXml(text: string, reportPath: string): unknown {
  const withoutDoctype = neutralizeInvalidCharRefs(stripDoctype(text));
  const validation = XMLValidator.validate(withoutDoctype, { allowBooleanAttributes: true });
  if (validation !== true) {
    throw new Error(`Invalid XML in report ${reportPath}`);
  }
  try {
    return fromOrdered(parser.parse(withoutDoctype));
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
  if (typeof meta?.commitSha === 'string' && meta.commitSha.length > 0) source.commitSha = meta.commitSha;
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
  rawFiles: string[],
  warnings: string[],
  missingProject: { value: boolean },
): void {
  if (!isObject(suite)) return;
  const ownProject = readHostname(suite);
  const project = ownProject ?? inheritedProject;
  for (const testcase of asArray(suite.testcase)) {
    if (!isObject(testcase)) continue;
    if (!project) missingProject.value = true;
    const read = readCase(testcase, project ?? 'default', source, warnings);
    records.push(read.record);
    rawFiles.push(read.raw);
  }
  for (const child of asArray(suite.testsuite)) {
    walkSuite(child, project, source, records, rawFiles, warnings, missingProject);
  }
}

function readCase(
  testcase: XmlNode,
  project: string,
  source: SourceInfo,
  warnings: string[],
): { record: TestRecord; raw: string } {
  const raw = rawFile(testcase);
  const file = toPortablePath(raw, undefined, warnings) ?? '';
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
    raw,
    record: {
      id: makeTestId(file, project, titlePath),
      file,
      project,
      titlePath,
      expectedStatus: 'passed',
      outcome,
      attempts: [attempt],
      source,
    },
  };
}

function rawFile(testcase: XmlNode): string {
  const fileAttr = attr(testcase, 'file');
  const classname = attr(testcase, 'classname');
  if (fileAttr !== undefined && fileAttr.trim() !== '') return fileAttr;
  return classname ?? '';
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

/**
 * A JUnit `[[ATTACHMENT|...]]` path can be `home/<name>/<more>` or
 * `Users/<name>/<more>` with no leading slash. That is a home only in this
 * attachment slot. Ids, files, titles, locations, evidence, and `--only`
 * do not use this rule, so `users/list.spec.ts` and `home/page.spec.ts` stay.
 */
function redactJunitAttachmentHome(file: string): string {
  const match = /^(home|Users)\/([^/]+)\/(.+)$/u.exec(file);
  if (!match) return file;
  const username = match[2] ?? '';
  const rest = match[3] ?? '';
  if (username === '' || username.startsWith(':') || !/\p{L}/u.test(username)) return file;
  return `<home>/${rest}`;
}

function readAttachments(testcase: XmlNode, warnings: string[]): Attachment[] {
  const chunks = [...asArray(testcase['system-out']), ...asArray(testcase['system-err'])];
  const text = chunks.map((chunk) => textOf(chunk)).join('\n');
  const attachments: Attachment[] = [];
  for (const match of text.matchAll(ATTACHMENT_PATTERN)) {
    const raw = match[1] ?? '';
    const portable = redactJunitAttachmentHome(toPortablePath(raw, undefined, warnings) ?? '');
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
 * Remove each DOCTYPE in the prolog and leave the root element untouched.
 *
 * The scan starts at the beginning, after an optional BOM. It passes the XML
 * declaration, whitespace, comments, and processing instructions. It drops
 * each DOCTYPE there, including quoted strings and an internal subset. It
 * stops at the first tag that starts an element. A DOCTYPE inside later
 * text or CDATA is kept. Expansion is already disabled.
 */
function stripDoctype(xml: string): string {
  let index = 0;
  if (xml.charCodeAt(0) === 0xfeff) index = 1;
  let out = '';
  while (index < xml.length) {
    const ch = xml[index];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      out += ch;
      index += 1;
      continue;
    }
    if (ch !== '<') return out + xml.slice(index);
    if (xml.startsWith('<!--', index)) {
      const end = xml.indexOf('-->', index + 4);
      if (end === -1) return out + xml.slice(index);
      out += xml.slice(index, end + 3);
      index = end + 3;
      continue;
    }
    if (xml.startsWith('<?', index)) {
      const end = xml.indexOf('?>', index + 2);
      if (end === -1) return out + xml.slice(index);
      out += xml.slice(index, end + 2);
      index = end + 2;
      continue;
    }
    if (xml.startsWith('<!DOCTYPE', index)) {
      const end = endOfDoctype(xml, index);
      if (end === -1) return out + xml.slice(index);
      index = end;
      continue;
    }
    return out + xml.slice(index);
  }
  return out;
}

/**
 * A character reference the XML grammar rejects is written as `&amp;#...`
 * outside CDATA, comments, and processing instructions. Validation then
 * accepts the document. `decodeXmlEntities` turns `&amp;` back into `&`
 * and does not decode the invalid reference, so `&#X41;` stays literal.
 * `&#0;` is grammatically a character reference, so it is left for the
 * decoder, which also keeps it literal.
 */
function neutralizeInvalidCharRefs(xml: string): string {
  let out = '';
  let index = 0;
  while (index < xml.length) {
    if (xml.startsWith('<![CDATA[', index)) {
      const end = xml.indexOf(']]>', index + 9);
      if (end === -1) return out + xml.slice(index);
      out += xml.slice(index, end + 3);
      index = end + 3;
      continue;
    }
    if (xml.startsWith('<!--', index)) {
      const end = xml.indexOf('-->', index + 4);
      if (end === -1) return out + xml.slice(index);
      out += xml.slice(index, end + 3);
      index = end + 3;
      continue;
    }
    if (xml.startsWith('<?', index)) {
      const end = xml.indexOf('?>', index + 2);
      if (end === -1) return out + xml.slice(index);
      out += xml.slice(index, end + 2);
      index = end + 2;
      continue;
    }
    if (xml.startsWith('&#', index) && charRefRejected(xml, index)) {
      out += '&amp;';
      index += 1;
      continue;
    }
    out += xml[index];
    index += 1;
  }
  return out;
}

function charRefRejected(xml: string, start: number): boolean {
  let index = start + 2;
  if (index >= xml.length) return true;
  let hex = false;
  if (xml[index] === 'x') {
    hex = true;
    index += 1;
  } else if (xml[index] === 'X') {
    return true;
  }
  const digit = hex ? /[0-9a-fA-F]/ : /[0-9]/;
  const first = xml[index];
  if (first === undefined || first === ';') return false;
  for (; index < xml.length; index += 1) {
    const ch = xml[index];
    if (ch === ';') return false;
    if (!digit.test(ch ?? '')) return true;
  }
  return true;
}

function endOfDoctype(xml: string, start: number): number {
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
    if (ch === '[') {
      brackets += 1;
      continue;
    }
    if (ch === ']') {
      brackets = Math.max(0, brackets - 1);
      continue;
    }
    if (ch === '<' && brackets === 0) return -1;
    if (ch === '>' && brackets === 0) return index + 1;
  }
  return -1;
}

function attr(node: XmlNode, name: string): string | undefined {
  const value = node[`@_${name}`];
  if (typeof value === 'string') return decodeXmlEntities(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => textOf(item)).join('');
  if (isObject(value) && typeof value['#text'] === 'string') return value['#text'];
  return '';
}

/**
 * Turn an ordered parse into the nested object the rest of this file reads.
 * Ordinary text is decoded. CDATA is appended as written, in source order.
 */
function fromOrdered(nodes: unknown): unknown {
  if (!Array.isArray(nodes)) return nodes;
  const obj: XmlNode = {};
  const textParts: string[] = [];
  let hasElement = false;
  for (const node of nodes) {
    if (!isObject(node)) continue;
    const key = elementKey(node);
    if (key === undefined) continue;
    if (key === '#text') {
      const value = node[key];
      if (typeof value === 'string' && value.length > 0) textParts.push(decodeXmlEntities(value));
      continue;
    }
    if (key === CDATA_KEY) {
      const raw = cdataText(node[key]);
      if (raw.length > 0) textParts.push(raw);
      continue;
    }
    hasElement = true;
    const attrs = isObject(node[':@']) ? node[':@'] : undefined;
    pushChild(obj, key, attachAttrs(fromOrdered(node[key]), attrs));
  }
  const text = textParts.join('');
  if (!hasElement && Object.keys(obj).length === 0) return text;
  if (text.length > 0) obj['#text'] = text;
  return obj;
}

function elementKey(node: XmlNode): string | undefined {
  for (const key of Object.keys(node)) {
    if (key !== ':@') return key;
  }
  return undefined;
}

function cdataText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => cdataText(item)).join('');
  if (isObject(value) && typeof value['#text'] === 'string') return value['#text'];
  return '';
}

function attachAttrs(child: unknown, attrs: XmlNode | undefined): unknown {
  if (!attrs) return child;
  if (typeof child === 'string') {
    if (child.length === 0) return { ...attrs };
    return { ...attrs, '#text': child };
  }
  if (isObject(child)) return { ...attrs, ...child };
  return { ...attrs };
}

function pushChild(obj: XmlNode, key: string, value: unknown): void {
  const existing = obj[key];
  if (existing === undefined) {
    obj[key] = ARRAY_TAGS.has(key) ? [value] : value;
    return;
  }
  if (Array.isArray(existing)) {
    existing.push(value);
    return;
  }
  obj[key] = [existing, value];
}

/** One left-to-right pass. A replacement is not scanned again. */
function decodeXmlEntities(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/g, (full, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (dec !== undefined) return characterReference(Number(dec)) ?? full;
    if (hex !== undefined) return characterReference(Number.parseInt(hex, 16)) ?? full;
    if (name !== undefined && Object.hasOwn(NAMED_XML_ENTITIES, name)) return NAMED_XML_ENTITIES[name] ?? full;
    return full;
  });
}

/** XML 1.0 Char. Invalid control characters stay as the original reference. */
function characterReference(code: number): string | undefined {
  if (!Number.isInteger(code)) return undefined;
  if (code === 0x9 || code === 0xa || code === 0xd) return String.fromCodePoint(code);
  if (code >= 0x20 && code <= 0xd7ff) return String.fromCodePoint(code);
  if (code >= 0xe000 && code <= 0xfffd) return String.fromCodePoint(code);
  if (code >= 0x10000 && code <= 0x10ffff) return String.fromCodePoint(code);
  return undefined;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function isObject(value: unknown): value is XmlNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
