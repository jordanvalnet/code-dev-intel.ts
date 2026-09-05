import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, normalize, relative, resolve } from 'node:path';
import type { UnresolvedDependency, UnresolvedReason } from '../../code-intel-mcp/src/contracts.ts';
import { DEFAULT_INCLUDE_ASSETS, isAssetPath, isAssetSpecifier } from './asset-modules.ts';
import { createImportResolver } from './import-resolver.ts';
import {
  createUnresolvedCollector,
  extractModuleGraph,
  type ModuleGraphFacts,
  type ReExportedName
} from './module-graph-extractor.ts';
import {
  canonicalRootKey,
  graphCacheEngineVersion,
  GRAPH_CACHE_SCHEMA_VERSION,
  isGraphCacheEnabled,
  readPersistedGraph,
  writePersistedGraph,
  type PersistedEdge,
  type PersistedFile,
  type PersistedResolution,
  type PersistedWorkspaceGraph
} from './workspace-graph-store.ts';

export interface ImportEdge {
  sourceFile: string;
  targetFile: string;
  importedSymbols: string[];
  /**
   * Present only when this edge is a re-export (`export … from`): which of the target's
   * names travel onwards, and under which name. An impact walk needs it to see through
   * a barrel — a file that republishes a changed symbol passes the change to its own
   * importers, while a file that merely uses the symbol does not pass that name on.
   */
  reExports?: ReExportedName[];
}

export interface WorkspaceGraph {
  files: string[];
  imports: ImportEdge[];
  exportsByFile: Record<string, string[]>;
}

/** What the cache did for this call. Diagnostics only — no tool payload carries it. */
export interface WorkspaceGraphCacheStats {
  /** A cache entry for this workspace root was reused (false = built from scratch). */
  hit: boolean;
  walkedFiles: number;
  walkedAssets: number;
  parsedFiles: number;
  reusedParses: number;
  addedFiles: number;
  removedFiles: number;
  renamedFiles: number;
  modifiedFiles: number;
  /** Files whose specifiers were resolved again this call. */
  resolvedFiles: number;
  reusedResolutions: number;
  /**
   * Unchanged files that still had to be resolved again, because a file that appeared or
   * vanished is one their resolver actually looked at. The rest of a file-set change
   * costs nothing — this number is how small "the rest" turned out to be.
   */
  invalidatedByProvenance: number;
  /**
   * Files resolved again because their answer rests on something no walk diff can
   * report — a path under a directory the walk refuses to enter, a symlink, or a target
   * the walk does not list at all. They are redone on every call, so this number is
   * also how much of the workspace is paying for a blind spot.
   */
  unwatchableFiles: number;
  /** A `tsconfig`/`jsconfig` changed, so every resolution had to be redone. */
  configChanged: boolean;
  /** This call started from the graph a previous PROCESS left in the user cache directory. */
  persistedLoad: boolean;
  /** This call wrote the workspace back to the user cache directory. */
  persistedSave: boolean;
  /** Milliseconds spent walking the directory tree and stat-ing what it found. */
  walkMs: number;
}

export interface WorkspaceGraphResult extends WorkspaceGraph {
  /** Distinct specifiers the graph could not follow — every one a possibly missing edge. */
  unresolvedCount: number;
  unresolvedSample: UnresolvedDependency[];
  cache: WorkspaceGraphCacheStats;
}

export interface WorkspaceGraphOptions {
  /**
   * Treat imports of non-code files as graph nodes. They are resolved by exact filename
   * only and never parsed, so they are always leaves.
   */
  includeAssets?: boolean;
}

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
/** Files whose CONTENT changes what a specifier resolves to, wherever they sit. */
const MANIFEST_FILE_NAMES = new Set(['package.json', 'tsconfig.json', 'jsconfig.json']);
/** Enough evidence for the agent to act on, few enough tokens to be free. */
const UNRESOLVED_SAMPLE_LIMIT = 10;
// Same build/output directories searchText ignores: walking a Next.js `.next/` or a
// coverage report (megabytes of minified JS) made impactedFiles block the server for minutes.
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'coverage', '.next']);

/**
 * How recently a file may have been written before `(mtime, size)` stops being proof
 * that it has not changed again.
 *
 * Filesystem timestamps are quantized. Measured on the NTFS volume this was developed
 * on: 200 rewrites of one file produced 60 distinct mtimes, with ticks of 0.5-18.7 ms,
 * and **358 of 500** same-length rewrites were indistinguishable from the previous
 * content by `(mtime, size)` alone. An agent's normal loop — edit a file, immediately
 * ask what it impacts — lands inside exactly that window, so a cache that trusted
 * `(mtime, size)` would answer from the version before the edit. Any file whose
 * recorded mtime is within this margin of the moment it was cached is therefore read
 * again, which costs one re-parse per recently-touched file and never a wrong answer.
 */
const MTIME_SAFETY_MS = 2_000;

export const WORKSPACE_CACHE_LIMITS = {
  /** Parsed files plus tracked assets, summed over every cached workspace. */
  maxFiles: 50_000,
  maxWorkspaces: 16
} as const;

export interface WorkspaceCacheLimits {
  maxFiles: number;
  maxWorkspaces: number;
}

interface FileStamp {
  mtimeMs: number;
  size: number;
}

interface ParsedFileEntry extends FileStamp {
  /** `Date.now()` taken BEFORE the file was read — see `MTIME_SAFETY_MS`. */
  cachedAtMs: number;
  /**
   * Digest of the content these facts were extracted from. It exists for one job: a
   * rename is guessed from `(mtime, size, extension)`, and that is a hint, not proof of
   * identity — this is the proof.
   */
  digest: string;
  facts: ModuleGraphFacts;
}

interface RawUnresolved {
  specifier: string;
  reason: UnresolvedReason;
}

/**
 * Every workspace path one file's resolutions looked at, merged and deduplicated. This
 * is the whole basis of incremental invalidation: when a walk reports files appearing
 * and vanishing, a file has to be resolved again if and only if the change intersects
 * this — the rule `tsserver` uses to decide which resolutions a file event invalidates.
 */
interface FileProvenance {
  /** Workspace files this file's specifiers resolved to. Deleting one moves an edge. */
  targets: string[];
  /** Paths probed and not found. One of them appearing outranks whatever answered. */
  failedLookups: string[];
  /**
   * Manifests whose content steered an answer (the `package.json` a directory import
   * read). Recorded, and checked below, but unreachable by construction: `package.json`,
   * `tsconfig.json` and `jsconfig.json` all end in `.json`, a tracked asset extension, so
   * a manifest appearing or vanishing is already an asset event AND a change to the
   * walk's manifest map — either of which forces a full re-resolution before the rule is
   * consulted. It is kept because it is exactly the evidence a narrower manifest rule
   * would need, and it costs 0.04 MB of a 6.9 MB cache file on a 4,000-file workspace.
   */
  affecting: string[];
  /** Paths whose existence AS A DIRECTORY decided an answer; anything below one counts. */
  directoryProbes: string[];
}

interface ResolvedFileEntry {
  /** Edges to code files. */
  edges: ImportEdge[];
  /** Edges to non-code files, kept apart so one cache serves both `includeAssets` values. */
  assetEdges: ImportEdge[];
  unresolved: RawUnresolved[];
  provenance: FileProvenance;
  /**
   * This answer rests on something no walk diff can report — see `isUnwatchable`. Such
   * a file is resolved again on every call, which is the only honest thing to do with a
   * resolution whose evidence cannot be watched.
   */
  unwatchable: boolean;
}

interface AssembledGraph {
  graph: WorkspaceGraph & { unresolvedCount: number; unresolvedSample: UnresolvedDependency[] };
  reverseIndex: Map<string, ImportEdge[]>;
}

interface WorkspaceCacheEntry {
  /** Parse cache, keyed by absolute posix path; shared with the dependency-graph reader. */
  parsed: Map<string, ParsedFileEntry>;
  /** Workspace-relative code files from the last walk, in walk order. */
  walkOrder: string[];
  walkAbsolute: Map<string, string>;
  assets: Set<string>;
  /** Every directory the last walk saw — see `WalkResult.directories`. */
  directories: Set<string>;
  /** Entries the last walk could not look inside — see `WalkResult.others`. */
  others: Set<string>;
  /** Content digests of every `package.json` / `tsconfig.json` / `jsconfig.json` walked. */
  manifests: Map<string, string>;
  resolved: Map<string, ResolvedFileEntry>;
  configSources: string[];
  configFingerprint: string;
  /** False until a full walk has happened, so a partial map is never diffed against. */
  walked: boolean;
  /** The user-cache file has been looked for once; there is no second attempt. */
  persistenceChecked: boolean;
  /** Assembled containers, keyed by `includeAssets`. */
  assembled: Map<boolean, AssembledGraph>;
  lastUsedAt: number;
}

let workspaceCache = new Map<string, WorkspaceCacheEntry>();
let cacheClock = 0;
let persistenceSuspended = false;

export function resetWorkspaceGraphCacheForTests(): void {
  workspaceCache.clear();
  cacheClock = 0;
}

/**
 * Test-only: run `build` against an empty cache and with the persisted file ignored,
 * then put the real cache back. It is how a long-lived incremental entry is compared
 * against a from-scratch build of the same workspace state without destroying the entry
 * being tested — the assertion that makes incremental invalidation provable rather than
 * plausible.
 */
export function withEmptyWorkspaceGraphCacheForTests<T>(build: () => T): T {
  const previousCache = workspaceCache;
  const previousClock = cacheClock;
  const previousSuspension = persistenceSuspended;
  workspaceCache = new Map();
  cacheClock = 0;
  persistenceSuspended = true;
  try {
    return build();
  } finally {
    workspaceCache = previousCache;
    cacheClock = previousClock;
    persistenceSuspended = previousSuspension;
  }
}

/**
 * Directories the workspace walk must not enter. Mirrors ripgrep's defaults (which
 * `searchText` already inherits): hidden directories are skipped, and so is any nested
 * git checkout — e.g. worktrees kept under `.claude/worktrees/` or `.worktrees/`, which
 * otherwise multiply the graph by the number of worktrees (66k files on one real repo).
 */
export function shouldSkipDirectory(name: string, absolutePath: string): boolean {
  if (SKIPPED_DIRECTORIES.has(name) || name.startsWith('.')) {
    return true;
  }

  return existsSync(join(absolutePath, '.git'));
}

function toPosixPath(value: string): string {
  return normalize(value).replaceAll('\\', '/');
}

function toRelativePosixPath(workspaceRoot: string, absolutePath: string): string {
  return toPosixPath(relative(workspaceRoot, absolutePath));
}

function digestOf(absolutePath: string): string {
  try {
    return createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
  } catch {
    return 'missing';
  }
}

function stampOf(absolutePath: string): FileStamp | null {
  try {
    const stats = statSync(absolutePath);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return null;
  }
}

interface WalkResult {
  /** Workspace-relative code paths, in walk order. */
  order: string[];
  absolute: Map<string, string>;
  stamps: Map<string, FileStamp>;
  assets: Set<string>;
  /**
   * Every directory the walk saw, skipped ones included. Resolution can turn on whether
   * a directory EXISTS — `billing/gone` is a package when nothing called `billing` is
   * there and a lost workspace edge when something is — and an empty directory being
   * created or removed is a change no file event reports.
   */
  directories: Set<string>;
  /**
   * Entries the walk saw and did not look inside: a directory it refuses to enter
   * (build output, a hidden directory, a nested checkout) and every dirent that is
   * neither a file nor a directory — a symlink it will not follow. Nothing underneath
   * one of these can ever appear in a walk diff, which is what makes a resolution that
   * looked there unwatchable.
   */
  blocked: Set<string>;
  /** Dirents that are neither file nor directory. Their existence is tracked; their contents are not. */
  others: Set<string>;
  manifests: Map<string, string>;
  walkMs: number;
}

/**
 * One pass over the workspace, collecting three things: the code files to parse, the
 * non-code files that can be depended on, and the manifests whose contents decide where
 * a specifier points. Code files are stamped with `(mtime, size)`; assets need only to
 * exist (their contents cannot change the graph); manifests are digested, because they
 * are few and a wrong `main` field moves real edges.
 */
function walkWorkspace(workspaceRoot: string): WalkResult {
  const startedAt = performance.now();
  const order: string[] = [];
  const absolute = new Map<string, string>();
  const stamps = new Map<string, FileStamp>();
  const assets = new Set<string>();
  const directories = new Set<string>();
  const blocked = new Set<string>();
  const others = new Set<string>();
  const manifests = new Map<string, string>();

  function walk(currentDir: string): void {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const absolutePath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        const relativeDirectory = toRelativePosixPath(workspaceRoot, absolutePath);
        directories.add(relativeDirectory);
        if (shouldSkipDirectory(entry.name, absolutePath)) {
          blocked.add(relativeDirectory);
        } else {
          walk(absolutePath);
        }
        continue;
      }

      if (!entry.isFile()) {
        // A symlink (or a device, or a socket). It is not parsed and not followed, so
        // nothing below it is ever reported — but the entry itself appearing or
        // vanishing is a real event, and a specifier can resolve straight to it.
        const relativeOther = toRelativePosixPath(workspaceRoot, absolutePath);
        others.add(relativeOther);
        blocked.add(relativeOther);
        continue;
      }

      const relativePath = toRelativePosixPath(workspaceRoot, absolutePath);
      if (MANIFEST_FILE_NAMES.has(entry.name.toLowerCase())) {
        manifests.set(relativePath, digestOf(absolutePath));
      }

      const extension = extname(entry.name).toLowerCase();
      if (CODE_EXTENSIONS.has(extension)) {
        const stamp = stampOf(absolutePath);
        if (stamp !== null) {
          order.push(relativePath);
          absolute.set(relativePath, toPosixPath(absolutePath));
          stamps.set(relativePath, stamp);
        }
        continue;
      }

      // Assets are tracked whatever `includeAssets` says: one of them appearing or
      // disappearing changes what an import resolves to, so the cache has to see it.
      if (isAssetPath(entry.name)) {
        assets.add(relativePath);
      }
    }
  }

  walk(workspaceRoot);
  return {
    order,
    absolute,
    stamps,
    assets,
    directories,
    blocked,
    others,
    manifests,
    walkMs: performance.now() - startedAt
  };
}

function fingerprintConfigSources(sources: readonly string[]): string {
  return sources.map((source) => `${source}:${digestOf(source)}`).join('|');
}

/**
 * Did anything that decides where a specifier points change? Two independent signals:
 * the `tsconfig`/`jsconfig` files the resolver actually consulted (plus their `extends`
 * chains), and every `package.json` / `tsconfig.json` / `jsconfig.json` the walk found —
 * the second catches a config appearing where the walk had never seen one, which the
 * first cannot, because a config that did not exist was never consulted.
 */
function hasConfigChanged(entry: WorkspaceCacheEntry, walk: WalkResult): boolean {
  if (entry.configFingerprint !== fingerprintConfigSources(entry.configSources)) {
    return true;
  }

  if (entry.manifests.size !== walk.manifests.size) {
    return true;
  }

  for (const [relativePath, digest] of walk.manifests) {
    if (entry.manifests.get(relativePath) !== digest) {
      return true;
    }
  }

  return false;
}

/**
 * What appeared and what vanished between two walks. The lists, not just the counts: an
 * asset arriving is exactly the event that turns one importer's `not-found` into an
 * edge, and naming it is what keeps the other four thousand files' resolutions.
 */
function diffPaths(
  previous: ReadonlySet<string>,
  current: ReadonlySet<string>
): { added: string[]; removed: string[]; changed: boolean } {
  const added: string[] = [];
  for (const relativePath of current) {
    if (!previous.has(relativePath)) {
      added.push(relativePath);
    }
  }

  const removed: string[] = [];
  for (const relativePath of previous) {
    if (!current.has(relativePath)) {
      removed.push(relativePath);
    }
  }

  return { added, removed, changed: added.length > 0 || removed.length > 0 };
}

function isStale(entry: ParsedFileEntry, stamp: FileStamp): boolean {
  if (entry.mtimeMs !== stamp.mtimeMs || entry.size !== stamp.size) {
    return true;
  }

  // The stamp matches, but the file was written so close to the moment it was cached
  // that the filesystem clock cannot prove it has not been written again since.
  return entry.mtimeMs >= entry.cachedAtMs - MTIME_SAFETY_MS;
}

function digestOfContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function parseFile(absolutePath: string): ParsedFileEntry {
  const cachedAtMs = Date.now();
  const stats = statSync(absolutePath);
  const content = readFileSync(absolutePath, 'utf8');
  return {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    cachedAtMs,
    digest: digestOfContent(content),
    facts: extractModuleGraph(absolutePath, content)
  };
}

/**
 * Take over `candidate`'s facts for a file that has just appeared, but only once the
 * bytes say it really is the same file.
 *
 * `(mtime, size, extension)` is what says "this addition is that removal moved", and it
 * is not proof: an archive restored with its timestamps, a codegen run, a `git`
 * operation that rewrites a tree can all produce a new file of the same length carrying
 * the same stamp as a file that just went away. Adopting the parse then hands the new
 * file the old file's exports — and `impactedFiles` filters on exports, so the answer
 * is wrong rather than slow. `null` means "not the same file", and the caller parses it
 * like any other addition.
 */
function adoptRenamedParse(absolutePath: string, candidate: ParsedFileEntry): ParsedFileEntry | null {
  try {
    const cachedAtMs = Date.now();
    const stats = statSync(absolutePath);
    const content = readFileSync(absolutePath, 'utf8');
    if (digestOfContent(content) !== candidate.digest) {
      return null;
    }
    return { mtimeMs: stats.mtimeMs, size: stats.size, cachedAtMs, digest: candidate.digest, facts: candidate.facts };
  } catch {
    return null;
  }
}

function emptyEntry(): WorkspaceCacheEntry {
  return {
    parsed: new Map(),
    walkOrder: [],
    walkAbsolute: new Map(),
    assets: new Set(),
    directories: new Set(),
    others: new Set(),
    manifests: new Map(),
    resolved: new Map(),
    configSources: [],
    configFingerprint: '',
    walked: false,
    persistenceChecked: false,
    assembled: new Map(),
    lastUsedAt: 0
  };
}

function entryFileCount(entry: WorkspaceCacheEntry): number {
  return entry.parsed.size + entry.assets.size;
}

/**
 * Which cached workspaces to drop, newest kept. A workspace that does not fit the file
 * cap even on its own is dropped rather than kept as the single resident, so the bound
 * is a real ceiling and not a suggestion.
 */
export function selectWorkspacesToEvict(
  entries: ReadonlyArray<{ key: string; fileCount: number; lastUsedAt: number }>,
  limits: WorkspaceCacheLimits
): string[] {
  const newestFirst = [...entries].sort((left, right) => right.lastUsedAt - left.lastUsedAt);
  const evicted: Array<{ key: string; lastUsedAt: number }> = [];
  let keptFiles = 0;
  let keptWorkspaces = 0;

  for (const entry of newestFirst) {
    if (keptWorkspaces + 1 > limits.maxWorkspaces || keptFiles + entry.fileCount > limits.maxFiles) {
      evicted.push(entry);
      continue;
    }

    keptFiles += entry.fileCount;
    keptWorkspaces += 1;
  }

  // Least recently used first, so the list reads in the order the entries aged out.
  return evicted.sort((left, right) => left.lastUsedAt - right.lastUsedAt).map((entry) => entry.key);
}

function enforceCacheBounds(): void {
  const evicted = selectWorkspacesToEvict(
    [...workspaceCache.entries()].map(([key, entry]) => ({
      key,
      fileCount: entryFileCount(entry),
      lastUsedAt: entry.lastUsedAt
    })),
    WORKSPACE_CACHE_LIMITS
  );

  for (const key of evicted) {
    workspaceCache.delete(key);
  }
}

function cacheKeyFor(workspaceRoot: string): string {
  const root = toPosixPath(resolve(workspaceRoot));
  return process.platform === 'win32' ? root.toLowerCase() : root;
}

function entryFor(workspaceRoot: string): WorkspaceCacheEntry {
  const key = cacheKeyFor(workspaceRoot);
  let entry = workspaceCache.get(key);
  if (!entry) {
    entry = emptyEntry();
    workspaceCache.set(key, entry);
  }

  cacheClock += 1;
  entry.lastUsedAt = cacheClock;
  return entry;
}

/**
 * One file's imports and exports, parsed at most once per version of the file. Both
 * module-graph engines read through here, so `dependencyGraph` following one file's
 * imports and `impactedFiles` walking the whole workspace share the same parse — and
 * cannot disagree about what a file contains.
 */
export function getModuleFacts(workspaceRoot: string, absolutePath: string): ModuleGraphFacts {
  const entry = entryFor(workspaceRoot);
  const key = toPosixPath(absolutePath);
  const cached = entry.parsed.get(key);
  const stamp = stampOf(key);

  if (cached && stamp !== null && !isStale(cached, stamp)) {
    return cached.facts;
  }

  const parsed = parseFile(key);
  entry.parsed.set(key, parsed);
  // This file just changed under a reader that does not walk, so the workspace graph
  // built from the previous parse is now wrong — and the walk cannot notice, because
  // the stamp it will read is the one just recorded. Drop this file's resolution and
  // the assembled containers so the next full build rebuilds them from what is here now.
  const relativePath = toRelativePosixPath(workspaceRoot, key);
  entry.resolved.delete(relativePath);
  entry.assembled.clear();
  // A file read outside a walk is not part of the walk snapshot; leaving `walked`
  // alone keeps the next full build from diffing against a partial file list.
  enforceCacheBounds();
  return parsed.facts;
}

interface DiffResult {
  added: string[];
  removed: string[];
  renamed: number;
  modified: string[];
  reusedParses: number;
}

/**
 * Re-parse only what changed. A file is modified when its stamp moved (or is too fresh
 * to trust); a rename shows up as one removal plus one addition with the same stamp,
 * and reuses the parse it already had instead of reading the file again.
 */
function refreshParses(entry: WorkspaceCacheEntry, walk: WalkResult): DiffResult {
  const previous = new Set(entry.walkOrder);
  const current = new Set(walk.order);
  const added = walk.order.filter((relativePath) => !previous.has(relativePath));
  const removed = entry.walkOrder.filter((relativePath) => !current.has(relativePath));
  const modified: string[] = [];
  let renamed = 0;
  let reusedParses = 0;

  // Candidate rename sources: a removed file's parse can be handed to an added file
  // with the same size, mtime and extension. The parse is captured here because the
  // removal loop below drops it from the cache, and only an unambiguous match is reused
  // — two files that happen to share a stamp are re-read rather than guessed at.
  const removedByStamp = new Map<string, ParsedFileEntry[]>();
  for (const relativePath of removed) {
    const absolutePath = entry.walkAbsolute.get(relativePath);
    const parsed = absolutePath === undefined ? undefined : entry.parsed.get(absolutePath);
    if (!parsed) {
      continue;
    }
    const stampKey = `${parsed.mtimeMs}:${parsed.size}:${extname(relativePath).toLowerCase()}`;
    const candidates = removedByStamp.get(stampKey);
    if (candidates) {
      candidates.push(parsed);
    } else {
      removedByStamp.set(stampKey, [parsed]);
    }
  }

  for (const relativePath of removed) {
    const absolutePath = entry.walkAbsolute.get(relativePath);
    if (absolutePath !== undefined) {
      entry.parsed.delete(absolutePath);
    }
    entry.resolved.delete(relativePath);
  }

  for (const relativePath of walk.order) {
    const absolutePath = walk.absolute.get(relativePath);
    const stamp = walk.stamps.get(relativePath);
    if (absolutePath === undefined || stamp === undefined) {
      continue;
    }

    const isAdded = !previous.has(relativePath);
    if (isAdded) {
      const stampKey = `${stamp.mtimeMs}:${stamp.size}:${extname(relativePath).toLowerCase()}`;
      const candidates = removedByStamp.get(stampKey);
      const match = candidates?.length === 1 ? candidates[0] : undefined;
      // The recency rule applies to a rename too: a codegen run that deletes one file
      // and writes a different one of the same length in the same timestamp tick would
      // otherwise hand the new file the old file's parse. Beyond the margin the stamp
      // proves nothing either, so the content is what decides.
      const reusable = match && !isStale(match, stamp) ? match : undefined;
      const adopted = reusable === undefined ? null : adoptRenamedParse(absolutePath, reusable);
      if (adopted !== null) {
        entry.parsed.set(absolutePath, adopted);
        removedByStamp.delete(stampKey);
        renamed += 1;
        reusedParses += 1;
        continue;
      }
    }

    const cached = entry.parsed.get(absolutePath);
    if (cached && !isStale(cached, stamp)) {
      reusedParses += 1;
      continue;
    }

    try {
      entry.parsed.set(absolutePath, parseFile(absolutePath));
    } catch {
      // Deleted (or made unreadable) between the walk and the read. Dropping it here
      // leaves it out of `files` and out of every edge, which is what it now is.
      entry.parsed.delete(absolutePath);
      continue;
    }

    if (!isAdded) {
      modified.push(relativePath);
    }
  }

  return { added, removed, renamed, modified, reusedParses };
}

/** Walk paths are compared, never displayed, so they fold the way the filesystem does. */
function foldWalkPath(relativePath: string): string {
  return process.platform === 'win32' ? relativePath.toLowerCase() : relativePath;
}

/**
 * What a walk can and cannot answer for, in the walk's own spelling.
 *
 * `reports` is the set of paths this walk actually produced. `canSee` is the weaker
 * question a resolution has to ask about a path it probed and did NOT find: could such
 * a file ever turn up in a walk diff? For anything under a directory the walk refuses
 * to enter — build output, a hidden directory, a nested checkout — or under a symlink
 * it will not follow, the answer is no, and no amount of diffing will ever say that
 * file arrived.
 */
interface WalkVisibility {
  reports(walkPath: string): boolean;
  canSee(walkPath: string): boolean;
}

function createWalkVisibility(walk: WalkResult): WalkVisibility {
  // Both spellings, so the two kinds of path this is asked about — provenance, which is
  // already folded, and an edge target, which is spelled the way the resolver found it —
  // both answer without folding anything per lookup.
  const reported = new Set<string>();
  const report = (relativePath: string): void => {
    reported.add(relativePath);
    reported.add(foldWalkPath(relativePath));
  };
  for (const relativePath of walk.order) {
    report(relativePath);
  }
  for (const relativePath of walk.assets) {
    report(relativePath);
  }
  for (const relativePath of walk.others) {
    report(relativePath);
  }

  const blocked = new Set<string>();
  for (const relativePath of walk.blocked) {
    blocked.add(foldWalkPath(relativePath));
  }

  const parentOf = (walkPath: string): string => {
    const separatorIndex = walkPath.lastIndexOf('/');
    return separatorIndex <= 0 ? '' : walkPath.slice(0, separatorIndex);
  };

  // Memoized per directory: a workspace has thousands of probed paths and hundreds of
  // distinct directories to hold them, and every path in one directory has one answer.
  const visibleDirectories = new Map<string, boolean>();
  const canSeeDirectory = (directory: string): boolean => {
    if (directory.length === 0) {
      return true;
    }
    const memoized = visibleDirectories.get(directory);
    if (memoized !== undefined) {
      return memoized;
    }
    const visible = !blocked.has(directory) && canSeeDirectory(parentOf(directory));
    visibleDirectories.set(directory, visible);
    return visible;
  };

  return {
    reports: (walkPath) => reported.has(walkPath) || reported.has(foldWalkPath(walkPath)),
    canSee: (walkPath) => canSeeDirectory(parentOf(walkPath))
  };
}

/**
 * Is this file's answer one a walk diff can be trusted to keep honest?
 *
 * Two ways it is not. The answer may NAME a file the walk does not report — a target
 * under a directory the walk refuses to enter, or, for a resolution restored from a
 * cache file, a path that is simply not there any more (or never was). Or its evidence
 * may LIE where the walk never looks: the resolver reads the whole disk, the walk skips
 * build output, hidden directories, nested checkouts and symlinks, so a file arriving in
 * one of those places is an event no diff will ever report — the `dist/` a package is
 * built into after the graph was taken is the everyday case. Either way the resolution
 * is redone on every call until it is back inside what the walk can see, so a blind spot
 * costs time rather than outliving the process that made it.
 */
function isUnwatchable(resolved: ResolvedFileEntry, visibility: WalkVisibility): boolean {
  // The edges are what a caller actually reads, and every internal or asset resolution
  // produces one, so they are the whole record of what this answer names — checked
  // directly rather than through the provenance that should agree with them, because a
  // cache file writes both and a file that could disagree with itself can lie.
  for (const edge of resolved.edges) {
    if (!visibility.reports(edge.targetFile)) {
      return true;
    }
  }

  for (const edge of resolved.assetEdges) {
    if (!visibility.reports(edge.targetFile)) {
      return true;
    }
  }

  const provenance = resolved.provenance;
  for (const probed of provenance.failedLookups) {
    if (!visibility.canSee(probed)) {
      return true;
    }
  }

  for (const manifest of provenance.affecting) {
    if (!visibility.canSee(manifest)) {
      return true;
    }
  }

  for (const directory of provenance.directoryProbes) {
    if (!visibility.canSee(directory)) {
      return true;
    }
  }

  return false;
}

/**
 * Resolve one file's specifiers into edges plus an unresolved report. Asset edges are
 * kept separate so the same cached entry answers both `includeAssets` settings.
 */
function resolveFile(
  workspaceRoot: string,
  importResolver: ReturnType<typeof createImportResolver>,
  relativePath: string,
  absolutePath: string,
  facts: ModuleGraphFacts,
  visibility: WalkVisibility
): ResolvedFileEntry {
  const edges: ImportEdge[] = [];
  const assetEdges: ImportEdge[] = [];
  const unresolved: RawUnresolved[] = [];
  const targets = new Set<string>();
  const failedLookups = new Set<string>();
  const affecting = new Set<string>();
  const directoryProbes = new Set<string>();

  for (const fileImport of facts.imports) {
    const { resolution, provenance } = importResolver.resolveModuleWithProvenance(
      absolutePath,
      fileImport.specifier
    );

    // Merged across the file's specifiers: invalidation is decided per file, so the
    // union is all that is ever asked, and deduplicating here is what keeps the record
    // small enough to hold for a workspace and write to disk.
    if (provenance.target !== undefined) {
      targets.add(provenance.target);
    }
    for (const probed of provenance.failedLookups) {
      failedLookups.add(probed);
    }
    for (const manifest of provenance.affecting) {
      affecting.add(manifest);
    }
    for (const directory of provenance.directoryProbes) {
      directoryProbes.add(directory);
    }

    if (resolution.kind === 'external') {
      continue;
    }

    if (resolution.kind === 'unresolved') {
      unresolved.push({ specifier: fileImport.specifier, reason: resolution.reason });
      continue;
    }

    const edge: ImportEdge = {
      sourceFile: relativePath,
      targetFile: toRelativePosixPath(workspaceRoot, resolution.filePath),
      importedSymbols: fileImport.importedSymbols
    };
    if (fileImport.reExports !== undefined) {
      edge.reExports = fileImport.reExports;
    }
    (resolution.kind === 'asset' ? assetEdges : edges).push(edge);
  }

  for (const dynamicSpecifier of facts.dynamicSpecifiers) {
    unresolved.push({ specifier: dynamicSpecifier, reason: 'dynamic-specifier' });
  }

  const resolved: ResolvedFileEntry = {
    edges,
    assetEdges,
    unresolved,
    provenance: {
      targets: [...targets],
      failedLookups: [...failedLookups],
      affecting: [...affecting],
      directoryProbes: [...directoryProbes]
    },
    unwatchable: false
  };
  resolved.unwatchable = isUnwatchable(resolved, visibility);
  return resolved;
}

/**
 * The changed paths plus every directory above them. A resolution that turned on
 * whether `src/billing` exists has to be redone when the first file appears under it or
 * the last one leaves, and neither event names the directory itself.
 */
function changeClosure(changes: ReadonlyArray<ReadonlySet<string>>): Set<string> {
  const closure = new Set<string>();
  for (const changed of changes) {
    for (const relativePath of changed) {
      closure.add(relativePath);
      let current = relativePath;
      for (;;) {
        const separatorIndex = current.lastIndexOf('/');
        if (separatorIndex <= 0) {
          break;
        }
        current = current.slice(0, separatorIndex);
        if (closure.has(current)) {
          break;
        }
        closure.add(current);
      }
    }
  }
  return closure;
}

/** Did this file's resolver actually look at anything the walk diff moved? */
function provenanceTouchesChange(
  provenance: FileProvenance,
  added: ReadonlySet<string>,
  removed: ReadonlySet<string>,
  closure: ReadonlySet<string>
): boolean {
  for (const target of provenance.targets) {
    if (removed.has(target)) {
      return true;
    }
  }

  for (const probed of provenance.failedLookups) {
    if (added.has(probed)) {
      return true;
    }
  }

  // Unreachable by construction, and kept deliberately: `package.json`, `tsconfig.json`
  // and `jsconfig.json` all end in `.json`, which is a tracked asset extension, so a
  // manifest appearing or vanishing is already an asset event AND a change to the walk's
  // manifest map — both of which mean a full re-resolution before this rule is ever
  // consulted. The list is collected and persisted because it is exactly the evidence a
  // narrower manifest rule would need, and it costs 0.04 MB of a 6.6 MB cache file.
  for (const manifest of provenance.affecting) {
    if (added.has(manifest) || removed.has(manifest)) {
      return true;
    }
  }

  for (const directory of provenance.directoryProbes) {
    if (closure.has(directory)) {
      return true;
    }
  }

  return false;
}

/**
 * Drop the resolutions no walk diff can keep honest, so they are taken again from disk.
 *
 * A `visibility` re-derives the flags; `null` trusts the ones already there. They are
 * decided against a particular walk, so a change in what that walk can see — a `dist/`
 * appearing, a directory becoming a nested checkout — moves them, and so does arriving
 * from a cache file written by another process, whose flags were never checked against
 * this disk. On a call where neither happened, an unchanged workspace pays one boolean
 * per file and never builds the index.
 */
function dropUnwatchableResolutions(entry: WorkspaceCacheEntry, visibility: WalkVisibility | null): number {
  let dropped = 0;

  for (const [relativePath, resolved] of entry.resolved) {
    if (visibility !== null) {
      resolved.unwatchable = isUnwatchable(resolved, visibility);
    }
    if (resolved.unwatchable) {
      entry.resolved.delete(relativePath);
      dropped += 1;
    }
  }

  return dropped;
}

/**
 * Drop the resolutions a file-set change can actually have moved, and only those.
 *
 * The old rule was "any file appeared or vanished, so redo all of them", which on a
 * four-thousand-file workspace meant nine seconds for one `git checkout` — and file
 * creation, deletion and renaming are the most common events in an agent's editing
 * loop. The rule here is the one a language server uses: a resolution survives unless
 * the change is a path it resolved to, a path it probed and did not find, a manifest it
 * read, or a directory whose existence it tested.
 */
function invalidateByProvenance(
  entry: WorkspaceCacheEntry,
  added: ReadonlySet<string>,
  removed: ReadonlySet<string>,
  changedDirectories: ReadonlySet<string>
): number {
  const closure = changeClosure([added, removed, changedDirectories]);
  let invalidated = 0;

  for (const [relativePath, resolved] of entry.resolved) {
    if (provenanceTouchesChange(resolved.provenance, added, removed, closure)) {
      entry.resolved.delete(relativePath);
      invalidated += 1;
    }
  }

  return invalidated;
}

/**
 * Build the containers a caller reads: the file list, the flat edge list, the exports
 * map, the deduplicated unresolved report and the reverse index `impactedFiles` walks.
 * Fresh containers every time, sharing the cached leaf records — a caller must treat
 * the result as read-only, and cannot corrupt the cache by replacing an array on it.
 */
function assemble(entry: WorkspaceCacheEntry, includeAssets: boolean): AssembledGraph {
  const files: string[] = [];
  const imports: ImportEdge[] = [];
  const exportsByFile: Record<string, string[]> = {};
  const reverseIndex = new Map<string, ImportEdge[]>();
  const unresolved = createUnresolvedCollector(UNRESOLVED_SAMPLE_LIMIT);

  const addEdge = (edge: ImportEdge): void => {
    imports.push(edge);
    const importers = reverseIndex.get(edge.targetFile);
    if (importers) {
      importers.push(edge);
    } else {
      reverseIndex.set(edge.targetFile, [edge]);
    }
  };

  for (const relativePath of entry.walkOrder) {
    const absolutePath = entry.walkAbsolute.get(relativePath);
    const parsed = absolutePath === undefined ? undefined : entry.parsed.get(absolutePath);
    const resolved = entry.resolved.get(relativePath);
    if (!parsed || !resolved) {
      continue;
    }

    files.push(relativePath);
    exportsByFile[relativePath] = parsed.facts.exports;

    resolved.edges.forEach(addEdge);
    if (includeAssets) {
      resolved.assetEdges.forEach(addEdge);
    }

    for (const entryUnresolved of resolved.unresolved) {
      // An asset import is only a hole in the answer when assets were asked for; with
      // `includeAssets: false` the caller asked for a code graph and a stylesheet the
      // graph did not follow is not something it is missing.
      if (!includeAssets && isAssetSpecifier(entryUnresolved.specifier)) {
        continue;
      }
      unresolved.add(relativePath, entryUnresolved.specifier, entryUnresolved.reason);
    }
  }

  return {
    graph: {
      files,
      imports,
      exportsByFile,
      unresolvedCount: unresolved.count,
      unresolvedSample: unresolved.sample
    },
    reverseIndex
  };
}

function toPersistedEdges(edges: readonly ImportEdge[]): PersistedEdge[] {
  return edges.map((edge) => {
    // `sourceFile` is not written: it is always the file the entry is filed under, and
    // a cache file that could disagree with its own key is a cache file that can lie.
    const persisted: PersistedEdge = { targetFile: edge.targetFile, importedSymbols: edge.importedSymbols };
    if (edge.reExports !== undefined) {
      persisted.reExports = edge.reExports;
    }
    return persisted;
  });
}

function fromPersistedEdges(sourceFile: string, edges: readonly PersistedEdge[]): ImportEdge[] {
  return edges.map((edge) => {
    const restored: ImportEdge = { sourceFile, targetFile: edge.targetFile, importedSymbols: edge.importedSymbols };
    if (edge.reExports !== undefined) {
      restored.reExports = edge.reExports;
    }
    return restored;
  });
}

function toPersistedResolution(resolved: ResolvedFileEntry): PersistedResolution {
  return {
    edges: toPersistedEdges(resolved.edges),
    assetEdges: toPersistedEdges(resolved.assetEdges),
    unresolved: resolved.unresolved,
    provenance: resolved.provenance
  };
}

function fromPersistedResolution(sourceFile: string, resolved: PersistedResolution): ResolvedFileEntry {
  return {
    edges: fromPersistedEdges(sourceFile, resolved.edges),
    assetEdges: fromPersistedEdges(sourceFile, resolved.assetEdges),
    unresolved: resolved.unresolved,
    provenance: resolved.provenance,
    // Nothing a cache file says about the disk is taken on trust, and this flag is a
    // statement about the disk: every restored resolution is re-checked against the
    // first walk of this process before it is allowed to answer anything.
    unwatchable: false
  };
}

/** Everything about this workspace that a new process could start from. */
function toPersistedGraph(entry: WorkspaceCacheEntry, workspaceRoot: string): PersistedWorkspaceGraph {
  const files: PersistedFile[] = [];

  for (const relativePath of entry.walkOrder) {
    const absolutePath = entry.walkAbsolute.get(relativePath);
    const parsed = absolutePath === undefined ? undefined : entry.parsed.get(absolutePath);
    if (!parsed) {
      continue;
    }

    const file: PersistedFile = {
      path: relativePath,
      mtimeMs: parsed.mtimeMs,
      size: parsed.size,
      cachedAtMs: parsed.cachedAtMs,
      digest: parsed.digest,
      facts: parsed.facts
    };
    const resolved = entry.resolved.get(relativePath);
    if (resolved) {
      file.resolved = toPersistedResolution(resolved);
    }
    files.push(file);
  }

  return {
    schemaVersion: GRAPH_CACHE_SCHEMA_VERSION,
    engineVersion: graphCacheEngineVersion(),
    root: canonicalRootKey(workspaceRoot),
    savedAtMs: Date.now(),
    files,
    assets: [...entry.assets],
    directories: [...entry.directories],
    others: [...entry.others],
    manifests: [...entry.manifests],
    configSources: entry.configSources,
    configFingerprint: entry.configFingerprint
  };
}

/**
 * Seed a cold entry from the file the last process left, then let the ordinary walk
 * diff decide what survives. Nothing here is believed about the disk: every stamp is
 * checked again by the walk, so a file the cache claims is unchanged and is not gets
 * re-parsed exactly as it would after an in-process edit. A stale or hostile file can
 * therefore cost time, never correctness.
 */
function loadPersistedEntry(entry: WorkspaceCacheEntry, workspaceRoot: string): boolean {
  if (entry.persistenceChecked || entry.walked || persistenceSuspended) {
    return false;
  }

  entry.persistenceChecked = true;
  const read = readPersistedGraph(workspaceRoot);
  if (read === null) {
    return false;
  }

  for (const file of read.graph.files) {
    const absolutePath = toPosixPath(join(workspaceRoot, file.path));
    entry.walkOrder.push(file.path);
    entry.walkAbsolute.set(file.path, absolutePath);

    // A `dependencyGraph` read may already have parsed this file in this process, and
    // what it read is newer than anything on disk. Its resolution was dropped with it,
    // so the file simply resolves again below.
    if (entry.parsed.has(absolutePath)) {
      continue;
    }

    entry.parsed.set(absolutePath, {
      mtimeMs: file.mtimeMs,
      size: file.size,
      cachedAtMs: file.cachedAtMs,
      digest: file.digest,
      facts: file.facts
    });
    if (file.resolved !== undefined) {
      entry.resolved.set(file.path, fromPersistedResolution(file.path, file.resolved));
    }
  }

  entry.assets = new Set(read.graph.assets);
  entry.directories = new Set(read.graph.directories);
  entry.others = new Set(read.graph.others);
  entry.manifests = new Map(read.graph.manifests);
  entry.configSources = read.graph.configSources;
  entry.configFingerprint = read.graph.configFingerprint;
  entry.walked = true;
  return true;
}

function savePersistedEntry(entry: WorkspaceCacheEntry, workspaceRoot: string): boolean {
  // The same ceiling the loader refuses to read past, applied before serializing rather
  // than after: a workspace this large would build a JSON string measured in hundreds of
  // megabytes, and it would be rejected on the way back in anyway.
  if (persistenceSuspended || !isGraphCacheEnabled() || entry.walkOrder.length > WORKSPACE_CACHE_LIMITS.maxFiles) {
    return false;
  }

  return writePersistedGraph(workspaceRoot, toPersistedGraph(entry, workspaceRoot));
}

/**
 * The workspace module graph, cached per workspace root for the life of the process.
 *
 * Each call re-walks the directory tree — cheap next to parsing, and the only way to
 * see a file appear, vanish or move — then re-parses only the files whose stamp moved
 * and re-resolves only the files the change can have reached. A content edit touches
 * one file's edges. A file appearing, vanishing or moving touches the files whose
 * resolver actually looked at it: the ones that resolved TO it, probed for it and did
 * not find it, read a manifest that moved, or tested a directory it lives under. Only a
 * `tsconfig`/`jsconfig`/`package.json` content change still redoes every resolution,
 * because an alias edit moves every aliased edge at once. The parses survive all of it:
 * they depend on the file, not on the workspace around it.
 *
 * The first call in a process also looks for the graph a previous process left in the
 * user's cache directory, and starts from it — an editor or agent session spawns a new
 * server, and paying the cold build once per session was the larger of the two costs.
 */
export function getWorkspaceGraph(
  workspaceRoot: string,
  options?: WorkspaceGraphOptions
): { graph: WorkspaceGraphResult; reverseIndex: Map<string, ImportEdge[]> } {
  const includeAssets = options?.includeAssets ?? DEFAULT_INCLUDE_ASSETS;
  const entry = entryFor(workspaceRoot);
  const persistedLoad = loadPersistedEntry(entry, workspaceRoot);
  const hit = entry.walked;

  const walk = walkWorkspace(workspaceRoot);
  const configChanged = hit && hasConfigChanged(entry, walk);
  const assetDiff = diffPaths(entry.assets, walk.assets);
  const directoryDiff = diffPaths(entry.directories, walk.directories);
  // A symlink is never followed, so it is not a file to this cache — but it can be the
  // very path a specifier resolves to, and one appearing or vanishing has to reach the
  // resolutions that named it.
  const otherDiff = diffPaths(entry.others, walk.others);

  // Built at most once per call, and only when something actually asks: an unchanged
  // workspace with nothing to re-resolve never pays for it.
  let visibility: WalkVisibility | undefined;
  const walkVisibility = (): WalkVisibility => (visibility ??= createWalkVisibility(walk));

  // A cold entry has an empty walk snapshot, so the same diff reports every file as
  // added and every parse as missing — no separate cold path is needed.
  const changes = refreshParses(entry, walk);
  const fileSetChanged =
    changes.added.length > 0 || changes.removed.length > 0 || assetDiff.changed || otherDiff.changed;
  // A directory appearing or vanishing moves no file, and still moves an answer: a bare
  // specifier under `baseUrl` is a package when nothing of that name is on disk and a
  // lost workspace edge when something is. Deleting the last file in a directory and
  // then deleting the directory are two separate events, and only the second one is this.
  const structureChanged = fileSetChanged || directoryDiff.changed;

  entry.walkOrder = walk.order;
  entry.walkAbsolute = walk.absolute;
  entry.assets = walk.assets;
  entry.directories = walk.directories;
  entry.others = walk.others;
  entry.manifests = walk.manifests;

  // A config decides where EVERY specifier points, so an edit to one is the single case
  // that still redoes all of them. A package manifest is on that list too: its `main`,
  // `exports` and `type` fields move edges anywhere the package is reachable from, and
  // unlike a file appearing there is no probed path that says which importers care.
  const mustResolveAll = !hit || configChanged;
  let invalidatedByProvenance = 0;
  let unwatchableFiles = 0;
  if (mustResolveAll) {
    entry.resolved.clear();
  } else {
    for (const relativePath of changes.modified) {
      entry.resolved.delete(relativePath);
    }

    if (structureChanged) {
      invalidatedByProvenance = invalidateByProvenance(
        entry,
        new Set([...changes.added, ...assetDiff.added, ...otherDiff.added].map(foldWalkPath)),
        new Set([...changes.removed, ...assetDiff.removed, ...otherDiff.removed].map(foldWalkPath)),
        new Set([...directoryDiff.added, ...directoryDiff.removed].map(foldWalkPath))
      );
    }

    // What the walk can see moved with the structure, and a resolution restored from
    // another process's file has never been checked against this disk at all.
    unwatchableFiles = dropUnwatchableResolutions(
      entry,
      structureChanged || persistedLoad ? walkVisibility() : null
    );
  }

  const pending = walk.order.filter((relativePath) => !entry.resolved.has(relativePath));
  const reusedResolutions = walk.order.length - pending.length;
  let resolvedFiles = 0;

  if (pending.length > 0) {
    const importResolver = createImportResolver(workspaceRoot);
    for (const relativePath of pending) {
      const absolutePath = walk.absolute.get(relativePath);
      const parsed = absolutePath === undefined ? undefined : entry.parsed.get(absolutePath);
      if (absolutePath === undefined || !parsed) {
        continue;
      }
      entry.resolved.set(
        relativePath,
        resolveFile(workspaceRoot, importResolver, relativePath, absolutePath, parsed.facts, walkVisibility())
      );
      resolvedFiles += 1;
    }

    const consulted = importResolver.configSources();
    // A partial pass only visits the configs of the files it re-resolved, so its list
    // has to be merged into what is already tracked rather than replacing it.
    entry.configSources = mustResolveAll ? consulted : [...new Set([...entry.configSources, ...consulted])];
    entry.configFingerprint = fingerprintConfigSources(entry.configSources);
  }

  const changedSinceLastCall = !hit || structureChanged || configChanged || changes.modified.length > 0;
  if (changedSinceLastCall || resolvedFiles > 0) {
    entry.assembled.clear();
  }

  entry.walked = true;
  entry.persistenceChecked = true;
  let assembled = entry.assembled.get(includeAssets);
  if (!assembled) {
    assembled = assemble(entry, includeAssets);
    entry.assembled.set(includeAssets, assembled);
  }

  // Written after the answer is assembled and never on the unchanged path, so a session
  // that only asks questions pays nothing, and a session that changed the workspace
  // hands the next process the work it just did. Files the walk cannot watch do not
  // count as a change worth writing megabytes for: the next process re-resolves them on
  // its own first call whatever the file says about them.
  const persistedSave =
    (changedSinceLastCall || resolvedFiles > unwatchableFiles) && savePersistedEntry(entry, workspaceRoot);

  enforceCacheBounds();

  return {
    graph: {
      ...assembled.graph,
      cache: {
        hit,
        walkedFiles: walk.order.length,
        walkedAssets: walk.assets.size,
        parsedFiles: walk.order.length - changes.reusedParses,
        reusedParses: changes.reusedParses,
        addedFiles: changes.added.length + assetDiff.added.length + otherDiff.added.length,
        removedFiles: changes.removed.length + assetDiff.removed.length + otherDiff.removed.length,
        renamedFiles: changes.renamed,
        modifiedFiles: changes.modified.length,
        resolvedFiles,
        reusedResolutions,
        invalidatedByProvenance,
        unwatchableFiles,
        configChanged,
        persistedLoad,
        persistedSave,
        walkMs: Math.round(walk.walkMs * 100) / 100
      }
    },
    reverseIndex: assembled.reverseIndex
  };
}

/**
 * Every file's imports, re-exports and exports, through the extractor `dependencyGraph`
 * also uses — so the two tools cannot disagree about the same repository — and one
 * resolver instance per resolution pass, so the workspace is read as a snapshot.
 */
export function buildWorkspaceGraph(
  workspaceRoot: string,
  options?: WorkspaceGraphOptions
): WorkspaceGraphResult {
  return getWorkspaceGraph(workspaceRoot, options).graph;
}
