import { createHash } from 'node:crypto';
import type { HealChange, HealProposal } from '../report/schema.js';

/**
 * Directory of linked patch files, next to triage.html.
 * The name is one letter so a page of 200 proposals stays under 300 KB.
 */
export const HEAL_PATCH_DIR = 'h';

/** Diffs longer than this are written to a patch file and linked from Markdown. */
export const PATCH_INLINE_LINE_LIMIT = 12;

/** Diffs larger than this are linked even when they have few lines. */
export const PATCH_INLINE_BYTE_LIMIT = 4_000;

/** Unified-diff style text for the changes on one proposal. */
export function proposalDiff(changes: readonly HealChange[]): string {
  const lines: string[] = [];
  for (const change of changes) {
    lines.push(`--- ${change.file}:${change.startLine}`);
    lines.push(`+++ ${change.file}:${change.endLine}`);
    for (const line of change.before.split('\n')) lines.push(`-${line}`);
    for (const line of change.after.split('\n')) lines.push(`+${line}`);
  }
  return lines.join('\n');
}

/** True when the diff is too long to inline in Markdown. */
export function patchIsExternal(diff: string): boolean {
  if (diff.length === 0) return false;
  if (Buffer.byteLength(diff) > PATCH_INLINE_BYTE_LIMIT) return true;
  return diff.split('\n').length > PATCH_INLINE_LINE_LIMIT;
}

/**
 * Text for the linked patch file.
 * Skipped and unavailable rows stay on the page as a status word, so they have no file.
 */
export function proposalPatchBody(proposal: HealProposal): string {
  if (proposal.status === 'skipped-by-gate' || proposal.status === 'unavailable') return '';
  if (proposal.changes.length === 0 && !proposal.refusal && proposal.explanation.length === 0) return '';
  const lines = [proposal.label, `Status: ${proposal.status}.`];
  if (proposal.explanation) lines.push('', proposal.explanation);
  if (proposal.refusal) lines.push('', `Refusal: ${proposal.refusal.code}. ${proposal.refusal.message}`);
  if (proposal.verification?.baselineReproduced === false) {
    lines.push('', 'Failure did not reproduce before the fix, so the passing re-run is weak evidence.');
  }
  const diff = proposalDiff(proposal.changes);
  if (diff.length > 0) lines.push('', diff);
  if (proposal.applyCommand) lines.push('', `Apply by hand: ${proposal.applyCommand}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Relative patch path for one triage entry.
 * The name is a hash, so the link does not repeat the test title.
 */
export function healPatchName(entryId: string): string {
  const hash = createHash('sha256').update(entryId, 'utf8').digest('hex').slice(0, 12);
  return `${HEAL_PATCH_DIR}/${hash}.diff`;
}
