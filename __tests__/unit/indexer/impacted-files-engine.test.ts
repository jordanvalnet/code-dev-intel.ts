import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  calculateWorkspaceImpactedFiles,
  buildWorkspaceGraph,
  calculateImpactedFiles,
  type WorkspaceGraph
} from '../../../services/indexer/src/impacted-files-engine.ts';

const tempDirs: string[] = [];

function createWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'impacted-engine-'));
  tempDirs.push(root);
  return root;
}

function writeSourceFile(root: string, relativePath: string, content: string): void {
  const parts = relativePath.split('/');
  const fileName = parts.pop();
  if (!fileName) {
    throw new Error('Invalid file path');
  }

  const dirPath = join(root, ...parts);
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(join(dirPath, fileName), content, 'utf8');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('calculateWorkspaceImpactedFiles', () => {
  it('propagates impact transitively through importers', () => {
    const root = createWorkspace();

    writeSourceFile(root, 'src/a.ts', 'export function core() {\n  return 1;\n}\n');
    writeSourceFile(root, 'src/b.ts', "import { core } from './a';\nexport const b = core();\n");
    writeSourceFile(root, 'src/c.ts', "import { b } from './b';\nexport const c = b + 1;\n");

    const impacted = calculateWorkspaceImpactedFiles({
      workspaceRoot: root,
      changedFiles: ['src/a.ts']
    });

    expect(impacted).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('filters importers when changed symbols are provided', () => {
    const root = createWorkspace();

    writeSourceFile(root, 'src/base.ts', 'export const foo = 1;\nexport const bar = 2;\n');
    writeSourceFile(root, 'src/uses-foo.ts', "import { foo } from './base';\nexport const value = foo;\n");
    writeSourceFile(root, 'src/uses-bar.ts', "import { bar } from './base';\nexport const value = bar;\n");

    const impacted = calculateWorkspaceImpactedFiles({
      workspaceRoot: root,
      changedFiles: ['src/base.ts'],
      changedSymbolsByFile: {
        'src/base.ts': ['foo']
      }
    });

    expect(impacted).toEqual(['src/base.ts', 'src/uses-foo.ts']);
  });

  it('handles import cycles without infinite traversal', () => {
    const root = createWorkspace();

    writeSourceFile(root, 'src/a.ts', "import { b } from './b';\nexport const a = b + 1;\n");
    writeSourceFile(root, 'src/b.ts', "import { a } from './a';\nexport const b = a + 1;\n");

    const impacted = calculateWorkspaceImpactedFiles({
      workspaceRoot: root,
      changedFiles: ['src/a.ts']
    });

    expect(impacted).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('buildWorkspaceGraph', () => {
  it('discovers all source files excluding node_modules/dist/.git', () => {
    const root = createWorkspace();

    writeSourceFile(root, 'src/main.ts', 'export const main = 1;\n');
    writeSourceFile(root, 'src/utils.ts', 'export const util = 1;\n');
    writeSourceFile(root, 'node_modules/dep/index.ts', 'export const dep = 1;\n');
    writeSourceFile(root, 'dist/out.js', 'export const out = 1;\n');
    writeSourceFile(root, 'README.md', '# test\n');

    const graph = buildWorkspaceGraph(root);

    expect(graph.files).toContain('src/main.ts');
    expect(graph.files).toContain('src/utils.ts');
    expect(graph.files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(graph.files.some((f) => f.includes('dist'))).toBe(false);
    expect(graph.files.some((f) => f.endsWith('.md'))).toBe(false);
  });

  it('captures import edges between files', () => {
    const root = createWorkspace();

    writeSourceFile(root, 'src/a.ts', 'export const a = 1;\n');
    writeSourceFile(root, 'src/b.ts', "import { a } from './a';\nexport const b = a;\n");

    const graph = buildWorkspaceGraph(root);

    expect(graph.imports.length).toBe(1);
    expect(graph.imports[0]?.sourceFile).toBe('src/b.ts');
    expect(graph.imports[0]?.targetFile).toBe('src/a.ts');
    expect(graph.imports[0]?.importedSymbols).toEqual(['a']);
  });

  it('extracts exports from files', () => {
    const root = createWorkspace();

    writeSourceFile(
      root,
      'src/exports.ts',
      [
        'export const foo = 1;',
        'export function bar() {}',
        'export class Baz {}',
        'export interface Qux {}',
        'export type Quux = string;',
        'export enum Status { A, B }',
        'export default function() {}',
        ''
      ].join('\n')
    );

    const graph = buildWorkspaceGraph(root);
    const exports = graph.exportsByFile['src/exports.ts'] ?? [];

    expect(exports).toContain('foo');
    expect(exports).toContain('bar');
    expect(exports).toContain('Baz');
    expect(exports).toContain('Qux');
    expect(exports).toContain('Quux');
    expect(exports).toContain('Status');
    expect(exports).toContain('default');
  });

  it('ignores external (non-relative) imports', () => {
    const root = createWorkspace();

    writeSourceFile(root, 'src/app.ts', "import { join } from 'node:path';\nexport const x = join('a', 'b');\n");

    const graph = buildWorkspaceGraph(root);

    expect(graph.imports.length).toBe(0);
  });

  it('resolves index files when importing a directory', () => {
    const root = createWorkspace();

    writeSourceFile(root, 'src/utils/index.ts', 'export const util = 1;\n');
    writeSourceFile(root, 'src/main.ts', "import { util } from './utils';\nexport const x = util;\n");

    const graph = buildWorkspaceGraph(root);

    expect(graph.imports.length).toBe(1);
    expect(graph.imports[0]?.targetFile).toBe('src/utils/index.ts');
  });

  it('handles re-exports via export { ... } from syntax', () => {
    const root = createWorkspace();

    writeSourceFile(root, 'src/core.ts', 'export const core = 1;\n');
    writeSourceFile(root, 'src/barrel.ts', "export { core } from './core';\n");
    writeSourceFile(root, 'src/consumer.ts', "import { core } from './barrel';\nexport const val = core;\n");

    const graph = buildWorkspaceGraph(root);

    const barrelExports = graph.exportsByFile['src/barrel.ts'] ?? [];
    expect(barrelExports).toContain('core');
    expect(graph.imports.length).toBe(2);
  });

  it('parses aliased imports', () => {
    const root = createWorkspace();

    writeSourceFile(root, 'src/lib.ts', 'export const original = 1;\n');
    writeSourceFile(root, 'src/consumer.ts', "import { original as alias } from './lib';\nexport const x = alias;\n");

    const graph = buildWorkspaceGraph(root);

    expect(graph.imports[0]?.importedSymbols).toEqual(['original']);
  });

  it('parses star imports', () => {
    const root = createWorkspace();

    writeSourceFile(root, 'src/lib.ts', 'export const a = 1;\nexport const b = 2;\n');
    writeSourceFile(root, 'src/consumer.ts', "import * as lib from './lib';\nexport const x = lib.a;\n");

    const graph = buildWorkspaceGraph(root);

    expect(graph.imports[0]?.importedSymbols).toEqual(['*']);
  });
});

describe('calculateImpactedFiles with synthetic graph', () => {
  it('marks star importers as impacted even with symbol filtering', () => {
    const graph: WorkspaceGraph = {
      files: ['a.ts', 'b.ts'],
      imports: [{ sourceFile: 'b.ts', targetFile: 'a.ts', importedSymbols: ['*'] }],
      exportsByFile: { 'a.ts': ['foo', 'bar'] }
    };

    const impacted = calculateImpactedFiles({
      graph,
      changedFiles: ['a.ts'],
      changedSymbolsByFile: { 'a.ts': ['foo'] }
    });

    expect(impacted).toContain('b.ts');
  });

  it('isolates files with no import relationship', () => {
    const graph: WorkspaceGraph = {
      files: ['a.ts', 'b.ts', 'c.ts'],
      imports: [{ sourceFile: 'b.ts', targetFile: 'a.ts', importedSymbols: ['x'] }],
      exportsByFile: { 'a.ts': ['x'] }
    };

    const impacted = calculateImpactedFiles({
      graph,
      changedFiles: ['a.ts']
    });

    expect(impacted).toContain('a.ts');
    expect(impacted).toContain('b.ts');
    expect(impacted).not.toContain('c.ts');
  });

  it('skips importers whose imported symbols do not overlap with changed symbols', () => {
    const graph: WorkspaceGraph = {
      files: ['lib.ts', 'foo-user.ts', 'bar-user.ts'],
      imports: [
        { sourceFile: 'foo-user.ts', targetFile: 'lib.ts', importedSymbols: ['foo'] },
        { sourceFile: 'bar-user.ts', targetFile: 'lib.ts', importedSymbols: ['bar'] }
      ],
      exportsByFile: { 'lib.ts': ['foo', 'bar'] }
    };

    const impacted = calculateImpactedFiles({
      graph,
      changedFiles: ['lib.ts'],
      changedSymbolsByFile: { 'lib.ts': ['bar'] }
    });

    expect(impacted).toContain('lib.ts');
    expect(impacted).toContain('bar-user.ts');
    expect(impacted).not.toContain('foo-user.ts');
  });

  it('handles diamond dependency: A->B, A->C, B->D, C->D', () => {
    const graph: WorkspaceGraph = {
      files: ['d.ts', 'b.ts', 'c.ts', 'a.ts'],
      imports: [
        { sourceFile: 'b.ts', targetFile: 'd.ts', importedSymbols: ['x'] },
        { sourceFile: 'c.ts', targetFile: 'd.ts', importedSymbols: ['x'] },
        { sourceFile: 'a.ts', targetFile: 'b.ts', importedSymbols: ['y'] },
        { sourceFile: 'a.ts', targetFile: 'c.ts', importedSymbols: ['z'] }
      ],
      exportsByFile: { 'd.ts': ['x'], 'b.ts': ['y'], 'c.ts': ['z'] }
    };

    const impacted = calculateImpactedFiles({
      graph,
      changedFiles: ['d.ts']
    });

    expect(impacted).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
  });

  it('returns only the changed file when it has no importers', () => {
    const graph: WorkspaceGraph = {
      files: ['leaf.ts', 'other.ts'],
      imports: [],
      exportsByFile: {}
    };

    const impacted = calculateImpactedFiles({
      graph,
      changedFiles: ['leaf.ts']
    });

    expect(impacted).toEqual(['leaf.ts']);
  });
});
