/** The line that contains a match, clipped to 300 characters. The result is a substring. */
export function lineContaining(text: string, pattern: RegExp): string | undefined {
  const flags = pattern.flags.includes('m') ? pattern.flags : `${pattern.flags}m`;
  const regex = new RegExp(pattern.source, flags.replaceAll('g', ''));
  const match = regex.exec(text);
  if (!match) return undefined;
  const line = clipLine(text, match.index);
  return line.length > 0 ? line : undefined;
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
