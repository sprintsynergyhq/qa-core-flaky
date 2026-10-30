export type {
  Attempt,
  AttemptError,
  AttemptStatus,
  Attachment,
  Outcome,
  ParseResult,
  RerunInfo,
  RerunMode,
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
export { homeMarks, redactHomeText, runnableConfigPath } from './report-path.js';
export type { HomeMarks } from './report-path.js';
export { redactParseResult } from './redact.js';
export { collapseRunRecords, reportStem, runIdentity } from './verdict.js';
export { normalizeErrorSignature } from './signature.js';
export { decideVerdict, VERDICT_ORDER } from './verdict.js';
export type { Verdict } from './verdict.js';
export { fixTemplates, suggestFix } from './fixes/templates.js';
export { buildTriageReport, renderTriageJson } from './report/json.js';
export {
  buildHealFindings,
  findingIdFor,
  findingPreimage,
  mergeProjectFacts,
  readReportProjectFacts,
  renderHealFindings,
} from './heal/findings.js';
export type { BuildHealFindingsOptions, HealFinding, HealFindingsDocument, HealProjectFacts } from './heal/findings.js';
export { collectHealProposals, healSpecPath, readFindingsContract, readRunTimeoutSupport, rowsFromCompatStdout, specRootsFromReport } from './heal/client.js';
export { canonicalFindingsPath, findingsPathIsTriageOutput } from './heal/findings-guard.js';
export { HEAL_PATCH_DIR, HEAL_PATCH_MARKER, healPatchName, ownedPatchEntries, ownedPatchNames, PATCH_INLINE_BYTE_LIMIT, PATCH_INLINE_LINE_LIMIT, patchBodyHash, patchIsExternal, patchMarkerText, proposalDiff, proposalPatchBody } from './heal/patch.js';
export { PatchWriteError, writeHealPatchFiles } from './heal/patch-write.js';
export {
  COMPAT_LABEL,
  CONTRACT_LABEL,
  errorProposal,
  proposalFromCompatRow,
  proposalFromContractRow,
  skippedProposal,
  unavailableProposal,
  UNAVAILABLE_LINE,
} from './heal/proposal.js';
export { assertHealArgsAllowed, bindHealTempDir, FORBIDDEN_HEAL_ARGS, findHealCli, healCommand, healTimeoutMs, installHealStopHandlers, removeHealStopHandlers, runHealCommand, runTimeoutSeconds } from './heal/run.js';
export type { HealCommand, HealCommandResult, HealCommandSource } from './heal/run.js';
export { decideHandoff } from './heal/handoff.js';
export type { HandoffDecision, HandoffGate, HandoffInput, HandoffMode } from './heal/handoff.js';
export { FINDING_REDACTION_RULES, redactFindingText } from './heal/redact.js';
export { quoteFailingSelector } from './heal/selector.js';
export type { BuildTriageOptions } from './report/json.js';
export { renderTriageMarkdown } from './report/markdown.js';
export { renderTriageHtml, writeTriageHtml } from './report/html.js';
export type { HtmlRenderOptions } from './report/html.js';
export { writeReportPair } from './report/pair.js';
export type { PairOps } from './report/pair.js';
export { orderDependencyEvidence } from './signals/order.js';
export { escapeRegex, shellQuote } from './rerun/quote.js';
export {
  RERUN_LIMITS,
  anchoredGrep,
  buildPlaywrightArgs,
  exactFileArg,
  fileFilterArg,
  formatCap,
  formatPrintedCommand,
  planReruns,
  commandForInvocation,
  shellCommand,
  splitRerunSentence,
} from './rerun/plan.js';
export type { PlanOptions, PlannedRun, RerunPlan, RunCap } from './rerun/plan.js';
export { commitFor, mergeRerunRecords, tagRerunAttempts } from './rerun/merge.js';
export {
  SIGNAL_EXIT,
  SIGNAL_WAIT_MS,
  STOP_SIGNALS,
  StoppedRun,
  executePlan,
  guardPipe,
  isStoppedRun,
  killProcessGroup,
  launchRerunChild,
  signalTree,
  stopChildTree,
  onStopSignal,
  releaseRun,
  rerunChildEnv,
  resolveProjectFile,
  selectRecords,
} from './rerun/run.js';
export type { CommandRunner, ReleaseState } from './rerun/run.js';
export type {
  HealChange,
  HealProposal,
  HealProposalStatus,
  HealStrategy,
  HealVerification,
  TriageAttempts,
  TriageEntry,
  TriageHistory,
  TriageReport,
  TriageReview,
  VerdictName,
  VerdictSignal,
  VerdictSignalKind,
} from './report/schema.js';
