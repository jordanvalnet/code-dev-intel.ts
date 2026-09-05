import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildWorkspaceGraph,
  resetWorkspaceGraphCacheForTests,
  withEmptyWorkspaceGraphCacheForTests,
  type WorkspaceGraphResult
} from '../../../services/indexer/src/workspace-graph-cache.ts';
import { resetResolutionConfigCacheForTests } from '../../../services/indexer/src/import-resolver.ts';

const tempDirs: string[] = [];

function createWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'graph-invalidation-'));
  tempDirs.push(root);
  return root;
}

function write(root: string, relativePath: string, content: string): string {
  const absolutePath = join(root, ...relativePath.split('/'));
  mkdirSync(resolve(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, content, 'utf8');
  return absolutePath;
}

function remove(root: string, relativePath: string): void {
  rmSync(join(root, ...relativePath.split('/')), { force: true });
}

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

/** Everything a caller can observe about a graph, so equality is not "close enough". */
function comparable(graph: WorkspaceGraphResult): unknown {
  return {
    files: graph.files,
    imports: graph.imports,
    exportsByFile: graph.exportsByFile,
    unresolvedCount: graph.unresolvedCount,
    unresolvedSample: graph.unresolvedSample
  };
}

/**
 * The whole contract of incremental invalidation in one assertion: whatever the cache
 * reused, the answer has to be the answer a process that had never seen this workspace
 * would give. Returns the incremental result so a test can also pin what was reused.
 */
function expectIncrementalMatchesScratch(root: string, includeAssets = true): WorkspaceGraphResult {
  const incremental = buildWorkspaceGraph(root, { includeAssets });
  const scratch = withEmptyWorkspaceGraphCacheForTests(() => buildWorkspaceGraph(root, { includeAssets }));
  expect(scratch.cache.hit).toBe(false);
  expect(comparable(incremental)).toEqual(comparable(scratch));
  return incremental;
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

describe('precise incremental invalidation', () => {
  it('re-points a specifier when a higher-precedence file appears beside the one it resolved to', () => {
    const root = createWorkspace();
    write(root, 'src/b.js', 'export const b = 1;\n');
    write(root, 'src/main.ts', "import { b } from './b';\nexport const main = b;\n");
    write(root, 'src/spectator.ts', 'export const spectator = 1;\n');
    ageWorkspace(root);

    expect(buildWorkspaceGraph(root).imports.map((edge) => edge.targetFile)).toEqual(['src/b.js']);

    write(root, 'src/b.ts', 'export const b = 2;\n');

    const after = expectIncrementalMatchesScratch(root);
    expect(after.imports.map((edge) => edge.targetFile)).toEqual(['src/b.ts']);
    // `main.ts` probed `src/b.ts` and did not find it; `spectator.ts` never asked.
    expect(after.cache).toMatchObject({ hit: true, invalidatedByProvenance: 1, resolvedFiles: 2 });
  });

  it('keeps a file-shadowed directory import untouched when an index file appears inside it', () => {
    const root = createWorkspace();
    write(root, 'src/lib.ts', 'export const lib = 1;\n');
    write(root, 'src/main.ts', "import { lib } from './lib';\nexport const main = lib;\n");
    write(root, 'src/lib/helper.ts', 'export const helper = 1;\n');
    ageWorkspace(root);

    expect(buildWorkspaceGraph(root).imports.map((edge) => edge.targetFile)).toEqual(['src/lib.ts']);

    write(root, 'src/lib/index.ts', 'export const lib = 2;\n');

    const after = expectIncrementalMatchesScratch(root);
    // `./lib` hit `src/lib.ts` on the first probe, so nothing it looked at moved.
    expect(after.imports.map((edge) => edge.targetFile)).toEqual(['src/lib.ts']);
    expect(after.cache).toMatchObject({ hit: true, invalidatedByProvenance: 0, resolvedFiles: 1 });
  });

  it('turns an edge into a hole when its target is deleted', () => {
    const root = createWorkspace();
    write(root, 'src/target.ts', 'export const target = 1;\n');
    write(root, 'src/main.ts', "import { target } from './target';\nexport const main = target;\n");
    write(root, 'src/spectator.ts', 'export const spectator = 1;\n');
    ageWorkspace(root);

    buildWorkspaceGraph(root);
    remove(root, 'src/target.ts');

    const after = expectIncrementalMatchesScratch(root);
    expect(after.imports).toEqual([]);
    expect(after.unresolvedSample).toEqual([{ from: 'src/main.ts', specifier: './target', reason: 'not-found' }]);
    expect(after.cache).toMatchObject({ hit: true, invalidatedByProvenance: 1, resolvedFiles: 1 });
  });

  it('follows a rename in both directions', () => {
    const root = createWorkspace();
    write(root, 'src/old.ts', 'export const value = 1;\n');
    write(root, 'src/main.ts', "import { value } from './old';\nexport const main = value;\n");
    ageWorkspace(root);

    buildWorkspaceGraph(root);
    renameSync(join(root, 'src', 'old.ts'), join(root, 'src', 'new.ts'));

    const renamed = expectIncrementalMatchesScratch(root);
    expect(renamed.files).toEqual(['src/main.ts', 'src/new.ts']);
    expect(renamed.imports).toEqual([]);

    renameSync(join(root, 'src', 'new.ts'), join(root, 'src', 'old.ts'));

    const restored = expectIncrementalMatchesScratch(root);
    expect(restored.files).toEqual(['src/main.ts', 'src/old.ts']);
    expect(restored.imports.map((edge) => edge.targetFile)).toEqual(['src/old.ts']);
  });

  it('redoes every resolution when a package manifest appears in a directory that is imported', () => {
    const root = createWorkspace();
    write(root, 'src/pkg/index.ts', 'export const pkg = 1;\n');
    write(root, 'src/pkg/entry.ts', 'export const pkg = 2;\n');
    write(root, 'src/main.ts', "import { pkg } from './pkg';\nexport const main = pkg;\n");
    ageWorkspace(root);

    expect(buildWorkspaceGraph(root).imports.map((edge) => edge.targetFile)).toEqual(['src/pkg/index.ts']);

    write(root, 'src/pkg/package.json', JSON.stringify({ main: 'entry.js' }));

    const after = expectIncrementalMatchesScratch(root);
    expect(after.imports.map((edge) => edge.targetFile)).toEqual(['src/pkg/entry.ts']);
    // A manifest is one of the three files whose CONTENT moves edges anywhere in the
    // workspace, so it keeps the full re-resolution rather than a provenance test.
    expect(after.cache).toMatchObject({ hit: true, configChanged: true, resolvedFiles: 3 });
  });

  it('links an asset that appears, and unlinks one that goes away', () => {
    const root = createWorkspace();
    write(root, 'src/widget.ts', "import './widget.css';\nexport const widget = 1;\n");
    write(root, 'src/spectator.ts', 'export const spectator = 1;\n');
    ageWorkspace(root);

    expect(buildWorkspaceGraph(root).unresolvedCount).toBe(1);

    write(root, 'src/widget.css', '.widget { display: block; }\n');

    const linked = expectIncrementalMatchesScratch(root);
    expect(linked.imports.map((edge) => edge.targetFile)).toEqual(['src/widget.css']);
    expect(linked.cache).toMatchObject({ hit: true, invalidatedByProvenance: 1, resolvedFiles: 1 });

    remove(root, 'src/widget.css');

    const unlinked = expectIncrementalMatchesScratch(root);
    expect(unlinked.imports).toEqual([]);
    expect(unlinked.cache).toMatchObject({ hit: true, invalidatedByProvenance: 1, resolvedFiles: 1 });
  });

  it('re-resolves nothing but the new file when a file nobody imports is added', () => {
    const root = createWorkspace();
    for (let index = 0; index < 12; index += 1) {
      write(root, `src/mod${index}.ts`, `import { shared } from './shared';\nexport const mod${index} = shared;\n`);
    }
    write(root, 'src/shared.ts', 'export const shared = 1;\n');
    ageWorkspace(root);

    buildWorkspaceGraph(root);
    write(root, 'src/orphan.ts', 'export const orphan = 1;\n');

    const after = expectIncrementalMatchesScratch(root);
    expect(after.cache.reusedResolutions).toBe(after.files.length - 1);
    expect(after.cache).toMatchObject({ hit: true, resolvedFiles: 1, invalidatedByProvenance: 0 });
  });

  it('links an alias-shaped import as soon as the file under the paths target exists', () => {
    const root = createWorkspace();
    write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }));
    write(root, 'src/main.ts', "import { late } from '@/late';\nexport const main = late;\n");
    write(root, 'src/spectator.ts', 'export const spectator = 1;\n');
    ageWorkspace(root);

    expect(buildWorkspaceGraph(root).unresolvedCount).toBe(1);

    write(root, 'src/late.ts', 'export const late = 1;\n');

    const after = expectIncrementalMatchesScratch(root);
    expect(after.imports.map((edge) => `${edge.sourceFile} -> ${edge.targetFile}`)).toEqual(['src/main.ts -> src/late.ts']);
    expect(after.cache).toMatchObject({ hit: true, configChanged: false, invalidatedByProvenance: 1, resolvedFiles: 2 });
  });

  it('redoes every resolution when the tsconfig paths change', () => {
    const root = createWorkspace();
    const configPath = write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['src/*'] } } }));
    write(root, 'src/target.ts', 'export const target = 1;\n');
    write(root, 'lib/target.ts', 'export const target = 2;\n');
    write(root, 'src/main.ts', "import { target } from '@/target';\nexport const main = target;\n");
    ageWorkspace(root);

    buildWorkspaceGraph(root);
    writeFileSync(configPath, JSON.stringify({ compilerOptions: { paths: { '@/*': ['lib/*'] } } }), 'utf8');

    const after = expectIncrementalMatchesScratch(root);
    expect(after.imports.map((edge) => edge.targetFile)).toEqual(['lib/target.ts']);
    expect(after.cache).toMatchObject({ hit: true, configChanged: true, resolvedFiles: 3, invalidatedByProvenance: 0 });
  });

  it('sees nothing at all when a file is created and deleted between two calls', () => {
    const root = createWorkspace();
    write(root, 'src/a.ts', 'export const a = 1;\n');
    write(root, 'src/main.ts', "import { a } from './a';\nexport const main = a;\n");
    ageWorkspace(root);

    buildWorkspaceGraph(root);

    write(root, 'src/transient.ts', 'export const transient = 1;\n');
    remove(root, 'src/transient.ts');

    const after = expectIncrementalMatchesScratch(root);
    expect(after.cache).toMatchObject({
      hit: true,
      addedFiles: 0,
      removedFiles: 0,
      resolvedFiles: 0,
      invalidatedByProvenance: 0
    });
  });

  it('handles a modified file and an added one in the same refresh', () => {
    const root = createWorkspace();
    write(root, 'src/a.ts', 'export const a = 1;\n');
    write(root, 'src/b.ts', 'export const b = 1;\n');
    write(root, 'src/main.ts', "import { a } from './a';\nexport const main = a;\n");
    write(root, 'src/spectator.ts', 'export const spectator = 1;\n');
    ageWorkspace(root);

    buildWorkspaceGraph(root);

    write(root, 'src/main.ts', "import { b } from './b';\nimport { late } from './late';\nexport const main = b + late;\n");
    write(root, 'src/late.ts', 'export const late = 1;\n');

    const after = expectIncrementalMatchesScratch(root);
    expect(after.imports.map((edge) => `${edge.sourceFile} -> ${edge.targetFile}`)).toEqual([
      'src/main.ts -> src/b.ts',
      'src/main.ts -> src/late.ts'
    ]);
    expect(after.cache).toMatchObject({ hit: true, addedFiles: 1, modifiedFiles: 1, resolvedFiles: 2 });
  });

  it('re-reads a baseUrl verdict that turned on whether a directory exists at all', () => {
    const root = createWorkspace();
    write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: 'src' } }));
    write(root, 'src/main.ts', "import { gone } from 'billing/gone';\nexport const main = gone;\n");
    write(root, 'src/spectator.ts', 'export const spectator = 1;\n');
    ageWorkspace(root);

    // Nothing called `billing` exists under `baseUrl`, so this is spelled like — and
    // taken for — a package that is simply not installed.
    expect(buildWorkspaceGraph(root).unresolvedCount).toBe(0);

    // `other.ts` is not a path anything probed for `billing/gone`; what changed is that
    // `src/billing` now EXISTS, which turns the same specifier into a lost workspace
    // edge. Only the directory that verdict tested says so.
    write(root, 'src/billing/other.ts', 'export const other = 1;\n');

    const appeared = expectIncrementalMatchesScratch(root);
    expect(appeared.unresolvedSample).toEqual([
      { from: 'src/main.ts', specifier: 'billing/gone', reason: 'not-found' }
    ]);
    expect(appeared.cache).toMatchObject({ hit: true, configChanged: false, invalidatedByProvenance: 1 });

    // And back: deleting the last file does not remove the directory, so the verdict
    // stands until the directory itself goes.
    remove(root, 'src/billing/other.ts');
    const stillThere = expectIncrementalMatchesScratch(root);
    expect(stillThere.unresolvedCount).toBe(1);
    expect(stillThere.cache).toMatchObject({ hit: true, invalidatedByProvenance: 1 });

    rmSync(join(root, 'src', 'billing'), { recursive: true, force: true });
    const vanished = expectIncrementalMatchesScratch(root);
    expect(vanished.unresolvedCount).toBe(0);
  });

  it('sees a file arrive inside a workspace package that is linked into node_modules', () => {
    const root = createWorkspace();
    write(root, 'packages/ui/package.json', JSON.stringify({ name: '@w/ui', main: 'index.js' }));
    write(root, 'packages/ui/index.js', 'module.exports = { Button: 1 };\n');
    write(root, 'src/main.ts', "import { Button } from '@w/ui';\nexport const main = Button;\n");
    write(root, 'src/spectator.ts', 'export const spectator = 1;\n');
    mkdirSync(join(root, 'node_modules', '@w'), { recursive: true });
    symlinkSync(
      join(root, 'packages', 'ui'),
      join(root, 'node_modules', '@w', 'ui'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    ageWorkspace(root);

    expect(buildWorkspaceGraph(root).imports.map((edge) => edge.targetFile)).toEqual(['packages/ui/index.js']);

    // TypeScript probed `node_modules/@w/ui/index.ts` for this; the walk will only ever
    // report `packages/ui/index.ts`, so the provenance has to have been rewritten
    // through the link or this file arrives unnoticed.
    write(root, 'packages/ui/index.ts', 'export const Button = 2;\n');

    const after = expectIncrementalMatchesScratch(root);
    expect(after.imports.map((edge) => edge.targetFile)).toEqual(['packages/ui/index.ts']);
    expect(after.cache).toMatchObject({ hit: true, configChanged: false, invalidatedByProvenance: 1 });
  });

  it('reuses the resolutions of every file a change cannot reach', () => {
    const root = createWorkspace();
    for (let index = 0; index < 40; index += 1) {
      write(root, `src/group/mod${index}.ts`, `import { shared } from '../shared';\nexport const mod${index} = shared;\n`);
    }
    write(root, 'src/shared.ts', 'export const shared = 1;\n');
    write(root, 'src/hopeful.ts', "import './later.css';\nexport const hopeful = 1;\n");
    ageWorkspace(root);

    buildWorkspaceGraph(root);
    write(root, 'src/later.css', '.later {}\n');

    const after = expectIncrementalMatchesScratch(root);
    // One file asked a question the new asset answers; the other 41 asked nothing that
    // could see it, and pay nothing for it.
    expect(after.cache).toMatchObject({ hit: true, resolvedFiles: 1, invalidatedByProvenance: 1 });
    expect(after.cache.reusedResolutions).toBe(after.files.length - 1);
  });
});

/**
 * The other half of the rule. Everything above rests on a walk diff naming the change;
 * these are the answers no walk diff can name, because the resolver reads places the
 * walk refuses to go — build output, hidden directories, nested checkouts, symlinks. A
 * file arriving there is invisible, so the only honest thing to do with a resolution
 * that looked there is to take it again, every call, and that is what these pin. Every
 * one of them is a divergence between incremental and from-scratch on 0.4.0 and on the
 * first cut of this engine; what makes them worth a test now is that the graph is
 * written to disk, so such an answer used to die with the process and would otherwise
 * be reloaded by the next one.
 */
describe('resolutions the walk cannot watch', () => {
  it('sees a module appear inside a build directory the walk refuses to enter', () => {
    const root = createWorkspace();
    write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: 'src' } }));
    write(root, 'src/main.ts', "import { built } from '../dist/bundle';\nexport const main = built;\n");
    mkdirSync(join(root, 'dist'), { recursive: true });
    ageWorkspace(root);

    const before = buildWorkspaceGraph(root);
    expect(before.imports).toEqual([]);
    expect(before.unresolvedCount).toBe(1);

    // The build runs. No file event: the walk never enters `dist/`.
    write(root, 'dist/bundle.ts', 'export const built = 1;\n');

    const after = expectIncrementalMatchesScratch(root);

    expect(after.imports.map((edge) => edge.targetFile)).toEqual(['dist/bundle.ts']);
    expect(after.cache).toMatchObject({ hit: true, unwatchableFiles: 1, resolvedFiles: 1 });
  });

  it('sees a module appear inside a hidden directory', () => {
    const root = createWorkspace();
    write(root, 'src/main.ts', "import { preview } from '../.storybook/preview';\nexport const main = preview;\n");
    mkdirSync(join(root, '.storybook'), { recursive: true });
    ageWorkspace(root);

    expect(buildWorkspaceGraph(root).imports).toEqual([]);

    write(root, '.storybook/preview.ts', 'export const preview = 1;\n');

    const after = expectIncrementalMatchesScratch(root);

    expect(after.imports.map((edge) => edge.targetFile)).toEqual(['.storybook/preview.ts']);
    expect(after.cache.unwatchableFiles).toBe(1);
  });

  it('sees a module appear inside a nested checkout', () => {
    const root = createWorkspace();
    write(root, 'vendor/sub/.git/HEAD', 'ref: refs/heads/main\n');
    write(root, 'src/main.ts', "import { vendored } from '../vendor/sub/entry';\nexport const main = vendored;\n");
    ageWorkspace(root);

    expect(buildWorkspaceGraph(root).imports).toEqual([]);

    write(root, 'vendor/sub/entry.ts', 'export const vendored = 1;\n');

    const after = expectIncrementalMatchesScratch(root);

    expect(after.imports.map((edge) => edge.targetFile)).toEqual(['vendor/sub/entry.ts']);
    expect(after.cache.unwatchableFiles).toBe(1);
  });

  it('drops an edge whose target leaves a directory the walk cannot see into', () => {
    const root = createWorkspace();
    write(root, 'dist/bundle.ts', 'export const built = 1;\n');
    write(root, 'src/main.ts', "import { built } from '../dist/bundle';\nexport const main = built;\n");
    write(root, 'src/spectator.ts', 'export const spectator = 1;\n');
    ageWorkspace(root);

    expect(buildWorkspaceGraph(root).imports.map((edge) => edge.targetFile)).toEqual(['dist/bundle.ts']);

    remove(root, 'dist/bundle.ts');

    const after = expectIncrementalMatchesScratch(root);

    expect(after.imports).toEqual([]);
    // Only the file that looked into the blind spot pays; the spectator keeps its answer.
    expect(after.cache).toMatchObject({ unwatchableFiles: 1, resolvedFiles: 1 });
    expect(after.cache.reusedResolutions).toBe(1);
  });

  it('stops re-resolving a file once the blind spot it looked into is gone', () => {
    const root = createWorkspace();
    write(root, 'src/main.ts', "import { built } from '../dist/bundle';\nexport const main = built;\n");
    mkdirSync(join(root, 'dist'), { recursive: true });
    ageWorkspace(root);

    expect(buildWorkspaceGraph(root).cache.unwatchableFiles).toBe(0);
    // The flag is decided against the walk, so a second call is the first one that can
    // act on what the first one learned.
    expect(buildWorkspaceGraph(root).cache).toMatchObject({ unwatchableFiles: 1, resolvedFiles: 1 });

    rmSync(join(root, 'dist'), { recursive: true, force: true });

    // The directory is gone, so `dist/bundle.ts` is once again a path the walk would
    // report if it ever existed: the flag is re-derived against this walk and cleared,
    // and the file goes back to being watched — and reused — like any other.
    expect(expectIncrementalMatchesScratch(root).cache.unwatchableFiles).toBe(0);
    expect(buildWorkspaceGraph(root).cache).toMatchObject({ unwatchableFiles: 0, resolvedFiles: 0 });
  });

  it('keeps watching a specifier that fails inside a directory the walk simply has not got yet', () => {
    const root = createWorkspace();
    write(root, 'src/main.ts', "import { later } from './pending/mod';\nexport const main = later;\n");
    for (let index = 0; index < 12; index += 1) {
      write(root, `src/group/mod${index}.ts`, `export const mod${index} = ${index};\n`);
    }
    ageWorkspace(root);

    // A directory that does not exist is not a blind spot: the walk would report a file
    // arriving there, so nothing here has to be resolved twice.
    expect(buildWorkspaceGraph(root).cache.unwatchableFiles).toBe(0);
    expect(buildWorkspaceGraph(root).cache).toMatchObject({ unwatchableFiles: 0, resolvedFiles: 0 });

    write(root, 'src/pending/mod.ts', 'export const later = 1;\n');

    const after = expectIncrementalMatchesScratch(root);

    expect(after.imports.map((edge) => edge.targetFile)).toEqual(['src/pending/mod.ts']);
    expect(after.cache).toMatchObject({ unwatchableFiles: 0, invalidatedByProvenance: 1, resolvedFiles: 2 });
  });
});

/**
 * The seed this suite runs with. Every failure is therefore reproducible: put the seed
 * printed by a red run here and the same 200 mutations happen again in the same order.
 */
const MUTATION_SEED = 0x5eed_1a20;

/**
 * Every step of this test builds a 300-file workspace's graph twice, so it costs about
 * two thirds of a second — measured at 120 s for 200 steps on the machine it was
 * written on, which is most of `pnpm test` and uncomfortably close to a timeout on
 * slower hardware. The divergences this class of test finds show up in the first few
 * dozen steps (every one found while writing the engine did), so the suite runs a short
 * soak and `CODE_INTEL_MUTATION_STEPS` turns it into a long one on demand.
 */
const MUTATION_COUNT = Math.max(1, Number(process.env['CODE_INTEL_MUTATION_STEPS'] ?? 60));
/** Three seconds a step, so a machine three times slower than this one still finishes. */
const MUTATION_TIMEOUT_MS = Math.max(60_000, MUTATION_COUNT * 3_000);

/** mulberry32 — small, seeded, and stable across Node versions. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface GeneratedWorkspace {
  root: string;
  codeFiles: string[];
  assetFiles: string[];
}

/**
 * A workspace with the shapes that make resolution interesting: `paths` aliases, a
 * `baseUrl`, extensionless and directory imports, `.js`-spelled imports of `.ts` files,
 * co-located stylesheets and a handful of imports that name files nobody has written yet.
 */
function generateWorkspace(root: string, moduleCount: number): GeneratedWorkspace {
  const codeFiles: string[] = [];
  const assetFiles: string[] = [];

  write(
    root,
    'tsconfig.json',
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'], '#lib/*': ['src/lib/*'] } } })
  );

  const libCount = Math.floor(moduleCount / 3);
  for (let index = 0; index < libCount; index += 1) {
    const relativePath = `src/lib/mod${index}.ts`;
    write(root, relativePath, `export const lib${index} = ${index};\nexport type Lib${index} = { id: string };\n`);
    codeFiles.push(relativePath);
  }

  write(root, 'src/lib/index.ts', "export { lib0 } from './mod0';\n");
  codeFiles.push('src/lib/index.ts');

  for (let index = 0; index < 12; index += 1) {
    const relativePath = `src/assets/tile${index}.css`;
    write(root, relativePath, `.tile${index} { display: block; }\n`);
    assetFiles.push(relativePath);
  }

  const appCount = moduleCount - libCount - 1;
  for (let index = 0; index < appCount; index += 1) {
    const group = index % 8;
    const relativePath = `src/app/g${group}/c${index}.ts`;
    write(root, relativePath, appModuleSource(index, libCount));
    codeFiles.push(relativePath);
  }

  return { root, codeFiles, assetFiles };
}

/** One app module's imports, spread across every resolution shape that matters. */
function appModuleSource(index: number, libCount: number): string {
  const lib = index % Math.max(1, libCount);
  const sibling = (index + 8) % Math.max(1, libCount);
  const lines = [
    `import { lib${lib} } from '@/lib/mod${lib}';`,
    `import { lib${sibling} } from '#lib/mod${sibling}';`,
    `import { lib0 } from '../../lib';`
  ];

  // A `baseUrl`-shaped specifier is the expensive one — TypeScript walks every
  // `node_modules` up to the drive root before it settles — so a quarter of the modules
  // carry one, which is enough for a mutation to land on that shape and cheap enough to
  // rebuild three hundred files two hundred times.
  if (index % 4 === 0) {
    lines.push(`import { lib${lib} as aliased } from 'src/lib/mod${lib}.js';`);
  }

  if (index % 3 === 0) {
    lines.push(`import './c${index}.module.css';`);
  }
  if (index % 5 === 0) {
    lines.push(`import '@/assets/tile${index % 12}.css';`);
  }
  if (index % 7 === 0) {
    lines.push(`import './absent${index}.css';`);
  }
  if (index % 11 === 0) {
    lines.push(`export * from '@/lib/mod${(index + 3) % Math.max(1, libCount)}';`);
  }

  lines.push(`export const c${index} = lib${lib} + lib${sibling} + lib0;`);
  return `${lines.join('\n')}\n`;
}

describe('incremental invalidation under random mutation', () => {
  it(
    `answers exactly like a from-scratch build after every one of ${MUTATION_COUNT} random mutations`,
    { timeout: MUTATION_TIMEOUT_MS },
    () => {
      const root = createWorkspace();
      const workspace = generateWorkspace(root, 300);
      ageWorkspace(root);

      const random = createRandom(MUTATION_SEED);
      const pick = <T>(values: T[]): T | undefined =>
        values.length === 0 ? undefined : values[Math.floor(random() * values.length)];

      buildWorkspaceGraph(root, { includeAssets: true });

      let added = 0;
      for (let step = 0; step < MUTATION_COUNT; step += 1) {
        const roll = random();
        let mutation = 'none';

        if (roll < 0.2) {
          const relativePath = `src/app/g${step % 8}/added${step}.ts`;
          write(root, relativePath, appModuleSource(1000 + added, 100));
          workspace.codeFiles.push(relativePath);
          added += 1;
          mutation = `add ${relativePath}`;
        } else if (roll < 0.35) {
          const victim = pick(workspace.codeFiles);
          if (victim !== undefined) {
            remove(root, victim);
            workspace.codeFiles = workspace.codeFiles.filter((file) => file !== victim);
            mutation = `delete ${victim}`;
          }
        } else if (roll < 0.5) {
          const victim = pick(workspace.codeFiles);
          if (victim !== undefined) {
            const renamed = victim.replace(/\.ts$/, `-r${step}.ts`);
            renameSync(join(root, ...victim.split('/')), join(root, ...renamed.split('/')));
            workspace.codeFiles = workspace.codeFiles.filter((file) => file !== victim);
            workspace.codeFiles.push(renamed);
            mutation = `rename ${victim} -> ${renamed}`;
          }
        } else if (roll < 0.75) {
          const victim = pick(workspace.codeFiles);
          if (victim !== undefined) {
            write(root, victim, appModuleSource(step, 100));
            mutation = `edit ${victim}`;
          }
        } else if (roll < 0.87) {
          const relativePath = `src/assets/added${step}.css`;
          write(root, relativePath, `.added${step} {}\n`);
          workspace.assetFiles.push(relativePath);
          mutation = `add asset ${relativePath}`;
        } else {
          const victim = pick(workspace.assetFiles);
          if (victim !== undefined) {
            remove(root, victim);
            workspace.assetFiles = workspace.assetFiles.filter((file) => file !== victim);
            mutation = `delete asset ${victim}`;
          }
        }

        const incremental = buildWorkspaceGraph(root, { includeAssets: true });
        const scratch = withEmptyWorkspaceGraphCacheForTests(() => buildWorkspaceGraph(root, { includeAssets: true }));
        expect(
          comparable(incremental),
          `seed ${MUTATION_SEED}, step ${step}: ${mutation}`
        ).toEqual(comparable(scratch));
      }
    }
  );
});
