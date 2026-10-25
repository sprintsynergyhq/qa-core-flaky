import type { Attempt, RerunMode, TestRecord } from '../model.js';
import { normalizeErrorSignature } from '../signature.js';

type ModeSummary = {
  kind: 'passed' | 'failed';
  count: number;
};

/**
 * Evidence for DATA-ORDER.
 *
 * A test that passes in-order and fails isolated, or the reverse, is
 * order-dependent when every failure in that mode shares one error signature.
 * A mode that mixes passes and failures, or mixes signatures, is not this signal.
 * An unselectable command is not a pass or a failure, so it cannot create this signal.
 * The line names the modes and the counts.
 */
export function orderDependencyEvidence(record: TestRecord): string[] {
  const ordered = summarize(record.attempts, 'in-order');
  const isolated = summarize(record.attempts, 'isolated');
  if (!ordered || !isolated) return [];
  if (ordered.kind === isolated.kind) return [];
  return [`in-order ${ordered.kind} ${ordered.count}, isolated ${isolated.kind} ${isolated.count}`];
}

function summarize(attempts: readonly Attempt[], mode: RerunMode): ModeSummary | undefined {
  const rows = attempts.filter((attempt) => attempt.rerun?.mode === mode && attempt.status !== 'unselectable');
  if (rows.length === 0) return undefined;
  const failed = rows.filter(isFailStatus);
  const passed = rows.filter((attempt) => attempt.status === 'passed');
  if (failed.length > 0 && passed.length > 0) return undefined;
  if (failed.length > 0) {
    const signatures = new Set(failed.map(attemptSignature));
    if (signatures.size !== 1) return undefined;
    return { kind: 'failed', count: failed.length };
  }
  if (passed.length === 0) return undefined;
  return { kind: 'passed', count: passed.length };
}

function attemptSignature(attempt: Attempt): string {
  const parts: string[] = [];
  for (const error of attempt.errors ?? []) {
    const message = error.message ?? '';
    const stack = error.stack ?? '';
    if (message.length > 0) parts.push(message);
    if (stack.length > 0 && stack !== message) parts.push(stack);
  }
  return normalizeErrorSignature(parts.join('\n').replace(/\r\n?/g, '\n'));
}

function isFailStatus(attempt: Attempt): boolean {
  return attempt.status === 'failed' || attempt.status === 'timedOut' || attempt.status === 'interrupted';
}
