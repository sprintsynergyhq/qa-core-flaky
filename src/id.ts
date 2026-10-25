/**
 * Build the stable test id.
 *
 * `project` is `default` when it is empty. `file` must already be relative
 * and use forward slashes; the parser does that before calling this.
 */
export function makeTestId(file: string, project: string, titlePath: readonly string[]): string {
  const projectName = project === '' ? 'default' : project;
  return `${file}::${projectName}::${titlePath.join(' > ')}`;
}

/**
 * One report can store two files that both redact to the same `<home>` path.
 * The first id stays `<home>`. Later distinct home directories become
 * `<file~2>`, `<file~3>`, in the order the parser saw them. `<home~2>` is
 * reserved for the second username inside one triage entry. The mark is not
 * the username. Records that already have different ids are left alone.
 */
export function disambiguateHomeFiles<T extends { id: string; file: string }>(
  records: readonly T[],
  rawFiles: readonly string[],
): T[] {
  const groups = new Map<string, number[]>();
  records.forEach((record, index) => {
    const list = groups.get(record.id) ?? [];
    list.push(index);
    groups.set(record.id, list);
  });
  const suffixes = new Map<number, string>();
  for (const indexes of groups.values()) {
    const keys: string[] = [];
    for (const index of indexes) {
      const key = homeUserKey(rawFiles[index] ?? '');
      if (key === '' || keys.includes(key)) continue;
      keys.push(key);
    }
    if (keys.length < 2) continue;
    const suffixByKey = new Map<string, string>();
    keys.forEach((key, keyIndex) => {
      suffixByKey.set(key, keyIndex === 0 ? '' : `~${keyIndex + 1}`);
    });
    for (const index of indexes) {
      const suffix = suffixByKey.get(homeUserKey(rawFiles[index] ?? '')) ?? '';
      if (suffix) suffixes.set(index, suffix);
    }
  }
  if (suffixes.size === 0) return [...records];
  return records.map((record, index) => {
    const suffix = suffixes.get(index);
    if (!suffix) return record;
    const mark = `<file${suffix}>`;
    return {
      ...record,
      file: record.file.replace('<home>', mark),
      id: record.id.replace('<home>', mark),
    };
  });
}

function homeUserKey(raw: string): string {
  const normalized = raw.replace(/\\+/g, '/');
  const match = /(?:^|\/)(?:home|Users)\/([^/]+)/i.exec(normalized);
  return match?.[1] ?? '';
}
