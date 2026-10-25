export type {
  Attempt,
  AttemptError,
  AttemptStatus,
  Attachment,
  Outcome,
  ParseResult,
  SourceInfo,
  TestRecord,
} from './model.js';

export { parsePlaywrightJson } from './parsers/playwright-json.js';
export { parseJunit } from './parsers/junit.js';
export { detectFormat } from './parsers/detect.js';
export type { ReportFormat } from './parsers/detect.js';
export { makeTestId } from './id.js';
export { classifyCauses } from './causes/index.js';
export type { Cause, CauseFinding, ClassifyOptions, Confidence, OrderDependencyHook } from './causes/index.js';
export { normalizeErrorSignature } from './signature.js';
export { decideVerdict, VERDICT_ORDER } from './verdict.js';
export type { Verdict } from './verdict.js';
export { fixTemplates, suggestFix } from './fixes/templates.js';
export { buildTriageReport, renderTriageJson } from './report/json.js';
export type { BuildTriageOptions } from './report/json.js';
export { renderTriageMarkdown } from './report/markdown.js';
export type {
  TriageAttempts,
  TriageEntry,
  TriageHistory,
  TriageReport,
  TriageReview,
  VerdictName,
  VerdictSignal,
  VerdictSignalKind,
} from './report/schema.js';
