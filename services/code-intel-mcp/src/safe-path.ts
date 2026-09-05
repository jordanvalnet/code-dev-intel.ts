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

/**
 * Symlinks resolved AND, on a case-insensitive filesystem, the casing the file really
 * has on disk.
 *
 * `realpathSync` resolves symlinks but hands back the CALLER's spelling of every
 * segment, so on Windows and macOS `src/Sender.ts` and `src/sender.ts` — one single
 * file — canonicalize to two different strings. A module graph joins its edges to the
 * files it walked by string, so a mis-cased import (which compiles and runs on those
 * platforms, and is therefore common) would resolve to a node that does not exist and
 * its importer would silently vanish from every impact set. `realpathSync.native` asks
 * the operating system for the real name instead; it can fail on path shapes the JS
 * implementation still handles, so that one stays as the fallback.
 */
function canonicalizePath(pathValue: string): string {
  const resolved = resolve(pathValue);
  if (!existsSync(resolved)) {
    return resolved;
  }

  try {
    return realpathSync.native(resolved);
  } catch {
    return realpathSync(resolved);
  }
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
 * Bound to one workspace root that is canonicalized a single time, this returns the
 * canonical (realpath-resolved) form of a candidate that lies inside the workspace,
 * and `null` for one that does not. `canonicalizePath` realpaths the filesystem, so a
 * caller that checks many candidates against the same root — every import target of
 * a module graph, say — otherwise pays for resolving that one constant path again
 * and again; and a caller that needs the resolved target as well (a module symlinked
 * into `node_modules` from inside the workspace) gets it without a second realpath.
 */
export function createWorkspaceBoundaryResolver(
  workspaceRoot: string
): (candidatePath: string) => string | null {
  const rootCanonical = canonicalizePath(workspaceRoot);
  return (candidatePath: string): string | null => {
    const candidateCanonical = canonicalizePath(candidatePath);
    return isWithinBoundary(rootCanonical, candidateCanonical) ? candidateCanonical : null;
  };
}

/** Same verdict as `isPathWithinWorkspace`, bound to one canonicalized workspace root. */
export function createWorkspaceBoundaryCheck(workspaceRoot: string): (candidatePath: string) => boolean {
  const resolveWithinWorkspace = createWorkspaceBoundaryResolver(workspaceRoot);
  return (candidatePath: string): boolean => resolveWithinWorkspace(candidatePath) !== null;
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
