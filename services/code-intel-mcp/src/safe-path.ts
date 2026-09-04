import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import picomatch from 'picomatch';

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

/**
 * Same verdict as `isPathWithinWorkspace`, but bound to one workspace root that is
 * canonicalized a single time. `canonicalizePath` realpaths the filesystem, so a
 * caller that checks many candidates against the same root — every import target of
 * a module graph, say — otherwise pays for resolving that one constant path again
 * and again.
 */
export function createWorkspaceBoundaryCheck(workspaceRoot: string): (candidatePath: string) => boolean {
  const rootCanonical = canonicalizePath(workspaceRoot);
  return (candidatePath: string): boolean => isWithinBoundary(rootCanonical, canonicalizePath(candidatePath));
}

/**
 * Returns true if `candidatePath` matches any of the operator-configured glob
 * `patterns`. Both sides are normalized the same way the boundary check uses
 * (forward slashes, no trailing slash, lower-cased on win32), so an explicit
 * allowlist entry can authorize a path OUTSIDE the default workspace root —
 * e.g. a sibling git worktree. The caller passes an already-canonical
 * (realpath-resolved) `candidatePath`, so `..`/symlink escapes are resolved
 * before matching and cannot widen the allowlist.
 */
export function matchesAnyPathPattern(candidatePath: string, patterns: string[]): boolean {
  const normalizedPatterns = patterns
    .map((pattern) => normalizeForCompare(pattern))
    .filter((pattern) => pattern.length > 0);

  if (normalizedPatterns.length === 0) {
    return false;
  }

  return picomatch(normalizedPatterns)(normalizeForCompare(candidatePath));
}
