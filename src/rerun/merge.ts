import type { Attempt, RerunMode, TestRecord } from '../model.js';

/**
 * Append rerun attempts to the original records with the same id and commit.
 * An empty commit matches an empty commit. Every original attempt is kept.
 * Attempts that do not match a record are added as their own record.
 */
export function mergeRerunRecords(
  originals: readonly TestRecord[],
  incoming: readonly TestRecord[],
): TestRecord[] {
  const merged = originals.map((record) => ({
    ...record,
    attempts: record.attempts.map((attempt) => ({ ...attempt })),
  }));
  for (const extra of incoming) {
    const commit = extra.source.commitSha ?? '';
    const target = merged.find(
      (record) => record.id === extra.id && (record.source.commitSha ?? '') === commit,
    );
    if (!target) {
      merged.push({
        ...extra,
        attempts: extra.attempts.map((attempt) => ({ ...attempt })),
      });
      continue;
    }
    target.attempts.push(...extra.attempts.map((attempt) => ({ ...attempt })));
  }
  return merged;
}

/** Copy `rerun` onto every attempt. `runIndex` is the invocation index, then the result order inside it. */
export function tagRerunAttempts(
  records: readonly TestRecord[],
  mode: RerunMode,
  runIndex: number,
  commitSha: string | undefined,
): TestRecord[] {
  let next = runIndex;
  return records.map((record) => {
    const source = { ...record.source };
    if (commitSha && !source.commitSha) source.commitSha = commitSha;
    return {
      ...record,
      source,
      attempts: record.attempts.map((attempt) => {
        const tagged = tagAttempt(attempt, mode, next);
        next += 1;
        return tagged;
      }),
    };
  });
}

function tagAttempt(attempt: Attempt, mode: RerunMode, runIndex: number): Attempt {
  return {
    ...attempt,
    rerun: { mode, runIndex },
  };
}

/** Use the original record's commit when the caller did not pass one, so the rerun joins that code group. */
export function commitFor(records: readonly TestRecord[], id: string, commitSha: string | undefined): string | undefined {
  if (commitSha && commitSha.length > 0) return commitSha;
  const found = records.find((record) => record.id === id && record.source.commitSha);
  return found?.source.commitSha;
}
