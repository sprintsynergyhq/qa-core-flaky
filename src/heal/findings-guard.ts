import fs from 'node:fs';
import path from 'node:path';

const TRIAGE_OUTPUTS = ['triage.json', 'triage.md', 'triage.html'] as const;

/**
 * Resolve a path for the findings guard.
 * An existing file uses realpath. A missing file resolves the parent
 * directory, then appends the file name, so a symlinked parent is not missed.
 */
export function canonicalFindingsPath(file: string): string {
  const resolved = path.resolve(file);
  try {
    return fs.realpathSync(resolved);
  } catch {
    // The final file is missing. A symlink at this path is still resolved.
  }
  try {
    if (fs.lstatSync(resolved).isSymbolicLink()) {
      const target = path.resolve(path.dirname(resolved), fs.readlinkSync(resolved));
      try {
        return fs.realpathSync(target);
      } catch {
        return path.join(canonicalDirectory(path.dirname(target)), path.basename(target));
      }
    }
  } catch {
    // The path does not exist, so resolve the parent and keep the name.
  }
  return path.join(canonicalDirectory(path.dirname(resolved)), path.basename(resolved));
}

function canonicalDirectory(dir: string): string {
  const resolved = path.resolve(dir);
  try {
    return fs.realpathSync(resolved);
  } catch {
    try {
      if (fs.lstatSync(resolved).isSymbolicLink()) {
        return canonicalDirectory(path.resolve(path.dirname(resolved), fs.readlinkSync(resolved)));
      }
    } catch {
      // The parent is missing too.
    }
    return resolved;
  }
}

/**
 * True when the findings path is one of the triage outputs in `outDir`.
 * The same device and inode match a hard link. On macOS and Windows the
 * names are also compared without regard to case.
 */
export function findingsPathIsTriageOutput(findingsPath: string, outDir: string, platform = process.platform): boolean {
  const findings = canonicalFindingsPath(findingsPath);
  const fold = platform === 'darwin' || platform === 'win32';
  for (const name of TRIAGE_OUTPUTS) {
    const triage = canonicalFindingsPath(path.join(outDir, name));
    if (findings === triage) return true;
    if (fold && findings.toLowerCase() === triage.toLowerCase()) return true;
    try {
      const left = fs.statSync(findings);
      const right = fs.statSync(triage);
      if (left.dev === right.dev && left.ino === right.ino) return true;
    } catch {
      // One of the files does not exist yet.
    }
  }
  return false;
}
