/** POSIX single quotes. A quote inside the value becomes `'\''`. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Escape a title or a file filter so `-g` and the file argument match literally. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
