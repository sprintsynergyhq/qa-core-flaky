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
 * Error text keeps its slashes except inside a rewritten token. A token
 * under the report root is rewritten with the root rules below. A token
 * outside the root is rewritten only when it starts with a known filesystem
 * folder (`/home/`, `/Users/`, `/tmp/`, `/var/`, `/runner/`, `/srv/`,
 * `/opt/`, `/etc/`, `/usr/`, `/root/`, `/mnt/`, `/private/`, `/workspace/`,
 * `/builds/`, `/__w/`, `/github/workspace/`, `/Volumes/`, `/agent/_work/`),
 * when it has a drive letter and a segment, or when it ends in a source
 * location such as `file.ts:12` or `file.ts:12:3`. `/app/` and `/data/` are
 * not known folders. Those outside tokens may contain `%`, `~`, `$`, `&`,
 * `!`, `@`, `+`, and Unicode letters, so `/home/józef/...` and `/Users/李/...`
 * are paths. A token that contains `?`, `*`, `#`, `=`, or `,` and does not
 * start with a known folder stays as written, so a query, a glob, and a
 * comma list are not paths. When a report root is known, a token outside
 * that root that starts with a known folder is rewritten up to the first of
 * those characters, and the rest is kept, so `/home/bob/file#1.json` does
 * not leave the absolute `/home/bob` path in the text. Error text keeps the
 * original home directory. Cause rules and signatures read that text.
 * `redactHomeText` hides the username later, when output strings are built.
 * A structured file path with no report root still hides the username here,
 * and that rewrite does not add a warning. A single segment such as `/var/`,
 * `/Ready/`, or
 * `"/inventory.html"`, a quoted URL path such as `"/cart/checkout.html"`,
 * and prose such as `/and/or` stay as written.
 * `http://` and `https://` URLs are left alone, including a query such as
 * `?x=/home/a` and a root prefix that sits inside the URL. A token may start
 * after whitespace, a quote, `=`, `(`, a backtick, `[`, `{`, `:`, `^`, or
 * `file://`. Trailing `,`, `.`, `;`, and `)` stay outside the rewritten
 * path. The report root is also removed wherever it still appears as its
 * own prefix, but not inside a URL. The root matches when the next character
 * does not continue the path name. Letters, digits, `_`, and `-` continue
 * the name. A `.` continues the name only when a name character follows it,
 * so `project-other` and `project.txt` stay whole, while `root&b`,
 * `root&&npm`, `root!`, `root?`, `root#x`, and `root*` are still the root.
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
 * Top-level folders that identify a real filesystem path outside the report
 * root. A URL path such as `/cart/` or prose such as `/and/` is not in this list.
 */
const FILESYSTEM_PREFIXES = [
  '/home/',
  '/Users/',
  '/tmp/',
  '/var/',
  '/runner/',
  '/srv/',
  '/opt/',
  '/etc/',
  '/usr/',
  '/root/',
  '/mnt/',
  '/private/',
  '/workspace/',
  '/builds/',
  '/__w/',
  '/github/workspace/',
  '/Volumes/',
  '/agent/_work/',
] as const;

/** Query, glob, and list characters. A token that contains one is not a path. */
const OUTSIDE_ROOT_BLOCKED = /[?*#=,]/;

/** Base path characters, Unicode letters, and `% ~ $ & ! @ +`. */
const OUTSIDE_ROOT_SEGMENT = /^[\p{L}\p{M}0-9._+@%~$&!-]+$/u;

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
  redactUser = true,
): string | undefined {
  if (file === undefined) return undefined;
  let normalized = stripTrailingSlash(normalizeSlashes(file));
  if (normalized === '') return '';
  const root = normalizeRoot(rootDir);
  // Structured file paths can hide a home directory here. Error text does not:
  // cause rules read the original message, and the report redacts at output.
  if (!root && redactUser) normalized = redactHomeText(normalized);
  if (!root && isBareHomePath(normalized)) return normalized;
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
    const rewritten = rewriteErrorToken(token, root, warnings);
    if (rewritten === undefined) return full;
    return `${prefix}${rewritten}`;
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

type HomeMatch =
  | {
      kind: 'replace';
      replaceFrom: number;
      username: string;
      hasSep: boolean;
      tail: string;
      next: number;
      /** `\/home\/name` keeps the escaped slash. A drive form replaces the drive too. */
      escaped?: 'slash' | 'drive';
    }
  | { kind: 'skip'; next: number };

/** Username to the `<home>` mark used for one triage entry. */
export type HomeMarks = ReadonlyMap<string, string>;

/**
 * Hide a home directory and its username.
 *
 * Call this when building evidence, ids, titles, and the next step.
 * Cause rules and signatures read the original error text, so this must not
 * run before classification.
 *
 * The username stops at a newline, `\r`, whitespace, `:`, `;`, `,`, a quote,
 * `)`, `]`, or `>`. A space is part of the name only when a path separator
 * follows on the same line before one of those stops, as in `Jöhn Smith`.
 * With no separator after the name, `/home/alice` becomes `<home>` and the
 * text after the name stays. With a separator, the result is `<home>/` plus
 * the rest of the path. A separator is one `/` or a run of one or more `\`,
 * so `C:\Users\alice\x.json` and `C:\\Users\\alice\\x.json` are the same path.
 * A path tail stops at whitespace, a quote, `)`, `]`, `>`, or `?`, `*`,
 * `#`, `=`, `,`. It does not stop at `:`. A space continues that tail for
 * one more segment only when the segment contains a backslash. That
 * continuation stops before a drive letter, `\\`, or a UNC path. It does
 * not look further down the line. `/home/bob/my project\a.spec.ts` becomes
 * `<home>/my project/a.spec.ts`. A later `C:\Users\...` or `\\server\Users\...`
 * stays its own home. `^` is a path boundary. An escaped slash is not
 * rewritten to `/`. `\/home\/name` and `C:\/Users\/name` hide the username
 * and leave every other escape as written.
 *
 * A letter before `:` is a drive letter only at the start of the text or
 * after a character that is not a letter or digit. `file:///` and `\\?\`
 * qualify. `cwd:/home/ci/w` does not: `d` is preceded by a letter, so the
 * path is POSIX `/home/`. A drive-letter path is never an app route.
 *
 * POSIX paths match `home` and `users` in any case, so `/HOME/`, `/USERS/`,
 * and `/Users/BOB/` are homes. A segment that starts with `:` is not a
 * username. `/users/:id`, `/api/home/settings/save`, `GET /home/index/page`,
 * and `/Users/42/orders` stay as written. `~alice/` is a home when the name
 * starts with a letter, a digit, or `_`, and a `/` or the end of the path
 * follows. `~/proj` is not, because it has no username. `~` inside
 * `locator('...')` or `locator("...")` is a CSS combinator and stays.
 * A path boundary may be `,`, `;`, `<`, `>`, or `^`.
 * `file://localhost/home/...` is a home. `../../../home/bob/...` is a home.
 * `\\server\Users\bob`, `\\?\UNC\server\Users\bob`, `//server/Users/bob`,
 * `smb://server/Users/bob`, `SMB://server/users/bob`, `x\\Users\\bob`, and
 * `\\home\\alice` are homes. The server name stays. `smb` matches in any case.
 * A path tail stops at `;`, so `;C:\\Windows` keeps its backslashes.
 * A quoted mark that the text already contains, such as `"<home~2>"`, is
 * tagged `<text:home~2>` before numbering so it does not look like a
 * generated mark.
 *
 * A bare POSIX `/home/<name>` or `/Users/<name>` is redacted inside an
 * Expected or Received value too. An app route such as `/home/feed` has
 * that same shape, so it shows as `<home>`. Pass `marks` from `homeMarks`
 * when one entry has several usernames: the first is `<home>` and the
 * later ones are `<home~2>`, `<home~3>`. Any path after the username is
 * rewritten, including one segment and no file extension.
 * `C:/Users/alice/Desktop` and `C:\\Users\\alice\\Downloads\\report.csv`
 * are drive paths, so they are rewritten at any depth.
 *
 * `http://` and `https://` URLs are left as written. This function does not
 * add a warning.
 */
export function redactHomeText(value: string, marks?: HomeMarks): string {
  const masked = maskUrls(value);
  const text = tagLiteralMarks(masked.text);
  let out = '';
  let cursor = 0;
  while (cursor < text.length) {
    const hit = findHome(text, cursor);
    if (!hit || hit.kind !== 'replace') {
      out += text.slice(cursor);
      break;
    }
    const mark = marks?.get(hit.username) ?? '<home>';
    out += text.slice(cursor, hit.replaceFrom);
    if (hit.escaped === 'slash') out += `\\/${mark}`;
    else if (hit.escaped === 'drive') out += mark;
    else out += homeToken(text, hit.replaceFrom, hit.hasSep, mark);
    out += hit.tail;
    if (hit.next <= cursor) break;
    cursor = hit.next;
  }
  return unmaskUrls(out, masked.urls);
}

/**
 * Number different home usernames inside one entry.
 * The first username in `texts` is `<home>`. The next new ones are
 * `<home~2>`, `<home~3>`, in that order. The mark is not the username.
 */
export function homeMarks(texts: readonly string[]): HomeMarks {
  const seen = new Set<string>();
  const users: string[] = [];
  for (const value of texts) {
    for (const user of homeUsernames(value)) {
      if (seen.has(user)) continue;
      seen.add(user);
      users.push(user);
    }
  }
  const marks = new Map<string, string>();
  users.forEach((user, index) => {
    marks.set(user, index === 0 ? '<home>' : `<home~${index + 1}>`);
  });
  return marks;
}

function homeUsernames(value: string): string[] {
  const text = maskUrls(value).text;
  const users: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const hit = findHome(text, cursor);
    if (!hit || hit.kind !== 'replace') break;
    users.push(hit.username);
    if (hit.next <= cursor) break;
    cursor = hit.next;
  }
  return users;
}

function findHome(text: string, from: number): HomeMatch | undefined {
  for (let index = from; index < text.length; index += 1) {
    const hit =
      matchEscapedHome(text, index) ??
      matchDriveHome(text, index) ??
      matchTildeHome(text, index) ??
      matchDotDotHome(text, index) ??
      matchSlashHome(text, index) ??
      matchBareFolderHome(text, index);
    if (!hit) continue;
    if (hit.kind === 'skip') {
      if (hit.next <= index) continue;
      index = hit.next - 1;
      continue;
    }
    return hit;
  }
  return undefined;
}

function matchDriveHome(text: string, index: number): HomeMatch | undefined {
  if (!isDriveLetter(text, index)) return undefined;
  const afterDrive = readSeparator(text, index + 2);
  if (afterDrive === undefined) return undefined;
  const folder = readHomeFolder(text, afterDrive, true);
  if (!folder) return undefined;
  return finishHome(text, index, folder.userStart);
}

/**
 * `home/alice/...` with no leading slash. A JUnit attachment can be stored
 * that way. The folder name is at most `users` (5 letters), so a longer
 * word is rejected without scanning it.
 */
function matchBareFolderHome(text: string, index: number): HomeMatch | undefined {
  const ch = text[index] ?? '';
  if (ch !== 'h' && ch !== 'H' && ch !== 'u' && ch !== 'U') return undefined;
  if (!isPathStart(text, index)) return undefined;
  let end = index;
  const cap = Math.min(text.length, index + 6);
  while (end < cap && /[A-Za-z]/.test(text[end] ?? '')) end += 1;
  if (end - index > 5) return undefined;
  const folder = readHomeFolder(text, index, false);
  if (!folder) return undefined;
  return finishHome(text, index, folder.userStart);
}

function matchSlashHome(text: string, index: number): HomeMatch | undefined {
  // The second character of a backslash run is not its own path. The first
  // character already consumes the whole run, including UNC `\\server\...`.
  if (text[index] === '\\' && text[index - 1] === '\\') return undefined;
  const afterSep = readSeparator(text, index);
  if (afterSep === undefined) return undefined;
  const folder = readHomeFolder(text, afterSep, false);
  if (!folder) return undefined;
  // A backslash home does not need a path boundary. `x\\Users\\bob` and
  // `\\server\Users\bob` are still home directories.
  if (text[index] !== '\\' && !slashContextOk(text, index)) return undefined;
  return finishHome(text, index, folder.userStart);
}

/**
 * `~alice` or `~alice/proj`. `~/proj` has no username and stays.
 * The name must start with a letter, a digit, or `_`, and a separator or
 * the end of the path must follow. A `~` inside a quoted `locator(...)`
 * string is a CSS combinator and is not a home.
 */
function matchTildeHome(text: string, index: number): HomeMatch | undefined {
  if (text[index] !== '~') return undefined;
  if (!isMarkedStart(text, index)) return undefined;
  if (insideQuotedLocator(text, index)) return undefined;
  const next = text[index + 1];
  if (next === undefined || !/[A-Za-z0-9_]/.test(next)) return undefined;
  const userEnd = readUsernameEnd(text, index + 1);
  if (userEnd === index + 1) return undefined;
  const after = text[userEnd];
  const endOfPath = after === undefined || /[\s"'`)\]}>]/.test(after);
  if (after !== '/' && after !== '\\' && !endOfPath) return undefined;
  return finishHome(text, index, index + 1);
}

/** True when `index` sits inside `locator('...')` or `locator("...")`. */
function insideQuotedLocator(text: string, index: number): boolean {
  const before = lookbehind(text, index, 8000);
  const open = before.lastIndexOf('locator(');
  if (open === -1) return false;
  const afterCall = before.slice(open + 'locator('.length);
  const quote = /^\s*(['"])/.exec(afterCall);
  const mark = quote?.[1];
  if (!mark || quote === null) return false;
  const rest = afterCall.slice(quote[0].length);
  return !rest.includes(mark);
}

/**
 * `../../../home/bob/...` is what a rooted report stores for a path outside
 * the root. The `../` chain is part of the home path.
 */
function matchDotDotHome(text: string, index: number): HomeMatch | undefined {
  if (!text.startsWith('../', index) && !text.startsWith('..\\', index)) return undefined;
  if (!isDotDotStart(text, index)) return undefined;
  let cursor = index;
  while (text.startsWith('../', cursor) || text.startsWith('..\\', cursor)) cursor += 3;
  const folder = readHomeFolder(text, cursor, false);
  if (!folder) return undefined;
  return finishHome(text, index, folder.userStart);
}

function isMarkedStart(text: string, index: number): boolean {
  if (index === 0) return true;
  return /[\s"'=(`\[{:,;<>^]/.test(text[index - 1] ?? '');
}

function isDotDotStart(text: string, index: number): boolean {
  if (index === 0) return true;
  return /[\s"'=(`\[{:,;<>^/\\]/.test(text[index - 1] ?? '');
}

/**
 * `\/home\/name` and `C:\/Users\/name` hide the username without turning
 * other `\/` escapes into `/`. The characters after the username stay.
 */
function matchEscapedHome(text: string, index: number): HomeMatch | undefined {
  const drive = isDriveLetter(text, index) && text.startsWith(':\\/', index + 1);
  let folderAt: number;
  if (drive) folderAt = index + 4;
  else if (text.startsWith('\\/', index) && isPathStart(text, index)) folderAt = index + 2;
  else return undefined;
  let folderEnd = folderAt;
  while (folderEnd < text.length && /[A-Za-z]/.test(text[folderEnd] ?? '')) folderEnd += 1;
  if (folderEnd === folderAt) return undefined;
  const name = text.slice(folderAt, folderEnd);
  if (!/^home$/i.test(name) && !/^users$/i.test(name)) return undefined;
  if (!text.startsWith('\\/', folderEnd)) return undefined;
  const userStart = folderEnd + 2;
  let userEnd = userStart;
  while (userEnd < text.length) {
    const ch = text[userEnd] ?? '';
    if (ch === '\\' || ch === '/' || ch === '\n' || ch === '\r' || /\s/.test(ch)) break;
    if (/[?*#=,;]/.test(ch) || /["'`()<>|[\]{}]/.test(ch)) break;
    userEnd += 1;
  }
  if (userEnd === userStart) return undefined;
  const username = text.slice(userStart, userEnd);
  if (username.startsWith(':') || !/\p{L}/u.test(username)) return undefined;
  return {
    kind: 'replace',
    replaceFrom: index,
    username,
    hasSep: false,
    tail: '',
    next: userEnd,
    escaped: drive ? 'drive' : 'slash',
  };
}

/**
 * One `/`, or a run of `\`. `C:\Users` and `C:\\Users` are the same separator.
 * The returned index is the first character after that separator.
 */
function readSeparator(text: string, index: number): number | undefined {
  const ch = text[index];
  if (ch === '/') return index + 1;
  if (ch !== '\\') return undefined;
  let end = index + 1;
  while (text[end] === '\\') end += 1;
  return end;
}

function readHomeFolder(text: string, start: number, drive: boolean): { userStart: number } | undefined {
  let end = start;
  while (end < text.length && /[A-Za-z]/.test(text[end] ?? '')) end += 1;
  if (end === start) return undefined;
  const name = text.slice(start, end);
  const afterName = readSeparator(text, end);
  if (afterName === undefined) return undefined;
  const allowed = /^home$/i.test(name) || /^users$/i.test(name);
  if (!allowed) return undefined;
  return { userStart: afterName };
}

/** A drive letter is at the start, or the previous character is not a letter or digit. */
function isDriveLetter(text: string, index: number): boolean {
  if (!/[A-Za-z]/.test(text[index] ?? '')) return false;
  if (text[index + 1] !== ':') return false;
  if (index === 0) return true;
  return !/[A-Za-z0-9]/.test(text[index - 1] ?? '');
}

/** A short tail keeps each home check O(1). The full prefix would be quadratic. */
function lookbehind(text: string, index: number, width = 240): string {
  return text.slice(Math.max(0, index - width), index);
}

function slashContextOk(text: string, index: number): boolean {
  const before = lookbehind(text, index);
  if (isKnownHomePrefix(before)) return true;
  if (before.endsWith('file://localhost')) return true;
  // `//server/Users/...` and `\\server\Users\...` keep the server.
  if (/(?:^|[\s"'=(`\[{:,;<>^])[/\\]{2}[^/\\]+$/.test(before)) return true;
  if (/(?:^|[\s"'=(`\[{:,;<>^])smb:\/\/[^/\\]+$/i.test(before)) return true;
  return isPathStart(text, index);
}

function endsWithAt(text: string, index: number, mark: string): boolean {
  return text.slice(Math.max(0, index - mark.length), index) === mark;
}

function finishHome(text: string, replaceFrom: number, userStart: number): HomeMatch | undefined {
  const userEnd = readUsernameEnd(text, userStart);
  if (userEnd === userStart) return undefined;
  const username = text.slice(userStart, userEnd);
  if (username.startsWith(':') || !/\p{L}/u.test(username)) return undefined;
  const afterUser = readSeparator(text, userEnd);
  const hasSep = afterUser !== undefined;
  const tail = hasSep ? readPathTail(text, afterUser) : { text: '', next: userEnd };
  return {
    kind: 'replace',
    replaceFrom,
    username,
    hasSep,
    tail: tail.text,
    next: tail.next,
  };
}

/**
 * The match includes the slash before `home`. After `/tmp` that slash is the
 * separator, so the replacement writes it back. A drive letter is replaced
 * together with the folder.
 */
function homeToken(text: string, index: number, hasSep: boolean, mark: string): string {
  const written = hasSep ? `${mark}/` : mark;
  if (text[index] === '~') return written;
  if (index === 0 || isDriveLetter(text, index)) return written;
  if (isKnownHomePrefix(text.slice(0, index))) return `/${written}`;
  if (text.slice(Math.max(0, index - 7), index) === 'file://') return `/${written}`;
  if (endsWithAt(text, index, 'file://localhost')) return `/${written}`;
  return written;
}

/**
 * Words that end a display name when no separator follows.
 * Every earlier token is part of the name, including a lowercase surname
 * and a 3- or 4-token name. A word in this list stops the name, so
 * `Failed Again` stays. This hides extra words on purpose so no part of
 * a name leaks.
 */
const SECOND_WORD_PROSE = new Set([
  'a',
  'again',
  'an',
  'and',
  'at',
  'but',
  'by',
  'error',
  'failed',
  'for',
  'from',
  'in',
  'is',
  'not',
  'npm',
  'of',
  'on',
  'or',
  'the',
  'to',
  'was',
  'with',
]);

function readUsernameEnd(text: string, start: number): number {
  const allowSpace = separatorFollowsOnLine(text, start);
  let index = start;
  while (index < text.length) {
    const ch = text[index] ?? '';
    if (ch === '/' || ch === '\\' || ch === '\n' || ch === '\r') break;
    if (ch === ' ' || ch === '\t') {
      if (allowSpace) {
        index += 1;
        continue;
      }
      const word = /^[ \t]+(\p{L}[\p{L}\p{M}0-9_'.-]*)/u.exec(text.slice(index));
      const token = word?.[1];
      if (!word || token === undefined || SECOND_WORD_PROSE.has(token.toLowerCase())) break;
      index += word[0].length;
      continue;
    }
    if (
      ch === ':' ||
      ch === ';' ||
      ch === ',' ||
      ch === '"' ||
      ch === "'" ||
      ch === '`' ||
      ch === ')' ||
      ch === ']' ||
      ch === '>'
    ) {
      break;
    }
    index += 1;
  }
  return index;
}

/** A separator later on this line, before a username stop, allows spaces in the name. */
function separatorFollowsOnLine(text: string, start: number): boolean {
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index] ?? '';
    if (ch === '\n' || ch === '\r') return false;
    if (ch === '/' || ch === '\\') return true;
    if (ch === ' ' || ch === '\t') continue;
    if (
      ch === ':' ||
      ch === ';' ||
      ch === ',' ||
      ch === '"' ||
      ch === "'" ||
      ch === '`' ||
      ch === ')' ||
      ch === ']' ||
      ch === '>'
    ) {
      return false;
    }
  }
  return false;
}

function isKnownHomePrefix(before: string): boolean {
  return (
    /(?:^|[/\\])tmp$/.test(before) ||
    /(?:^|[/\\])var$/.test(before) ||
    /(?:^|[/\\])private$/.test(before) ||
    /(?:^|[/\\])mnt[/\\][^/\\]+$/.test(before)
  );
}

function isPathStart(text: string, index: number): boolean {
  if (index === 0) return true;
  if (text.slice(Math.max(0, index - 7), index) === 'file://') return true;
  const prev = text[index - 1] ?? '';
  if (!/[\s"'=(`\[{:,;<>^]/.test(prev)) return false;
  if (/\s/.test(prev)) {
    const method = /([A-Za-z]+)\s+$/.exec(lookbehind(text, index, 80));
    if (method && /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method[1] ?? '')) return false;
  }
  return true;
}

function readPathTail(value: string, start: number): { text: string; next: number } {
  let text = '';
  let index = start;
  while (index < value.length) {
    const ch = value[index] ?? '';
    if (isTailStop(ch) || /\s/.test(ch)) break;
    if (ch === '\\') {
      text += '/';
      while (value[index + 1] === '\\') index += 1;
    } else {
      text += ch;
    }
    index += 1;
  }
  const mixed = readMixedTail(value, index);
  if (mixed) {
    text += mixed.text;
    index = mixed.next;
  }
  return { text, next: index };
}

function isTailStop(ch: string): boolean {
  return /[?*#=,;]/.test(ch) || /["'`()<>|[\]{}]/.test(ch);
}

/**
 * One whitespace-delimited segment after the tail, and only when that
 * segment contains a backslash. Stop before a drive letter, `\\`, or a
 * UNC path so a later home is found on its own. Do not scan past that
 * segment: a backslash anywhere later on the line is not this path.
 */
function readMixedTail(value: string, start: number): { text: string; next: number } | undefined {
  if (start >= value.length || !/[\t ]/.test(value[start] ?? '')) return undefined;
  let index = start;
  let text = '';
  while (index < value.length && /[\t ]/.test(value[index] ?? '')) {
    text += value[index];
    index += 1;
  }
  if (index >= value.length || isDriveLetter(value, index) || isUncStart(value, index)) return undefined;
  const segmentAt = index;
  let sawBackslash = false;
  while (index < value.length) {
    const ch = value[index] ?? '';
    if (isTailStop(ch) || /\s/.test(ch) || ch === '/') break;
    if (index !== segmentAt && (isDriveLetter(value, index) || isUncStart(value, index))) break;
    if (ch === '\\') {
      if (value[index + 1] === '\\') break;
      if (isDriveLetter(value, index + 1)) break;
      sawBackslash = true;
      text += '/';
      index += 1;
      continue;
    }
    text += ch;
    index += 1;
  }
  if (!sawBackslash) return undefined;
  return { text, next: index };
}

function isUncStart(value: string, index: number): boolean {
  return value.startsWith('\\\\', index) || value.startsWith('//', index);
}

/**
 * A `/home/` or `/Users/` path left in the text on purpose.
 * `home` and `users` match in any case.
 */
function isBareHomePath(value: string): boolean {
  return /^\/(?:home|users)\//i.test(value) || /^[A-Za-z]:\/(?:home|users)\//i.test(value);
}

function stripAbsolutePrefix(value: string): string {
  const stripped = value.replace(/^[A-Za-z]:\//, '').replace(/^\/+/, '');
  return stripped === '' ? '.' : stripped;
}

/**
 * Rewrite one error-text token, or return undefined to leave it as written.
 * A token under the report root is rewritten whole, even when it contains
 * `?`, `*`, `#`, `=`, or `,`. When a report root is known, any other token
 * that starts with a known folder is rewritten only up to the first of
 * those characters. Without a report root, a home directory stays in the
 * error text. Any other blocked token stays as written.
 */
function rewriteErrorToken(token: string, root: string | undefined, warnings: string[]): string | undefined {
  const whole = rewritePathToken(token, root, warnings);
  if (whole !== undefined) return whole;
  if (!root) return undefined;
  // With a root, a known folder outside that root is cut at the first
  // blocked character so the absolute home path does not remain.
  const blockedAt = token.search(OUTSIDE_ROOT_BLOCKED);
  if (blockedAt <= 0) return undefined;
  const head = token.slice(0, blockedAt);
  const suffix = token.slice(blockedAt);
  const headPath = splitErrorToken(head).path;
  if (!startsWithFilesystemPrefix(normalizeSlashes(headPath))) return undefined;
  const shortened = rewritePathToken(head, root, warnings);
  if (shortened === undefined) return undefined;
  return `${shortened}${suffix}`;
}

function rewritePathToken(token: string, root: string | undefined, warnings: string[]): string | undefined {
  const parts = splitErrorToken(token);
  if (parts.path === '') return undefined;
  if (!shouldRewriteErrorToken(parts.path, root)) return undefined;
  const portable = toPortablePath(parts.path, root, warnings, false);
  if (portable === undefined) return undefined;
  const body = portable === '' ? '.' : portable;
  return `${parts.lead}${body}${parts.trailing}`;
}

function startsWithFilesystemPrefix(value: string): boolean {
  return FILESYSTEM_PREFIXES.some((prefix) => value.startsWith(prefix));
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
  if (OUTSIDE_ROOT_BLOCKED.test(stripped) || OUTSIDE_ROOT_BLOCKED.test(normalized)) return false;
  if (isRegexLiteral(stripped) || isRegexLiteral(normalized)) return false;
  if (!hasAllowedOutsideSegments(stripped)) return false;
  // Leave home paths in the error text. Classification reads that text, and
  // the triage report redacts the username when it builds output strings.
  if (!root && (isBareHomePath(stripped) || isBareHomePath(normalized) || redactHomeText(stripped) !== stripped)) {
    return false;
  }
  if (isWindowsDrivePath(stripped) && windowsHasSegment(stripped)) return true;
  if (normalized.startsWith('/') && SOURCE_LOCATION.test(normalized)) return true;
  return pathSegments(stripped).length >= 2 && FILESYSTEM_PREFIXES.some((prefix) => stripped.startsWith(prefix));
}

function hasAllowedOutsideSegments(value: string): boolean {
  const segments = pathSegments(value);
  if (segments.length === 0) return false;
  return segments.every((segment) => OUTSIDE_ROOT_SEGMENT.test(segment));
}

function pathSegments(value: string): string[] {
  const withoutDrive = value.replace(/^[A-Za-z]:/, '');
  return withoutDrive.replace(/\/+$/, '').split('/').filter((part) => part.length > 0);
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

/**
 * A mark the application already wrote, inside quotes, is not a generated
 * home mark. Tag it before numbering so `Expected: "<home~2>"` and a
 * redacted second username do not print the same text.
 * A parser path such as `<home>/proj` is not quoted, so it stays.
 */
function tagLiteralMarks(text: string): string {
  return text.replace(/<(home(?:~\d+)?|file~\d+)>/g, (full, inner: string, offset: number) => {
    const before = text[offset - 1];
    if (before !== '"' && before !== "'" && before !== '`') return full;
    return `<text:${inner}>`;
  });
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function pushWarning(warnings: string[], message: string): void {
  if (!warnings.includes(message)) warnings.push(message);
}
