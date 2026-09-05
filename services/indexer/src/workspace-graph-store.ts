import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import type { UnresolvedReason } from '../../code-intel-mcp/src/contracts.ts';

/**
 * Bump whenever the shape below changes in a way an older writer would get wrong. A
 * file that does not match is not migrated — it is ignored, and the workspace is read
 * again from disk, which is slower and always right.
 */
export const GRAPH_CACHE_SCHEMA_VERSION = 2;

/** Cap on what a cache file may claim to contain, so a huge or hostile file is refused. */
const MAX_PERSISTED_FILES = 60_000;

/**
 * How long a workspace's cache file is kept after the last time it was written, and how
 * many workspaces are kept at all. One file per workspace root, nothing ever deleting
 * them and roots that no longer exist among them, is a directory that only grows — an
 * agent working across worktrees can leave a multi-megabyte file per checkout behind
 * forever. Both bounds are swept on write, which is the only moment this code already
 * knows it is allowed to touch the directory.
 */
const MAX_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 32;
/** A temporary file older than this is a write that died, not a write in progress. */
const MAX_TEMPORARY_AGE_MS = 60 * 60 * 1000;

const UNRESOLVED_REASONS = new Set<string>([
  'not-found',
  'outside-workspace',
  'unsupported-file-type',
  'dynamic-specifier'
]);

export interface PersistedReExport {
  source: string;
  exported: string;
}

export interface PersistedImportRef {
  specifier: string;
  importedSymbols: string[];
  reExports?: PersistedReExport[];
}

export interface PersistedFacts {
  imports: PersistedImportRef[];
  dynamicSpecifiers: string[];
  exports: string[];
}

export interface PersistedEdge {
  targetFile: string;
  importedSymbols: string[];
  reExports?: PersistedReExport[];
}

export interface PersistedUnresolved {
  specifier: string;
  reason: UnresolvedReason;
}

export interface PersistedProvenance {
  targets: string[];
  failedLookups: string[];
  affecting: string[];
  directoryProbes: string[];
}

export interface PersistedResolution {
  edges: PersistedEdge[];
  assetEdges: PersistedEdge[];
  unresolved: PersistedUnresolved[];
  provenance: PersistedProvenance;
}

export interface PersistedFile {
  /** Workspace-relative posix path. Never absolute, never containing `..`. */
  path: string;
  mtimeMs: number;
  size: number;
  /** `Date.now()` from before the writing process read the file — the freshness margin. */
  cachedAtMs: number;
  /** Digest of the content the facts came from; what proves a suspected rename really is one. */
  digest: string;
  facts: PersistedFacts;
  /** Absent when the writing process had parsed the file but not yet resolved it. */
  resolved?: PersistedResolution;
}

export interface PersistedWorkspaceGraph {
  schemaVersion: number;
  engineVersion: string;
  /** Canonical, case-folded root the file was written for. */
  root: string;
  savedAtMs: number;
  files: PersistedFile[];
  assets: string[];
  /** Every directory the walk saw, so an empty one appearing or vanishing is a change. */
  directories: string[];
  /** Entries the walk saw but could not look inside (symlinks), tracked for the same reason. */
  others: string[];
  /** `[relativePath, contentDigest]` for every walked manifest. */
  manifests: Array<[string, string]>;
  /** Config files the resolver consulted, with the fingerprint they had when saved. */
  configSources: string[];
  configFingerprint: string;
}

function readPackageVersion(): string {
  try {
    // Three levels up from `<pkg>/services/indexer/src` in a checkout and from
    // `<pkg>/dist/indexer/src` in the published package — the same relative place.
    const manifestPath = resolve(import.meta.dirname, '..', '..', '..', 'package.json');
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null) {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === 'string' && version.length > 0) {
        return version;
      }
    }
  } catch {
    // A package with no readable manifest still gets a stable, self-consistent key.
  }
  return 'unknown';
}

/**
 * What the cached answers were produced BY. TypeScript's version is part of it because
 * module resolution is its behaviour, not this package's: an upgrade can legitimately
 * move an edge, and reusing yesterday's resolutions across it would be a wrong graph.
 */
const ENGINE_VERSION = `${readPackageVersion()}+ts${ts.version}`;

export function graphCacheEngineVersion(): string {
  return ENGINE_VERSION;
}

/**
 * Any of the ordinary ways of writing "no" switches the file off entirely — nothing
 * read, nothing written, no directory made. A user who sets this to `false` and gets a
 * multi-megabyte file in their home directory anyway has been told one thing and given
 * another, so all four spellings are honoured rather than only the documented one.
 */
const DISABLING_VALUES = new Set(['off', 'false', '0', 'no']);

export function isGraphCacheEnabled(): boolean {
  return !DISABLING_VALUES.has((process.env['CODE_INTEL_GRAPH_CACHE'] ?? '').trim().toLowerCase());
}

/**
 * Where the cache lives: the OS user cache directory, never the workspace.
 *
 * A cache inside the repository would be a file a repository can SHIP — and this one
 * decides which files import which, so a planted copy could quietly add edges to an
 * answer an agent then acts on. Keeping it in the user's own cache directory means a
 * checkout can only ever affect the machine that checked it out.
 */
function graphCacheDirectory(): string {
  const override = process.env['CODE_INTEL_CACHE_DIR'];
  if (override !== undefined && override.trim().length > 0) {
    return resolve(override.trim());
  }

  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'];
    if (localAppData !== undefined && localAppData.trim().length > 0) {
      return join(localAppData, 'code-dev-intel', 'graph-cache');
    }
  }

  const xdg = process.env['XDG_CACHE_HOME'];
  const base = xdg !== undefined && xdg.trim().length > 0 ? xdg : join(homedir(), '.cache');
  return join(base, 'code-dev-intel', 'graph-cache');
}

/**
 * One file per workspace, named by a digest of the canonical root. The name carries
 * nothing about the project, so a shared or synced cache directory leaks no paths.
 */
export function graphCacheFilePath(workspaceRoot: string): string {
  const canonical = resolve(workspaceRoot).replaceAll('\\', '/');
  const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  return join(graphCacheDirectory(), `${createHash('sha256').update(key).digest('hex')}.json`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * A workspace-relative posix path and nothing else. This is the load-bearing check on
 * an untrusted file: without it a planted entry could name `../../elsewhere/x.ts`, or a
 * Windows absolute path, and have the graph answer about a file the walk never saw.
 */
function isWorkspaceRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    return false;
  }
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/') || /^[a-zA-Z]:/.test(value)) {
    return false;
  }
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function isReExportArray(value: unknown): value is PersistedReExport[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => isPlainObject(entry) && typeof entry['source'] === 'string' && typeof entry['exported'] === 'string')
  );
}

function isFacts(value: unknown): value is PersistedFacts {
  if (!isPlainObject(value) || !isStringArray(value['dynamicSpecifiers']) || !isStringArray(value['exports'])) {
    return false;
  }

  const imports = value['imports'];
  return (
    Array.isArray(imports) &&
    imports.every(
      (entry) =>
        isPlainObject(entry) &&
        typeof entry['specifier'] === 'string' &&
        isStringArray(entry['importedSymbols']) &&
        (entry['reExports'] === undefined || isReExportArray(entry['reExports']))
    )
  );
}

function isEdgeArray(value: unknown): value is PersistedEdge[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isPlainObject(entry) &&
        isWorkspaceRelativePath(entry['targetFile']) &&
        isStringArray(entry['importedSymbols']) &&
        (entry['reExports'] === undefined || isReExportArray(entry['reExports']))
    )
  );
}

function isProvenance(value: unknown): value is PersistedProvenance {
  return (
    isPlainObject(value) &&
    isStringArray(value['targets']) &&
    isStringArray(value['failedLookups']) &&
    isStringArray(value['affecting']) &&
    isStringArray(value['directoryProbes'])
  );
}

function isResolution(value: unknown): value is PersistedResolution {
  if (!isPlainObject(value) || !isEdgeArray(value['edges']) || !isEdgeArray(value['assetEdges'])) {
    return false;
  }

  const unresolved = value['unresolved'];
  if (
    !Array.isArray(unresolved) ||
    !unresolved.every(
      (entry) =>
        isPlainObject(entry) &&
        typeof entry['specifier'] === 'string' &&
        typeof entry['reason'] === 'string' &&
        UNRESOLVED_REASONS.has(entry['reason'])
    )
  ) {
    return false;
  }

  return isProvenance(value['provenance']);
}

function isPersistedFile(value: unknown): value is PersistedFile {
  return (
    isPlainObject(value) &&
    isWorkspaceRelativePath(value['path']) &&
    isFiniteNumber(value['mtimeMs']) &&
    isFiniteNumber(value['size']) &&
    isFiniteNumber(value['cachedAtMs']) &&
    typeof value['digest'] === 'string' &&
    value['digest'].length > 0 &&
    value['digest'].length <= 128 &&
    isFacts(value['facts']) &&
    (value['resolved'] === undefined || isResolution(value['resolved']))
  );
}

/**
 * Validate a cache file field by field. It is read from a directory the user owns, but
 * it is still input from outside this process, and the cost of trusting it is a graph
 * that quietly disagrees with the disk. Anything unexpected is `null`, which the caller
 * turns into an ordinary cold build.
 */
function validatePersistedGraph(value: unknown, expectedRoot: string): PersistedWorkspaceGraph | null {
  if (!isPlainObject(value)) {
    return null;
  }

  if (value['schemaVersion'] !== GRAPH_CACHE_SCHEMA_VERSION || value['engineVersion'] !== ENGINE_VERSION) {
    return null;
  }

  if (value['root'] !== expectedRoot || !isFiniteNumber(value['savedAtMs'])) {
    return null;
  }

  const files = value['files'];
  if (!Array.isArray(files) || files.length > MAX_PERSISTED_FILES || !files.every(isPersistedFile)) {
    return null;
  }

  const assets = value['assets'];
  if (!Array.isArray(assets) || !assets.every(isWorkspaceRelativePath)) {
    return null;
  }

  const directories = value['directories'];
  if (!Array.isArray(directories) || !directories.every(isWorkspaceRelativePath)) {
    return null;
  }

  const others = value['others'];
  if (!Array.isArray(others) || !others.every(isWorkspaceRelativePath)) {
    return null;
  }

  const manifests = value['manifests'];
  if (
    !Array.isArray(manifests) ||
    !manifests.every(
      (entry) => Array.isArray(entry) && entry.length === 2 && isWorkspaceRelativePath(entry[0]) && typeof entry[1] === 'string'
    )
  ) {
    return null;
  }

  if (!isStringArray(value['configSources']) || typeof value['configFingerprint'] !== 'string') {
    return null;
  }

  return {
    schemaVersion: GRAPH_CACHE_SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    root: expectedRoot,
    savedAtMs: value['savedAtMs'],
    files,
    assets,
    directories,
    others,
    manifests: manifests as Array<[string, string]>,
    configSources: value['configSources'],
    configFingerprint: value['configFingerprint']
  };
}

/** The root spelling a cache file is stamped with, and validated against on load. */
export function canonicalRootKey(workspaceRoot: string): string {
  const canonical = resolve(workspaceRoot).replaceAll('\\', '/');
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

export interface PersistedGraphRead {
  graph: PersistedWorkspaceGraph;
  bytes: number;
  loadMs: number;
}

/**
 * The workspace's cache file, or `null` — for any reason at all. A missing, unreadable,
 * truncated, stale or hostile file all mean the same thing here: build from disk.
 */
export function readPersistedGraph(workspaceRoot: string): PersistedGraphRead | null {
  if (!isGraphCacheEnabled()) {
    return null;
  }

  const filePath = graphCacheFilePath(workspaceRoot);
  const startedAt = performance.now();
  try {
    const text = readFileSync(filePath, 'utf8');
    const graph = validatePersistedGraph(JSON.parse(text), canonicalRootKey(workspaceRoot));
    if (graph === null) {
      return null;
    }
    return { graph, bytes: Buffer.byteLength(text), loadMs: performance.now() - startedAt };
  } catch {
    return null;
  }
}

/**
 * Keep the cache directory to its bounds: nothing older than a month, no more than a
 * few dozen workspaces, and no temporary file left by a write that died. A workspace
 * that is still being indexed is written on every changed call, so age is a fair proxy
 * for "nobody works here any more" — and a deleted checkout leaves a file that would
 * otherwise sit at full size for good.
 *
 * Swept after a successful write, best effort throughout: another process may be
 * deleting the same file, and a directory this one cannot read is not a reason to fail
 * a tool call. `keepPath` is the file just written, which is never a candidate.
 */
function pruneCacheDirectory(directory: string, keepPath: string): void {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }

  const now = Date.now();
  const remove = (absolutePath: string): void => {
    try {
      rmSync(absolutePath, { force: true });
    } catch {
      // Someone else's file, or someone else got there first. Either is fine.
    }
  };

  const kept: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const absolutePath = join(directory, entry.name);
    if (absolutePath === keepPath) {
      continue;
    }

    let mtimeMs;
    try {
      mtimeMs = statSync(absolutePath).mtimeMs;
    } catch {
      continue;
    }

    if (entry.name.endsWith('.tmp')) {
      if (now - mtimeMs > MAX_TEMPORARY_AGE_MS) {
        remove(absolutePath);
      }
      continue;
    }

    if (!entry.name.endsWith('.json')) {
      continue;
    }

    if (now - mtimeMs > MAX_CACHE_AGE_MS) {
      remove(absolutePath);
      continue;
    }

    kept.push({ path: absolutePath, mtimeMs });
  }

  // The file just written holds one of the slots, so the rest keep one fewer.
  if (kept.length > MAX_CACHE_ENTRIES - 1) {
    kept.sort((left, right) => right.mtimeMs - left.mtimeMs);
    for (const stale of kept.slice(MAX_CACHE_ENTRIES - 1)) {
      remove(stale.path);
    }
  }
}

/**
 * Write the file, or do not — never fail the tool call over it. A read-only home
 * directory, a full disk or a cache directory someone turned into a file all end the
 * same way: `false`, and the process carries on with the in-memory cache it already has.
 *
 * The write is atomic: a temporary sibling is renamed over the target, so a process
 * killed mid-write leaves either the old file or the new one, never half of either.
 */
export function writePersistedGraph(workspaceRoot: string, graph: PersistedWorkspaceGraph): boolean {
  if (!isGraphCacheEnabled()) {
    return false;
  }

  const directory = graphCacheDirectory();
  const filePath = graphCacheFilePath(workspaceRoot);
  const temporaryPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(temporaryPath, JSON.stringify(graph), 'utf8');
    renameSync(temporaryPath, filePath);
  } catch {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Nothing left to do: the temporary file is in a directory this process cannot write.
    }
    return false;
  }

  pruneCacheDirectory(directory, filePath);
  return true;
}
