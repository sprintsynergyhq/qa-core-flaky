import { stripAnsi } from './report-path.js';

/**
 * Build a stable signature for comparing one error across attempts and runs.
 *
 * The steps run in this order:
 * 1. ANSI escape codes are removed.
 * 2. A trailing `:line:column` on a file token becomes `:L:C`. The match starts
 *    where the previous character is not part of a file token.
 * 3. A duration such as `5000ms` or `1.5ms` becomes `Nms`.
 * 4. A port on `localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`, or an `http(s)`
 *    URL becomes `:PORT`.
 * 5. Digits inside a `/tmp/`, `/private/tmp/`, or `/var/folders/` path become `N`.
 * 6. A UUID becomes `ID`. Digits after `id=` or `id:` become `N`.
 * 7. Inside a `Call log:` block only, a leading count becomes `N ×`.
 *    Optional spaces come first, then an optional `-` and the spaces after
 *    it, then the count, then `×` or `x`, then the rest of the line.
 *    `2 × locator` and `2 × waiting for element to be visible` both match.
 *    The block starts at a `Call log:` line and continues while the next
 *    lines are indented further. A blank line or a less-indented line ends
 *    it. A count outside that block stays, including a Received line and a
 *    continuation that only looks like a call-log line.
 * 8. Runs of spaces or tabs become one space, then the ends are trimmed.
 *
 * Numbers in assertion values are kept, including `Expected: "1 × 4"`,
 * `Received: "2×"`, and `Received: "2 × Backpack"`. Two errors that differ
 * only by a call-log repeat count share a signature. Steps 2 and 3 walk the
 * text once so a long run of digits stays linear.
 */
export function normalizeErrorSignature(text: string): string {
  let out = stripAnsi(text);
  out = replaceLineColumn(out);
  out = replaceDurations(out);
  out = out.replace(/\b(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+\b/g, '$1:PORT');
  out = out.replace(/(https?:\/\/[^/\s:]+):\d+/gi, '$1:PORT');
  out = out.replace(/\/private\/tmp\/[^\s"'`)>\]]+/g, (path) => path.replace(/\d+/g, 'N'));
  out = out.replace(/\/tmp\/[^\s"'`)>\]]+/g, (path) => path.replace(/\d+/g, 'N'));
  out = out.replace(/\/var\/folders\/[^\s"'`)>\]]+/g, (path) => path.replace(/\d+/g, 'N'));
  out = out.replace(
    /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
    'ID',
  );
  out = out.replace(/\bid[=:]\s*\d+/gi, 'id=N');
  out = normalizeCallLogCounts(out);
  out = out.replace(/[ \t]+/g, ' ');
  return out.trim();
}

const TOKEN_CHAR = /[A-Za-z0-9_.+\-]/;

/** `:line:column` on a file token becomes `:L:C`. One forward pass. */
function replaceLineColumn(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const colon = text.indexOf(':', index);
    if (colon === -1) return out + text.slice(index);
    const first = readDigits(text, colon + 1);
    if (first === colon + 1 || text[first] !== ':') {
      out += text.slice(index, colon + 1);
      index = colon + 1;
      continue;
    }
    const second = readDigits(text, first + 1);
    if (second === first + 1) {
      out += text.slice(index, colon + 1);
      index = colon + 1;
      continue;
    }
    let start = colon;
    while (start > index && TOKEN_CHAR.test(text[start - 1] ?? '')) start -= 1;
    const before = start > 0 ? text[start - 1] : undefined;
    if (start === colon || (before !== undefined && TOKEN_CHAR.test(before))) {
      out += text.slice(index, colon + 1);
      index = colon + 1;
      continue;
    }
    out += text.slice(index, colon);
    out += ':L:C';
    index = second;
  }
  return out;
}

/** `5000ms` and `1.5ms` become `Nms`. One forward pass. */
function replaceDurations(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const at = text.indexOf('ms', index);
    if (at === -1) return out + text.slice(index);
    const after = text[at + 2];
    if (after !== undefined && /[A-Za-z0-9_]/.test(after)) {
      out += text.slice(index, at + 2);
      index = at + 2;
      continue;
    }
    const start = durationStart(text, index, at);
    if (start === undefined) {
      out += text.slice(index, at + 2);
      index = at + 2;
      continue;
    }
    out += text.slice(index, start);
    out += 'Nms';
    index = at + 2;
  }
  return out;
}

function durationStart(text: string, from: number, msAt: number): number | undefined {
  let index = msAt - 1;
  if (index < from || !isDigit(text[index] ?? '')) return undefined;
  while (index >= from && isDigit(text[index] ?? '')) index -= 1;
  if (index >= from && text[index] === '.') {
    const dot = index;
    index -= 1;
    if (index >= from && isDigit(text[index] ?? '')) {
      while (index >= from && isDigit(text[index] ?? '')) index -= 1;
      return index + 1;
    }
    return dot + 1;
  }
  return index + 1;
}

function readDigits(text: string, start: number): number {
  let index = start;
  while (index < text.length && isDigit(text[index] ?? '')) index += 1;
  return index;
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

const CALL_LOG_COUNT = /^([ \t]*(?:-[ \t]*)?)\d+[ \t]*[×x][ \t]+/;

/**
 * Rewrite repeat counts only on lines that belong to a `Call log:` block.
 * A line such as `2 x locator q` outside that block is left as written.
 */
function normalizeCallLogCounts(text: string): string {
  const lines = text.split('\n');
  let inBlock = false;
  let baseIndent = 0;
  const rewritten = lines.map((line) => {
    const header = /^([ \t]*)Call log:[ \t]*$/.exec(line);
    if (!inBlock) {
      if (header?.[1] !== undefined) {
        inBlock = true;
        baseIndent = header[1].length;
      }
      return line;
    }
    if (line.trim() === '') {
      inBlock = false;
      return line;
    }
    const indent = /^[ \t]*/.exec(line)?.[0].length ?? 0;
    if (indent <= baseIndent) {
      inBlock = false;
      if (header?.[1] !== undefined) {
        inBlock = true;
        baseIndent = header[1].length;
      }
      return line;
    }
    return line.replace(CALL_LOG_COUNT, '$1N × ');
  });
  return rewritten.join('\n');
}
