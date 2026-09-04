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
  it('skips hidden directories and nested git checkouts such as worktrees', () => {
    const root = createWorkspace();

    writeSourceFile(root, 'src/a.ts', 'export const a = 1;\n');
    writeSourceFile(root, '.claude/worktrees/feature/src/a.ts', 'export const a = 1;\n');
    writeSourceFile(root, '.worktrees/other/src/a.ts', 'export const a = 1;\n');
    writeSourceFile(root, 'vendor/checkout/.git/HEAD', 'ref: refs/heads/main\n');
    writeSourceFile(root, 'vendor/checkout/src/a.ts', 'export const a = 1;\n');
    writeSourceFile(root, 'vendor/plain/b.ts', 'export const b = 1;\n');

    const graph = buildWorkspaceGraph(root);

    expect(graph.files).toEqual(['src/a.ts', 'vendor/plain/b.ts']);
  });

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

  it('resolves tsconfig paths aliases into internal edges and propagates impact through them', () => {
    const root = createWorkspace();

    writeSourceFile(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));
    writeSourceFile(root, 'src/domain/ports/Port.ts', 'export interface Port {\n  run(): void;\n}\n');
    writeSourceFile(root, 'src/adapters/Adapter.ts', "import type { Port } from '@/domain/ports/Port';\nexport class Adapter implements Port {\n  run() {}\n}\n");
    writeSourceFile(root, 'src/app/main.ts', "import { Adapter } from '@/adapters/Adapter';\nimport { join } from 'node:path';\nexport const x = [new Adapter(), join('a', 'b')];\n");

    const graph = buildWorkspaceGraph(root);

    expect(graph.imports.map((edge) => `${edge.sourceFile} -> ${edge.targetFile}`).sort()).toEqual([
      'src/adapters/Adapter.ts -> src/domain/ports/Port.ts',
      'src/app/main.ts -> src/adapters/Adapter.ts'
    ]);

    const impacted = calculateWorkspaceImpactedFiles({ workspaceRoot: root, changedFiles: ['src/domain/ports/Port.ts'] });
    expect(impacted).toEqual(['src/adapters/Adapter.ts', 'src/app/main.ts', 'src/domain/ports/Port.ts']);
  });

  it('still builds the relative-import graph when tsconfig.json is malformed', () => {
    const root = createWorkspace();

    // A JSON syntax error in the workspace config must not fail the whole tool call.
    writeSourceFile(root, 'tsconfig.json', '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } ');
    writeSourceFile(root, 'src/util.ts', 'export const util = 1;\n');
    writeSourceFile(root, 'src/main.ts', "import { util } from './util.ts';\nimport { x } from '@/missing';\nexport const main = [util, x];\n");

    const graph = buildWorkspaceGraph(root);

    expect(graph.imports.map((edge) => `${edge.sourceFile} -> ${edge.targetFile}`)).toEqual([
      'src/main.ts -> src/util.ts'
    ]);

    const impacted = calculateWorkspaceImpactedFiles({ workspaceRoot: root, changedFiles: ['src/util.ts'] });
    expect(impacted).toEqual(['src/main.ts', 'src/util.ts']);
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

describe('buildWorkspaceGraph import extraction', () => {
  /**
   * Builds a two-file workspace and returns the symbols the consumer imports from
   * `src/lib.ts`, or `undefined` when no edge was extracted at all.
   */
  function symbolsImportedFromLib(consumerSource: string): string[] | undefined {
    const root = createWorkspace();

    writeSourceFile(root, 'src/lib.ts', 'export const a = 1;\nexport const b = 2;\n');
    writeSourceFile(root, 'src/consumer.ts', consumerSource);

    const graph = buildWorkspaceGraph(root);

    return graph.imports.find(
      (edge) => edge.sourceFile === 'src/consumer.ts' && edge.targetFile === 'src/lib.ts'
    )?.importedSymbols;
  }

  it('captures multi-line named imports', () => {
    const symbols = symbolsImportedFromLib(
      ['import {', '  A,', '  B,', "} from './lib';", 'export const x = [A, B];', ''].join('\n')
    );

    expect(symbols).toEqual(['A', 'B']);
  });

  it('captures multi-line type-only imports', () => {
    const symbols = symbolsImportedFromLib(
      ['import type {', '  A,', '  B,', "} from './lib';", 'export type X = A | B;', ''].join('\n')
    );

    expect(symbols).toEqual(['A', 'B']);
  });

  it('strips inline type modifiers from named imports', () => {
    const symbols = symbolsImportedFromLib("import { type A, B } from './lib';\nexport const x = B;\n");

    expect(symbols).toEqual(['A', 'B']);
  });

  it('captures a default import alongside named imports', () => {
    const symbols = symbolsImportedFromLib("import D, { A } from './lib';\nexport const x = [D, A];\n");

    expect(symbols).toEqual(['default', 'A']);
  });

  it('captures namespace imports as a wildcard', () => {
    const symbols = symbolsImportedFromLib("import * as ns from './lib';\nexport const x = ns;\n");

    expect(symbols).toEqual(['*']);
  });

  it('captures side-effect imports as a wildcard', () => {
    const symbols = symbolsImportedFromLib("import './lib';\nexport const x = 1;\n");

    expect(symbols).toEqual(['*']);
  });

  it('captures single-line re-exports under their source name', () => {
    const symbols = symbolsImportedFromLib("export { a, b as c } from './lib';\n");

    expect(symbols).toEqual(['a', 'b']);
  });

  it('captures multi-line re-exports', () => {
    const symbols = symbolsImportedFromLib(
      ['export {', '  a,', '  b as c,', "} from './lib';", ''].join('\n')
    );

    expect(symbols).toEqual(['a', 'b']);
  });

  it('captures star re-exports as a wildcard', () => {
    const symbols = symbolsImportedFromLib("export * from './lib';\n");

    expect(symbols).toEqual(['*']);
  });

  it('captures namespace re-exports as a wildcard', () => {
    const symbols = symbolsImportedFromLib("export * as ns from './lib';\n");

    expect(symbols).toEqual(['*']);
  });

  it('ignores import-looking text inside comments and string literals', () => {
    const symbols = symbolsImportedFromLib(
      [
        "// the adapter no longer does: import { a } from './lib'",
        '/**',
        " * Historically re-exported: export { a } from './lib'",
        ' */',
        'const note = "import { a } from \'./lib\'";',
        'export const x = note;',
        ''
      ].join('\n')
    );

    expect(symbols).toBeUndefined();
  });

  it('propagates impact through a multi-line type-only alias import', () => {
    // The shape Prettier produces in a real Next.js app: the adapter that implements a
    // port imports its types across several lines, through a `paths` alias. Before the
    // scanner-based extractor these statements produced no edge at all, so the port's
    // implementers were missing from the impact set.
    const root = createWorkspace();

    writeSourceFile(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));
    writeSourceFile(
      root,
      'src/domain/ports/notification/NotificationPort.ts',
      [
        'export interface DeleteNotificationInput { id: string }',
        'export interface NotificationPort { remove(input: DeleteNotificationInput): void }',
        ''
      ].join('\n')
    );
    writeSourceFile(
      root,
      'src/adapters/notification/EmailNotificationAdapter.ts',
      [
        'import type {',
        '  DeleteNotificationInput,',
        '  NotificationPort,',
        "} from '@/domain/ports/notification/NotificationPort';",
        '',
        'export class EmailNotificationAdapter implements NotificationPort {',
        '  remove(input: DeleteNotificationInput): void {',
        '    void input;',
        '  }',
        '}',
        ''
      ].join('\n')
    );

    const graph = buildWorkspaceGraph(root);
    const edge = graph.imports.find(
      (item) => item.sourceFile === 'src/adapters/notification/EmailNotificationAdapter.ts'
    );

    expect(edge?.targetFile).toBe('src/domain/ports/notification/NotificationPort.ts');
    expect(edge?.importedSymbols).toEqual(['DeleteNotificationInput', 'NotificationPort']);

    const impacted = calculateWorkspaceImpactedFiles({
      workspaceRoot: root,
      changedFiles: ['src/domain/ports/notification/NotificationPort.ts'],
      changedSymbolsByFile: {
        'src/domain/ports/notification/NotificationPort.ts': ['NotificationPort']
      }
    });

    expect(impacted).toEqual([
      'src/adapters/notification/EmailNotificationAdapter.ts',
      'src/domain/ports/notification/NotificationPort.ts'
    ]);
  });
});
