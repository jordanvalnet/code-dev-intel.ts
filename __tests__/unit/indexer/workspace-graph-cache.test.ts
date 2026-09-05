import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildWorkspaceGraph,
  getModuleFacts,
  resetWorkspaceGraphCacheForTests,
  selectWorkspacesToEvict,
  WORKSPACE_CACHE_LIMITS
} from '../../../services/indexer/src/workspace-graph-cache.ts';
import { calculateWorkspaceImpactedFiles } from '../../../services/indexer/src/impacted-files-engine.ts';
import { resetResolutionConfigCacheForTests } from '../../../services/indexer/src/import-resolver.ts';

const tempDirs: string[] = [];

function createWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'graph-cache-'));
  tempDirs.push(root);
  return root;
}

function write(root: string, relativePath: string, content: string): string {
  const absolutePath = join(root, ...relativePath.split('/'));
  mkdirSync(resolve(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, content, 'utf8');
  return absolutePath;
}

/**
 * Pushes every file's mtime a minute into the past. The cache deliberately re-reads any
 * file whose recorded mtime is within `MTIME_SAFETY_MS` of when it was cached — the
 * filesystem timestamp is too coarse to prove a just-written file did not change again —
 * so a test that wants to observe a pure cache hit has to age the workspace first, the
 * way a workspace nobody is typing into already is.
 */
function ageWorkspace(root: string, secondsAgo = 60): void {
  const when = new Date(Date.now() - secondsAgo * 1000);
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
      } else if (entry.isFile()) {
        utimesSync(absolutePath, when, when);
      }
    }
  };
  walk(root);
}

function edgeStrings(root: string): string[] {
  return buildWorkspaceGraph(root)
    .imports.map((edge) => `${edge.sourceFile} -> ${edge.targetFile}`)
    .sort((left, right) => left.localeCompare(right));
}

beforeEach(() => {
  resetWorkspaceGraphCacheForTests();
  resetResolutionConfigCacheForTests();
});

afterEach(() => {
  resetWorkspaceGraphCacheForTests();
  resetResolutionConfigCacheForTests();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('workspace graph cache', () => {
  it('answers the first call exactly as an uncached build does', () => {
    const root = createWorkspace();
    write(root, 'src/a.ts', 'export const a = 1;\n');
    write(root, 'src/b.ts', "import { a } from './a';\nexport const b = a;\n");
    write(root, 'src/c.ts', "export { b } from './b';\n");
    ageWorkspace(root);

    const cold = buildWorkspaceGraph(root);
    resetWorkspaceGraphCacheForTests();
    const alsoCold = buildWorkspaceGraph(root);

    expect(cold.cache.hit).toBe(false);
    expect(alsoCold.cache.hit).toBe(false);
    expect(cold.files).toEqual(alsoCold.files);
    expect(cold.imports).toEqual(alsoCold.imports);
    expect(cold.exportsByFile).toEqual(alsoCold.exportsByFile);
    expect(cold.unresolvedCount).toBe(alsoCold.unresolvedCount);
  });

  it('serves an unchanged workspace from the cache without re-reading or re-resolving', () => {
    const root = createWorkspace();
    write(root, 'src/a.ts', 'export const a = 1;\n');
    write(root, 'src/b.ts', "import { a } from './a';\nexport const b = a;\n");
    ageWorkspace(root);

    const first = buildWorkspaceGraph(root);
    const second = buildWorkspaceGraph(root);

    expect(first.cache).toMatchObject({ hit: false, parsedFiles: 2, resolvedFiles: 2 });
    expect(second.cache).toMatchObject({
      hit: true,
      parsedFiles: 0,
      reusedParses: 2,
      resolvedFiles: 0,
      reusedResolutions: 2,
      addedFiles: 0,
      removedFiles: 0,
      modifiedFiles: 0,
      configChanged: false
    });
    expect(second.files).toEqual(first.files);
    expect(second.imports).toEqual(first.imports);
    expect(second.exportsByFile).toEqual(first.exportsByFile);
  });

  it('re-reads a modified file and updates its edges', () => {
    const root = createWorkspace();
    write(root, 'src/a.ts', 'export const a = 1;\n');
    write(root, 'src/b.ts', 'export const b = 1;\n');
    write(root, 'src/main.ts', "import { a } from './a';\nexport const main = a;\n");
    ageWorkspace(root);

    expect(edgeStrings(root)).toEqual(['src/main.ts -> src/a.ts']);

    write(root, 'src/main.ts', "import { b } from './b';\nexport const main = b;\n");

    expect(edgeStrings(root)).toEqual(['src/main.ts -> src/b.ts']);
  });

  it('detects a rewrite that lands in the same filesystem timestamp tick and keeps the same size', () => {
    const root = createWorkspace();
    write(root, 'src/a.ts', 'export const a = 1;\n');
    write(root, 'src/b.ts', 'export const b = 1;\n');
    const main = write(root, 'src/main.ts', "import { a } from './a';\n");
    // Whole milliseconds, so `utimesSync` can reproduce this exact stamp below; the
    // file still counts as just-written, which is the situation being reproduced.
    const justNow = new Date(Date.now());
    utimesSync(main, justNow, justNow);

    expect(edgeStrings(root)).toEqual(['src/main.ts -> src/a.ts']);

    // Same byte length, and the mtime forced back to exactly what the cache recorded:
    // (mtime, size) alone cannot tell this rewrite from the original, which is the
    // normal case — 358 of 500 same-length rewrites measured on this filesystem.
    const stamp = statSync(main);
    writeFileSync(main, "import { b } from './b';\n", 'utf8');
    utimesSync(main, justNow, justNow);
    expect(statSync(main).mtimeMs).toBe(stamp.mtimeMs);
    expect(statSync(main).size).toBe(stamp.size);

    expect(edgeStrings(root)).toEqual(['src/main.ts -> src/b.ts']);
  });

  it('links a newly added importer and grows the impact set', () => {
    const root = createWorkspace();
    write(root, 'src/a.ts', 'export const a = 1;\n');
    write(root, 'src/b.ts', "import { a } from './a';\nexport const b = a;\n");
    ageWorkspace(root);

    expect(calculateWorkspaceImpactedFiles({ workspaceRoot: root, changedFiles: ['src/a.ts'] }).impactedFiles).toEqual([
      'src/a.ts',
      'src/b.ts'
    ]);

    write(root, 'src/c.ts', "import { b } from './b';\nexport const c = b;\n");

    const after = buildWorkspaceGraph(root);
    expect(after.cache).toMatchObject({ hit: true, addedFiles: 1, removedFiles: 0, parsedFiles: 1 });
    expect(after.files).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(calculateWorkspaceImpactedFiles({ workspaceRoot: root, changedFiles: ['src/a.ts'] }).impactedFiles).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts'
    ]);
  });

  it('drops the edges of a deleted file and shrinks the impact set', () => {
    const root = createWorkspace();
    write(root, 'src/a.ts', 'export const a = 1;\n');
    write(root, 'src/b.ts', "import { a } from './a';\nexport const b = a;\n");
    write(root, 'src/c.ts', "import { b } from './b';\nexport const c = b;\n");
    ageWorkspace(root);

    expect(calculateWorkspaceImpactedFiles({ workspaceRoot: root, changedFiles: ['src/a.ts'] }).impactedFiles).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts'
    ]);

    rmSync(join(root, 'src', 'c.ts'));

    const after = buildWorkspaceGraph(root);
    expect(after.cache).toMatchObject({ hit: true, removedFiles: 1, addedFiles: 0 });
    expect(after.files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(after.imports.map((edge) => edge.sourceFile)).toEqual(['src/b.ts']);
    expect(after.exportsByFile['src/c.ts']).toBeUndefined();
    expect(calculateWorkspaceImpactedFiles({ workspaceRoot: root, changedFiles: ['src/a.ts'] }).impactedFiles).toEqual([
      'src/a.ts',
      'src/b.ts'
    ]);
  });

  it('moves the edges of a renamed file and reuses the parse it already had', () => {
    const root = createWorkspace();
    write(root, 'src/a.ts', 'export const a = 1;\n');
    write(root, 'src/old-name.ts', "import { a } from './a';\nexport const value = a;\n");
    ageWorkspace(root);

    expect(edgeStrings(root)).toEqual(['src/old-name.ts -> src/a.ts']);

    renameSync(join(root, 'src', 'old-name.ts'), join(root, 'src', 'new-name.ts'));

    const after = buildWorkspaceGraph(root);
    expect(after.cache).toMatchObject({ hit: true, renamedFiles: 1, parsedFiles: 0, addedFiles: 1, removedFiles: 1 });
    expect(after.files).toEqual(['src/a.ts', 'src/new-name.ts']);
    expect(after.imports.map((edge) => `${edge.sourceFile} -> ${edge.targetFile}`)).toEqual([
      'src/new-name.ts -> src/a.ts'
    ]);
    expect(after.exportsByFile['src/old-name.ts']).toBeUndefined();
  });

  it('does not hand a new file the parse of a deleted one that shared its timestamp and size', () => {
    const root = createWorkspace();
    write(root, 'src/a.ts', 'export const a = 1;\n');
    write(root, 'src/b.ts', 'export const b = 1;\n');
    const goneSoon = write(root, 'src/gone.ts', "import './a';\n");
    // Whole milliseconds so the stamp can be reproduced exactly; recent, because a
    // codegen run that deletes one file and writes another does it in one burst.
    const justNow = new Date(Date.now());
    utimesSync(goneSoon, justNow, justNow);

    expect(edgeStrings(root)).toEqual(['src/gone.ts -> src/a.ts']);

    // A different file, same byte length, same stamp: it is NOT a rename, and reusing
    // the deleted file's parse would give it an import it does not have.
    rmSync(goneSoon);
    const fresh = write(root, 'src/fresh.ts', "import './b';\n");
    utimesSync(fresh, justNow, justNow);

    const after = buildWorkspaceGraph(root);
    expect(after.cache.renamedFiles).toBe(0);
    expect(after.imports.map((edge) => `${edge.sourceFile} -> ${edge.targetFile}`)).toEqual([
      'src/fresh.ts -> src/b.ts'
    ]);
  });

  it('redoes every resolution when a tsconfig alias changes, without re-parsing the sources', () => {
    const root = createWorkspace();
    const configPath = write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['src/*'] } } }));
    write(root, 'src/target.ts', 'export const target = 1;\n');
    write(root, 'lib/target.ts', 'export const target = 2;\n');
    write(root, 'src/main.ts', "import { target } from '@/target';\nexport const main = target;\n");
    ageWorkspace(root);

    expect(edgeStrings(root)).toEqual(['src/main.ts -> src/target.ts']);

    writeFileSync(configPath, JSON.stringify({ compilerOptions: { paths: { '@/*': ['lib/*'] } } }), 'utf8');

    const after = buildWorkspaceGraph(root);
    expect(after.cache).toMatchObject({ hit: true, configChanged: true, parsedFiles: 0, resolvedFiles: 3 });
    expect(after.imports.map((edge) => `${edge.sourceFile} -> ${edge.targetFile}`)).toEqual([
      'src/main.ts -> lib/target.ts'
    ]);
  });

  it('links an asset that appears only after the first build', () => {
    const root = createWorkspace();
    write(root, 'src/widget.ts', "import './widget.css';\nexport const widget = 1;\n");
    ageWorkspace(root);

    const before = buildWorkspaceGraph(root, { includeAssets: true });
    expect(before.imports).toEqual([]);
    expect(before.unresolvedSample).toEqual([
      { from: 'src/widget.ts', specifier: './widget.css', reason: 'not-found' }
    ]);

    write(root, 'src/widget.css', '.widget { display: block; }\n');

    const after = buildWorkspaceGraph(root, { includeAssets: true });
    expect(after.cache).toMatchObject({ hit: true, addedFiles: 1, parsedFiles: 0, resolvedFiles: 1 });
    expect(after.unresolvedCount).toBe(0);
    expect(after.imports.map((edge) => `${edge.sourceFile} -> ${edge.targetFile}`)).toEqual([
      'src/widget.ts -> src/widget.css'
    ]);
    expect(
      calculateWorkspaceImpactedFiles({
        workspaceRoot: root,
        changedFiles: ['src/widget.css'],
        includeAssets: true
      }).impactedFiles
    ).toEqual(['src/widget.css', 'src/widget.ts']);
  });

  it('keeps one cache per workspace root', () => {
    const first = createWorkspace();
    const second = createWorkspace();
    write(first, 'src/a.ts', "import './b';\nexport const a = 1;\n");
    write(first, 'src/b.ts', 'export const b = 1;\n');
    write(second, 'src/x.ts', 'export const x = 1;\n');
    ageWorkspace(first);
    ageWorkspace(second);

    expect(buildWorkspaceGraph(first).files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(buildWorkspaceGraph(second).files).toEqual(['src/x.ts']);
    expect(buildWorkspaceGraph(first).cache.hit).toBe(true);
    expect(buildWorkspaceGraph(second).cache.hit).toBe(true);
    expect(buildWorkspaceGraph(first).files).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('shares one parse with the dependency-graph reader', () => {
    const root = createWorkspace();
    const mainPath = write(root, 'src/main.ts', "import './a';\nexport const main = 1;\n");
    write(root, 'src/a.ts', 'export const a = 1;\n');
    ageWorkspace(root);

    const graph = buildWorkspaceGraph(root);
    const facts = getModuleFacts(root, mainPath);

    // Same parse object, so the reader that walked the workspace and the reader that
    // follows one file's imports cannot disagree and cannot pay for the parse twice.
    expect(facts.exports).toBe(graph.exportsByFile['src/main.ts']);
    expect(getModuleFacts(root, mainPath)).toBe(facts);

    write(root, 'src/main.ts', "import './a';\nexport const main = 2;\nexport const extra = 3;\n");
    expect(getModuleFacts(root, mainPath).exports).toEqual(['main', 'extra']);
  });

  it('builds a complete graph even when a dependency-graph read touched the root first', () => {
    const root = createWorkspace();
    write(root, 'src/a.ts', 'export const a = 1;\n');
    const mainPath = write(root, 'src/main.ts', "import { a } from './a';\nexport const main = a;\n");
    ageWorkspace(root);

    // A partial cache entry: one file parsed, no walk has happened. The first full build
    // must still be a cold build and not diff against that half-filled snapshot.
    getModuleFacts(root, mainPath);

    const graph = buildWorkspaceGraph(root);
    expect(graph.cache.hit).toBe(false);
    expect(graph.files).toEqual(['src/a.ts', 'src/main.ts']);
    expect(graph.imports.map((edge) => `${edge.sourceFile} -> ${edge.targetFile}`)).toEqual([
      'src/main.ts -> src/a.ts'
    ]);
    expect(buildWorkspaceGraph(root).cache).toMatchObject({ hit: true, parsedFiles: 0 });
  });

  it('does not serve a graph built before a dependency-graph read picked up an edit', () => {
    const root = createWorkspace();
    write(root, 'src/a.ts', 'export const a = 1;\n');
    write(root, 'src/b.ts', 'export const b = 1;\n');
    const mainPath = write(root, 'src/main.ts', "import { a } from './a';\nexport const main = a;\n");
    ageWorkspace(root);

    expect(edgeStrings(root)).toEqual(['src/main.ts -> src/a.ts']);

    // The edit is seen first by the reader that follows one file's imports. It refreshes
    // the shared parse, so the next workspace walk finds a stamp that already matches —
    // the assembled graph has to be invalidated here or it is served stale for good.
    // The file is aged past the recency margin first, so the walk really does take the
    // "nothing changed" path: an agent that edits, asks dependencyGraph, then asks
    // impactedFiles a few seconds later is exactly this sequence.
    write(root, 'src/main.ts', "import { b } from './b';\nexport const main = b;\n");
    ageWorkspace(root);
    expect(getModuleFacts(root, mainPath).imports.map((entry) => entry.specifier)).toEqual(['./b']);

    expect(edgeStrings(root)).toEqual(['src/main.ts -> src/b.ts']);
  });

  it('evicts the least recently used workspace once the cap is reached', () => {
    const roots: string[] = [];
    for (let index = 0; index <= WORKSPACE_CACHE_LIMITS.maxWorkspaces; index += 1) {
      const root = createWorkspace();
      write(root, 'src/a.ts', `export const a = ${index};\n`);
      ageWorkspace(root);
      roots.push(root);
      buildWorkspaceGraph(root);
    }

    // One workspace more than the cap has been built, so the first one is gone.
    expect(buildWorkspaceGraph(roots[0] ?? '').cache.hit).toBe(false);
    expect(buildWorkspaceGraph(roots[roots.length - 1] ?? '').cache.hit).toBe(true);
  });
});

describe('selectWorkspacesToEvict', () => {
  it('keeps the newest workspaces within both the file and the workspace cap', () => {
    const entries = [
      { key: 'oldest', fileCount: 10, lastUsedAt: 1 },
      { key: 'middle', fileCount: 10, lastUsedAt: 2 },
      { key: 'newest', fileCount: 10, lastUsedAt: 3 }
    ];

    expect(selectWorkspacesToEvict(entries, { maxFiles: 100, maxWorkspaces: 10 })).toEqual([]);
    expect(selectWorkspacesToEvict(entries, { maxFiles: 25, maxWorkspaces: 10 })).toEqual(['oldest']);
    expect(selectWorkspacesToEvict(entries, { maxFiles: 15, maxWorkspaces: 10 })).toEqual(['oldest', 'middle']);
    expect(selectWorkspacesToEvict(entries, { maxFiles: 100, maxWorkspaces: 2 })).toEqual(['oldest']);
  });

  it('evicts a single workspace that does not fit the file cap on its own', () => {
    const entries = [{ key: 'huge', fileCount: 90_000, lastUsedAt: 1 }];
    expect(selectWorkspacesToEvict(entries, { maxFiles: 50_000, maxWorkspaces: 10 })).toEqual(['huge']);
  });
});
