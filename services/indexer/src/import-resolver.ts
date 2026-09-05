import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import type { UnresolvedReason } from '../../code-intel-mcp/src/contracts.ts';
import { createWorkspaceBoundaryResolver } from '../../code-intel-mcp/src/safe-path.ts';
import { IMPLICIT_ASSET_EXTENSION, isAssetPath, isAssetSpecifier, withoutSpecifierQuery } from './asset-modules.ts';

/**
 * What a specifier turned out to be. Nothing is ever dropped: a specifier the resolver
 * cannot place is `unresolved` with a reason, so the tools can say the graph is
 * incomplete instead of answering as if it were whole.
 */
export type ModuleResolution =
  | { readonly kind: 'internal'; readonly filePath: string }
  /** A non-code workspace file (stylesheet, icon, JSON…): a graph node, never parsed. */
  | { readonly kind: 'asset'; readonly filePath: string }
  | { readonly kind: 'external' }
  | {
      readonly kind: 'unresolved';
      readonly reason: Exclude<UnresolvedReason, 'dynamic-specifier'>;
    };

/**
 * Every workspace path a resolution looked at, spelled the way the workspace walk
 * spells one: relative to the root, posix separators, case-folded where the filesystem
 * is. This is what lets a cache re-resolve one file instead of all of them — a
 * specifier's answer can only move when one of these paths appears or disappears.
 *
 * It is the same evidence `tsserver` watches: TypeScript hands back the locations it
 * probed and did not find, and the manifests it read, precisely so that a long-lived
 * process can tell which file events invalidate which resolution.
 */
export interface SpecifierProvenance {
  /** Workspace file the specifier landed on; absent for a package, a builtin or a hole. */
  readonly target: string | undefined;
  /**
   * Paths probed and NOT found. Any one of them appearing is a file that outranks
   * whatever answered — a `b.ts` written next to the `b.js` a specifier had settled for.
   */
  readonly failedLookups: readonly string[];
  /** Files whose CONTENT steered the answer: the `package.json` a directory import read. */
  readonly affecting: readonly string[];
  /**
   * Paths looked at as DIRECTORIES rather than files. What matters about these is
   * whether anything lives under them, so a change anywhere below one counts.
   */
  readonly directoryProbes: readonly string[];
}

/** A verdict together with the evidence that would overturn it. */
export interface ProvenancedResolution {
  readonly resolution: ModuleResolution;
  readonly provenance: SpecifierProvenance;
}

export interface ImportResolver {
  readonly workspaceRoot: string;
  /**
   * Classify `specifier` as written in `sourceFileAbsolute`: a workspace file
   * (`internal`), a non-code workspace file (`asset`), a package or node builtin
   * (`external`), or `unresolved`.
   */
  resolveModule(sourceFileAbsolute: string, specifier: string): ModuleResolution;
  /**
   * The same verdict, plus every workspace path the answer depended on. A caller that
   * keeps resolutions between calls stores this and re-resolves only the files whose
   * evidence a walk diff actually touched.
   */
  resolveModuleWithProvenance(sourceFileAbsolute: string, specifier: string): ProvenancedResolution;
  /**
   * Every `tsconfig`/`jsconfig` this resolver has consulted so far, each one followed by
   * the files in its `extends` chain. A caller that caches a graph across calls stores
   * these and re-fingerprints them to find out whether resolution can be reused.
   */
  configSources(): string[];
}

const CONFIG_FILE_NAMES = ['tsconfig.json', 'jsconfig.json'];

/**
 * The two fields of `ts.resolveModuleName`'s result that carry the provenance. They are
 * marked `@internal` in TypeScript's public typings — present on the runtime object,
 * absent from `ts.ResolvedModuleWithFailedLookupLocations` — so the result is widened
 * to this shape rather than cast blind, and both fields stay optional because
 * TypeScript leaves them undefined when a lookup succeeded on its first probe.
 *
 * Verified against the installed typescript 6.0.3: a resolution that had to probe
 * (`./b` reaching `b.js` past a missing `b.ts`, a directory import, a miss) carries
 * `failedLookupLocations`, and a directory import through `package.json` carries
 * `affectingLocations`. `import-resolver.test.ts` fails loudly if a future TypeScript
 * stops populating them, because a silent loss here would make the graph cache blind
 * to files arriving rather than merely slower.
 */
interface ResolutionProvenanceFields {
  readonly failedLookupLocations?: readonly string[];
  readonly affectingLocations?: readonly string[];
}

/** Where a resolution looked, before the paths are folded into the walk's spelling. */
interface ProbeLog {
  readonly failed: Set<string>;
  readonly affecting: Set<string>;
  readonly directories: Set<string>;
}

const EMPTY_PROVENANCE: SpecifierProvenance = Object.freeze({
  target: undefined,
  failedLookups: Object.freeze([]),
  affecting: Object.freeze([]),
  directoryProbes: Object.freeze([])
});

function createProbeLog(): ProbeLog {
  return { failed: new Set(), affecting: new Set(), directories: new Set() };
}

const EXTERNAL: ModuleResolution = { kind: 'external' };
const NOT_FOUND: ModuleResolution = { kind: 'unresolved', reason: 'not-found' };
const OUTSIDE_WORKSPACE: ModuleResolution = { kind: 'unresolved', reason: 'outside-workspace' };
/** The file is there; this graph has no way to read it. Never confuse that with missing. */
const UNSUPPORTED_FILE_TYPE: ModuleResolution = { kind: 'unresolved', reason: 'unsupported-file-type' };

/**
 * Config parsing must never glob the workspace: `readDirectory` is what expands
 * `include`/`files`, and on a large repo that walk costs seconds. Only
 * `compilerOptions` matter here, so the host reports no input files at all (the
 * "no inputs were found" diagnostic this provokes is ignored with every other one).
 */
const NON_GLOBBING_PARSE_HOST: ts.ParseConfigHost = {
  useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  readDirectory: () => [],
  fileExists: (fileName) => ts.sys.fileExists(fileName),
  readFile: (fileName) => ts.sys.readFile(fileName)
};

/**
 * Resolution options for a file no `tsconfig`/`jsconfig` covers. `bundler` is the most
 * permissive of TypeScript's modes — extensionless and directory imports, `paths`
 * without `baseUrl`, package `exports` — which is what an index of *what the code
 * depends on* wants.
 */
const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler
};

interface ResolutionConfig {
  readonly options: ts.CompilerOptions;
  /** `compilerOptions.paths` keys, used to tell a broken alias from a bare package. */
  readonly pathPatterns: readonly string[];
  /**
   * Absolute directory `paths` targets are written relative to: `baseUrl` when it is
   * set, else the directory of the config that declared `paths` (which is what
   * TypeScript records as `pathsBasePath`, and is not always the final config in an
   * `extends` chain). Only asset lookup needs it — code resolution is TypeScript's own.
   */
  readonly pathsBase: string | undefined;
}

interface ResolutionContext {
  /** Config path, or `''` for the built-in defaults; identifies the resolution cache. */
  readonly key: string;
  readonly config: ResolutionConfig;
  readonly cache: ts.ModuleResolutionCache;
}

interface ConfigCacheEntry {
  /** The config file plus every file in its `extends` chain. */
  sources: string[];
  /** `sources` with the mtimes they had when the config was parsed. */
  fingerprint: string;
  config: ResolutionConfig;
}

/** Keyed by config path, so every config in a workspace is cached and invalidated. */
const configCache = new Map<string, ConfigCacheEntry>();

export function resetResolutionConfigCacheForTests(): void {
  configCache.clear();
}

function isFile(candidatePath: string): boolean {
  try {
    return statSync(candidatePath).isFile();
  } catch {
    return false;
  }
}

function toPosixPath(value: string): string {
  return value.replaceAll('\\', '/');
}

function hasNodeModulesSegment(posixPath: string): boolean {
  return /(?:^|\/)node_modules(?:\/|$)/.test(posixPath);
}

/**
 * Config files are fingerprinted by CONTENT, not by mtime. They are few and small, so
 * the read costs nothing next to the resolution it guards — and mtime cannot do the
 * job: filesystem timestamps are quantized (a measured 0.5-18.7 ms on the NTFS volume
 * this was developed on), so an edit that keeps a config the same length and lands in
 * the same tick as the previous one is invisible to `(mtime, size)`. Serving stale
 * `paths` after an alias edit would silently move every aliased edge to the wrong file.
 */
function fingerprintSource(source: string): string {
  try {
    const digest = createHash('sha256').update(readFileSync(source)).digest('hex');
    return `${source}:${digest}`;
  } catch {
    return `${source}:missing`;
  }
}

function fingerprintSources(sources: readonly string[]): string {
  return sources.map(fingerprintSource).join('|');
}

/**
 * The options actually handed to `ts.resolveModuleName`. This tool indexes files, it
 * never emits, so three of TypeScript's *emit* rules — which would hide dependencies
 * that plainly exist on disk — are overridden: `allowJs` (a `.js` neighbour is a real
 * dependency of a `.ts` file), `allowImportingTsExtensions` (`./x.mts` names a file
 * that exists, whatever `tsc` would say about emitting it), and `classic` module
 * resolution, a legacy mode that ignores `node_modules` altogether and would erase
 * every workspace-package edge.
 */
function toResolutionConfig(options: ts.CompilerOptions): ResolutionConfig {
  const configured = options.moduleResolution;
  const moduleResolution =
    configured === undefined || configured === ts.ModuleResolutionKind.Classic
      ? ts.ModuleResolutionKind.Bundler
      : configured;

  // `pathsBasePath` is how TypeScript records the directory a `paths` block was
  // declared in; it is not in the public typings, so it is read through the option
  // bag's index signature and narrowed.
  const declaredPathsBase = options['pathsBasePath'];

  return {
    options: {
      ...DEFAULT_COMPILER_OPTIONS,
      ...options,
      moduleResolution,
      allowJs: true,
      allowImportingTsExtensions: true,
      noEmit: true
    },
    pathPatterns: Object.keys(options.paths ?? {}),
    pathsBase: options.baseUrl ?? (typeof declaredPathsBase === 'string' ? declaredPathsBase : undefined)
  };
}

const DEFAULT_RESOLUTION_CONFIG: ResolutionConfig = toResolutionConfig({});

function parseResolutionConfig(configPath: string): { config: ResolutionConfig; sources: string[] } {
  try {
    // `readJsonConfigFile` tolerates comments and trailing commas the way `tsc` does.
    const configSourceFile = ts.readJsonConfigFile(configPath, (fileName) => ts.sys.readFile(fileName));
    const parsed = ts.parseJsonSourceFileConfigFileContent(
      configSourceFile,
      NON_GLOBBING_PARSE_HOST,
      dirname(configPath),
      undefined,
      configPath
    );

    return {
      config: toResolutionConfig(parsed.options),
      // Populated by the parse above: every config pulled in through `extends`, so the
      // cache can notice a base config changing and not just the root one.
      sources: [configPath, ...(configSourceFile.extendedSourceFiles ?? [])]
    };
  } catch {
    // A config the compiler API refuses to digest degrades to the defaults rather than
    // failing the tool call: both module graphs still resolve their relative imports.
    return { config: DEFAULT_RESOLUTION_CONFIG, sources: [configPath] };
  }
}

/**
 * Load (and cache, keyed on the contents of the config file and everything it
 * `extends`) one `tsconfig`/`jsconfig`. Every config a workspace contains goes through
 * here, so a long-lived server picks up an edit to a nested project as well as to the
 * root one.
 *
 * An `extends` chain is followed wherever it leads, including outside the workspace
 * root — deliberately, because that is what `tsc` does and a shared base config kept
 * beside the repository is a normal monorepo shape. It is the one read this module
 * makes that the workspace boundary does not gate, and it is bounded to config JSON:
 * nothing from those files reaches a payload, and a `paths` target they declare outside
 * the root is still refused as `outside-workspace` like any other.
 */
function loadResolutionConfig(configPath: string): ResolutionConfig {
  const cached = configCache.get(configPath);
  if (cached && cached.fingerprint === fingerprintSources(cached.sources)) {
    return cached.config;
  }

  // Stamp the config with the mtime it had BEFORE the parse read it. Stat it afterwards
  // instead and a rewrite landing mid-parse is recorded as already-parsed, so the stale
  // options survive in this long-lived process until the next edit.
  const rootFingerprint = fingerprintSource(configPath);
  const { config, sources } = parseResolutionConfig(configPath);
  const extendedSources = sources.filter((source) => source !== configPath);
  configCache.set(configPath, {
    sources: [configPath, ...extendedSources],
    fingerprint: [rootFingerprint, ...extendedSources.map(fingerprintSource)].join('|'),
    config
  });
  return config;
}

/**
 * Does `specifier` match a `paths` key the way TypeScript parses one? Only exact
 * (wildcard-free) keys and keys with a single `*` are patterns at all — TypeScript
 * drops the rest, so `a*b*c` matches nothing, not even itself. Used to tell a broken
 * alias (`@/does-not-exist`, worth reporting) from a bare package specifier
 * (`some-lib`, external whether or not it is installed).
 */
function matchesPathPattern(pathPatterns: readonly string[], specifier: string): boolean {
  for (const key of pathPatterns) {
    const starIndex = key.indexOf('*');
    if (starIndex === -1) {
      if (key === specifier) {
        return true;
      }
      continue;
    }

    if (key.includes('*', starIndex + 1)) {
      continue;
    }

    const prefix = key.slice(0, starIndex);
    const suffix = key.slice(starIndex + 1);
    if (
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * The file paths a `paths` mapping would substitute for `specifier`, following
 * TypeScript's own precedence: an exact (wildcard-free) key wins outright, otherwise
 * the matching single-`*` key with the longest prefix does, and its targets are tried
 * in the order they are written. Keys with two or more `*` are not patterns at all.
 *
 * Only asset lookup uses this. Code resolution never re-implements `paths` — it hands
 * the specifier to `ts.resolveModuleName` — but TypeScript will not resolve a
 * stylesheet or an icon, so the substitution has to be done here to find the exact file
 * an aliased asset import names.
 */
function pathAliasCandidates(config: ResolutionConfig, specifier: string): string[] {
  const paths = config.options.paths;
  const pathsBase = config.pathsBase;
  if (!paths || pathsBase === undefined) {
    return [];
  }

  let bestPrefix: string | undefined;
  let bestSuffix = '';
  let bestKey: string | undefined;

  for (const key of Object.keys(paths)) {
    const starIndex = key.indexOf('*');
    if (starIndex === -1) {
      if (key === specifier) {
        return (paths[key] ?? []).map((target) => resolve(pathsBase, target));
      }
      continue;
    }

    if (key.includes('*', starIndex + 1)) {
      continue;
    }

    const prefix = key.slice(0, starIndex);
    const suffix = key.slice(starIndex + 1);
    if (
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix) &&
      (bestPrefix === undefined || prefix.length > bestPrefix.length)
    ) {
      bestPrefix = prefix;
      bestSuffix = suffix;
      bestKey = key;
    }
  }

  if (bestKey === undefined || bestPrefix === undefined) {
    return [];
  }

  const captured = specifier.slice(bestPrefix.length, specifier.length - bestSuffix.length);
  return (paths[bestKey] ?? []).map((target) => resolve(pathsBase, target.replace('*', captured)));
}

/**
 * Module resolution for the graph engines, delegated to TypeScript's own
 * `ts.resolveModuleName` so that `paths`, `baseUrl`, `extends`, package `exports` /
 * `main`, directory and index imports, declaration files and the whole `.mts`/`.cts`
 * family behave exactly as they do in the compiler — with the options of the NEAREST
 * config to each file, not just the workspace root's. One instance per engine call:
 * the module-resolution caches and boundary verdicts it accumulates are a snapshot of
 * the workspace for the duration of that call.
 */
export function createImportResolver(workspaceRoot: string): ImportResolver {
  const root = resolve(workspaceRoot);
  const rootPosix = toPosixPath(root);
  const useCaseSensitiveFileNames = ts.sys.useCaseSensitiveFileNames;
  const getCanonicalFileName = (fileName: string): string =>
    useCaseSensitiveFileNames ? fileName : fileName.toLowerCase();
  // Canonicalizes the root once; realpaths each candidate and answers with its canonical
  // path when it is inside the workspace, so a module symlinked into `node_modules` from
  // inside the workspace resolves to the real file and an escape is rejected.
  const resolveWithinWorkspace = createWorkspaceBoundaryResolver(root);
  const canonicalRoot = resolveWithinWorkspace(root) ?? root;

  const configPathByDirectory = new Map<string, string | null>();
  const configByKey = new Map<string, ResolutionConfig>();
  const resolutionCacheByKey = new Map<string, ts.ModuleResolutionCache>();
  const classifications = new Map<string, ModuleResolution>();
  const existingFileClassifications = new Map<string, ModuleResolution>();
  /**
   * One verdict per distinct question, for the life of this resolver.
   *
   * Resolution is a pure function of the containing DIRECTORY (which fixes the config,
   * the nearest `package.json` and the `node_modules` chain), the containing file's
   * EXTENSION (which, with that `package.json`, fixes the ESM/CJS resolution mode under
   * `node16`/`nodenext`) and the specifier — given a file set that cannot change while
   * one resolver instance lives. A workspace asks the same question many times over:
   * measured on a 4,000-file synthetic workspace, 19,721 of 27,420 specifiers were
   * repeats of one of 7,699 distinct questions.
   */
  const resolutions = new Map<string, ProvenancedResolution>();
  // Config files consulted, plus their `extends` chains, in discovery order: a caller
  // that caches resolutions across calls re-fingerprints exactly this list.
  const consultedConfigSources = new Set<string>();

  // Provenance is only useful if it is spelled exactly as the workspace walk spells a
  // path, because the whole point is set membership against a walk diff. The walk folds
  // case on win32 and reports paths relative to the root, so provenance does too.
  const foldsCase = process.platform === 'win32';
  const foldPath = (value: string): string => (foldsCase ? value.toLowerCase() : value);
  const rootSpellings = [rootPosix, toPosixPath(canonicalRoot)];

  /**
   * Which entries of one `node_modules` directory are links, and where they really go.
   * A workspace package is normally installed as a link back into the repository, so
   * TypeScript probes (and resolves through) `node_modules/@scope/name/...` for files
   * the walk will only ever report under `packages/name/...`. Without the rewrite this
   * map provides, a file appearing in such a package would invalidate nothing.
   *
   * Built lazily, one `readdirSync` per `node_modules` directory actually probed, and
   * only for the entries the directory says are links.
   */
  const nodeModulesLinks = new Map<string, Map<string, string>>();

  function indexLink(index: Map<string, string>, name: string, absolutePath: string): void {
    try {
      index.set(name, toPosixPath(realpathSync(absolutePath)));
    } catch {
      // Broken link: nothing to rewrite to, and nothing the walk can see either.
    }
  }

  function linkIndexFor(nodeModulesDirectory: string): Map<string, string> {
    const cached = nodeModulesLinks.get(nodeModulesDirectory);
    if (cached) {
      return cached;
    }

    const index = new Map<string, string>();
    nodeModulesLinks.set(nodeModulesDirectory, index);

    let entries;
    try {
      entries = readdirSync(nodeModulesDirectory, { withFileTypes: true });
    } catch {
      // The overwhelmingly common case: `<some-directory>/node_modules` does not exist,
      // and the resolver probed it only because that is how a package lookup walks up.
      return index;
    }

    for (const entry of entries) {
      const absolutePath = `${nodeModulesDirectory}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        indexLink(index, entry.name, absolutePath);
        continue;
      }

      // Scoped packages hide one level deeper: `node_modules/@scope/name` is the link.
      if (entry.isDirectory() && entry.name.startsWith('@')) {
        let scoped;
        try {
          scoped = readdirSync(absolutePath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const inner of scoped) {
          if (inner.isSymbolicLink()) {
            indexLink(index, `${entry.name}/${inner.name}`, `${absolutePath}/${inner.name}`);
          }
        }
      }
    }

    return index;
  }

  /**
   * Re-express a path that runs through a `node_modules` directory as the path the walk
   * would report, or `null` when the walk can never see it. A package that really lives
   * in `node_modules` is not workspace source and no file event can make it so, which is
   * why everything but a link back into the workspace is dropped rather than kept.
   */
  function throughNodeModulesLink(relativePath: string): string | null {
    const segments = relativePath.split('/');
    const index = segments.indexOf('node_modules');
    if (index === -1) {
      return relativePath;
    }

    const directory = `${rootPosix}/${segments.slice(0, index + 1).join('/')}`;
    const links = linkIndexFor(directory);
    if (links.size === 0) {
      return null;
    }

    const first = segments[index + 1];
    if (first === undefined) {
      return null;
    }

    const scopedName = first.startsWith('@') ? `${first}/${segments[index + 2] ?? ''}` : first;
    const target = links.get(scopedName);
    if (target === undefined) {
      return null;
    }

    const consumed = index + 1 + scopedName.split('/').length;
    const rest = segments.slice(consumed);
    return toWorkspaceRelative(rest.length === 0 ? target : `${target}/${rest.join('/')}`);
  }

  function toWorkspaceRelative(posixPath: string): string | null {
    // The prefix is compared folded and cut UNFOLDED. `toLowerCase` is not
    // length-preserving for every code point (U+0130 lowercases to two units), so
    // slicing by the folded length would cut a root containing one in the wrong place
    // and hand back a path the walk can never match — under-invalidation, silently.
    for (const base of rootSpellings) {
      if (posixPath.length < base.length || foldPath(posixPath.slice(0, base.length)) !== foldPath(base)) {
        continue;
      }
      if (posixPath.length === base.length) {
        return '';
      }
      if (posixPath[base.length] === '/') {
        return posixPath.slice(base.length + 1);
      }
    }
    return null;
  }

  /**
   * One probed path, in the walk's spelling, or `null` when the walk cannot see it —
   * outside the workspace, or inside a real `node_modules`. Dropping those is not a
   * shortcut: resolving one bare specifier probes two hundred such paths, none of which
   * a workspace diff can ever contain.
   */
  function toWalkPath(pathLike: string): string | null {
    const relativePath = toWorkspaceRelative(toPosixPath(pathLike));
    if (relativePath === null || relativePath.length === 0) {
      return null;
    }

    const rewritten = hasNodeModulesSegment(relativePath) ? throughNodeModulesLink(relativePath) : relativePath;
    if (rewritten === null || rewritten.length === 0 || hasNodeModulesSegment(rewritten)) {
      return null;
    }

    return foldPath(rewritten);
  }

  function record(into: Set<string>, pathLike: string): void {
    const walkPath = toWalkPath(pathLike);
    if (walkPath !== null) {
      into.add(walkPath);
    }
  }

  function recordAll(into: Set<string>, paths: readonly string[] | undefined): void {
    for (const pathLike of paths ?? []) {
      record(into, pathLike);
    }
  }

  /** Nearest `tsconfig.json`, else `jsconfig.json`, walking up to (and including) the root. */
  function findNearestConfigPath(startDirectory: string): string | null {
    let current = startDirectory;
    for (;;) {
      for (const fileName of CONFIG_FILE_NAMES) {
        // Forward slashes, exactly like `ts.findConfigFile` returns: TypeScript normalizes
        // `sourceFile.fileName` but keeps the raw name on parse diagnostics, and attaching
        // those two to each other trips an internal assertion when they disagree — which on
        // win32 a `join()`ed path always does, for every config with a JSON syntax error.
        const candidate = toPosixPath(join(current, fileName));
        if (isFile(candidate)) {
          return candidate;
        }
      }

      // The walk stops at the workspace root; the filesystem root ends it for the (guarded
      // against elsewhere) case of a file that is not under the workspace at all.
      if (getCanonicalFileName(toPosixPath(current)) === getCanonicalFileName(rootPosix)) {
        return null;
      }

      const parent = dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  }

  function contextForDirectory(directory: string): ResolutionContext {
    let configPath = configPathByDirectory.get(directory);
    if (configPath === undefined) {
      configPath = findNearestConfigPath(directory);
      configPathByDirectory.set(directory, configPath);
    }

    const key = configPath ?? '';
    let config = configByKey.get(key);
    if (!config) {
      if (configPath === null) {
        config = DEFAULT_RESOLUTION_CONFIG;
      } else {
        config = loadResolutionConfig(configPath);
        for (const source of configCache.get(configPath)?.sources ?? [configPath]) {
          consultedConfigSources.add(source);
        }
      }
      configByKey.set(key, config);
    }

    let cache = resolutionCacheByKey.get(key);
    if (!cache) {
      cache = ts.createModuleResolutionCache(root, getCanonicalFileName, config.options);
      resolutionCacheByKey.set(key, cache);
    }

    return { key, config, cache };
  }

  let rootContext: ResolutionContext | undefined;
  function contextForRoot(): ResolutionContext {
    rootContext ??= contextForDirectory(root);
    return rootContext;
  }

  /** Re-base a canonical path onto the root as the caller spelled it, so callers can `relative()` it. */
  function toWorkspacePath(canonicalPath: string): string {
    return join(root, relative(canonicalRoot, canonicalPath));
  }

  function classifyResolvedFile(resolvedFileName: string): ModuleResolution {
    const cached = classifications.get(resolvedFileName);
    if (cached) {
      return cached;
    }

    const posixPath = toPosixPath(resolvedFileName);
    // The verdict is taken on the REAL path: a workspace package symlinked into
    // `node_modules` is workspace source (internal, at the file it really is), while a
    // package that only lives in `node_modules` is a dependency wherever it sits.
    const canonical = resolveWithinWorkspace(posixPath);
    let result: ModuleResolution;
    if (canonical === null) {
      result = hasNodeModulesSegment(posixPath) ? EXTERNAL : OUTSIDE_WORKSPACE;
    } else if (hasNodeModulesSegment(toPosixPath(canonical))) {
      result = EXTERNAL;
    } else {
      result = { kind: 'internal', filePath: toWorkspacePath(canonical) };
    }

    classifications.set(resolvedFileName, result);
    return result;
  }

  /**
   * A `baseUrl` import and a package name are spelled identically — `billing/invoice`
   * is either a workspace file under `baseUrl` or a subpath of an installed package —
   * so only the filesystem separates them: the first segment names a directory (or a
   * file) under `baseUrl`, or it does not. Without this test, a module DELETED from a
   * `baseUrl` workspace is filed as an installed package: its importers lose the edge
   * and `unresolvedCount` still reports the graph as complete, which is the one failure
   * mode this release exists to end.
   */
  function namesBaseUrlEntry(config: ResolutionConfig, specifier: string, probe: ProbeLog): boolean {
    const baseUrl = config.options.baseUrl;
    if (baseUrl === undefined) {
      return false;
    }

    const firstSegment = specifier.split('/')[0];
    if (firstSegment === undefined || firstSegment.length === 0) {
      return false;
    }

    // The answer turns on whether anything lives at this path, so the path is recorded
    // as a directory: a file appearing anywhere beneath it can change the verdict.
    const candidate = resolve(baseUrl, firstSegment);
    record(probe.directories, candidate);
    return existsSync(candidate);
  }

  /**
   * Nothing on disk answers this specifier. A relative, absolute, package-internal
   * (`#…`), alias-shaped or `baseUrl`-shaped specifier names a file that should exist,
   * so it is reported; every other bare specifier is a package, which is external
   * whether or not `node_modules` has been installed — reporting those would bury the
   * real breakages in noise.
   */
  function classifyUnresolved(
    specifier: string,
    contexts: readonly ResolutionContext[],
    probe: ProbeLog
  ): ModuleResolution {
    if (specifier.startsWith('.') || specifier.startsWith('#') || isAbsolute(specifier)) {
      return NOT_FOUND;
    }

    const namesAWorkspaceFile = contexts.some(
      (context) =>
        matchesPathPattern(context.config.pathPatterns, specifier) ||
        namesBaseUrlEntry(context.config, specifier, probe)
    );
    return namesAWorkspaceFile ? NOT_FOUND : EXTERNAL;
  }

  function resolveWith(
    context: ResolutionContext,
    sourceFileAbsolute: string,
    specifier: string,
    probe: ProbeLog
  ): string | undefined {
    const resolved: ts.ResolvedModuleWithFailedLookupLocations & ResolutionProvenanceFields = ts.resolveModuleName(
      specifier,
      toPosixPath(sourceFileAbsolute),
      context.config.options,
      ts.sys,
      context.cache
    );

    recordAll(probe.failed, resolved.failedLookupLocations);
    recordAll(probe.affecting, resolved.affectingLocations);
    return resolved.resolvedModule?.resolvedFileName;
  }

  /**
   * The exact files a specifier could name, in the order they should be tried: one
   * candidate for a relative or absolute specifier, and for a bare one every `paths`
   * substitution followed by the `baseUrl` reading, per config in scope. No extension
   * probing, no directory index, no `node_modules` walk — these are the paths the
   * specifier literally spells.
   */
  function candidateFilePaths(
    sourceFileAbsolute: string,
    target: string,
    contexts: readonly ResolutionContext[]
  ): string[] {
    if (target.startsWith('.') || isAbsolute(target)) {
      return [resolve(dirname(sourceFileAbsolute), target)];
    }

    const candidates: string[] = [];
    for (const context of contexts) {
      candidates.push(...pathAliasCandidates(context.config, target));
      const baseUrl = context.config.options.baseUrl;
      if (baseUrl !== undefined) {
        candidates.push(resolve(baseUrl, target));
      }
    }
    return candidates;
  }

  /**
   * A file that is really there. Where it sits settles it: outside the workspace it is
   * refused and never read, inside `node_modules` it is a package's business, and inside
   * the workspace it is either an asset — a graph node the tools can point at — or a
   * file of a kind this graph does not follow, which is SAID rather than pretended away.
   *
   * Memoized: the verdict costs a `realpath`, and a shared stylesheet, icon or component
   * is named by hundreds of importers.
   */
  function classifyExistingFile(candidateAbsolute: string): ModuleResolution {
    const posixPath = toPosixPath(candidateAbsolute);
    const cached = existingFileClassifications.get(posixPath);
    if (cached) {
      return cached;
    }

    const canonical = resolveWithinWorkspace(posixPath);
    let result: ModuleResolution;
    if (canonical === null) {
      result = hasNodeModulesSegment(posixPath) ? EXTERNAL : OUTSIDE_WORKSPACE;
    } else if (hasNodeModulesSegment(toPosixPath(canonical))) {
      result = EXTERNAL;
    } else if (isAssetPath(canonical)) {
      result = { kind: 'asset', filePath: toWorkspacePath(canonical) };
    } else {
      result = UNSUPPORTED_FILE_TYPE;
    }

    existingFileClassifications.set(posixPath, result);
    return result;
  }

  /**
   * An asset is resolved by NAMING THE FILE, and nothing else: the specifier either
   * points at a file that exists on disk or it points at nothing. That is the whole
   * guarantee — a graph that invents `./button.css` because `button.css.ts` happens to
   * exist would be worse than one that omits assets entirely.
   *
   * Aliases and `baseUrl` are honoured because a component importing
   * `@shared/icons/logo.svg` depends on that icon just as much as its relative
   * neighbour does; each substitution still has to land on an existing file.
   */
  function resolveAsset(
    sourceFileAbsolute: string,
    specifier: string,
    contexts: readonly ResolutionContext[],
    probe: ProbeLog
  ): ModuleResolution {
    const target = withoutSpecifierQuery(specifier);
    if (target.length === 0) {
      return NOT_FOUND;
    }

    for (const candidate of candidateFilePaths(sourceFileAbsolute, target, contexts)) {
      if (isFile(candidate)) {
        return classifyExistingFile(candidate);
      }
      // The stylesheet an import names but nobody has written yet: the day it lands,
      // this is the only record that says whose edges have to be worked out again.
      record(probe.failed, candidate);
    }

    return classifyUnresolved(target, contexts, probe);
  }

  /**
   * TypeScript found no module. Before reporting a hole, look at the disk: a specifier
   * that names a file which plainly exists is not missing, it is a file this graph does
   * not follow — a `.vue` component, a `.wasm` module — and saying `not-found` about it
   * is a false answer that also buries the real breakages under the noise.
   */
  function resolveMissingModule(
    sourceFileAbsolute: string,
    target: string,
    contexts: readonly ResolutionContext[],
    probe: ProbeLog
  ): ModuleResolution {
    for (const candidate of candidateFilePaths(sourceFileAbsolute, target, contexts)) {
      if (isFile(candidate)) {
        return classifyExistingFile(candidate);
      }
      record(probe.failed, candidate);

      // `.json` is the one extension every JavaScript resolver appends, so an existing
      // `data/fixture.json` really is the file `./data/fixture` names. Nothing else on
      // the asset list is ever guessed at: no bundler resolves `./button` to a stylesheet.
      if (extname(candidate).length === 0) {
        const withJson = `${candidate}${IMPLICIT_ASSET_EXTENSION}`;
        if (isFile(withJson)) {
          return classifyExistingFile(withJson);
        }
        record(probe.failed, withJson);
      }
    }

    return classifyUnresolved(target, contexts, probe);
  }

  function resolveUncached(sourceFileAbsolute: string, trimmed: string, probe: ProbeLog): ModuleResolution {
    const nearest = contextForDirectory(dirname(sourceFileAbsolute));
    const rootConfigContext = contextForRoot();
    const contexts = rootConfigContext.key === nearest.key ? [nearest] : [nearest, rootConfigContext];

    // Assets are decided before TypeScript is asked anything. TypeScript resolves a
    // few of them (`.json` under `resolveJsonModule`) and none of the rest, so letting
    // it try first would classify the same kind of dependency two different ways —
    // and would hand a JSON file to the module parser as if it were code.
    if (isAssetSpecifier(trimmed)) {
      return resolveAsset(sourceFileAbsolute, trimmed, contexts, probe);
    }

    const resolvedFileName = resolveWith(nearest, sourceFileAbsolute, trimmed, probe);
    if (resolvedFileName !== undefined) {
      return classifyResolvedFile(resolvedFileName);
    }

    // The nearest project cannot place this specifier. When the workspace-root config
    // declares a `paths` pattern that matches it, try there before giving up: a nested
    // project that redefines `paths` without re-declaring the root's aliases makes
    // `tsc` fail on those imports, but the file they name exists and the dependency is
    // real — and dropping a real edge in silence is the one failure this tool must not
    // have. Only root-alias-shaped specifiers take this second lookup, so a workspace
    // whose packages are simply not installed pays nothing for it.
    if (
      rootConfigContext.key !== nearest.key &&
      matchesPathPattern(rootConfigContext.config.pathPatterns, trimmed)
    ) {
      const rootResolvedFileName = resolveWith(rootConfigContext, sourceFileAbsolute, trimmed, probe);
      if (rootResolvedFileName !== undefined) {
        return classifyResolvedFile(rootResolvedFileName);
      }
    }

    return resolveMissingModule(sourceFileAbsolute, withoutSpecifierQuery(trimmed), contexts, probe);
  }

  function resolveWithProvenance(sourceFileAbsolute: string, specifier: string): ProvenancedResolution {
    const trimmed = specifier.trim();
    if (trimmed.length === 0) {
      return { resolution: NOT_FOUND, provenance: EMPTY_PROVENANCE };
    }

    // `node:`-prefixed names can only ever be builtins.
    if (trimmed.startsWith('node:')) {
      return { resolution: EXTERNAL, provenance: EMPTY_PROVENANCE };
    }

    const sourcePosix = toPosixPath(sourceFileAbsolute);
    const separatorIndex = sourcePosix.lastIndexOf('/');
    const directory = separatorIndex === -1 ? sourcePosix : sourcePosix.slice(0, separatorIndex);
    const extension = extname(sourcePosix).toLowerCase();
    // Length-prefixed rather than separated: a directory, an extension and a specifier
    // can all contain whatever punctuation a separator might use.
    const key = `${directory.length}:${extension.length}:${directory}${extension}${trimmed}`;
    const cached = resolutions.get(key);
    if (cached) {
      return cached;
    }

    const probe = createProbeLog();
    const resolution = resolveUncached(sourceFileAbsolute, trimmed, probe);
    const target =
      resolution.kind === 'internal' || resolution.kind === 'asset' ? toWalkPath(resolution.filePath) : null;
    const entry: ProvenancedResolution = {
      resolution,
      provenance: {
        target: target ?? undefined,
        failedLookups: [...probe.failed],
        affecting: [...probe.affecting],
        directoryProbes: [...probe.directories]
      }
    };
    resolutions.set(key, entry);
    return entry;
  }

  return {
    workspaceRoot: root,
    configSources(): string[] {
      return [...consultedConfigSources];
    },
    resolveModule(sourceFileAbsolute: string, specifier: string): ModuleResolution {
      return resolveWithProvenance(sourceFileAbsolute, specifier).resolution;
    },
    resolveModuleWithProvenance(sourceFileAbsolute: string, specifier: string): ProvenancedResolution {
      return resolveWithProvenance(sourceFileAbsolute, specifier);
    }
  };
}
