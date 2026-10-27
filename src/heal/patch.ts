import { createHash } from 'node:crypto';
import type { HealChange } from '../report/schema.js';

/** Diffs longer than this are written to a patch file and linked. */
export const PATCH_INLINE_LINE_LIMIT = 12;

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

/** True when the diff is too long to inline in the HTML report. */
export function patchIsExternal(diff: string): boolean {
  if (diff.length === 0) return false;
  return diff.split('\n').length > PATCH_INLINE_LINE_LIMIT;
}

/**
 * Relative patch path for one triage entry.
 * The name is a hash, so the link does not repeat the test title.
 */
export function healPatchName(entryId: string): string {
  const hash = createHash('sha256').update(entryId, 'utf8').digest('hex').slice(0, 12);
  return `heal-patches/${hash}.diff`;
}
