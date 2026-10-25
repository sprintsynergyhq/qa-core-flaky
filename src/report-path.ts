/**
 * Report paths stored on a record stay relative when they can be.
 *
 * A structured POSIX path inside the report root loses that prefix. A
 * structured POSIX path outside the root, or an absolute POSIX path when
 * the report has no root, is rewritten to a relative path. Each distinct
 * rewrite adds one warning, and that warning quotes the relative path only.
 *
 * A Windows path is normalized before anything else: a run of backslashes
 * is one separator, and the stored form uses forward slashes. `C:\\Users\\bob`
 * becomes `C:/Users/bob`, not `Users//bob`. The drive letter stays. When the
 * report root uses that same drive, the path is made relative and the drive
 * is no longer in the result. Otherwise the normalized `C:/...` form is
 * kept, because dropping the drive would throw away the only root the path
 * has. That case adds a warning that quotes the normalized path.
 *
 * Error text keeps its slashes except inside a rewritten token. A token is
 * rewritten when it is the report root, when it is an absolute POSIX path
 * with at least two segments, when it is a Windows path with a drive and a
 * segment, or when it is a source location ending in `.ts`, `.js`, or
 * `.mjs` with a line number. A single segment such as `/var/`, `/Ready/`,
 * or `"/inventory.html"` is left alone. `http://` and `https://` URLs are
 * left alone, including a query such as `?x=/home/a` and a root prefix that
 * sits inside the URL. A token may start after whitespace, a quote, `=`,
 * `(`, a backtick, `[`, `{`, `:`, or `file://`. Trailing `,`, `.`, `;`, and
 * `)` stay outside the rewritten path. The report root is also removed
 * wherever it still appears as its own prefix, but not inside a URL. The
 * root matches when the next character does not continue the path name.
 * Letters, digits, `_`, and `-` continue the name. A `.` continues the name
 * only when a name character follows it, so `project-other` and `project.txt`
 * stay whole, while `root&b`, `root&&npm`, and `root!` are still the root.
 * A path segment may also contain `%`, `~`, `$`, `&`, `!`, `#`, `?`, `*`,
 * `@`, `+`, `,`, or `=`.
 */

const OUTSIDE_ROOT_WARNING =
  'File path is outside the report root and was rewritten to a relative path: ';
const ABSOLUTE_WARNING = 'File path was absolute and was rewritten to a relative path: ';
const WINDOWS_WARNING = 'File path is a Windows path and was normalized: ';

/**
 * A path token after a boundary.
 * `file://` and a drive letter may lead the token. `:12` or `:12:3` may
 * follow it. Quotes, brackets, and the boundary characters stay outside.
 */
const TEXT_TOKEN =
  /(^|[\s"'=(`\[{:])((?:[A-Za-z]:[\\/]|file:\/\/)?[^\s"'=()<>|`\[\]{}:]+(?::\d+)*)/g;

const TRAILING_PUNCTUATION = /[,.;)]+$/;

/** `file.ts:12` or `file.ts:12:3` at the end of a token. */
const SOURCE_LOCATION = /\.(?:ts|js|mjs):\d+(?::\d+)?$/;

/**
 * Turn Windows separators into forward slashes.
 * A run of backslashes is one separator, so `C:\\Users\\bob` becomes
 * `C:/Users/bob` rather than `C://Users//bob`.
 */
export function normalizeSlashes(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    while (index + 1 < value.length && value[index + 1] === '\\') index += 1;
    out += '/';
  }
  return out;
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
  if (isWindowsDrivePath(normalized) && !sameDrive(root, normalized)) {
    pushWarning(warnings, `${WINDOWS_WARNING}${normalized}`);
    return normalized;
  }
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
 * `http://` and `https://` URLs are masked first, so a query such as
 * `?x=/home/a` and a root prefix inside the URL are not rewritten and do
 * not warn. Patterns, single-segment URL paths, regular expressions, and
 * backslash text that is not a Windows path stay as written. A path inside
 * the report root is removed with no warning. The root prefix is then
 * removed anywhere it remains outside a URL, using the same boundary check.
 */
export function relativizeText(text: string, rootDir: string | undefined, warnings: string[]): string {
  const root = normalizeRoot(rootDir);
  const masked = maskUrls(text);
  const tokenized = masked.text.replace(TEXT_TOKEN, (full, prefix: string, token: string) => {
    const parts = splitErrorToken(token);
    if (parts.path === '') return full;
    if (!shouldRewriteErrorToken(parts.path, root)) return full;
    const portable = toPortablePath(parts.path, root, warnings);
    if (portable === undefined) return full;
    const body = portable === '' ? '.' : portable;
    return `${prefix}${parts.lead}${body}${parts.trailing}`;
  });
  return unmaskUrls(replaceRootPrefixes(tokenized, root), masked.urls);
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
    const boundary = !continuesPathName(text, at + root.length);
    out += text.slice(from, at);
    out += boundary ? '.' : root;
    from = at + root.length;
  }
  return out;
}

/**
 * True when `text[index]` continues a directory or file name.
 * A name character is a letter, a digit, `_`, or `-`. A dot continues the
 * name only when a name character follows it.
 */
function continuesPathName(text: string, index: number): boolean {
  const next = text[index];
  if (next === undefined) return false;
  if (isPathNameChar(next)) return true;
  if (next !== '.') return false;
  const after = text[index + 1];
  return after !== undefined && isPathNameChar(after);
}

function isPathNameChar(ch: string): boolean {
  return /[A-Za-z0-9_-]/.test(ch);
}

function shouldRewriteErrorToken(token: string, root: string | undefined): boolean {
  const normalized = normalizeSlashes(token);
  const stripped = stripLocationSuffix(normalized);
  if (root && (pathStartsWithRoot(stripped, root) || pathStartsWithRoot(normalized, root))) return true;
  if (isWindowsDrivePath(stripped) && windowsHasSegment(stripped)) return true;
  if (isRegexLiteral(stripped) || isRegexLiteral(normalized)) return false;
  if (normalized.startsWith('/') && SOURCE_LOCATION.test(normalized)) return true;
  return isMultiSegmentPosixPath(stripped);
}

function pathStartsWithRoot(value: string, root: string): boolean {
  if (!value.startsWith(root)) return false;
  return !continuesPathName(value, root.length);
}

function stripLocationSuffix(value: string): string {
  return value.replace(/:\d+(?::\d+)?$/, '');
}

function isWindowsDrivePath(value: string): boolean {
  return /^[A-Za-z]:\//.test(value);
}

function sameDrive(root: string | undefined, value: string): boolean {
  if (!root || !isWindowsDrivePath(root) || !isWindowsDrivePath(value)) return false;
  return root.slice(0, 2).toLowerCase() === value.slice(0, 2).toLowerCase();
}

function windowsHasSegment(value: string): boolean {
  const rest = value.replace(/^[A-Za-z]:\//, '').replace(/\/+$/, '');
  return rest.split('/').some((part) => part.length > 0);
}

/** A `/pattern/` token, including flags. A filesystem path with two segments does not match. */
function isRegexLiteral(value: string): boolean {
  return /^\/(?:[^/\n\\]|\\.)+\/[gimsuy]*$/.test(value);
}

/**
 * An absolute POSIX path with at least two segments, such as
 * `/opt/app/data.json` or `/home/ci/w/a%20b.ts`. One segment (`/var/`,
 * `/inventory.html`) is not a filesystem path. A regex literal is rejected
 * before this check. A segment may contain `% ~ $ & ! # ? * @ + , =`.
 */
function isMultiSegmentPosixPath(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//')) return false;
  const segments = value
    .replace(/\/+$/, '')
    .split('/')
    .filter((part) => part.length > 0);
  if (segments.length < 2) return false;
  return segments.every((segment) => /^[A-Za-z0-9._+@%~$&!#?=*,-]+$/.test(segment));
}

function maskUrls(text: string): { text: string; urls: string[] } {
  const urls: string[] = [];
  const masked = text.replace(/https?:\/\/[^\s<>"'`]+/gi, (url) => {
    const token = `\uE000${urls.length}\uE001`;
    urls.push(url);
    return token;
  });
  return { text: masked, urls };
}

function unmaskUrls(text: string, urls: readonly string[]): string {
  return text.replace(/\uE000(\d+)\uE001/g, (_full, index: string) => urls[Number(index)] ?? '');
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function pushWarning(warnings: string[], message: string): void {
  if (!warnings.includes(message)) warnings.push(message);
}
