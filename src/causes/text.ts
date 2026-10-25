/**
 * The line that contains a match, clipped to 300 characters. The result is a substring.
 * `skipLine` drops a match whose line is locator or expected text, so the next match is used.
 */
export function lineContaining(
  text: string,
  pattern: RegExp,
  skipLine?: (line: string) => boolean,
): string | undefined {
  const flags = pattern.flags.includes('m') ? pattern.flags : `${pattern.flags}m`;
  const regex = new RegExp(pattern.source, `${flags.replaceAll('g', '')}g`);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match[0].length === 0) {
      regex.lastIndex += 1;
      continue;
    }
    const line = clipLine(text, match.index);
    if (line.length === 0) continue;
    if (skipLine?.(line)) continue;
    return line;
  }
  return undefined;
}

/**
 * A locator or expected line. These quote the test, not the failure.
 * `Locator:` and `Expected:` may be indented. Call-log lines carry `waiting for`
 * or `locator resolved to`.
 */
export function isQuotedContextLine(line: string): boolean {
  if (/^\s*(?:Locator:|Expected:)/.test(line)) return true;
  if (line.includes('waiting for ')) return true;
  if (line.includes('locator resolved to ')) return true;
  return false;
}

function clipLine(text: string, index: number): string {
  const start = text.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  let end = text.indexOf('\n', index);
  if (end === -1) end = text.length;
  const line = text.slice(start, end);
  if (line.length <= 300) return line;
  const local = Math.max(0, index - start);
  const from = Math.max(0, Math.min(local, line.length - 300));
  return line.slice(from, from + 300);
}
