export type ReportFormat = 'json' | 'junit';

/** Drop a leading UTF-8 BOM so detection and JSON.parse see the real first character. */
export function stripLeadingBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Detect a report format from its contents.
 *
 * JSON when the first non-space character is `{`. JUnit when the root
 * element is `testsuites` or `testsuite`. A mention of `<testsuite` inside
 * later text, a comment, or a different root element is not JUnit. The file
 * extension is ignored. A leading UTF-8 BOM is ignored. The prolog may
 * contain an XML declaration, comments, processing instructions, and a
 * `DOCTYPE` before that root element.
 */
export function detectFormat(text: string, reportPath: string): ReportFormat {
  const source = stripLeadingBom(text);
  if (source.trimStart().startsWith('{')) return 'json';
  if (hasJunitRoot(source)) return 'junit';
  throw new Error(`unknown report format: ${reportPath}`);
}

function hasJunitRoot(xml: string): boolean {
  let index = 0;
  while (index < xml.length) {
    const ch = xml[index];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      index += 1;
      continue;
    }
    if (ch !== '<') return false;
    if (xml.startsWith('<!--', index)) {
      const end = xml.indexOf('-->', index + 4);
      if (end === -1) return false;
      index = end + 3;
      continue;
    }
    if (xml.startsWith('<?', index)) {
      const end = xml.indexOf('?>', index + 2);
      if (end === -1) return false;
      index = end + 2;
      continue;
    }
    if (xml.startsWith('<!DOCTYPE', index)) {
      const end = endOfDoctype(xml, index);
      if (end === -1) return false;
      index = end;
      continue;
    }
    return isJunitStartTag(xml, index);
  }
  return false;
}

function isJunitStartTag(xml: string, index: number): boolean {
  const rest = xml.slice(index + 1);
  for (const name of ['testsuites', 'testsuite']) {
    if (!rest.startsWith(name)) continue;
    const next = rest[name.length];
    if (next === undefined || next === '>' || next === '/' || /\s/.test(next)) return true;
  }
  return false;
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
