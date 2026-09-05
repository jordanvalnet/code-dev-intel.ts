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
  /** A `tsconfig`/`jsconfig` changed, so every resolution had to be redone. */
  configChanged: boolean;
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
  facts: ModuleGraphFacts;
}

interface RawUnresolved {
  specifier: string;
  reason: UnresolvedReason;
}

interface ResolvedFileEntry {
  /** Edges to code files. */
  edges: ImportEdge[];
  /** Edges to non-code files, kept apart so one cache serves both `includeAssets` values. */
  assetEdges: ImportEdge[];
  unresolved: RawUnresolved[];
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
  /** Content digests of every `package.json` / `tsconfig.json` / `jsconfig.json` walked. */
  manifests: Map<string, string>;
  resolved: Map<string, ResolvedFileEntry>;
  configSources: string[];
  configFingerprint: string;
  /** False until a full walk has happened, so a partial map is never diffed against. */
  walked: boolean;
  /** Assembled containers, keyed by `includeAssets`. */
  assembled: Map<boolean, AssembledGraph>;
  lastUsedAt: number;
}

const workspaceCache = new Map<string, WorkspaceCacheEntry>();
let cacheClock = 0;

export function resetWorkspaceGraphCacheForTests(): void {
  workspaceCache.clear();
  cacheClock = 0;
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
  const manifests = new Map<string, string>();

  function walk(currentDir: string): void {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const absolutePath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(entry.name, absolutePath)) {
          walk(absolutePath);
        }
        continue;
      }

      if (!entry.isFile()) {
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
  return { order, absolute, stamps, assets, manifests, walkMs: performance.now() - startedAt };
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

function countAssetDiff(
  previous: ReadonlySet<string>,
  current: ReadonlySet<string>
): { added: number; removed: number; changed: boolean } {
  let added = 0;
  for (const relativePath of current) {
    if (!previous.has(relativePath)) {
      added += 1;
    }
  }

  // An asset only ever exists or not, so the counts alone settle the difference.
  const removed = previous.size - (current.size - added);
  return { added, removed, changed: added > 0 || removed > 0 };
}

function isStale(entry: ParsedFileEntry, stamp: FileStamp): boolean {
  if (entry.mtimeMs !== stamp.mtimeMs || entry.size !== stamp.size) {
    return true;
  }

  // The stamp matches, but the file was written so close to the moment it was cached
  // that the filesystem clock cannot prove it has not been written again since.
  return entry.mtimeMs >= entry.cachedAtMs - MTIME_SAFETY_MS;
}

function parseFile(absolutePath: string): ParsedFileEntry {
  const cachedAtMs = Date.now();
  const stats = statSync(absolutePath);
  const facts = extractModuleGraph(absolutePath, readFileSync(absolutePath, 'utf8'));
  return { mtimeMs: stats.mtimeMs, size: stats.size, cachedAtMs, facts };
}

function emptyEntry(): WorkspaceCacheEntry {
  return {
    parsed: new Map(),
    walkOrder: [],
    walkAbsolute: new Map(),
    assets: new Set(),
    manifests: new Map(),
    resolved: new Map(),
    configSources: [],
    configFingerprint: '',
    walked: false,
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
      // otherwise hand the new file the old file's parse.
      const reusable = match && !isStale(match, stamp) ? match : undefined;
      if (reusable) {
        entry.parsed.set(absolutePath, reusable);
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

/**
 * Resolve one file's specifiers into edges plus an unresolved report. Asset edges are
 * kept separate so the same cached entry answers both `includeAssets` settings.
 */
function resolveFile(
  workspaceRoot: string,
  importResolver: ReturnType<typeof createImportResolver>,
  relativePath: string,
  absolutePath: string,
  facts: ModuleGraphFacts
): ResolvedFileEntry {
  const edges: ImportEdge[] = [];
  const assetEdges: ImportEdge[] = [];
  const unresolved: RawUnresolved[] = [];

  for (const fileImport of facts.imports) {
    const resolution = importResolver.resolveModule(absolutePath, fileImport.specifier);
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

  return { edges, assetEdges, unresolved };
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

/**
 * The workspace module graph, cached per workspace root for the life of the process.
 *
 * Each call re-walks the directory tree — cheap next to parsing, and the only way to
 * see a file appear, vanish or move — then re-parses only the files whose stamp moved
 * and re-resolves only what the change can have affected. Content edits touch one
 * file's edges; anything that changes the SET of files, or any `tsconfig`/`jsconfig`/
 * `package.json` content, redoes every resolution, because those are exactly the inputs
 * that decide where a specifier points (a new `b.ts` can shadow the `b.js` a specifier
 * used to resolve to, and an alias edit moves every aliased edge at once). The parses
 * survive that: they depend on the file, not on the workspace around it.
 */
export function getWorkspaceGraph(
  workspaceRoot: string,
  options?: WorkspaceGraphOptions
): { graph: WorkspaceGraphResult; reverseIndex: Map<string, ImportEdge[]> } {
  const includeAssets = options?.includeAssets ?? DEFAULT_INCLUDE_ASSETS;
  const entry = entryFor(workspaceRoot);
  const hit = entry.walked;

  const walk = walkWorkspace(workspaceRoot);
  const configChanged = hit && hasConfigChanged(entry, walk);
  const assetDiff = countAssetDiff(entry.assets, walk.assets);

  // A cold entry has an empty walk snapshot, so the same diff reports every file as
  // added and every parse as missing — no separate cold path is needed.
  const changes = refreshParses(entry, walk);
  const fileSetChanged = changes.added.length > 0 || changes.removed.length > 0 || assetDiff.changed;

  entry.walkOrder = walk.order;
  entry.walkAbsolute = walk.absolute;
  entry.assets = walk.assets;
  entry.manifests = walk.manifests;

  // Resolution depends on the whole workspace, not on one file: a new `b.ts` can shadow
  // the `b.js` a specifier used to reach, a deleted file turns an edge into a hole, and
  // an alias edit moves every aliased edge at once. So a changed file set or a changed
  // config redoes all of them — while the parses, which depend only on the file itself,
  // survive untouched.
  const mustResolveAll = !hit || configChanged || fileSetChanged;
  if (mustResolveAll) {
    entry.resolved.clear();
  } else {
    for (const relativePath of changes.modified) {
      entry.resolved.delete(relativePath);
    }
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
        resolveFile(workspaceRoot, importResolver, relativePath, absolutePath, parsed.facts)
      );
      resolvedFiles += 1;
    }

    const consulted = importResolver.configSources();
    // A partial pass only visits the configs of the files it re-resolved, so its list
    // has to be merged into what is already tracked rather than replacing it.
    entry.configSources = mustResolveAll ? consulted : [...new Set([...entry.configSources, ...consulted])];
    entry.configFingerprint = fingerprintConfigSources(entry.configSources);
  }

  if (!hit || fileSetChanged || configChanged || changes.modified.length > 0) {
    entry.assembled.clear();
  }

  entry.walked = true;
  let assembled = entry.assembled.get(includeAssets);
  if (!assembled) {
    assembled = assemble(entry, includeAssets);
    entry.assembled.set(includeAssets, assembled);
  }

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
        addedFiles: changes.added.length + assetDiff.added,
        removedFiles: changes.removed.length + assetDiff.removed,
        renamedFiles: changes.renamed,
        modifiedFiles: changes.modified.length,
        resolvedFiles,
        reusedResolutions,
        configChanged,
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
