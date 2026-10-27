import { createHash } from 'node:crypto';
import type { HealChange, HealProposal } from '../report/schema.js';

/**
 * Directory of linked patch files, next to triage.html.
 * The name is one letter so a page of 200 proposals stays under 300 KB.
 */
export const HEAL_PATCH_DIR = 'h';

/**
 * Marker written inside the patch folder after this tool creates diff files.
 * A later `--heal` run deletes only the names listed under it.
 */
export const HEAL_PATCH_MARKER = '.qa-core-flaky';

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

export type OwnedPatch = { name: string; sha256: string };

const OWNED_LINE = /^([0-9a-f]{12}\.diff) ([0-9a-f]{64})$/;

/**
 * Diff files this tool recorded, each with the SHA-256 of the bytes it wrote.
 * A line that is only a file name is ignored, so a planted name is not deleted.
 */
export function ownedPatchEntries(markerText: string): OwnedPatch[] {
  const lines = markerText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines[0] !== 'qa-core-flaky') return [];
  const owned: OwnedPatch[] = [];
  for (const line of lines.slice(1)) {
    const match = OWNED_LINE.exec(line);
    if (!match?.[1] || !match[2]) continue;
    owned.push({ name: match[1], sha256: match[2] });
  }
  return owned;
}

/** Diff names this tool recorded in a marker file. Anything else is left alone. */
export function ownedPatchNames(markerText: string): string[] {
  return ownedPatchEntries(markerText).map((entry) => entry.name);
}

/** SHA-256 of a patch body. The marker stores this next to the file name. */
export function patchBodyHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** Marker body listing the diff files this run wrote, with the hash of each body. */
export function patchMarkerText(entries: readonly OwnedPatch[]): string {
  return ['qa-core-flaky', ...entries.map((entry) => `${entry.name} ${entry.sha256}`), ''].join('\n');
}
