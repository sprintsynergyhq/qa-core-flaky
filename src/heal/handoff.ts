import type { VerdictName } from '../report/schema.js';

/** Handoff class written on each finding. `none` means heal must not act. */
export type HandoffMode = 'locator' | 'suggest' | 'none';

export type HandoffGateName =
  | 'verdict-not-likely-real-bug'
  | 'verdict-not-environment-issue'
  | 'no-slow-load-signal'
  | 'rule-has-fix-strategy'
  | 'evidence-present';

export type HandoffGate = {
  name: HandoffGateName;
  passed: boolean;
};

export type HandoffDecision = {
  mode: HandoffMode;
  reason: string;
  gates: HandoffGate[];
};

/**
 * Inputs for the five gates.
 * `ruleIds` is every cause rule on the test, so a slow load signal counts
 * even when it is not the primary rule.
 * `evidence` is quoted cause evidence. A note that the report has no error
 * text is not evidence.
 */
export type HandoffInput = {
  verdict: VerdictName;
  primaryRuleId: string;
  ruleIds: readonly string[];
  evidence: readonly string[];
};

/** Locator rules. Heal may propose a locator change, and only a person applies it. */
const LOCATOR_RULES = new Set(['SEL-NOTFOUND', 'SEL-UNRESOLVED', 'SEL-ZERO']);

/**
 * Suggestion rules. Heal may show a patch for review. It does not auto-apply.
 * `TIM-SLOW-LOAD` is in this set. The slow load gate blocks a locator
 * handoff. It does not turn this rule's own suggestion off.
 */
const SUGGEST_RULES = new Set([
  'SEL-STRICT',
  'TIM-EXPECT-TIMEOUT',
  'TIM-SLOW-LOAD',
  'TIM-TEST-TIMEOUT',
  'TIM-INTERCEPT',
  'DATA-VALUE-DRIFT',
  'DATA-ALREADY-EXISTS',
  'DATA-ORDER',
]);

const RULE_ID = /^(SEL|TIM|DATA|ENV|UNK)-[A-Z0-9-]+$/;

/**
 * Choose the handoff from the verdict, the primary rule, and the evidence.
 * A likely real bug or an environment issue is always `none`.
 * The same inputs return the same decision.
 */
export function decideHandoff(input: HandoffInput): HandoffDecision {
  const primaryRuleId = RULE_ID.test(input.primaryRuleId) ? input.primaryRuleId : 'UNK-NONE';
  const strategy = strategyFor(primaryRuleId);
  const slowLoad = input.ruleIds.includes('TIM-SLOW-LOAD');
  const evidence = input.evidence.some((line) => line.trim().length > 0);
  const gates: HandoffGate[] = [
    { name: 'verdict-not-likely-real-bug', passed: input.verdict !== 'likely-real-bug' },
    { name: 'verdict-not-environment-issue', passed: input.verdict !== 'environment-issue' },
    { name: 'no-slow-load-signal', passed: !slowLoad },
    { name: 'rule-has-fix-strategy', passed: strategy !== 'refuse' },
    { name: 'evidence-present', passed: evidence },
  ];
  const verdictOk = gates[0]?.passed === true && gates[1]?.passed === true;
  const slowOk = gates[2]?.passed === true;
  const evidenceOk = gates[4]?.passed === true;

  let mode: HandoffMode = 'none';
  if (verdictOk && evidenceOk && strategy === 'locator' && slowOk) mode = 'locator';
  else if (verdictOk && evidenceOk && strategy === 'suggest') mode = 'suggest';

  return {
    mode,
    reason: clip(reasonFor(mode, input.verdict, primaryRuleId, strategy, slowOk, evidenceOk)),
    gates,
  };
}

function strategyFor(ruleId: string): 'locator' | 'suggest' | 'refuse' {
  if (LOCATOR_RULES.has(ruleId)) return 'locator';
  if (SUGGEST_RULES.has(ruleId)) return 'suggest';
  return 'refuse';
}

function reasonFor(
  mode: HandoffMode,
  verdict: VerdictName,
  primaryRuleId: string,
  strategy: 'locator' | 'suggest' | 'refuse',
  slowOk: boolean,
  evidenceOk: boolean,
): string {
  if (verdict === 'likely-real-bug') {
    return 'Verdict is likely-real-bug. Heal must not change this test.';
  }
  if (verdict === 'environment-issue') {
    return 'Verdict is environment-issue. Heal must not change this test.';
  }
  if (mode === 'locator') {
    return `Selector rule ${primaryRuleId} can be handed to heal. The verdict is not a likely real bug or an environment issue, and there is no slow load signal.`;
  }
  if (mode === 'suggest') {
    return `Rule ${primaryRuleId} has a suggestion heal can review. The verdict is not a likely real bug or an environment issue.`;
  }
  if (strategy === 'refuse') {
    return `Rule ${primaryRuleId} has no fix strategy. Heal must not change this test.`;
  }
  if (!slowOk && strategy === 'locator') {
    return 'A slow load signal is present, so a locator handoff is not offered.';
  }
  if (!evidenceOk) {
    return 'There is no quoted evidence, so heal is not offered a handoff.';
  }
  return 'Heal is not offered a handoff for this test.';
}

function clip(value: string): string {
  return value.length > 300 ? value.slice(0, 300) : value;
}
