export type ReportFormat = 'json' | 'junit';

/**
 * Detect a report format from its contents.
 *
 * JSON when the first non-space character is `{`. JUnit when the text
 * contains a `testsuites` or `testsuite` tag. The file extension is ignored.
 */
export function detectFormat(text: string, reportPath: string): ReportFormat {
  const first = text.trimStart()[0];
  if (first === '{') return 'json';
  if (text.includes('<testsuites') || text.includes('<testsuite')) return 'junit';
  throw new Error(`unknown report format: ${reportPath}`);
}
