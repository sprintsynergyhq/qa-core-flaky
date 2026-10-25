export type ReportFormat = 'json' | 'junit';

/** Drop a leading UTF-8 BOM so detection and JSON.parse see the real first character. */
export function stripLeadingBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Detect a report format from its contents.
 *
 * JSON when the first non-space character is `{`. JUnit when the text
 * contains a `testsuites` or `testsuite` tag. The file extension is ignored.
 * A leading UTF-8 BOM is ignored.
 */
export function detectFormat(text: string, reportPath: string): ReportFormat {
  const source = stripLeadingBom(text);
  const first = source.trimStart()[0];
  if (first === '{') return 'json';
  if (source.includes('<testsuites') || source.includes('<testsuite')) return 'junit';
  throw new Error(`unknown report format: ${reportPath}`);
}
