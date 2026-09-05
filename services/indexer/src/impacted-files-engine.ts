import { normalize } from 'node:path';
import type { UnresolvedDependency } from '../../code-intel-mcp/src/contracts.ts';
import { isAssetPath } from './asset-modules.ts';
import { getWorkspaceGraph, type ImportEdge, type WorkspaceGraph } from './workspace-graph-cache.ts';

export {
  buildWorkspaceGraph,
  getWorkspaceGraph,
  shouldSkipDirectory,
  type ImportEdge,
  type WorkspaceGraph,
  type WorkspaceGraphCacheStats,
  type WorkspaceGraphOptions,
  type WorkspaceGraphResult
} from './workspace-graph-cache.ts';

export interface WorkspaceImpactResult {
  impactedFiles: string[];
  unresolvedCount: number;
  unresolvedSample: UnresolvedDependency[];
}

export interface ImpactedFilesOptions {
  graph: WorkspaceGraph;
  changedFiles: string[];
  changedSymbolsByFile?: Record<string, string[]>;
  /**
   * Reverse edges, if the caller already has them. `buildWorkspaceGraph` keeps one per
   * cached workspace, so the common path never rebuilds it; passing nothing rebuilds it
   * from `graph.imports`, which is what a caller holding a hand-made graph wants.
   */
  reverseIndex?: Map<string, ImportEdge[]>;
}

function toPosixPath(value: string): string {
  return normalize(value).replaceAll('\\', '/');
}

function buildReverseIndex(imports: readonly ImportEdge[]): Map<string, ImportEdge[]> {
  const reverseEdges = new Map<string, ImportEdge[]>();

  for (const edge of imports) {
    const importers = reverseEdges.get(edge.targetFile);
    if (importers) {
      importers.push(edge);
    } else {
      reverseEdges.set(edge.targetFile, [edge]);
    }
  }

  return reverseEdges;
}

/**
 * What is known to have changed about one file's exports. `all` is the honest answer
 * whenever nothing can be ruled out — a file the caller named without listing symbols,
 * or a file whose own code consumes something that changed.
 */
interface ChangedExports {
  all: boolean;
  names: Set<string>;
}

/** Nothing about this module's exports can be ruled out. */
const EVERYTHING: ChangedExports = { all: true, names: new Set() };

/**
 * Does this importer touch anything that changed? `*` covers a namespace import, a
 * side-effect import, a `require()` and an `export * from`, all of which depend on
 * whatever the module happens to have.
 */
function edgeCarriesChange(edge: ImportEdge, changed: ChangedExports): boolean {
  // An asset exports nothing, so there is no symbol for the filter to decide on. A
  // stylesheet or a JSON fixture that changed changed for everyone who imports it.
  if (isAssetPath(edge.targetFile)) {
    return true;
  }

  if (changed.all || edge.importedSymbols.includes('*')) {
    return true;
  }

  return edge.importedSymbols.some((symbol) => changed.names.has(symbol));
}

/**
 * What now counts as changed in the IMPORTER.
 *
 * A re-export is transparent: `export { foo } from './impl'` republishes the very
 * symbol that changed, so the change travels on by name and a barrel does not hide it —
 * while `export { bar as renamed }` passes on nothing when only `foo` changed. Any
 * other import means the importer USES the symbol in its own code, and no static
 * analysis here can say which of its exports that affects, so all of them are suspect.
 * The unsound direction — assuming an importer publishes nothing new — is what silently
 * truncated an impact set at the first barrel.
 */
function propagatedChange(edge: ImportEdge, changed: ChangedExports): ChangedExports {
  const reExports = edge.reExports;
  if (reExports === undefined) {
    return EVERYTHING;
  }

  const names = new Set<string>();
  for (const { source, exported } of reExports) {
    if (source !== '*') {
      if (changed.all || changed.names.has(source)) {
        names.add(exported);
      }
      continue;
    }

    // `export * as ns from` collapses the whole module into one binding, so any change
    // to it is a change to `ns`; plain `export *` lets the target's own names through.
    if (exported !== '*') {
      names.add(exported);
    } else if (changed.all) {
      return EVERYTHING;
    } else {
      for (const name of changed.names) {
        names.add(name);
      }
    }
  }

  return { all: false, names };
}

export function calculateImpactedFiles(options: ImpactedFilesOptions): string[] {
  const reverseEdges = options.reverseIndex ?? buildReverseIndex(options.graph.imports);
  const declaredChanges = options.changedSymbolsByFile;

  const changedExports = new Map<string, ChangedExports>();
  const impacted = new Set<string>();
  const queue: string[] = [];

  /** Widen what is known about a file; report whether that actually added anything. */
  function widen(file: string, addition: ChangedExports): boolean {
    const known = changedExports.get(file);
    if (!known) {
      changedExports.set(file, {
        all: addition.all,
        // Whatever the caller declared about this file holds however it was reached.
        names: new Set([...(declaredChanges?.[file] ?? []), ...addition.names])
      });
      return true;
    }

    if (known.all) {
      return false;
    }

    if (addition.all) {
      known.all = true;
      return true;
    }

    let grew = false;
    for (const name of addition.names) {
      if (!known.names.has(name)) {
        known.names.add(name);
        grew = true;
      }
    }
    return grew;
  }

  for (const changedFile of options.changedFiles) {
    const file = toPosixPath(changedFile);
    const declared = declaredChanges?.[file];
    impacted.add(file);
    // No list for a file the caller says changed means the caller did not narrow it
    // down, not that nothing in it changed.
    changedExports.set(file, {
      all: declared === undefined || declared.length === 0,
      names: new Set(declared ?? [])
    });
    queue.push(file);
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      continue;
    }

    const changed = changedExports.get(current);
    if (!changed) {
      continue;
    }

    for (const importerEdge of reverseEdges.get(current) ?? []) {
      if (!edgeCarriesChange(importerEdge, changed)) {
        continue;
      }

      impacted.add(importerEdge.sourceFile);
      // Re-queued only when something new is known about it, so a cycle settles instead
      // of spinning: the sets only ever grow, and there are finitely many names.
      if (widen(importerEdge.sourceFile, propagatedChange(importerEdge, changed))) {
        queue.push(importerEdge.sourceFile);
      }
    }
  }

  return [...impacted].sort((left, right) => left.localeCompare(right));
}

export interface WorkspaceImpactRequest {
  workspaceRoot: string;
  changedFiles: string[];
  changedSymbolsByFile?: Record<string, string[]>;
  /** Follow imports of non-code files, so a changed asset lists the code that uses it. */
  includeAssets?: boolean;
}

export function calculateWorkspaceImpactedFiles(request: WorkspaceImpactRequest): WorkspaceImpactResult {
  const { graph, reverseIndex } = getWorkspaceGraph(request.workspaceRoot, {
    includeAssets: request.includeAssets
  });

  return {
    impactedFiles: calculateImpactedFiles({
      graph,
      reverseIndex,
      changedFiles: request.changedFiles.map((filePath) => toPosixPath(filePath)),
      changedSymbolsByFile: request.changedSymbolsByFile
    }),
    // Workspace-wide: any specifier the graph could not follow is a possibly missing
    // importer, so the caller is told even though the answer itself is a subset.
    unresolvedCount: graph.unresolvedCount,
    unresolvedSample: graph.unresolvedSample
  };
}
