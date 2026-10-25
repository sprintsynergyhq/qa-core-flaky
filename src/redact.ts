import type { ParseResult, TestRecord } from './model.js';
import { redactHomeText } from './report-path.js';

/**
 * Hide home usernames in a parse result.
 *
 * `parse` and the parsers return the original error text. Cause rules read
 * that text. Call this, or pass `--redact` to `parse`, when the printed
 * records should hide the username too. The default stays raw.
 */
export function redactParseResult(result: ParseResult): ParseResult {
  return {
    ...result,
    records: result.records.map(redactRecord),
    warnings: result.warnings.map((warning) => redactHomeText(warning)),
  };
}

function redactRecord(record: TestRecord): TestRecord {
  return {
    ...record,
    id: redactHomeText(record.id),
    file: redactHomeText(record.file),
    titlePath: record.titlePath.map((part) => redactHomeText(part)),
    source: {
      ...record.source,
      reportPath: redactHomeText(record.source.reportPath),
    },
    attempts: record.attempts.map((attempt) => ({
      ...attempt,
      errors: attempt.errors.map((error) => {
        const next = {
          ...error,
          message: redactHomeText(error.message),
        };
        if (error.stack !== undefined) next.stack = redactHomeText(error.stack);
        if (error.location) {
          next.location = { ...error.location, file: redactHomeText(error.location.file) };
        }
        return next;
      }),
      attachments: attempt.attachments.map((item) => {
        if (item.path === undefined) return item;
        return { ...item, path: redactHomeText(item.path) };
      }),
    })),
  };
}
