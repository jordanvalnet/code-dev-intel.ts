import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_INCLUDE_ASSETS } from '../../../services/indexer/src/asset-modules.ts';
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

    const { impactedFiles: impacted } = calculateWorkspaceImpactedFiles({
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

    const { impactedFiles: impacted } = calculateWorkspaceImpactedFiles({
      workspaceRoot: root,
      changedFiles: ['src/base.ts'],
      changedSymbolsByFile: {
        'src/base.ts': ['foo']
      }
    });

    expect(impacted).toEqual(['src/base.ts', 'src/uses-foo.ts']);
  });

  it('follows a changed symbol through a barrel and through a named re-export', () => {
    const root = createWorkspace();

    writeSourceFile(root, 'src/impl.ts', 'export const foo = 1;\nexport const bar = 2;\n');
    writeSourceFile(root, 'src/index.ts', "export * from './impl';\n");
    writeSourceFile(root, 'src/named.ts', "export { foo, bar as renamed } from './impl';\n");
    writeSourceFile(root, 'src/via-star.ts', "import { foo } from './index';\nexport const a = foo;\n");
    writeSourceFile(root, 'src/via-named.ts', "import { foo } from './named';\nexport const b = foo;\n");
    writeSourceFile(root, 'src/via-alias.ts', "import { renamed } from './named';\nexport const c = renamed;\n");

    const { impactedFiles: impacted } = calculateWorkspaceImpactedFiles({
      workspaceRoot: root,
      changedFiles: ['src/impl.ts'],
      changedSymbolsByFile: { 'src/impl.ts': ['foo'] }
    });

    // A re-export is transparent: `foo` arrives at the barrel's importers as `foo`, so
    // scoping a refactor on an alias/barrel codebase does not silently lose them.
    expect(impacted).toEqual([
      'src/impl.ts',
      'src/index.ts',
      'src/named.ts',
      'src/via-named.ts',
      'src/via-star.ts'
    ]);
    // `bar as renamed` republishes a symbol that did not change, so its consumer stays out.
    expect(impacted).not.toContain('src/via-alias.ts');
  });

  it('carries a change through an aliased re-export under the name the alias gives it', () => {
    const root = createWorkspace();

    writeSourceFile(root, 'src/impl.ts', 'export const foo = 1;\n');
    writeSourceFile(root, 'src/named.ts', "export { foo as publicFoo } from './impl';\n");
    writeSourceFile(root, 'src/consumer.ts', "import { publicFoo } from './named';\nexport const a = publicFoo;\n");

    const { impactedFiles: impacted } = calculateWorkspaceImpactedFiles({
      workspaceRoot: root,
      changedFiles: ['src/impl.ts'],
      changedSymbolsByFile: { 'src/impl.ts': ['foo'] }
    });

    expect(impacted).toEqual(['src/consumer.ts', 'src/impl.ts', 'src/named.ts']);
  });

  it('keeps the importers of a module whose exports it cannot read', () => {
    const root = createWorkspace();

    // `module.exports` is not a parse-tree export, so this module's export list is
    // empty. That is missing knowledge, not proof that nothing matches.
    writeSourceFile(root, 'src/legacy.cjs', 'module.exports = { baz: 1 };\n');
    writeSourceFile(root, 'src/consumer.ts', "import { baz } from './legacy.cjs';\nexport const value = baz;\n");

    const { impactedFiles: impacted } = calculateWorkspaceImpactedFiles({
      workspaceRoot: root,
      changedFiles: ['src/legacy.cjs'],
      changedSymbolsByFile: { 'src/legacy.cjs': ['baz'] }
    });

    expect(impacted).toEqual(['src/consumer.ts', 'src/legacy.cjs']);
  });

  it('handles import cycles without infinite traversal', () => {
    const root = createWorkspace();

    writeSourceFile(root, 'src/a.ts', "import { b } from './b';\nexport const a = b + 1;\n");
    writeSourceFile(root, 'src/b.ts', "import { a } from './a';\nexport const b = a + 1;\n");

    const { impactedFiles: impacted } = calculateWorkspaceImpactedFiles({
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

    const { impactedFiles: impacted } = calculateWorkspaceImpactedFiles({ workspaceRoot: root, changedFiles: ['src/domain/ports/Port.ts'] });
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

    const { impactedFiles: impacted } = calculateWorkspaceImpactedFiles({ workspaceRoot: root, changedFiles: ['src/util.ts'] });
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

describe('buildWorkspaceGraph edge targets', () => {
  it('never points an internal edge at a file the walk did not see', () => {
    const root = createWorkspace();

    writeSourceFile(root, 'src/notifications/Sender.ts', 'export const send = 1;\n');
    writeSourceFile(root, 'src/exact.ts', "import { send } from './notifications/Sender';\nexport const a = send;\n");
    writeSourceFile(root, 'src/mis-cased.ts', "import { send } from './notifications/sender';\nexport const b = send;\n");
    writeSourceFile(
      root,
      'src/mis-cased-directory.ts',
      "import { send } from './Notifications/Sender';\nexport const c = send;\n"
    );

    const graph = buildWorkspaceGraph(root);
    const walked = new Set(graph.files);

    // On a case-insensitive filesystem a mis-cased import compiles, runs, and used to
    // resolve to a path spelled the importer's way — a node no walk ever produced, so
    // the importer silently disappeared from every impact set.
    expect(graph.imports.filter((edge) => !walked.has(edge.targetFile))).toEqual([]);

    const { impactedFiles: impacted } = calculateWorkspaceImpactedFiles({
      workspaceRoot: root,
      changedFiles: ['src/notifications/Sender.ts']
    });

    for (const edge of graph.imports) {
      if (edge.targetFile === 'src/notifications/Sender.ts') {
        expect(impacted).toContain(edge.sourceFile);
      }
    }
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
    // The shape Prettier produces in a formatted codebase: the adapter that implements a
    // port imports its types across several lines, through a `paths` alias. Before the
    // scanner-based extractor these statements produced no edge at all, so the port's
    // implementers were missing from the impact set.
    const root = createWorkspace();

    writeSourceFile(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));
    writeSourceFile(
      root,
      'src/domain/ports/notification/NotificationPort.ts',
      [
        'export interface SendNotificationInput { id: string }',
        'export interface NotificationPort { send(input: SendNotificationInput): void }',
        ''
      ].join('\n')
    );
    writeSourceFile(
      root,
      'src/adapters/notification/EmailNotificationAdapter.ts',
      [
        'import type {',
        '  SendNotificationInput,',
        '  NotificationPort,',
        "} from '@/domain/ports/notification/NotificationPort';",
        '',
        'export class EmailNotificationAdapter implements NotificationPort {',
        '  send(input: SendNotificationInput): void {',
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
    expect(edge?.importedSymbols).toEqual(['SendNotificationInput', 'NotificationPort']);

    const { impactedFiles: impacted } = calculateWorkspaceImpactedFiles({
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

describe('buildWorkspaceGraph dependency-form coverage', () => {
  it('follows every import form the extractor understands', () => {
    const root = createWorkspace();

    writeSourceFile(root, 'src/star.ts', 'export const star = 1;\n');
    writeSourceFile(root, 'src/legacy.ts', 'export const legacy = 1;\n');
    writeSourceFile(root, 'src/lazy.ts', 'export const lazy = 1;\n');
    writeSourceFile(root, 'src/required.ts', 'export const required = 1;\n');
    writeSourceFile(root, 'src/ambient-target.ts', 'export const ambientTarget = 1;\n');
    writeSourceFile(
      root,
      'src/consumer.ts',
      [
        "export * as star from './star';",
        "import legacy = require('./legacy');",
        'export const load = async () => {',
        "  const lazy = await import('./lazy');",
        "  const required = require('./required');",
        '  return [legacy, lazy, required];',
        '};',
        "declare module 'virtual:ambient' {",
        "  export { ambientTarget } from './ambient-target';",
        '}',
        ''
      ].join('\n')
    );

    const graph = buildWorkspaceGraph(root);
    const targets = graph.imports
      .filter((edge) => edge.sourceFile === 'src/consumer.ts')
      .map((edge) => edge.targetFile)
      .sort();

    expect(targets).toEqual([
      'src/ambient-target.ts',
      'src/lazy.ts',
      'src/legacy.ts',
      'src/required.ts',
      'src/star.ts'
    ]);
  });

  it('links a dependency that is only ever named in a type position', () => {
    const root = createWorkspace();

    writeSourceFile(root, 'src/payload.ts', 'export interface Payload { id: string }\n');
    writeSourceFile(root, 'src/registry.ts', 'export const registry = 1;\n');
    writeSourceFile(root, 'src/settings.ts', 'export interface Settings { on: boolean }\n');
    writeSourceFile(root, 'src/documented.js', "/** @type {import('./settings').Settings} */\nexport let settings;\n");
    writeSourceFile(
      root,
      'src/consumer.ts',
      [
        "export type Echo = import('./payload').Payload;",
        "declare const whole: typeof import('./registry');",
        'export const value = whole;',
        ''
      ].join('\n')
    );

    const graph = buildWorkspaceGraph(root);
    const edges = graph.imports
      .filter((edge) => edge.sourceFile !== 'src/documented.js')
      .map((edge) => `${edge.sourceFile} -> ${edge.targetFile} [${edge.importedSymbols.join(',')}]`)
      .sort((left, right) => left.localeCompare(right));

    expect(edges).toEqual([
      'src/consumer.ts -> src/payload.ts [Payload]',
      'src/consumer.ts -> src/registry.ts [*]'
    ]);
    // JSDoc types are the type system of a JavaScript file, so `tsc` follows this one.
    expect(graph.imports).toContainEqual({
      sourceFile: 'src/documented.js',
      targetFile: 'src/settings.ts',
      importedSymbols: ['Settings']
    });
    expect(graph.unresolvedCount).toBe(0);

    const { impactedFiles: impacted } = calculateWorkspaceImpactedFiles({
      workspaceRoot: root,
      changedFiles: ['src/payload.ts'],
      changedSymbolsByFile: { 'src/payload.ts': ['Payload'] }
    });

    expect(impacted).toEqual(['src/consumer.ts', 'src/payload.ts']);
  });

  it('walks and links the .mts/.cts/.mjs/.cjs family', () => {
    const root = createWorkspace();

    writeSourceFile(root, 'src/esm.mts', 'export const esm = 1;\n');
    writeSourceFile(root, 'src/cjs.cts', 'export const cjs = 1;\n');
    writeSourceFile(root, 'src/plain.mjs', 'export const plain = 1;\n');
    writeSourceFile(root, 'src/legacy.cjs', 'export const legacy = 1;\n');
    writeSourceFile(
      root,
      'src/main.mts',
      [
        "import { esm } from './esm.mjs';",
        "import { cjs } from './cjs.cjs';",
        "import { plain } from './plain.mjs';",
        "import { legacy } from './legacy.cjs';",
        'export const all = [esm, cjs, plain, legacy];',
        ''
      ].join('\n')
    );

    const graph = buildWorkspaceGraph(root);

    expect(graph.files).toEqual(
      expect.arrayContaining(['src/cjs.cts', 'src/esm.mts', 'src/legacy.cjs', 'src/main.mts', 'src/plain.mjs'])
    );
    expect(graph.imports.map((edge) => edge.targetFile).sort()).toEqual([
      'src/cjs.cts',
      'src/esm.mts',
      'src/legacy.cjs',
      'src/plain.mjs'
    ]);

    const { impactedFiles } = calculateWorkspaceImpactedFiles({ workspaceRoot: root, changedFiles: ['src/esm.mts'] });
    expect(impactedFiles).toEqual(['src/esm.mts', 'src/main.mts']);
  });

  it('links a workspace package that is symlinked into node_modules', () => {
    const root = createWorkspace();

    writeSourceFile(
      root,
      'packages/ui-kit/package.json',
      JSON.stringify({ name: '@workspace/ui-kit', main: './src/index.ts' })
    );
    writeSourceFile(root, 'packages/ui-kit/src/index.ts', 'export const kit = 1;\n');
    mkdirSync(join(root, 'node_modules', '@workspace'), { recursive: true });
    symlinkSync(
      join(root, 'packages', 'ui-kit'),
      join(root, 'node_modules', '@workspace', 'ui-kit'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    writeSourceFile(root, 'src/main.ts', "import { kit } from '@workspace/ui-kit';\nexport const x = kit;\n");

    const graph = buildWorkspaceGraph(root);

    expect(graph.imports).toContainEqual({
      sourceFile: 'src/main.ts',
      targetFile: 'packages/ui-kit/src/index.ts',
      importedSymbols: ['kit']
    });
    expect(graph.unresolvedCount).toBe(0);
  });

  it('reads exports off the parse tree, not the source text', () => {
    const root = createWorkspace();

    writeSourceFile(
      root,
      'src/exports.ts',
      [
        '// export const commentedOut = 1;',
        "const sample = 'export const insideString = 1';",
        'namespace Internal { export const hidden = 1; }',
        'const local = 1;',
        'export { local as renamed };',
        'export const real = [sample, Internal.hidden];',
        'export default function () {}',
        ''
      ].join('\n')
    );

    const graph = buildWorkspaceGraph(root);

    expect((graph.exportsByFile['src/exports.ts'] ?? []).sort()).toEqual(['default', 'real', 'renamed']);
  });
});

describe('buildWorkspaceGraph unresolved reporting', () => {
  it('reports missing files and dynamic specifiers instead of dropping them', () => {
    const root = createWorkspace();

    writeSourceFile(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));
    writeSourceFile(root, 'src/present.ts', 'export const present = 1;\n');
    writeSourceFile(
      root,
      'src/main.ts',
      [
        "import { present } from './present';",
        "import { gone } from './deleted-file';",
        "import { alias } from '@/also-gone';",
        "import { join } from 'node:path';",
        "import { pkg } from 'some-package';",
        'const locale = "en";',
        'export const load = () => import(`./locales/${locale}.ts`);',
        'export const all = [present, gone, alias, join, pkg];',
        ''
      ].join('\n')
    );

    const graph = buildWorkspaceGraph(root);

    // The one edge that does resolve is still there.
    expect(graph.imports.map((edge) => edge.targetFile)).toEqual(['src/present.ts']);
    // A node builtin and an uninstalled package are dependencies, not breakages.
    expect(graph.unresolvedCount).toBe(3);
    expect(graph.unresolvedSample).toEqual([
      { from: 'src/main.ts', specifier: './deleted-file', reason: 'not-found' },
      { from: 'src/main.ts', specifier: '@/also-gone', reason: 'not-found' },
      { from: 'src/main.ts', specifier: '`./locales/${locale}.ts`', reason: 'dynamic-specifier' }
    ]);
  });

  it('separates a file it cannot read from a file that is not there', () => {
    const root = createWorkspace();

    writeSourceFile(root, 'src/Widget.vue', '<template />');
    writeSourceFile(root, 'src/main.ts', "import './Widget.vue';\nimport './Missing.vue';\nexport const app = 1;\n");

    const graph = buildWorkspaceGraph(root);

    expect(graph.unresolvedSample).toEqual([
      { from: 'src/main.ts', specifier: './Widget.vue', reason: 'unsupported-file-type' },
      { from: 'src/main.ts', specifier: './Missing.vue', reason: 'not-found' }
    ]);
    // A `.vue` file is never walked, so it is not a node of the graph either.
    expect(graph.files).toEqual(['src/main.ts']);
  });

  it('reports a specifier that escapes the workspace root', () => {
    const outside = createWorkspace();
    writeSourceFile(outside, 'secret.ts', 'export const secret = 1;\n');
    const root = createWorkspace();
    writeSourceFile(
      root,
      'src/main.ts',
      `import { secret } from '../../${basename(outside)}/secret';\nexport const x = secret;\n`
    );

    const graph = buildWorkspaceGraph(root);

    expect(graph.imports).toEqual([]);
    expect(graph.unresolvedCount).toBe(1);
    expect(graph.unresolvedSample[0]?.reason).toBe('outside-workspace');
  });

  it('counts every unresolved specifier but samples at most ten', () => {
    const root = createWorkspace();

    for (let index = 0; index < 12; index += 1) {
      writeSourceFile(root, `src/file${index}.ts`, `import { gone } from './missing${index}';\nexport const x = gone;\n`);
    }

    const graph = buildWorkspaceGraph(root);

    expect(graph.unresolvedCount).toBe(12);
    expect(graph.unresolvedSample).toHaveLength(10);
    expect(graph.unresolvedSample.every((entry) => entry.reason === 'not-found')).toBe(true);
  });

  it('counts one repeated broken import once', () => {
    const root = createWorkspace();

    writeSourceFile(
      root,
      'src/main.ts',
      ["import './missing';", "export const reload = () => import('./missing');", ''].join('\n')
    );

    const graph = buildWorkspaceGraph(root);

    expect(graph.unresolvedCount).toBe(1);
  });

  it('hands the unresolved report to calculateWorkspaceImpactedFiles callers', () => {
    const root = createWorkspace();

    writeSourceFile(root, 'src/core.ts', 'export const core = 1;\n');
    writeSourceFile(root, 'src/user.ts', "import { core } from './core';\nexport const user = core;\n");
    writeSourceFile(root, 'src/broken.ts', "import { gone } from './missing';\nexport const broken = gone;\n");

    const result = calculateWorkspaceImpactedFiles({ workspaceRoot: root, changedFiles: ['src/core.ts'] });

    expect(result.impactedFiles).toEqual(['src/core.ts', 'src/user.ts']);
    expect(result.unresolvedCount).toBe(1);
    expect(result.unresolvedSample).toEqual([
      { from: 'src/broken.ts', specifier: './missing', reason: 'not-found' }
    ]);
  });
});

describe('assets as graph leaves', () => {
  function writeAssetWorkspace(root: string): void {
    writeSourceFile(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@shared/*': ['src/shared/*'] } } }));
    writeSourceFile(root, 'src/shared/icons/logo.svg', '<svg></svg>');
    writeSourceFile(root, 'src/shared/copy/terms.md', '# Terms\n');
    writeSourceFile(root, 'src/widget/widget.module.css', '.widget {}');
    writeSourceFile(root, 'src/widget/data.json', '{ "a": 1 }');
    writeSourceFile(
      root,
      'src/widget/widget.ts',
      [
        "import styles from './widget.module.css';",
        "import data from './data.json';",
        "import logo from '@shared/icons/logo.svg?react';",
        "import doc from '@shared/copy/terms.md';",
        'export const widget = [styles, data, logo, doc];',
        ''
      ].join('\n')
    );
    writeSourceFile(root, 'src/widget/page.ts', "import { widget } from './widget';\nexport const page = widget;\n");
  }

  it('links every asset form when assets are included', () => {
    const root = createWorkspace();
    writeAssetWorkspace(root);

    const graph = buildWorkspaceGraph(root, { includeAssets: true });

    expect(
      graph.imports
        .filter((edge) => edge.sourceFile === 'src/widget/widget.ts')
        .map((edge) => edge.targetFile)
        .sort((left, right) => left.localeCompare(right))
    ).toEqual([
      'src/shared/copy/terms.md',
      'src/shared/icons/logo.svg',
      'src/widget/data.json',
      'src/widget/widget.module.css'
    ]);
    expect(graph.unresolvedCount).toBe(0);
  });

  it('never walks or parses an asset, so an asset is never an edge source', () => {
    const root = createWorkspace();
    writeAssetWorkspace(root);
    // A markdown file whose fenced example looks exactly like real code.
    writeSourceFile(root, 'docs/guide.md', "# Guide\n\n```ts\nimport { widget } from '../src/widget/widget';\n```\n");

    const graph = buildWorkspaceGraph(root, { includeAssets: true });

    expect(graph.files.some((filePath) => filePath.endsWith('.md'))).toBe(false);
    expect(graph.files.some((filePath) => filePath.endsWith('.css'))).toBe(false);
    expect(graph.imports.some((edge) => edge.sourceFile.endsWith('.md'))).toBe(false);
    expect(Object.keys(graph.exportsByFile).some((filePath) => filePath.endsWith('.json'))).toBe(false);
  });

  it('lists the code that imports a changed asset, transitively', () => {
    const root = createWorkspace();
    writeAssetWorkspace(root);

    const result = calculateWorkspaceImpactedFiles({
      workspaceRoot: root,
      changedFiles: ['src/widget/widget.module.css'],
      includeAssets: true
    });

    expect(result.impactedFiles).toEqual(['src/widget/page.ts', 'src/widget/widget.module.css', 'src/widget/widget.ts']);
  });

  it('propagates a changed asset even when a changed-symbol filter is in play', () => {
    const root = createWorkspace();
    writeAssetWorkspace(root);

    const result = calculateWorkspaceImpactedFiles({
      workspaceRoot: root,
      changedFiles: ['src/widget/widget.module.css'],
      changedSymbolsByFile: { 'src/widget/widget.ts': ['widget'] },
      includeAssets: true
    });

    // An asset has no exports, so the symbol filter has nothing to decide on and must
    // not silently drop the importers of a stylesheet that really did change.
    expect(result.impactedFiles).toEqual(['src/widget/page.ts', 'src/widget/widget.module.css', 'src/widget/widget.ts']);
  });

  it('drops asset specifiers entirely — edges and unresolved report — when assets are excluded', () => {
    const root = createWorkspace();
    writeAssetWorkspace(root);
    writeSourceFile(root, 'src/widget/broken.ts', "import './nowhere.css';\nexport const broken = 1;\n");

    const graph = buildWorkspaceGraph(root, { includeAssets: false });

    expect(graph.imports.map((edge) => `${edge.sourceFile} -> ${edge.targetFile}`)).toEqual([
      'src/widget/page.ts -> src/widget/widget.ts'
    ]);
    // Neither the resolved assets nor the broken one are reported: the caller asked for a
    // code graph, so an asset import is not a hole in the answer it requested.
    expect(graph.unresolvedCount).toBe(0);
    expect(graph.unresolvedSample).toEqual([]);
  });

  it('reports an asset import that names no file when assets are included', () => {
    const root = createWorkspace();
    writeAssetWorkspace(root);
    writeSourceFile(root, 'src/widget/broken.ts', "import './nowhere.css';\nexport const broken = 1;\n");

    const graph = buildWorkspaceGraph(root, { includeAssets: true });

    expect(graph.unresolvedSample).toEqual([
      { from: 'src/widget/broken.ts', specifier: './nowhere.css', reason: 'not-found' }
    ]);
  });

  it('uses the shipped default when no option is passed', () => {
    const root = createWorkspace();
    writeAssetWorkspace(root);

    const withDefault = buildWorkspaceGraph(root);
    const withExplicitDefault = buildWorkspaceGraph(root, { includeAssets: DEFAULT_INCLUDE_ASSETS });

    expect(withDefault.imports).toEqual(withExplicitDefault.imports);
    expect(withDefault.imports.some((edge) => edge.targetFile.endsWith('.css'))).toBe(DEFAULT_INCLUDE_ASSETS);
  });
});
