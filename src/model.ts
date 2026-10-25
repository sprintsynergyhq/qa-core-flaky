/**
 * Normalized result for a whole test, after retries.
 * `passed` means the Playwright status was expected (including an expected failure).
 * `flaky` means the first run failed and a retry passed.
 * `failed` means the test finished unexpected.
 * `skipped` means the test did not run.
 */
export type Outcome = 'passed' | 'flaky' | 'failed' | 'skipped';

/**
 * Status of one attempt. These are Playwright's result status values.
 * `passed` means the attempt passed.
 * `failed` means the attempt failed an assertion or threw.
 * `timedOut` means the attempt hit its timeout.
 * `skipped` means the attempt did not run.
 * `interrupted` means the attempt was stopped before it finished.
 * `unselectable` means a rerun command could not select this test.
 * Parsers do not emit it. Verdicts, causes, signatures, and rerun counts skip it.
 */
export type AttemptStatus = 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted' | 'unselectable';

/**
 * One error attached to an attempt. ANSI escape codes are removed before
 * the text is stored.
 */
export type AttemptError = {
  /** Error text with ANSI escape codes removed. */
  message: string;
  /** Stack trace with ANSI escape codes removed, when the report has one. */
  stack?: string;
  /** Source location of the error, when the report has file, line, and column. */
  location?: {
    /** File path. Relative to the report root. Never an absolute machine path. */
    file: string;
    /** Line number from the report. */
    line: number;
    /** Column number from the report. */
    column: number;
  };
};

/** A file the report attached to an attempt, such as a screenshot or trace. */
export type Attachment = {
  /** Attachment name from the report. */
  name: string;
  /** Path on disk, when the report has one. Relative. Never an absolute machine path. */
  path?: string;
  /** Media type from the report. */
  contentType: string;
};

/**
 * How a rerun attempt was launched.
 * `repeat` is `--repeat-each`. `isolated` is one test alone. `in-order` is the whole file.
 */
export type RerunMode = 'repeat' | 'isolated' | 'in-order';

/**
 * Marks an attempt that `qa-core-flaky rerun` produced.
 * `runIndex` starts at 0 for each mode and test. The original report has no `rerun` field.
 */
export type RerunInfo = {
  /** Which rerun mode produced this attempt. */
  mode: RerunMode;
  /** Index of this attempt inside that mode, starting at 0. */
  runIndex: number;
};

/** One run of a test, including the first run (retry 0) and each retry. */
export type Attempt = {
  /** Retry index. The first run is 0. */
  retry: number;
  /** Status of this attempt. */
  status: AttemptStatus;
  /** Duration of this attempt in milliseconds, from the report's duration field. */
  durationMs: number;
  /** Errors recorded for this attempt. Empty when the attempt has none. */
  errors: AttemptError[];
  /** Attachments recorded for this attempt. Empty when the attempt has none. */
  attachments: Attachment[];
  /** Worker that ran this attempt, when the report has one. */
  workerIndex?: number;
  /** Start time string from the report, when present. */
  startTime?: string;
  /** Set when this attempt came from `qa-core-flaky rerun`. Absent on the original report. */
  rerun?: RerunInfo;
};

/** Where a record came from. Later parsers reuse this shape. */
export type SourceInfo = {
  /** Report format. `playwright-json` or `junit`. */
  format: 'playwright-json' | 'junit';
  /** Path of the report that was parsed, as given to the parser. */
  reportPath: string;
  /** Run id, when the caller passes one. */
  runId?: string;
  /** Commit SHA, when the caller passes one. */
  commitSha?: string;
  /** Branch name, when the caller passes one. */
  branch?: string;
  /** Creation time, when the caller passes one. */
  createdAt?: string;
  /** Playwright config path recorded on the report, when it has one. */
  configFile?: string;
};

/** One test from a report, with every retry attempt kept. */
export type TestRecord = {
  /** Stable id: `file::project::title path`, with the title path joined by ` > `. */
  id: string;
  /** Spec file. Relative to the report root, with forward slashes, never an absolute machine path. */
  file: string;
  /** Line of the test in `file`, when the report has one. */
  line?: number;
  /** Playwright project name. `default` when the report has none. */
  project: string;
  /** Describe titles, then the spec title. The file-level suite title is omitted. A describe title is kept even when it equals the spec file name. */
  titlePath: string[];
  /** Status the test was expected to finish with. */
  expectedStatus: 'passed' | 'failed' | 'skipped' | 'timedOut' | 'interrupted';
  /** Normalized result for the whole test. */
  outcome: Outcome;
  /** Every attempt, sorted by `retry`. */
  attempts: Attempt[];
  /** Report this record was read from. */
  source: SourceInfo;
};

/** Output of a parser. Printed as JSON by `qa-core-flaky parse`. */
export type ParseResult = {
  /** Schema version of this document. This parser always writes 1. */
  schemaVersion: 1;
  /** One record per test found in the report. */
  records: TestRecord[];
  /** Problems that did not stop the parse. A test with zero results adds one. */
  warnings: string[];
};
