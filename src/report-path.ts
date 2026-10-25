/**
 * Report paths stored on a record stay relative.
 *
 * A structured path inside the report root loses that prefix. A structured
 * path outside the root, or an absolute structured path when the report has
 * no root, is rewritten. The stored value never keeps an absolute machine
 * path. Each distinct rewrite adds one warning, and the warning quotes the
 * relative path only.
 *
 * Error text is left unchanged except for a token that starts with the
 * report root, or that looks like a filesystem path: `/home/`, `/Users/`,
 * `/tmp/`, `/var/`, `/runner/`, a drive letter such as `X:\`, or a source
 * location ending in `.ts`, `.js`, or `.mjs` with a line number. Slashes
 * are normalized only inside such a token.
 */

const OUTSIDE_ROOT_WARNING =
  'File path is outside the report root and was rewritten to a relative path: ';
const ABSOLUTE_WARNING = 'File path was absolute and was rewritten to a relative path: ';

/** A token after a boundary. Quotes and parentheses stay outside the token. */
const TEXT_TOKEN = /(^|[\s"'=(])([^\s"'<>|()]+)/g;

const FILESYSTEM_PREFIXES = ['/home/', '/Users/', '/tmp/', '/var/', '/runner/'];

/** `file.ts:12` or `file.ts:12:3` at the end of a token. */
const SOURCE_LOCATION = /\.(?:ts|js|mjs):\d+(?::\d+)?$/;

export function normalizeSlashes(value: string): string {
  return value.replaceAll('\\', '/');
}

export function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:\//.test(value);
}

/**
 * Make one report path relative to `rootDir` when that root is known.
 * Already relative paths are returned unchanged.
 */
export function toPortablePath(
  file: string | undefined,
  rootDir: string | undefined,
  warnings: string[],
): string | undefined {
  if (file === undefined) return undefined;
  const normalized = stripTrailingSlash(normalizeSlashes(file));
  if (normalized === '') return '';
  const root = normalizeRoot(rootDir);
  if (root) {
    if (normalized === root) return '';
    if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  }
  if (!isAbsolutePath(normalized)) return normalized;
  const rewritten =
    root && isAbsolutePath(root) ? relativeFrom(root, normalized) : stripAbsolutePrefix(normalized);
  const safe = isAbsolutePath(rewritten) ? stripAbsolutePrefix(rewritten) : rewritten;
  const prefix = root ? OUTSIDE_ROOT_WARNING : ABSOLUTE_WARNING;
  pushWarning(warnings, `${prefix}${safe}`);
  return safe;
}

/**
 * Rewrite filesystem paths inside error text.
 *
 * Patterns, URL paths, regular expressions, and backslash text stay as
 * written. No warning is added for those.
 */
export function relativizeText(text: string, rootDir: string | undefined, warnings: string[]): string {
  const root = normalizeRoot(rootDir);
  return text.replace(TEXT_TOKEN, (full, prefix: string, token: string) => {
    if (!shouldRewriteErrorToken(token, root)) return full;
    const portable = toPortablePath(token, root, warnings);
    if (portable === undefined) return full;
    if (portable === '') return `${prefix}.`;
    return `${prefix}${portable}`;
  });
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function normalizeRoot(rootDir: string | undefined): string | undefined {
  if (!rootDir) return undefined;
  const normalized = stripTrailingSlash(normalizeSlashes(rootDir));
  if (normalized === '' || normalized === '.') return undefined;
  return normalized;
}

function relativeFrom(from: string, to: string): string {
  const left = splitAbsolute(from);
  const right = splitAbsolute(to);
  if (left.drive !== right.drive) return stripAbsolutePrefix(to);
  let index = 0;
  while (index < left.parts.length && index < right.parts.length && left.parts[index] === right.parts[index]) {
    index += 1;
  }
  const up = left.parts.length - index;
  const down = right.parts.slice(index);
  if (up === 0 && down.length === 0) return '.';
  const parts = [...Array.from({ length: up }, () => '..'), ...down];
  return parts.join('/');
}

function splitAbsolute(value: string): { drive: string; parts: string[] } {
  const drive = /^([A-Za-z]:)\//.exec(value);
  if (drive?.[1]) {
    return { drive: drive[1].toLowerCase(), parts: value.slice(drive[1].length + 1).split('/').filter(Boolean) };
  }
  return { drive: '', parts: value.split('/').filter(Boolean) };
}

function stripAbsolutePrefix(value: string): string {
  const stripped = value.replace(/^[A-Za-z]:\//, '').replace(/^\/+/, '');
  return stripped === '' ? '.' : stripped;
}

function shouldRewriteErrorToken(token: string, root: string | undefined): boolean {
  const normalized = normalizeSlashes(token);
  if (root && (normalized === root || normalized.startsWith(`${root}/`))) return true;
  if (FILESYSTEM_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true;
  if (/^[A-Za-z]:\//.test(normalized)) return true;
  if (normalized.startsWith('/') && SOURCE_LOCATION.test(normalized)) return true;
  return false;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function pushWarning(warnings: string[], message: string): void {
  if (!warnings.includes(message)) warnings.push(message);
}
