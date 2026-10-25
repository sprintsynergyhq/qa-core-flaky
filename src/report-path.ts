/**
 * Report paths stored on a record stay relative.
 *
 * A structured path inside the report root loses that prefix. A structured
 * path outside the root, or an absolute structured path when the report has
 * no root, is rewritten. The stored value never keeps an absolute machine
 * path. Each distinct rewrite adds one warning, and the warning quotes the
 * relative path only.
 *
 * Error text keeps its slashes. A token is rewritten when it is the report
 * root, or when it looks like a filesystem path: `/home/`, `/Users/`,
 * `/tmp/`, `/var/`, `/runner/`, a drive letter such as `X:\`, or a source
 * location ending in `.ts`, `.js`, or `.mjs` with a line number. A token may
 * start after whitespace, a quote, `=`, `(`, a backtick, `[`, `{`, `:`, or
 * `file://`. Trailing `,`, `.`, `;`, and `)` stay outside the rewritten path.
 * The report root is also removed wherever it still appears as its own
 * prefix. The character after the root has to be a boundary, so a longer
 * name such as `/tmp/project-other` is not cut apart. Slashes are normalized
 * only inside a rewritten path.
 */

const OUTSIDE_ROOT_WARNING =
  'File path is outside the report root and was rewritten to a relative path: ';
const ABSOLUTE_WARNING = 'File path was absolute and was rewritten to a relative path: ';

/**
 * A path token after a boundary.
 * `file://` and a drive letter may lead the token. `:12` or `:12:3` may
 * follow it. Quotes, brackets, and the boundary characters stay outside.
 */
const TEXT_TOKEN =
  /(^|[\s"'=(`\[{:])((?:[A-Za-z]:[\\/]|file:\/\/)?[^\s"'=()<>|`\[\]{}:]+(?::\d+)*)/g;

const TRAILING_PUNCTUATION = /[,.;)]+$/;

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
 * written. No warning is added for those. A path inside the report root is
 * removed with no warning. The root prefix is then removed anywhere it
 * remains, using the same boundary check.
 */
export function relativizeText(text: string, rootDir: string | undefined, warnings: string[]): string {
  const root = normalizeRoot(rootDir);
  const tokenized = text.replace(TEXT_TOKEN, (full, prefix: string, token: string) => {
    const parts = splitErrorToken(token);
    if (parts.path === '') return full;
    if (!shouldRewriteErrorToken(parts.path, root)) return full;
    const portable = toPortablePath(parts.path, root, warnings);
    if (portable === undefined) return full;
    const body = portable === '' ? '.' : portable;
    return `${prefix}${parts.lead}${body}${parts.trailing}`;
  });
  return replaceRootPrefixes(tokenized, root);
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

function splitErrorToken(token: string): { lead: string; path: string; trailing: string } {
  let path = token;
  let lead = '';
  if (path.startsWith('file://')) {
    lead = 'file://';
    path = path.slice(lead.length);
  }
  const trailing = TRAILING_PUNCTUATION.exec(path)?.[0] ?? '';
  if (trailing) path = path.slice(0, -trailing.length);
  return { lead, path, trailing };
}

/**
 * Remove `root/` anywhere, then a bare `root` when the next character is a
 * boundary. This is the report-root step used for error text: no warning,
 * and no slash rewrite of the surrounding message.
 */
function replaceRootPrefixes(text: string, root: string | undefined): string {
  if (!root || !text.includes(root)) return text;
  return replaceRootBoundaries(text.split(`${root}/`).join(''), root);
}

function replaceRootBoundaries(text: string, root: string): string {
  let out = '';
  let from = 0;
  while (from <= text.length) {
    const at = text.indexOf(root, from);
    if (at === -1) return out + text.slice(from);
    const next = text[at + root.length];
    const boundary =
      next === undefined ||
      next === '/' ||
      next === ':' ||
      next === '"' ||
      next === "'" ||
      next === '`' ||
      next === '[' ||
      next === '{' ||
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
