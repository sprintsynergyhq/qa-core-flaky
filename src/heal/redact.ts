import { redactHomeText, type HomeMarks } from '../report-path.js';

/**
 * Rules applied to every heal findings file.
 * The list is what the writer runs, not which rules happened to match.
 */
export const FINDING_REDACTION_RULES = [
  'home-user',
  'absolute-path',
  'url-query',
  'token-like',
  'email',
] as const;

export type FindingRedactionRule = (typeof FINDING_REDACTION_RULES)[number];

/**
 * Filesystem folders that identify a machine path.
 * An app route such as `/assets/` or `/inventory.html` is not in this list.
 * Longest prefixes are checked first.
 */
const FILESYSTEM_PREFIXES = [
  '/github/workspace/',
  '/agent/_work/',
  '/workspace/',
  '/private/',
  '/library/',
  '/project/',
  '/volumes/',
  '/runner/',
  '/builds/',
  '/users/',
  '/home/',
  '/code/',
  '/data/',
  '/proc/',
  '/root/',
  '/mnt/',
  '/opt/',
  '/etc/',
  '/usr/',
  '/tmp/',
  '/var/',
  '/app/',
  '/dev/',
  '/nix/',
  '/run/',
  '/src/',
  '/srv/',
  '/__w/',
] as const;

const URL_PATTERN = /(?:https?|wss?|ftps?):\/\/[^\s<>"'`]+/gi;
const FILE_URL_PATTERN = /file:\/\/+[^\s<>"'`]+/gi;
const MNT_HOME_PATTERN = /\/mnt\/[A-Za-z]\/(?:Users|home)\/[^\s<>"'`|)]*/gi;
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const ASSIGNED_SECRET_PATTERN =
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret[_-]?key|password|token)\s*[:=]\s*['"]?[^\s'"]{6,}/gi;
const STRIPE_PATTERN = /\bsk_(?:live|test)_[A-Za-z0-9]{8,}\b/g;
const GITHUB_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g;
const AWS_KEY_PATTERN = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const BASIC_AUTH_PATTERN = /\bAuthorization\s*:\s*Basic\s+\S+/gi;
const ENCODED_ROOTS =
  'home|users|opt|root|workspace|private|tmp|var|etc|usr|mnt|github|agent|app|data|code|src|project|library|proc|run|dev|nix';
const ENCODED_PATH_PATTERN = new RegExp(
  `%(?:2f|5c)(?:${ENCODED_ROOTS})(?:%(?:2f|5c)|\\/)[^\\s"'<>?\`]*(?:\\?[^\\s"'<>\`]*)?`,
  'gi',
);
const RELATIVE_QUERY_PATTERN =
  /(^|[\s"'`(=:[{,])((?:\.\.?\/|\/)[^?\s"'`<>#\\]*)[?][^\s"'`<>]*/g;

/**
 * Hide home usernames, other absolute paths, URL queries, token-like
 * strings, and emails. The same input returns the same text.
 * `marks` numbers home usernames the same way triage does.
 * A query is removed from http, https, ws, wss, and ftp URLs, from a
 * masked machine path, from a home mark, and from a relative path such as
 * `/cart?session=abc`. The relative query is removed before emails, so a
 * query that contains an email does not leave a fragment of that address.
 */
export function redactFindingText(value: string, marks?: HomeMarks): string {
  const urls = sanitizeUrls(value, marks);
  const files = redactFileUrls(urls);
  const queried = stripRelativeQueries(files);
  const emails = queried.replace(EMAIL_PATTERN, '<email>');
  const tokens = emails
    .replace(BEARER_PATTERN, 'Bearer <token>')
    .replace(JWT_PATTERN, '<token>')
    .replace(BASIC_AUTH_PATTERN, 'Authorization: Basic <token>')
    .replace(STRIPE_PATTERN, '<token>')
    .replace(GITHUB_PATTERN, '<token>')
    .replace(AWS_KEY_PATTERN, '<token>')
    .replace(ASSIGNED_SECRET_PATTERN, '<token>');
  const mounted = tokens.replace(MNT_HOME_PATTERN, (token) => maskPathToken(token));
  const homes = redactHomeText(mounted, marks);
  return stripHomeQueries(stripRelativeQueries(redactEncodedPaths(redactAbsolutePaths(homes))));
}

function sanitizeUrls(value: string, marks: HomeMarks | undefined): string {
  return value.replace(URL_PATTERN, (raw) => {
    const split = /^((?:https?|wss?|ftps?):\/\/)([^/?#]*)([^?#]*)/i.exec(raw);
    if (!split?.[1] || split[2] === undefined) return raw;
    const scheme = split[1];
    const authority = split[2].replace(/^[^/@]*@/, '');
    const path = redactAbsolutePaths(redactHomeText(split[3] ?? '', marks));
    return `${scheme}${authority}${path}`;
  });
}

function redactFileUrls(value: string): string {
  return value.replace(FILE_URL_PATTERN, (raw) => {
    const pathOnly = raw.split(/[?#]/)[0] ?? raw;
    const baseRaw = pathOnly.replace(/\\/g, '/').split('/').filter((part) => part.length > 0 && part.toLowerCase() !== 'file:').pop();
    const base = baseRaw?.replace(/:\d+(?::\d+)?$/, '');
    if (!base || base.includes(':') || base.startsWith('<')) return 'file:///<path>';
    return `file:///<path>/${base}`;
  });
}

function stripRelativeQueries(value: string): string {
  return value.replace(RELATIVE_QUERY_PATTERN, '$1$2');
}

/** A home mark keeps the path tail and drops `?query` and `#fragment`. */
function stripHomeQueries(value: string): string {
  return value.replace(/(<home(?:~\d+)?>\/[^\s<>"'`?#]*)[?#][^\s<>"'`]*/g, '$1');
}

function redactEncodedPaths(value: string): string {
  return value.replace(ENCODED_PATH_PATTERN, '<path>');
}

/**
 * Replace a machine path with `<path>/` plus its last segment.
 * A query or fragment on that path is dropped.
 * `http://`, `https://`, `ws://`, `wss://`, and `ftp://` spans are left
 * alone. They were cleaned first.
 */
function redactAbsolutePaths(value: string): string {
  let out = '';
  let index = 0;
  while (index < value.length) {
    const url = matchUrl(value, index);
    if (url !== undefined) {
      out += url;
      index += url.length;
      continue;
    }
    const token = matchAbsolute(value, index);
    if (token !== undefined) {
      out += maskPathToken(token);
      index += token.length;
      continue;
    }
    out += value[index] ?? '';
    index += 1;
  }
  return out;
}

function matchUrl(value: string, index: number): string | undefined {
  if (!isBoundary(value, index)) return undefined;
  const slice = value.slice(index);
  const match = /^(?:https?|wss?|ftps?):\/\/[^\s<>"'`]+/i.exec(slice);
  return match?.[0];
}

function matchAbsolute(value: string, index: number): string | undefined {
  if (!isBoundary(value, index)) return undefined;
  const slice = value.slice(index);
  const drive = /^[A-Za-z]:[\\/][^\s<>"'`|)]*/.exec(slice);
  if (drive?.[0]) return drive[0];
  if (value[index - 1] !== ':') {
    const unc = /^(?:\\\\|\/\/)[^\s<>"'`|)]+/.exec(slice);
    if (unc?.[0] && unc[0] !== '//' && unc[0] !== '\\\\') return unc[0];
  }
  const lower = slice.toLowerCase();
  for (const prefix of FILESYSTEM_PREFIXES) {
    if (!lower.startsWith(prefix)) continue;
    const rest = /^[^\s<>"'`|)]*/.exec(slice.slice(prefix.length));
    return slice.slice(0, prefix.length + (rest?.[0].length ?? 0));
  }
  return undefined;
}

function isBoundary(value: string, index: number): boolean {
  if (index === 0) return true;
  const previous = value[index - 1] ?? '';
  return /[\s"'`(=:[{,]/.test(previous);
}

function maskPathToken(token: string): string {
  const withoutQuery = token.split(/[?#]/)[0] ?? token;
  const normalized = withoutQuery.replace(/\\/g, '/').replace(/\/+$/, '');
  const base = normalized.split('/').filter((part) => part.length > 0).pop() ?? '';
  if (base === '' || base.includes(':') || base.startsWith('<')) return '<path>';
  return `<path>/${base}`;
}
