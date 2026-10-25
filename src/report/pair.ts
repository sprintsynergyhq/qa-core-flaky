import fs from 'node:fs';
import path from 'node:path';

export type PairOps = {
  /** Used for the temp renames. Tests pass a function that throws. */
  renameSync?: (from: string, to: string) => void;
};

/**
 * Write both triage files, or leave the previous pair in place.
 * Both bodies are written to temp names first. If either write fails, the
 * temp names are removed and the previous files stay. A destination that is
 * not a regular file, such as a directory named triage.json, is left as it
 * is. When both destinations are missing or are files, they are moved aside,
 * the temp names are renamed into place, and the copies are removed.
 * If a rename fails after a new file was created, that new file is removed
 * so an empty directory does not keep triage.md without triage.json.
 * A directory under /proc is not detected here. Node can hang while creating
 * one, which is documented on --out-dir instead of probed.
 */
export function writeReportPair(dir: string, json: string, markdown: string, ops: PairOps = {}): void {
  if (dir.trim() === '') throw new Error('The output directory is empty.');
  const renameSync = ops.renameSync ?? fs.renameSync;
  const resolved = path.resolve(dir);
  const jsonPath = path.join(resolved, 'triage.json');
  const mdPath = path.join(resolved, 'triage.md');
  const jsonTmp = path.join(resolved, `.triage.json.${process.pid}.tmp`);
  const mdTmp = path.join(resolved, `.triage.md.${process.pid}.tmp`);
  const jsonBak = path.join(resolved, `.triage.json.${process.pid}.bak`);
  const mdBak = path.join(resolved, `.triage.md.${process.pid}.bak`);
  let mdMoved = false;
  let jsonMoved = false;
  let mdPlaced = false;
  let jsonPlaced = false;
  try {
    fs.mkdirSync(resolved, { recursive: true });
    fs.writeFileSync(mdTmp, markdown);
    fs.writeFileSync(jsonTmp, json);
    if (blocksReplace(mdPath) || blocksReplace(jsonPath)) {
      throw new Error('triage.json and triage.md must be files');
    }
    mdMoved = moveAside(mdPath, mdBak, renameSync);
    jsonMoved = moveAside(jsonPath, jsonBak, renameSync);
    renameSync(mdTmp, mdPath);
    mdPlaced = true;
    renameSync(jsonTmp, jsonPath);
    jsonPlaced = true;
    fs.rmSync(mdBak, { force: true });
    fs.rmSync(jsonBak, { force: true });
  } catch (error) {
    if (mdPlaced && !mdMoved) fs.rmSync(mdPath, { force: true });
    if (jsonPlaced && !jsonMoved) fs.rmSync(jsonPath, { force: true });
    restoreMoved(mdPath, mdBak, mdMoved, renameSync);
    restoreMoved(jsonPath, jsonBak, jsonMoved, renameSync);
    fs.rmSync(jsonTmp, { force: true });
    fs.rmSync(mdTmp, { force: true });
    fs.rmSync(jsonBak, { force: true });
    fs.rmSync(mdBak, { force: true });
    throw error instanceof Error ? error : new Error('unknown error');
  }
}

function blocksReplace(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  return !fs.statSync(file).isFile();
}

function moveAside(file: string, bak: string, renameSync: (from: string, to: string) => void): boolean {
  if (!fs.existsSync(file)) return false;
  renameSync(file, bak);
  return true;
}

function restoreMoved(
  file: string,
  bak: string,
  moved: boolean,
  renameSync: (from: string, to: string) => void,
): void {
  if (!moved || !fs.existsSync(bak)) return;
  if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  renameSync(bak, file);
}
