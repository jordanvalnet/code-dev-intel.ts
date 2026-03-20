import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

function normalizeForCompare(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/g, '');
  if (process.platform === 'win32') {
    return normalized.toLowerCase();
  }
  return normalized;
}

function canonicalizePath(pathValue: string): string {
  const resolved = resolve(pathValue);
  if (existsSync(resolved)) {
    return realpathSync(resolved);
  }
  return resolved;
}

function isWithinBoundary(rootPath: string, candidatePath: string): boolean {
  const rootComparable = normalizeForCompare(rootPath);
  const candidateComparable = normalizeForCompare(candidatePath);

  if (candidateComparable === rootComparable) {
    return true;
  }

  const rootWithSeparator = `${rootComparable}/`;
  return candidateComparable.startsWith(rootWithSeparator);
}

export function assertWithinWorkspace(workspaceRoot: string, userPath: string): string {
  const rootCanonical = canonicalizePath(workspaceRoot);
  const candidateCanonical = canonicalizePath(resolve(rootCanonical, userPath));

  if (!isWithinBoundary(rootCanonical, candidateCanonical)) {
    throw new Error('path outside workspace root');
  }

  return candidateCanonical;
}

export function isPathWithinWorkspace(workspaceRoot: string, candidatePath: string): boolean {
  const rootCanonical = canonicalizePath(workspaceRoot);
  const candidateCanonical = canonicalizePath(candidatePath);
  return isWithinBoundary(rootCanonical, candidateCanonical);
}
