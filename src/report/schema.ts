import type { CauseFinding } from '../causes/types.js';

/**
 * Verdict names, in report order.
 * `likely-real-bug` is a likely real bug. The report never says confirmed.
 */
export type VerdictName =
  | 'likely-real-bug'
  | 'flaky'
  | 'broken-test'
  | 'environment-issue'
  | 'needs-more-runs';

/** How the attempts supported the verdict. A conflict lists more than one. */
export type VerdictSignalKind =
  | 'consistent-failure'
  | 'same-code-flip'
  | 'insufficient-evidence'
  | 'unexpected-pass';

export type VerdictSignal = {
  /** Which signal this is. */
  kind: VerdictSignalKind;
  /** One sentence. No timestamp. */
  detail: string;
};

/** Pass and fail counts for one rerun mode. */
export type RerunCounts = {
  /** Attempts in this mode that Playwright actually ran. Unselectable commands are not included. */
  total: number;
  /** Failed, timed out, or interrupted attempts in this mode. */
  failed: number;
  /** Passed attempts in this mode. */
  passed: number;
  /** Commands that could not select this test. Omitted when there are none. Not part of `total`. */
  notRun?: number;
};

/** Pass and fail counts for one test id across every report given to triage. */
export type TriageAttempts = {
  /** Every attempt that ran, including skipped attempts. An unselectable rerun command is not included. */
  total: number;
  /** Attempts whose status is failed, timedOut, or interrupted. */
  failed: number;
  /** Attempts whose status is passed. */
  passed: number;
  /**
   * Present when `qa-core-flaky rerun` added attempts.
   * Only modes that ran are included.
   */
  reruns?: {
    repeat?: RerunCounts;
    isolated?: RerunCounts;
    'in-order'?: RerunCounts;
  };
  /**
   * True when a pass and a fail share the same code.
   * The same commit SHA matches across reports. A missing SHA matches only
   * inside one report.
   */
  sameCommit: boolean;
};

/**
 * History is filled by a later version.
 * `runsSeen` is the number of input records for this test id.
 * `firstFailingCommit` is always null here.
 */
export type TriageHistory = {
  runsSeen: number;
  firstFailingCommit: null;
};

export type TriageReview = {
  status: 'Needs Review';
  reviewer: null;
  decision: null;
};

/** One line range copied from a heal result. */
export type HealChange = {
  file: string;
  startLine: number;
  endLine: number;
  before: string;
  after: string;
};

export type HealProposalStatus =
  | 'proposed'
  | 'applied'
  | 'refused'
  | 'not-locator'
  | 'nothing-to-heal'
  | 'error'
  | 'unavailable'
  | 'skipped-by-gate';

export type HealStrategy = 'locator-heal' | 'rule-suggestion' | 'ai-suggestion' | 'none';

export type HealVerification = {
  performed: boolean;
  method: 'shadow-rerun' | 'none';
  runs: number;
  passed: number;
  failed: number;
  baselineReproduced: boolean | null;
  outcome: 'passed' | 'failed' | 'not-run';
};

/**
 * A dry-run proposal merged from qa-core-heal.
 * `null` means this command did not ask heal.
 * The shape matches `schemas/heal-proposal.v1.schema.json`.
 */
export type HealProposal = {
  contractVersion: 1;
  tool: 'qa-core-heal';
  toolVersion: string;
  mode: 'dry-run' | 'apply';
  status: HealProposalStatus;
  strategy: HealStrategy;
  fixRuleId: string | null;
  reviewLevel: 'standard' | 'review-carefully';
  label: string;
  changes: HealChange[];
  explanation: string;
  refusal: { code: string; message: string } | null;
  verification: HealVerification | null;
  ai: { used: boolean; label: string | null; promptSha256: string | null } | null;
  applyCommand: string | null;
};

/** One non-passing test in a triage report. */
export type TriageEntry = {
  /** Stable test id from the normalized record. */
  id: string;
  /** Verdict for this test. */
  verdict: VerdictName;
  /** High, medium, or low. See docs/verdicts.md. */
  confidence: 'high' | 'medium' | 'low';
  /** Decision-table row that selected the verdict, such as `LIKELY-REAL-BUG`. */
  ruleId: string;
  /** Signals that were present. A conflict lists the stronger one and the flip. */
  signals: VerdictSignal[];
  /** Likely causes, primary first. Evidence on each cause is quoted error text. */
  causes: CauseFinding[];
  /**
   * Quoted evidence from the cause that selected the verdict.
   * An unexpected pass, or any verdict whose failures have no error text, uses the note as evidence.
   */
  evidence: string[];
  /** Attempt counts. */
  attempts: TriageAttempts;
  /** Placeholder history. See `TriageHistory`. */
  history: TriageHistory;
  /** Fix text for the primary rule id. It never says to only raise a timeout. */
  suggestedFix: string;
  /**
   * A dry-run proposal from qa-core-heal.
   * Null when triage was not run with `--heal`.
   */
  healProposal: HealProposal | null;
  /** A sentence that contains `qa-core-flaky rerun --from <report> --only <id>`, plus `--config` when the report recorded one. */
  nextStep: string;
  /**
   * Set when every rerun attempt that ran passed.
   * The text is `no flake observed in N runs`. N does not include an unselectable command.
   * Absent when there were no ran reruns or a ran rerun did not pass.
   * The report does not call that result steady.
   */
  observation?: string;
  /** Set for an unexpected `test.fail()` pass, or when the failures have no error text. Otherwise null. */
  note: string | null;
  /** Reserved for a later explanation. Always null in this version. */
  llm: null;
  /** Every entry starts as Needs Review. */
  review: TriageReview;
};

/**
 * Triage report. `schemaVersion` 1 keeps these field meanings.
 * New fields may be added later. Existing fields are not renamed.
 */
export type TriageReport = {
  schemaVersion: 1;
  entries: TriageEntry[];
  /** Present only when triage is run with `--timestamp`. */
  generatedAt?: string;
};
