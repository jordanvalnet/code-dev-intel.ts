import { statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import ts from 'typescript';
import { createWorkspaceBoundaryCheck } from '../../code-intel-mcp/src/safe-path.ts';

/**
 * Path-alias configuration extracted from the workspace `tsconfig.json`
 * (or `jsconfig.json`): `compilerOptions.paths` plus the directory those
 * targets are relative to, and `baseUrl` when set.
 */
export interface PathAliasConfig {
  readonly configPath: string;
  /** Directory alias targets are resolved against: `baseUrl` if set, else the config that defines `paths`. */
  readonly basePath: string;
  readonly baseUrl?: string;
  /** Readonly because the parsed config is shared through a process-wide cache. */
  readonly paths: Readonly<Record<string, readonly string[]>>;
}

export interface ImportResolver {
  readonly workspaceRoot: string;
  readonly aliasConfig: PathAliasConfig | null;
  /**
   * Absolute path of the workspace source file `specifier` refers to when imported
   * from `sourceFileAbsolute`, or `null` when it is external (bare package, node
   * builtin), unresolvable, or outside the workspace root.
   */
  resolve(sourceFileAbsolute: string, specifier: string): string | null;
}

const CONFIG_FILE_NAMES = ['tsconfig.json', 'jsconfig.json'];
const RUNTIME_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.d.ts'];
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.d.ts'];

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

interface AliasCacheEntry {
  configPath: string;
  /** The config file plus every file in its `extends` chain. */
  sources: string[];
  /** `sources` with the mtimes they had when the config was parsed. */
  fingerprint: string;
  config: PathAliasConfig | null;
}

const aliasConfigCache = new Map<string, AliasCacheEntry>();

export function resetPathAliasCacheForTests(): void {
  aliasConfigCache.clear();
}

function isFile(candidatePath: string): boolean {
  try {
    return statSync(candidatePath).isFile();
  } catch {
    return false;
  }
}

function fingerprintSource(source: string): string {
  try {
    return `${source}:${statSync(source).mtimeMs}`;
  } catch {
    return `${source}:missing`;
  }
}

function fingerprintSources(sources: readonly string[]): string {
  return sources.map(fingerprintSource).join('|');
}

function findConfigFile(workspaceRoot: string): string | null {
  for (const fileName of CONFIG_FILE_NAMES) {
    // Forward slashes, exactly like `ts.findConfigFile` returns: TypeScript normalizes
    // `sourceFile.fileName` but keeps the raw name on parse diagnostics, and attaching
    // those two to each other trips an internal assertion when they disagree — which on
    // win32 a `join()`ed path always does, for every config with a JSON syntax error.
    const candidate = join(workspaceRoot, fileName).replaceAll('\\', '/');
    if (isFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

function parsePathAliasConfig(configPath: string): { config: PathAliasConfig | null; sources: string[] } {
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
    // Populated by the parse above: every config pulled in through `extends`, so the
    // cache can notice a base config changing and not just the root one.
    const sources = [configPath, ...(configSourceFile.extendedSourceFiles ?? [])];

    // `pathsBasePath` is how TypeScript remembers which config (in an `extends` chain)
    // declared `paths`; targets are relative to it unless `baseUrl` is set. It is not
    // part of the public `CompilerOptions` surface, hence the widening cast.
    const options = parsed.options as ts.CompilerOptions & { pathsBasePath?: string };
    const paths: Record<string, string[]> = {};
    for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
      if (Array.isArray(targets)) {
        paths[pattern] = targets.filter((target): target is string => typeof target === 'string');
      }
    }

    const baseUrl = options.baseUrl;
    if (Object.keys(paths).length === 0 && baseUrl === undefined) {
      return { config: null, sources };
    }

    return {
      config: {
        configPath,
        basePath: baseUrl ?? options.pathsBasePath ?? dirname(configPath),
        baseUrl,
        paths
      },
      sources
    };
  } catch {
    // A config the compiler API refuses to digest degrades to "no aliases" rather than
    // failing the tool call: both module graphs still resolve their relative imports.
    return { config: null, sources: [configPath] };
  }
}

/**
 * Load (and cache, keyed on the mtimes of the config file and everything it
 * `extends`) the alias configuration of a workspace. Returns `null` when there is
 * no config or it declares neither `paths` nor `baseUrl`.
 */
export function loadPathAliasConfig(workspaceRoot: string): PathAliasConfig | null {
  const root = resolve(workspaceRoot);
  const configPath = findConfigFile(root);
  if (!configPath) {
    aliasConfigCache.delete(root);
    return null;
  }

  const cached = aliasConfigCache.get(root);
  if (cached && cached.configPath === configPath && cached.fingerprint === fingerprintSources(cached.sources)) {
    return cached.config;
  }

  // Stamp the root config with the mtime it had BEFORE the parse read it. Stat it
  // afterwards instead and a rewrite landing mid-parse is recorded as already-parsed,
  // so the stale aliases survive in this long-lived process until the next edit.
  const rootFingerprint = fingerprintSource(configPath);
  const { config, sources } = parsePathAliasConfig(configPath);
  const extendedSources = sources.filter((source) => source !== configPath);
  aliasConfigCache.set(root, {
    configPath,
    sources: [configPath, ...extendedSources],
    fingerprint: [rootFingerprint, ...extendedSources.map(fingerprintSource)].join('|'),
    config
  });
  return config;
}

/**
 * Candidate absolute paths for a non-relative specifier per TypeScript's `paths`
 * rules: an exact (wildcard-free) key wins, otherwise the single-`*` pattern with
 * the longest prefix, with the captured text substituted into every target (which
 * are tried in order). `null` means no pattern matched at all — the only case in
 * which TypeScript goes on to try `baseUrl`.
 */
function matchAliasCandidates(config: PathAliasConfig, specifier: string): string[] | null {
  // TypeScript substitutes only a NON-EMPTY capture (`matchedStar ? ... : subst`), so a
  // target keeps its literal `*` for an exact key and for a pattern matched with nothing
  // between prefix and suffix — and then resolves to nothing.
  const toCandidates = (targets: readonly string[], captured: string): string[] =>
    targets.map((target) => resolve(config.basePath, captured ? target.replace('*', captured) : target));

  // TypeScript drops any key it cannot parse as a zero- or one-wildcard pattern, so a
  // key with two or more `*` is not matchable at all, not even literally.
  if (!specifier.includes('*') && Object.hasOwn(config.paths, specifier)) {
    return toCandidates(config.paths[specifier] ?? [], '');
  }

  let bestKey: string | null = null;
  let bestPrefixLength = -1;
  let captured = '';

  for (const key of Object.keys(config.paths)) {
    const starIndex = key.indexOf('*');
    if (starIndex === -1 || key.includes('*', starIndex + 1)) {
      continue; // Exact keys are handled above; TypeScript ignores multi-wildcard patterns.
    }

    const prefix = key.slice(0, starIndex);
    const suffix = key.slice(starIndex + 1);
    if (
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix) &&
      prefix.length > bestPrefixLength
    ) {
      bestKey = key;
      bestPrefixLength = prefix.length;
      captured = specifier.slice(prefix.length, specifier.length - suffix.length);
    }
  }

  if (bestKey === null) {
    return null;
  }

  return toCandidates(config.paths[bestKey] ?? [], captured);
}

/** Probe `basePath` as a file, with source extensions, and as a directory with an index file. */
function probeSourceFile(basePath: string): string | null {
  const candidates = [basePath];

  const runtimeExtension = RUNTIME_EXTENSIONS.find((extension) => basePath.endsWith(extension));
  if (runtimeExtension) {
    const stem = basePath.slice(0, -runtimeExtension.length);
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.d.ts`);
  }

  for (const extension of SOURCE_EXTENSIONS) {
    candidates.push(`${basePath}${extension}`);
  }

  for (const indexFile of INDEX_FILES) {
    candidates.push(join(basePath, indexFile));
  }

  for (const candidate of candidates) {
    if (isFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Resolver for the module graph engines: relative imports plus the workspace's
 * `tsconfig`/`jsconfig` `paths` and `baseUrl` aliases. One instance per engine call,
 * so the alias config is read once and the workspace-boundary verdicts are reused.
 */
export function createImportResolver(workspaceRoot: string): ImportResolver {
  const root = resolve(workspaceRoot);
  const aliasConfig = loadPathAliasConfig(root);
  // A popular module is imported by many files; the boundary check realpaths the
  // candidate on every call, so memoize the verdict per resolved file. The root is
  // canonicalized once, by the bound check itself.
  const isWithinRoot = createWorkspaceBoundaryCheck(root);
  const withinWorkspace = new Map<string, boolean>();
  // Alias and `baseUrl` lookups do not depend on the importing file, so their answer
  // can be reused: without this, every `import 'react'` in a `baseUrl` workspace pays
  // for the full candidate probe again.
  const nonRelativeResults = new Map<string, string | null>();

  function isInsideWorkspace(candidatePath: string): boolean {
    const cached = withinWorkspace.get(candidatePath);
    if (cached !== undefined) {
      return cached;
    }

    const verdict = isWithinRoot(candidatePath);
    withinWorkspace.set(candidatePath, verdict);
    return verdict;
  }

  /**
   * The first candidate that exists wins, as in TypeScript — but a file outside the
   * workspace is out of bounds, so it counts as external rather than silently handing
   * the graph whatever target comes next.
   */
  function resolveCandidates(candidates: string[]): string | null {
    for (const candidate of candidates) {
      const found = probeSourceFile(candidate);
      if (found) {
        return isInsideWorkspace(found) ? found : null;
      }
    }

    return null;
  }

  return {
    workspaceRoot: root,
    aliasConfig,
    resolve(sourceFileAbsolute: string, specifier: string): string | null {
      const trimmed = specifier.trim();
      if (trimmed.length === 0 || trimmed.startsWith('node:') || isAbsolute(trimmed)) {
        return null;
      }

      if (trimmed.startsWith('.')) {
        return resolveCandidates([resolve(dirname(sourceFileAbsolute), trimmed)]);
      }

      if (!aliasConfig) {
        return null; // Bare package specifier with no alias configuration: external.
      }

      const cached = nonRelativeResults.get(trimmed);
      if (cached !== undefined) {
        return cached;
      }

      const matched = matchAliasCandidates(aliasConfig, trimmed);
      let resolved: string | null = null;
      if (matched !== null) {
        // A matched pattern is terminal in TypeScript: it never falls back to `baseUrl`.
        resolved = resolveCandidates(matched);
      } else if (aliasConfig.baseUrl !== undefined) {
        resolved = resolveCandidates([resolve(aliasConfig.baseUrl, trimmed)]);
      }

      nonRelativeResults.set(trimmed, resolved);
      return resolved;
    }
  };
}
