import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HEAL_PATCH_DIR, HEAL_PATCH_MARKER, ownedPatchEntries, patchBodyHash, patchMarkerText, type OwnedPatch } from './patch.js';

/** A patch path was not safe to read or write. The triage files can still be written. */
export class PatchWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchWriteError';
  }
}

export type PatchPlan = { name: string; body: string };

export type WriteHealPatchesOptions = {
  dir: string;
  planned: readonly PatchPlan[];
  /**
   * Runs after the patch directory is opened and before any file is written.
   * Tests use it to swap the directory path.
   */
  beforeWrite?: () => void;
  /** Runs after each new diff and the marker that lists it have been written. */
  afterEachWrite?: (index: number, name: string) => void;
};

type PathKind = { kind: 'missing' } | { kind: 'regular' } | { kind: 'reject'; reason: string };

/**
 * Write the patch files for one `--heal` run.
 * The directory is opened once. On Linux later reads and writes go through
 * that handle, so a swapped path is not followed. New files are written
 * before old names are deleted. A file is deleted only when its bytes match
 * the hash stored in the marker.
 */
export function writeHealPatchFiles(options: WriteHealPatchesOptions): void {
  const planned = options.planned.map((item) => {
    if (!/^[0-9a-f]{12}\.diff$/.test(item.name)) {
      throw new PatchWriteError(`Cannot write heal patches: ${item.name} is not a patch name.`);
    }
    return item;
  });
  const folder = path.join(path.resolve(options.dir), HEAL_PATCH_DIR);
  let info: fs.Stats | undefined;
  try {
    info = fs.lstatSync(folder);
  } catch {
    info = undefined;
  }
  if (info && (info.isSymbolicLink() || !info.isDirectory())) {
    if (planned.length === 0) return;
    throw new PatchWriteError(`Cannot write heal patches: ${HEAL_PATCH_DIR} exists and is not a directory.`);
  }
  if (!info) {
    if (planned.length === 0) return;
    fs.mkdirSync(folder, { recursive: true });
  }
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(folder, flags);
  try {
    options.beforeWrite?.();
    const opened = fs.fstatSync(fd);
    const viaHandle = process.platform === 'linux';
    if (!viaHandle) {
      const again = fs.lstatSync(folder);
      if (again.dev !== opened.dev || again.ino !== opened.ino || again.isSymbolicLink()) {
        throw new PatchWriteError(`Cannot write heal patches: ${HEAL_PATCH_DIR} changed before the write.`);
      }
    }
    const join = (name: string): string => (viaHandle ? `/proc/self/fd/${fd}/${name}` : path.join(folder, name));
    writeInside(join, planned, options.afterEachWrite);
  } finally {
    fs.closeSync(fd);
  }
}

function writeInside(
  join: (name: string) => string,
  planned: readonly PatchPlan[],
  afterEachWrite: WriteHealPatchesOptions['afterEachWrite'],
): void {
  const markerPath = join(HEAL_PATCH_MARKER);
  const markerState = inspectPatchPath(markerPath);
  if (markerState.kind === 'reject') refuse(HEAL_PATCH_MARKER, markerState.reason);
  const owned = markerState.kind === 'regular' ? ownedPatchEntries(fs.readFileSync(markerPath, 'utf8')) : [];
  for (const entry of owned) {
    const state = inspectPatchPath(join(entry.name));
    if (state.kind === 'reject') refuse(entry.name, state.reason);
  }
  for (const item of planned) {
    const state = inspectPatchPath(join(item.name));
    if (state.kind === 'reject') refuse(item.name, state.reason);
  }
  if (planned.length === 0) {
    for (const entry of owned) unlinkIfHashMatches(join(entry.name), entry.sha256);
    if (markerState.kind === 'regular') fs.unlinkSync(markerPath);
    return;
  }
  const listed = new Map<string, string>();
  for (const entry of owned) listed.set(entry.name, entry.sha256);
  planned.forEach((item, index) => {
    const hash = patchBodyHash(item.body);
    writeNewFile(join(item.name), item.name, item.body);
    listed.set(item.name, hash);
    writeMarker(join, [...listed.entries()].map(([name, sha256]) => ({ name, sha256 })));
    afterEachWrite?.(index, item.name);
  });
  const keep = new Set(planned.map((item) => item.name));
  for (const entry of owned) {
    if (keep.has(entry.name)) continue;
    unlinkIfHashMatches(join(entry.name), entry.sha256);
  }
  writeMarker(
    join,
    planned.map((item) => ({ name: item.name, sha256: patchBodyHash(item.body) })),
  );
}

function unlinkIfHashMatches(file: string, sha256: string): void {
  const state = inspectPatchPath(file);
  if (state.kind === 'missing') return;
  if (state.kind === 'reject') refuse(path.posix.basename(file), state.reason);
  if (hashFile(file) !== sha256) return;
  fs.unlinkSync(file);
}

function writeNewFile(file: string, label: string, body: string): void {
  const state = inspectPatchPath(file);
  if (state.kind === 'reject') refuse(label, state.reason);
  if (state.kind === 'regular') fs.unlinkSync(file);
  try {
    fs.writeFileSync(file, body, { flag: 'wx' });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    throw new PatchWriteError(`Cannot write heal patches: ${label}: ${detail}`);
  }
}

function writeMarker(join: (name: string) => string, entries: readonly OwnedPatch[]): void {
  const tmpName = '.qa-core-flaky.writing';
  const tmp = join(tmpName);
  const tmpState = inspectPatchPath(tmp);
  if (tmpState.kind === 'reject') refuse(tmpName, tmpState.reason);
  if (tmpState.kind === 'regular') fs.unlinkSync(tmp);
  fs.writeFileSync(tmp, patchMarkerText(entries), { flag: 'wx' });
  fs.renameSync(tmp, join(HEAL_PATCH_MARKER));
}

function inspectPatchPath(file: string): PathKind {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return { kind: 'reject', reason: 'is a symlink' };
    if (stat.isFIFO()) return { kind: 'reject', reason: 'is a fifo' };
    if (stat.isDirectory()) return { kind: 'reject', reason: 'is a directory' };
    if (stat.nlink > 1) return { kind: 'reject', reason: 'has more than one link' };
    if (!stat.isFile()) return { kind: 'reject', reason: 'is not a regular file' };
    return { kind: 'regular' };
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : '';
    if (code === 'ENOENT') return { kind: 'missing' };
    const detail = error instanceof Error ? error.message : 'unknown error';
    throw new PatchWriteError(`Cannot write heal patches: ${detail}`);
  }
}

function hashFile(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function refuse(label: string, reason: string): never {
  throw new PatchWriteError(`Cannot write heal patches: ${label} ${reason}.`);
}
