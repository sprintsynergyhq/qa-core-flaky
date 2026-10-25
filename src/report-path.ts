/**
 * Report paths stored on a record stay relative.
 *
 * A path inside the report root loses that prefix. A path outside the root,
 * or an absolute path when the report has no root, is rewritten. The stored
 * value never keeps an absolute machine path. Each distinct rewrite adds one
 * warning, and the warning quotes the relative path only.
 */

const OUTSIDE_ROOT_WARNING =
  'File path is outside the report root and was rewritten to a relative path: ';
const ABSOLUTE_WARNING = 'File path was absolute and was rewritten to a relative path: ';

/** An absolute path at a token boundary, with forward slashes. */
const ABSOLUTE_TOKEN = /(^|[\s"'=(])((?:\/|[A-Za-z]:\/)[^\s"'<>|]+)/g;

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

/** Rewrite absolute paths inside error text. Relative text is left as written. */
export function relativizeText(text: string, rootDir: string | undefined, warnings: string[]): string {
  const root = normalizeRoot(rootDir);
  let out = normalizeSlashes(text);
  if (root && out.includes(root)) {
    out = out.split(`${root}/`).join('');
    out = replaceRootBoundaries(out, root);
  }
  return out.replace(ABSOLUTE_TOKEN, (_full, prefix: string, token: string) => {
    const portable = toPortablePath(token, root, warnings);
    return `${prefix}${portable ?? token}`;
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

function replaceRootBoundaries(text: string, root: string): string {
  let out = '';
  let from = 0;
  while (from <= text.length) {
    const at = text.indexOf(root, from);
    if (at === -1) {
      out += text.slice(from);
      return out;
    }
    const next = text[at + root.length];
    const boundary =
      next === undefined ||
      next === '/' ||
      next === ':' ||
      next === '"' ||
      next === "'" ||
      next === '<' ||
      next === '>' ||
      next === '|' ||
      /\s/.test(next);
    out += text.slice(from, at);
    out += boundary ? '.' : root;
    from = at + root.length;
  }
  return out;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function pushWarning(warnings: string[], message: string): void {
  if (!warnings.includes(message)) warnings.push(message);
}
