import type { HealChange, HealProposal, HealStrategy, HealVerification } from '../report/schema.js';
import { shellQuote } from '../rerun/quote.js';
import { redactFindingText } from './redact.js';

export const CONTRACT_LABEL = 'Proposal from qa-core-heal (dry run, not applied)';
export const COMPAT_LABEL = 'Heal 0.3.x dry run, not re-run verified';
export const UNAVAILABLE_LINE = 'qa-core-heal is not installed. No proposal was made.';

const RESULT_STATUSES = new Set([
  'proposed',
  'applied',
  'refused',
  'not-locator',
  'nothing-to-heal',
  'error',
] as const);

type ResultStatus = (typeof RESULT_STATUSES extends Set<infer T> ? T : never);

function isResultStatus(status: string): status is ResultStatus {
  return (RESULT_STATUSES as ReadonlySet<string>).has(status);
}

const STRATEGIES = new Set(['locator-heal', 'rule-suggestion', 'ai-suggestion', 'none']);

const REFUSAL_CODES = new Set([
  'ambiguous-match',
  'element-changed',
  'strict-needs-human',
  'possible-real-bug',
  'weakens-test',
  'verification-failed',
  'baseline-not-reproduced',
  'no-safe-pattern',
  'ai-disabled',
  'ai-invalid-output',
  'ineligible-handoff',
  'navigation-or-network',
  'spec-not-found',
  'timeout',
]);

const FIX_RULE = /^(HEAL|FIX)-[A-Z0-9-]+$/;
const NO_AI = { used: false, label: null, promptSha256: null };

export type HealResultRow = {
  findingId?: string;
  testId?: string;
  file?: string;
  title?: string;
  name?: string;
  status?: string;
  strategy?: string;
  fixRuleId?: string | null;
  reviewLevel?: string;
  changes?: unknown;
  explanation?: string;
  message?: string;
  reason?: string;
  refusal?: unknown;
  verification?: unknown;
  ai?: unknown;
};

/** One clear line when heal cannot be started. */
export function unavailableProposal(): HealProposal {
  return shape({
    toolVersion: '',
    status: 'unavailable',
    strategy: 'none',
    reviewLevel: 'standard',
    label: CONTRACT_LABEL,
    explanation: UNAVAILABLE_LINE,
  });
}

/** Handoff was none, so heal is not asked to change the test. */
export function skippedProposal(toolVersion: string, reason: string, label: string = CONTRACT_LABEL): HealProposal {
  return shape({
    toolVersion,
    status: 'skipped-by-gate',
    strategy: 'none',
    reviewLevel: 'standard',
    label,
    explanation: clip(reason, 600),
    verification: notRunVerification(),
  });
}

/** Heal did not finish, or its output could not be used. */
export function errorProposal(
  toolVersion: string,
  explanation: string,
  label: string = CONTRACT_LABEL,
  refusal: { code: string; message: string } | null = null,
): HealProposal {
  return shape({
    toolVersion,
    status: 'error',
    strategy: 'none',
    reviewLevel: 'standard',
    label,
    explanation: clip(redactFindingText(explanation), 600),
    refusal: refusal
      ? { code: refusal.code, message: clip(redactFindingText(refusal.message), 400) }
      : null,
    verification: notRunVerification(),
  });
}

/**
 * Copy one contract-mode result into a proposal.
 * Apply mode is rejected. A proposed row still needs a change and a passing re-run.
 */
export function proposalFromContractRow(row: HealResultRow, toolVersion: string, mode: string): HealProposal {
  if (mode === 'apply') {
    return errorProposal(
      toolVersion,
      'qa-core-heal reported apply mode. This command only asks for a dry run.',
    );
  }
  return proposalFromRow(row, toolVersion, CONTRACT_LABEL, false);
}

/**
 * Copy one compat-mode row.
 * The re-run was not performed. The label says so, and review stays careful.
 */
export function proposalFromCompatRow(row: HealResultRow, toolVersion: string): HealProposal {
  return proposalFromRow(row, toolVersion, COMPAT_LABEL, true);
}

function proposalFromRow(row: HealResultRow, toolVersion: string, label: string, compat: boolean): HealProposal {
  const rawStatus = typeof row.status === 'string' ? row.status : 'error';
  if (!isResultStatus(rawStatus)) {
    return errorProposal(toolVersion, 'qa-core-heal returned a status this tool does not know.', label);
  }
  const status = rawStatus;
  if (status === 'applied') {
    return errorProposal(toolVersion, 'qa-core-heal reported an applied change during a dry run.', label);
  }
  const changes = readChanges(row.changes);
  const refusal = readRefusal(row.refusal, row);
  const strategy = readStrategy(row.strategy, changes, compat);
  if (status === 'proposed') {
    if (changes.length === 0) {
      return errorProposal(toolVersion, 'qa-core-heal marked this test proposed without a change.', label);
    }
    if (refusal) {
      return errorProposal(toolVersion, 'qa-core-heal marked this test proposed and also refused it.', label);
    }
    if (!compat) {
      const verification = readVerification(row.verification);
      if (!verification || verification.performed !== true || verification.outcome !== 'passed') {
        return errorProposal(toolVersion, 'qa-core-heal marked this test proposed without a passing re-run.', label);
      }
      return shape({
        toolVersion,
        status,
        strategy,
        fixRuleId: readFixRule(row.fixRuleId),
        reviewLevel: reviewLevel(row.reviewLevel, verification),
        label,
        changes,
        explanation: readExplanation(row),
        verification,
        ai: readAi(row.ai),
        applyCommand: applyCommandFor(strategy, status, changes),
      });
    }
    return shape({
      toolVersion,
      status: 'proposed',
      strategy,
      fixRuleId: readFixRule(row.fixRuleId),
      reviewLevel: 'review-carefully',
      label,
      changes,
      explanation: readExplanation(row),
      verification: notRunVerification(),
      ai: readAi(row.ai),
      applyCommand: applyCommandFor(strategy, 'proposed', changes),
    });
  }
  if (status === 'refused' && !refusal) {
    return errorProposal(toolVersion, 'qa-core-heal refused this test without a reason.', label);
  }
  return shape({
    toolVersion,
    status,
    strategy: status === 'refused' || status === 'error' ? 'none' : strategy,
    fixRuleId: readFixRule(row.fixRuleId),
    reviewLevel: row.reviewLevel === 'review-carefully' ? 'review-carefully' : 'standard',
    label,
    changes: status === 'refused' ? [] : changes,
    explanation: readExplanation(row),
    refusal,
    verification: readVerification(row.verification) ?? notRunVerification(),
    ai: readAi(row.ai),
    applyCommand: null,
  });
}

function shape(input: {
  toolVersion: string;
  status: HealProposal['status'];
  strategy: HealProposal['strategy'];
  reviewLevel: HealProposal['reviewLevel'];
  label: string;
  explanation: string;
  fixRuleId?: string | null;
  changes?: HealChange[];
  refusal?: HealProposal['refusal'];
  verification?: HealVerification | null;
  ai?: HealProposal['ai'];
  applyCommand?: string | null;
}): HealProposal {
  return {
    contractVersion: 1,
    tool: 'qa-core-heal',
    toolVersion: input.toolVersion,
    mode: 'dry-run',
    status: input.status,
    strategy: input.strategy,
    fixRuleId: input.fixRuleId ?? null,
    reviewLevel: input.reviewLevel,
    label: input.label,
    changes: input.changes ?? [],
    explanation: input.explanation,
    refusal: input.refusal ?? null,
    verification: input.verification ?? null,
    ai: input.ai ?? NO_AI,
    applyCommand: input.applyCommand ?? null,
  };
}

function notRunVerification(): HealVerification {
  return {
    performed: false,
    method: 'none',
    runs: 0,
    passed: 0,
    failed: 0,
    baselineReproduced: null,
    outcome: 'not-run',
  };
}

function readStrategy(value: unknown, changes: readonly HealChange[], compat: boolean): HealStrategy {
  if (typeof value === 'string' && STRATEGIES.has(value)) return value as HealStrategy;
  if (compat && changes.length > 0) return 'locator-heal';
  return 'none';
}

function readFixRule(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return FIX_RULE.test(value) ? value : null;
}

function reviewLevel(value: unknown, verification: HealVerification): 'standard' | 'review-carefully' {
  if (verification.baselineReproduced === false) return 'review-carefully';
  return value === 'review-carefully' ? 'review-carefully' : 'standard';
}

function readExplanation(row: HealResultRow): string {
  const text = firstString(row.explanation, row.message, row.reason);
  return clip(redactFindingText(text), 600);
}

function readRefusal(value: unknown, row: HealResultRow): HealProposal['refusal'] {
  if (isObject(value) && typeof value.code === 'string') {
    const known = REFUSAL_CODES.has(value.code);
    const code = known ? value.code : 'no-safe-pattern';
    const message = typeof value.message === 'string' ? value.message : firstString(row.message, row.reason, row.explanation);
    if (message.length === 0 && known) return null;
    const shown = known || message.length === 0 ? message : `${value.code}: ${message}`;
    if (shown.length === 0) return null;
    return { code, message: clip(redactFindingText(shown), 400) };
  }
  if (row.status === 'refused') {
    const message = firstString(row.message, row.reason, row.explanation);
    if (message.length === 0) return null;
    return { code: 'no-safe-pattern', message: clip(redactFindingText(message), 400) };
  }
  return null;
}

function readChanges(value: unknown): HealChange[] {
  if (!Array.isArray(value)) return [];
  const changes: HealChange[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const file = typeof item.file === 'string' ? redactFindingText(item.file) : '';
    const before = typeof item.before === 'string' ? redactFindingText(item.before) : '';
    const after = typeof item.after === 'string' ? redactFindingText(item.after) : '';
    const startLine = integerAtLeast1(item.startLine);
    const endLine = integerAtLeast1(item.endLine);
    if (file.length === 0 || startLine === null || endLine === null) continue;
    changes.push({ file, startLine, endLine, before, after });
  }
  return changes;
}

function readVerification(value: unknown): HealVerification | null {
  if (!isObject(value)) return null;
  if (typeof value.performed !== 'boolean') return null;
  const method = value.method === 'shadow-rerun' ? 'shadow-rerun' : 'none';
  const outcome = value.outcome === 'passed' || value.outcome === 'failed' ? value.outcome : 'not-run';
  const baseline = value.baselineReproduced;
  return {
    performed: value.performed,
    method,
    runs: whole(value.runs),
    passed: whole(value.passed),
    failed: whole(value.failed),
    baselineReproduced: typeof baseline === 'boolean' ? baseline : null,
    outcome,
  };
}

function readAi(value: unknown): HealProposal['ai'] {
  if (!isObject(value) || value.used !== true) return NO_AI;
  const label = typeof value.label === 'string' ? clip(redactFindingText(value.label), 200) : null;
  const prompt = typeof value.promptSha256 === 'string' && /^[0-9a-f]{64}$/.test(value.promptSha256) ? value.promptSha256 : null;
  return { used: true, label, promptSha256: prompt };
}

function applyCommandFor(strategy: HealStrategy, status: string, changes: readonly HealChange[]): string | null {
  if (strategy !== 'locator-heal' || status !== 'proposed') return null;
  const file = changes[0]?.file;
  if (!file) return null;
  return `npx qa-core-heal ${shellQuote(file)} --apply`;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return '';
}

function integerAtLeast1(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
  return value;
}

function whole(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return 0;
  return value;
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
