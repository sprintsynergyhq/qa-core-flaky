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
 * 7. A call-log repeat count such as `9 ×` or `9 x locator` becomes `N ×`.
 * 8. Runs of spaces or tabs become one space, then the ends are trimmed.
 *
 * Numbers that are part of the assertion, such as `Received: "1"`, are kept.
 * Two errors that differ only by a call-log repeat count share a signature.
 */
export function normalizeErrorSignature(text: string): string {
  let out = stripAnsi(text);
  out = out.replace(/(?<![A-Za-z0-9_.+\-])([A-Za-z0-9_.+\-]+):\d+:\d+/g, '$1:L:C');
  out = out.replace(/\d+(?:\.\d+)?ms\b/g, 'Nms');
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
  out = out.replace(/\d+[ \t]*×/g, 'N ×');
  out = out.replace(/\d+[ \t]+x(?=[ \t]+locator\b)/gi, 'N ×');
  out = out.replace(/[ \t]+/g, ' ');
  return out.trim();
}
