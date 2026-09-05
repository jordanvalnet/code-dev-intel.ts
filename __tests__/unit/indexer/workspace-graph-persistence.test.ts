import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildWorkspaceGraph,
  getModuleFacts,
  resetWorkspaceGraphCacheForTests,
  type WorkspaceGraphResult
} from '../../../services/indexer/src/workspace-graph-cache.ts';
import {
  GRAPH_CACHE_SCHEMA_VERSION,
  graphCacheFilePath
} from '../../../services/indexer/src/workspace-graph-store.ts';
import { resetResolutionConfigCacheForTests } from '../../../services/indexer/src/import-resolver.ts';

const tempDirs: string[] = [];
let cacheDir = '';
const originalEnv = { dir: process.env['CODE_INTEL_CACHE_DIR'], mode: process.env['CODE_INTEL_GRAPH_CACHE'] };

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, relativePath: string, content: string): string {
  const absolutePath = join(root, ...relativePath.split('/'));
  mkdirSync(resolve(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, content, 'utf8');
  return absolutePath;
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

function comparable(graph: WorkspaceGraphResult): unknown {
  return {
    files: graph.files,
    imports: graph.imports,
    exportsByFile: graph.exportsByFile,
    unresolvedCount: graph.unresolvedCount,
    unresolvedSample: graph.unresolvedSample
  };
}

/** A workspace the way another process would have left it, plus that process's graph. */
function buildInFirstProcess(root: string): WorkspaceGraphResult {
  const graph = buildWorkspaceGraph(root);
  resetWorkspaceGraphCacheForTests();
  resetResolutionConfigCacheForTests();
  return graph;
}

function smallWorkspace(): string {
  const root = createTempDir('graph-persist-ws-');
  write(root, 'src/a.ts', 'export const a = 1;\n');
  write(root, 'src/b.ts', "import { a } from './a';\nexport const b = a;\n");
  write(root, 'src/c.ts', "export { b } from './b';\nimport './c.css';\n");
  write(root, 'src/c.css', '.c {}\n');
  ageWorkspace(root);
  return root;
}

beforeEach(() => {
  resetWorkspaceGraphCacheForTests();
  resetResolutionConfigCacheForTests();
  cacheDir = createTempDir('graph-persist-cache-');
  process.env['CODE_INTEL_CACHE_DIR'] = cacheDir;
  process.env['CODE_INTEL_GRAPH_CACHE'] = 'on';
});

afterEach(() => {
  resetWorkspaceGraphCacheForTests();
  resetResolutionConfigCacheForTests();
  if (originalEnv.dir === undefined) {
    delete process.env['CODE_INTEL_CACHE_DIR'];
  } else {
    process.env['CODE_INTEL_CACHE_DIR'] = originalEnv.dir;
  }
  if (originalEnv.mode === undefined) {
    delete process.env['CODE_INTEL_GRAPH_CACHE'];
  } else {
    process.env['CODE_INTEL_GRAPH_CACHE'] = originalEnv.mode;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('persisted workspace graph', () => {
  it('gives one file per workspace root a name that carries nothing about the workspace', () => {
    const first = graphCacheFilePath('/home/someone/private-project');
    const second = graphCacheFilePath('/home/someone/other-project');

    expect(first).not.toBe(second);
    expect(first.startsWith(cacheDir)).toBe(true);
    // The path a workspace lives at is nobody's business but the machine's: the file is
    // named by a digest, so a shared cache directory leaks no project names.
    expect(/^[0-9a-f]{64}\.json$/.test(first.slice(cacheDir.length + 1))).toBe(true);
  });

  it('answers the first call of a new process from the file the last one left', () => {
    const root = smallWorkspace();
    const first = buildInFirstProcess(root);

    expect(first.cache.persistedSave).toBe(true);
    expect(existsSync(graphCacheFilePath(root))).toBe(true);

    const second = buildWorkspaceGraph(root);

    expect(second.cache).toMatchObject({ persistedLoad: true, parsedFiles: 0, resolvedFiles: 0 });
    expect(second.cache.reusedParses).toBe(first.files.length);
    expect(comparable(second)).toEqual(comparable(first));
  });

  it('redoes only what moved between the two processes', () => {
    const root = smallWorkspace();
    buildInFirstProcess(root);

    write(root, 'src/b.ts', "import { a } from './a';\nexport const b = a + 1;\nexport const extra = 2;\n");
    write(root, 'src/d.ts', "import { b } from './b';\nexport const d = b;\n");

    const second = buildWorkspaceGraph(root);
    const scratch = (() => {
      resetWorkspaceGraphCacheForTests();
      process.env['CODE_INTEL_GRAPH_CACHE'] = 'off';
      const graph = buildWorkspaceGraph(root);
      process.env['CODE_INTEL_GRAPH_CACHE'] = 'on';
      return graph;
    })();

    expect(second.cache).toMatchObject({ persistedLoad: true, addedFiles: 1, modifiedFiles: 1, parsedFiles: 2 });
    expect(second.exportsByFile['src/b.ts']).toEqual(['b', 'extra']);
    expect(comparable(second)).toEqual(comparable(scratch));
  });

  it('never lets the file on disk overwrite a parse this process already read', () => {
    const root = createTempDir('graph-persist-ws-');
    write(root, 'src/a.ts', 'export const value = 1;\n');
    write(root, 'src/b.ts', 'export const value = 2;\n');
    const mainPath = write(root, 'src/main.ts', "import { value } from './a';\n");
    ageWorkspace(root);

    buildInFirstProcess(root);

    // The same byte length, and the stamp forced back to what the saved file records:
    // the walk has no way to tell this rewrite happened, and the saved parse is aged
    // past the freshness margin, so nothing but the in-process read knows the truth.
    const before = statSync(mainPath);
    writeFileSync(mainPath, "import { value } from './b';\n", 'utf8');
    utimesSync(mainPath, new Date(before.mtimeMs), new Date(before.mtimeMs));
    expect(statSync(mainPath).size).toBe(before.size);

    // A `dependencyGraph` read gets there first and parses the real file.
    expect(getModuleFacts(root, mainPath).imports.map((entry) => entry.specifier)).toEqual(['./b']);

    const graph = buildWorkspaceGraph(root);

    expect(graph.cache.persistedLoad).toBe(true);
    expect(graph.imports.map((edge) => `${edge.sourceFile} -> ${edge.targetFile}`)).toEqual([
      'src/main.ts -> src/b.ts'
    ]);
  });

  it('degrades to a cold build when the file on disk is corrupt', () => {
    const root = smallWorkspace();
    const first = buildInFirstProcess(root);

    writeFileSync(graphCacheFilePath(root), '{ this is not json', 'utf8');

    const second = buildWorkspaceGraph(root);

    expect(second.cache).toMatchObject({ persistedLoad: false, hit: false });
    expect(second.cache.parsedFiles).toBe(first.files.length);
    expect(comparable(second)).toEqual(comparable(first));
  });

  it('degrades to a cold build when the schema version moved', () => {
    const root = smallWorkspace();
    const first = buildInFirstProcess(root);

    const payload = JSON.parse(readFileSync(graphCacheFilePath(root), 'utf8')) as Record<string, unknown>;
    expect(payload['schemaVersion']).toBe(GRAPH_CACHE_SCHEMA_VERSION);
    payload['schemaVersion'] = GRAPH_CACHE_SCHEMA_VERSION + 1;
    writeFileSync(graphCacheFilePath(root), JSON.stringify(payload), 'utf8');

    const second = buildWorkspaceGraph(root);

    expect(second.cache).toMatchObject({ persistedLoad: false, hit: false });
    expect(comparable(second)).toEqual(comparable(first));
  });

  it('degrades to a cold build when the engine version moved', () => {
    const root = smallWorkspace();
    buildInFirstProcess(root);

    const payload = JSON.parse(readFileSync(graphCacheFilePath(root), 'utf8')) as Record<string, unknown>;
    payload['engineVersion'] = '0.0.0-not-this-build';
    writeFileSync(graphCacheFilePath(root), JSON.stringify(payload), 'utf8');

    expect(buildWorkspaceGraph(root).cache.persistedLoad).toBe(false);
  });

  it('degrades to a cold build when the file was written for another workspace', () => {
    const root = smallWorkspace();
    buildInFirstProcess(root);

    const payload = JSON.parse(readFileSync(graphCacheFilePath(root), 'utf8')) as Record<string, unknown>;
    payload['root'] = `${String(payload['root'])}-somewhere-else`;
    writeFileSync(graphCacheFilePath(root), JSON.stringify(payload), 'utf8');

    expect(buildWorkspaceGraph(root).cache.persistedLoad).toBe(false);
  });

  it('refuses a cache file that names a file outside the workspace', () => {
    const root = smallWorkspace();
    const first = buildInFirstProcess(root);

    const payload = JSON.parse(readFileSync(graphCacheFilePath(root), 'utf8')) as {
      files: Array<Record<string, unknown>>;
    };
    // A cache file is untrusted input: a planted entry must not be able to teach the
    // graph about a file the walk never saw, inside the workspace or out of it.
    payload.files[0] = { ...payload.files[0], path: '../../elsewhere/planted.ts' };
    writeFileSync(graphCacheFilePath(root), JSON.stringify(payload), 'utf8');

    const second = buildWorkspaceGraph(root);

    expect(second.cache.persistedLoad).toBe(false);
    expect(comparable(second)).toEqual(comparable(first));
  });

  it('refuses a cache file whose entries are the wrong shape', () => {
    const root = smallWorkspace();
    buildInFirstProcess(root);

    const payload = JSON.parse(readFileSync(graphCacheFilePath(root), 'utf8')) as {
      files: Array<Record<string, unknown>>;
    };
    payload.files[0] = { ...payload.files[0], facts: { imports: 'not-an-array', dynamicSpecifiers: [], exports: [] } };
    writeFileSync(graphCacheFilePath(root), JSON.stringify(payload), 'utf8');

    expect(buildWorkspaceGraph(root).cache.persistedLoad).toBe(false);
  });

  it('refuses an edge the cache file names and the walk does not report', () => {
    const root = smallWorkspace();
    const first = buildInFirstProcess(root);

    const payload = JSON.parse(readFileSync(graphCacheFilePath(root), 'utf8')) as {
      files: Array<{ path: string; resolved?: { edges: unknown[] } }>;
    };
    // Well-formed, workspace-relative, and about a file that is not there. Validation
    // cannot tell — only the walk can, and the walk is what settles it.
    const importer = payload.files.find((file) => file.path === 'src/b.ts');
    importer?.resolved?.edges.push({ targetFile: 'src/planted.ts', importedSymbols: ['planted'] });
    writeFileSync(graphCacheFilePath(root), JSON.stringify(payload), 'utf8');

    const second = buildWorkspaceGraph(root);

    expect(second.cache).toMatchObject({ persistedLoad: true, unwatchableFiles: 1, resolvedFiles: 1 });
    expect(second.imports.some((edge) => edge.targetFile === 'src/planted.ts')).toBe(false);
    expect(comparable(second)).toEqual(comparable(first));
  });

  it('sweeps cache files nothing has touched in a month, and temporary files left by a dead write', () => {
    const root = smallWorkspace();
    const stale = join(cacheDir, `${'a'.repeat(64)}.json`);
    const recent = join(cacheDir, `${'b'.repeat(64)}.json`);
    const deadWrite = join(cacheDir, `${'c'.repeat(64)}.json.4242.abcdef.tmp`);
    for (const [file, daysAgo] of [
      [stale, 40],
      [recent, 3],
      [deadWrite, 1]
    ] as const) {
      writeFileSync(file, '{}', 'utf8');
      const when = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
      utimesSync(file, when, when);
    }

    expect(buildWorkspaceGraph(root).cache.persistedSave).toBe(true);

    // A workspace nobody has indexed for a month is a workspace that has moved, been
    // deleted, or is not worth megabytes of the user's disk any more.
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(deadWrite)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(graphCacheFilePath(root))).toBe(true);
  });

  it('keeps the cache directory to a few dozen workspaces', () => {
    const root = smallWorkspace();
    for (let index = 0; index < 60; index += 1) {
      writeFileSync(join(cacheDir, `${index.toString(16).padStart(64, '0')}.json`), '{}', 'utf8');
    }

    buildWorkspaceGraph(root);

    const remaining = readdirSync(cacheDir);
    expect(remaining.length).toBeLessThanOrEqual(32);
    expect(remaining).toContain(graphCacheFilePath(root).slice(cacheDir.length + 1));
  });

  it('treats every ordinary spelling of no as off', () => {
    const root = smallWorkspace();

    for (const spelling of ['off', 'OFF', 'false', '0', 'no']) {
      resetWorkspaceGraphCacheForTests();
      resetResolutionConfigCacheForTests();
      process.env['CODE_INTEL_GRAPH_CACHE'] = spelling;

      expect(buildWorkspaceGraph(root).cache.persistedSave, spelling).toBe(false);
      expect(existsSync(graphCacheFilePath(root)), spelling).toBe(false);
    }

    resetWorkspaceGraphCacheForTests();
    process.env['CODE_INTEL_GRAPH_CACHE'] = 'on';
    expect(buildWorkspaceGraph(root).cache.persistedSave).toBe(true);
  });

  it('keeps answering when the cache directory cannot be written', () => {
    const root = smallWorkspace();
    const blocker = createTempDir('graph-persist-blocked-');
    const asFile = join(blocker, 'not-a-directory');
    writeFileSync(asFile, 'this is a file, not a directory\n', 'utf8');
    process.env['CODE_INTEL_CACHE_DIR'] = join(asFile, 'graph-cache');

    const graph = buildWorkspaceGraph(root);

    expect(graph.cache.persistedSave).toBe(false);
    expect(graph.files).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('writes and reads nothing at all when the persisted cache is switched off', () => {
    const root = smallWorkspace();
    process.env['CODE_INTEL_GRAPH_CACHE'] = 'off';

    const first = buildWorkspaceGraph(root);
    expect(first.cache.persistedSave).toBe(false);
    expect(existsSync(graphCacheFilePath(root))).toBe(false);

    resetWorkspaceGraphCacheForTests();
    expect(buildWorkspaceGraph(root).cache).toMatchObject({ persistedLoad: false, hit: false });
  });

  it('does not rewrite the file when nothing about the workspace changed', () => {
    const root = smallWorkspace();
    buildInFirstProcess(root);
    const firstBytes = readFileSync(graphCacheFilePath(root));

    const reloaded = buildWorkspaceGraph(root);
    expect(reloaded.cache.persistedSave).toBe(false);
    expect(readFileSync(graphCacheFilePath(root))).toEqual(firstBytes);
  });
});
