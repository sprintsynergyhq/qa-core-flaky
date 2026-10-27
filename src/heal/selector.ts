const SOURCE_FRAME_LINE = /^[ \t]*(?:>[ \t]*)?\d+[ \t]*\|/;
const CARET_LINE = /^[ \t]*\|[ \t]*\^/;
const CALL_START = /(?:locator|getBy[A-Za-z]+)\(/;

/**
 * Quote the failing selector from error text, when the error has one.
 * A simple `locator('...')` with no chain is stored as the inner selector.
 * A chain or a `getBy` call is stored as printed. Source frames are skipped.
 * The result is at most 300 characters. The same text returns the same quote.
 */
export function quoteFailingSelector(texts: readonly string[]): string | null {
  for (const text of texts) {
    const quoted = selectorInText(text);
    if (quoted && quoted.length > 0) return clip(quoted);
  }
  return null;
}

function selectorInText(text: string): string | null {
  const lines = text.split('\n');
  for (const line of lines) {
    if (isFrame(line)) continue;
    const locator = /^[ \t]*Locator:[ \t]*(.*)$/.exec(line);
    if (!locator?.[1]) continue;
    const call = readCall(locator[1]);
    if (call) return presentSelector(call);
  }
  for (const line of lines) {
    if (isFrame(line)) continue;
    const strict = /strict mode violation:\s*(.*)$/.exec(line);
    if (!strict?.[1]) continue;
    const call = readCall(strict[1]);
    if (call) return presentSelector(call);
  }
  for (const line of lines) {
    if (isFrame(line)) continue;
    const waiting = /waiting for\s+(.*)$/.exec(line);
    if (!waiting?.[1]) continue;
    const call = readCall(waiting[1]);
    if (call) return presentSelector(call);
  }
  return null;
}

function isFrame(line: string): boolean {
  return SOURCE_FRAME_LINE.test(line) || CARET_LINE.test(line);
}

/** The call, plus a simple chain such as `.first()` on the same line. */
function readCall(source: string): string | null {
  const start = source.search(CALL_START);
  if (start < 0) return null;
  const open = source.indexOf('(', start);
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === '(') {
      depth += 1;
      continue;
    }
    if (ch === '\n') return null;
    if (ch !== ')') continue;
    depth -= 1;
    if (depth !== 0) continue;
    let end = index + 1;
    const chain = /^(?:\.[A-Za-z_][A-Za-z0-9_]*\([^)\n]*\))*/.exec(source.slice(end));
    if (chain?.[0]) end += chain[0].length;
    return source.slice(start, end);
  }
  return null;
}

function presentSelector(call: string): string {
  const trimmed = call.trim();
  const simple = /^locator\((['"])([\s\S]*)\1\)$/.exec(trimmed);
  if (simple?.[2] !== undefined) return simple[2];
  return trimmed;
}

function clip(value: string): string {
  return value.length > 300 ? value.slice(0, 300) : value;
}
