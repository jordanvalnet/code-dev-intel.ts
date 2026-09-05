import { describe, expect, it } from 'vitest';

import { extractModuleGraph } from '../../../services/indexer/src/module-graph-extractor.ts';

function importsOf(source: string, fileName = 'file.ts'): Record<string, string[]> {
  const facts = extractModuleGraph(fileName, source);
  const bySpecifier: Record<string, string[]> = {};
  for (const entry of facts.imports) {
    bySpecifier[entry.specifier] = entry.importedSymbols;
  }
  return bySpecifier;
}

function exportsOf(source: string, fileName = 'file.ts'): string[] {
  return extractModuleGraph(fileName, source).exports;
}

describe('extractModuleGraph imports', () => {
  it('covers every static import clause shape', () => {
    const imports = importsOf(
      [
        "import Default from './default';",
        "import { a, b as c } from './named';",
        "import * as ns from './namespace';",
        "import type { T } from './type-only';",
        "import { type A, B } from './inline-type';",
        "import './side-effect';",
        "import Both, { d } from './mixed';",
        "import Both2, * as all from './mixed-namespace';"
      ].join('\n')
    );

    expect(imports['./default']).toEqual(['default']);
    // Named bindings are recorded under the name the TARGET module exports.
    expect(imports['./named']).toEqual(['a', 'b']);
    expect(imports['./namespace']).toEqual(['*']);
    expect(imports['./type-only']).toEqual(['T']);
    expect(imports['./inline-type']).toEqual(['A', 'B']);
    expect(imports['./side-effect']).toEqual(['*']);
    expect(imports['./mixed']).toEqual(['default', 'd']);
    expect(imports['./mixed-namespace']).toEqual(['default', '*']);
  });

  it('covers every re-export form', () => {
    const imports = importsOf(
      [
        "export { x, y as z } from './list';",
        "export * from './star';",
        "export * as ns from './star-as';",
        "export type { T } from './type-list';"
      ].join('\n')
    );

    expect(imports['./list']).toEqual(['x', 'y']);
    expect(imports['./star']).toEqual(['*']);
    // `export * as ns from` is the form ts.preProcessFile missed entirely.
    expect(imports['./star-as']).toEqual(['*']);
    expect(imports['./type-list']).toEqual(['T']);
  });

  it('records which names a re-export republishes, and under which name', () => {
    const facts = extractModuleGraph(
      'file.ts',
      [
        "export { x, y as z } from './list';",
        "export * from './star';",
        "export * as ns from './star-as';",
        "import { plain } from './plain';",
        'export const used = plain;'
      ].join('\n')
    );

    const bySpecifier = new Map(facts.imports.map((entry) => [entry.specifier, entry.reExports]));

    expect(bySpecifier.get('./list')).toEqual([
      { source: 'x', exported: 'x' },
      { source: 'y', exported: 'z' }
    ]);
    // `export *` lets the target's own names through; `export * as ns` collapses the
    // whole module into one binding, so any change to it is a change to `ns`.
    expect(bySpecifier.get('./star')).toEqual([{ source: '*', exported: '*' }]);
    expect(bySpecifier.get('./star-as')).toEqual([{ source: '*', exported: 'ns' }]);
    // An ordinary import republishes nothing, which is what `undefined` says here.
    expect(bySpecifier.get('./plain')).toBeUndefined();
  });

  it('covers import-equals-require, dynamic import and require anywhere in the file', () => {
    const imports = importsOf(
      [
        "import legacy = require('./legacy');",
        'export class Loader {',
        '  async load() {',
        '    const inner = () => {',
        "      const sync = require('./sync-dep');",
        '      return sync;',
        '    };',
        "    const lazy = await import('./lazy-dep');",
        '    return [inner(), lazy];',
        '  }',
        '}',
        "const nested = { run: () => import('./deep-dep') };",
        'export const runner = nested;'
      ].join('\n')
    );

    expect(imports['./legacy']).toEqual(['*']);
    expect(imports['./sync-dep']).toEqual(['*']);
    expect(imports['./lazy-dep']).toEqual(['*']);
    expect(imports['./deep-dep']).toEqual(['*']);
  });

  it('reads imports inside declare module bodies', () => {
    const imports = importsOf(
      [
        "declare module 'virtual:generated' {",
        "  import { helper } from './helper';",
        "  export * from './re-exported';",
        '  export const value: typeof helper;',
        '}'
      ].join('\n')
    );

    expect(imports['./helper']).toEqual(['helper']);
    expect(imports['./re-exported']).toEqual(['*']);
  });

  it('reports non-literal dynamic specifiers instead of dropping them', () => {
    const facts = extractModuleGraph(
      'file.ts',
      [
        'const lang = "en";',
        'export const load = () => import(`./locales/${lang}.ts`);',
        'export const legacy = (name: string) => require(name);',
        "export const fine = () => import('./static-one');"
      ].join('\n')
    );

    expect(facts.imports.map((entry) => entry.specifier)).toEqual(['./static-one']);
    expect(facts.dynamicSpecifiers).toEqual(['`./locales/${lang}.ts`', 'name']);
  });

  it('treats a template literal without substitutions as a literal specifier', () => {
    const facts = extractModuleGraph('file.ts', 'export const load = () => import(`./plain`);');

    expect(facts.imports).toEqual([{ specifier: './plain', importedSymbols: ['*'] }]);
    expect(facts.dynamicSpecifiers).toEqual([]);
  });

  it('covers import() in type position, in every syntactic context', () => {
    const imports = importsOf(
      [
        "export type Payload = import('./type-alias').Payload;",
        "declare const declared: import('./declared').Thing;",
        "type Returned = () => import('./return-type').R;",
        "type Mapped = { [K in keyof import('./mapped').Shape]: string };",
        "type Generic = Array<import('./generic').Item>;",
        "declare const whole: typeof import('./typeof-import');",
        "declare module 'ambient' { const inner: import('./ambient-body').X; }",
        "declare global { interface Global { member: import('./global-body').P } }",
        "type Qualified = import('./qualified').Outer.Inner;",
        "type Bare = import('./bare');"
      ].join('\n')
    );

    // These are real edges: `tsc` follows every one of them, and a file that only ever
    // names its dependency in a type position is still a file that breaks when it moves.
    expect(imports['./type-alias']).toEqual(['Payload']);
    expect(imports['./declared']).toEqual(['Thing']);
    expect(imports['./return-type']).toEqual(['R']);
    expect(imports['./mapped']).toEqual(['Shape']);
    expect(imports['./generic']).toEqual(['Item']);
    // `typeof import(...)` depends on the module as a whole, as does a bare `import(...)`.
    expect(imports['./typeof-import']).toEqual(['*']);
    expect(imports['./ambient-body']).toEqual(['X']);
    expect(imports['./global-body']).toEqual(['P']);
    // `import('./q').Outer.Inner` is the export `Outer`, reached through its namespace.
    expect(imports['./qualified']).toEqual(['Outer']);
    expect(imports['./bare']).toEqual(['*']);
  });

  it('reports a non-literal type-position import instead of dropping it', () => {
    const facts = extractModuleGraph(
      'file.ts',
      ['type Locale = "en";', 'type Bundle = import(`./locales/${Locale}`).Messages;'].join('\n')
    );

    expect(facts.imports).toEqual([]);
    expect(facts.dynamicSpecifiers).toEqual(['`./locales/${Locale}`']);
  });

  it('reads import() types out of JSDoc in JavaScript, where they are the type system', () => {
    const jsImports = importsOf(
      [
        "/** @type {import('./typed').Config} */",
        'let config;',
        "/** @param {import('./param').Input} input */",
        'function handle(input) {',
        '  return input;',
        '}',
        "/** @returns {import('./returned').Result} */",
        'function make() {',
        '  return null;',
        '}'
      ].join('\n'),
      'file.js'
    );

    expect(jsImports['./typed']).toEqual(['Config']);
    expect(jsImports['./param']).toEqual(['Input']);
    expect(jsImports['./returned']).toEqual(['Result']);

    // In a .ts file the checker ignores JSDoc types, so following one would invent an
    // edge `tsc` does not have.
    const tsImports = importsOf(["/** @type {import('./doc-only').T} */", 'let value: number;'].join('\n'));
    expect(tsImports['./doc-only']).toBeUndefined();
  });

  it('parses .tsx as JSX so later statements are still seen', () => {
    const imports = importsOf(
      [
        "import { Widget } from './widget';",
        'export const View = () => <Widget prop={1 as unknown as number} />;',
        "export * from './after-jsx';"
      ].join('\n'),
      'view.tsx'
    );

    expect(imports['./widget']).toEqual(['Widget']);
    expect(imports['./after-jsx']).toEqual(['*']);
  });
});

describe('extractModuleGraph exports', () => {
  it('reads every exported declaration form off the AST', () => {
    const exported = exportsOf(
      [
        'export const constant = 1;',
        'export let mutable = 2;',
        'export var legacy = 3;',
        'export function fn() {}',
        'export class Cls {}',
        'export interface Iface {}',
        'export type Alias = string;',
        'export enum Enum { A }',
        'export namespace Space { export const inner = 1; }',
        'export const { destructured, renamed: alias } = { destructured: 1, renamed: 2 };',
        'export const [first, second] = [1, 2];',
        'export declare const ambient: number;'
      ].join('\n')
    );

    expect(exported).toEqual(
      expect.arrayContaining([
        'constant',
        'mutable',
        'legacy',
        'fn',
        'Cls',
        'Iface',
        'Alias',
        'Enum',
        'Space',
        'destructured',
        'alias',
        'first',
        'second',
        'ambient'
      ])
    );
    // A name exported only from inside a namespace is not a file export.
    expect(exported).not.toContain('inner');
  });

  it('reads export lists, defaults, export= and re-exports', () => {
    const exported = exportsOf(
      [
        'const local = 1;',
        'const other = 2;',
        'export { local, other as renamed };',
        "export { source as fromModule } from './source';",
        "export * as bundle from './bundle';",
        "export type { Ported } from './ported';",
        'export default function () {}'
      ].join('\n')
    );

    expect(exported).toEqual(
      expect.arrayContaining(['local', 'renamed', 'fromModule', 'bundle', 'Ported', 'default'])
    );
    // The alias is the exported name; the local name behind it is not exported.
    expect(exported).not.toContain('source');
  });

  it('records export = under the exported entity name', () => {
    expect(exportsOf('const handler = () => 1;\nexport = handler;\n')).toEqual(['handler']);
  });

  it('records a default-exported class or const under "default" only', () => {
    expect(exportsOf('export default class Widget {}\n')).toEqual(['default']);
    expect(exportsOf('const value = 1;\nexport default value;\n')).toEqual(['default']);
  });

  it('does not invent exports from comments, strings or namespace bodies', () => {
    const exported = exportsOf(
      [
        '// export const commentedOut = 1;',
        '/** @example export function docExample() {} */',
        "const sample = 'export const insideString = 1';",
        'namespace Internal { export const hidden = 1; }',
        "declare module 'ambient' { export const ambientMember: number; }",
        'export const real = sample;'
      ].join('\n')
    );

    expect(exported).toEqual(['real']);
  });

  it('does not report re-exported names it cannot know', () => {
    // `export * from` re-exports names that only the target module knows.
    expect(exportsOf("export * from './everything';\n")).toEqual([]);
  });
});
