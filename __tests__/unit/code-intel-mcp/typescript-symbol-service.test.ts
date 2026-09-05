import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  getDependencyGraph,
  getFileOutline,
  getSymbolContent,
  findDefinitionsBySymbol,
  findImplementationsBySymbol,
  findReferencesBySymbol
} from '../../../services/code-intel-mcp/src/typescript-symbol-service.ts';
import { buildWorkspaceGraph } from '../../../services/indexer/src/impacted-files-engine.ts';

const fixtureRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/self-test-workspace');

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('typescript-symbol-service', () => {
  it('finds definition across files', () => {
    const result = findDefinitionsBySymbol(fixtureRoot, 'src/usage.ts', 'buildGreeting');

    expect(result.count).toBeGreaterThan(0);
    expect(Object.keys(result.byFile)).toContain('src/definitions.ts');
  });

  it('finds references in usage and definition files', () => {
    const result = findReferencesBySymbol(fixtureRoot, 'src/usage.ts', 'buildGreeting');

    const filePaths = new Set(Object.keys(result.byFile));
    expect(filePaths.has('src/usage.ts')).toBe(true);
    expect(filePaths.has('src/definitions.ts')).toBe(true);
  });

  it('finds class implementations of an interface symbol', () => {
    const result = findImplementationsBySymbol(fixtureRoot, 'src/contract.ts', 'GreetingContract');

    const filePaths = new Set(Object.keys(result.byFile));
    expect(filePaths.has('src/greeting-implementation.ts')).toBe(true);
  });

  it('returns rich outline metadata and supports kind filters', () => {
    const fullOutline = getFileOutline(fixtureRoot, 'src/definitions.ts');

    expect(fullOutline.appliedKinds).toEqual([]);
    expect(fullOutline.symbolsByKind.function).toBeDefined();

    const functionSymbol = fullOutline.symbolsByKind.function?.find((item) => item.name === 'buildGreeting');
    expect(functionSymbol?.signature).toBe('function buildGreeting(name: string): string');
    expect('kind' in (functionSymbol ?? {})).toBe(false);
    expect('filePath' in (functionSymbol ?? {})).toBe(false);

    const filteredOutline = getFileOutline(fixtureRoot, 'src/definitions.ts', {
      symbolKinds: ['function']
    });

    expect(filteredOutline.appliedKinds).toEqual(['function']);
    expect(Object.keys(filteredOutline.symbolsByKind)).toEqual(['function']);
    expect(filteredOutline.symbolsByKind.function?.length).toBeGreaterThan(0);
  });

  it('builds dependency graph with transitive and external dependencies', () => {
    const result = getDependencyGraph(fixtureRoot, 'src/dep-level2.ts', {
      maxDepth: 3,
      includeExternal: true
    });

    expect(result.rootFilePath).toBe('src/dep-level2.ts');
    expect(result.maxDepth).toBe(3);
    expect(result.dependencies).toContain('src/dep-level1.ts');
    expect(result.dependencies).toContain('src/definitions.ts');
    expect(result.externalDependencies).toContain('node:path');
    expect(result.edges.some((edge) => edge.from === 'src/dep-level2.ts' && edge.to === 'src/dep-level1.ts')).toBe(
      true
    );
  });

  it('dependency graph resolves tsconfig paths aliases as internal dependencies', () => {
    const root = mkdtempSync(join(tmpdir(), 'dev-intel-dependency-graph-alias-'));
    tempDirs.push(root);
    const write = (relativePath: string, content: string): void => {
      const absolutePath = join(root, ...relativePath.split('/'));
      mkdirSync(resolve(absolutePath, '..'), { recursive: true });
      writeFileSync(absolutePath, content, 'utf8');
    };
    write('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }));
    write('src/domain/ports/Port.ts', 'export interface Port {\n  run(): void;\n}\n');
    write('src/adapters/Adapter.ts', "import type { Port } from '@/domain/ports/Port';\nimport { join } from 'node:path';\nexport class Adapter implements Port {\n  run() {\n    join('a', 'b');\n  }\n}\n");
    write('src/app/main.ts', "import { Adapter } from '@/adapters/Adapter';\nexport const adapter = new Adapter();\n");

    const result = getDependencyGraph(root, 'src/app/main.ts', { maxDepth: 3, includeExternal: true });

    expect(result.dependencies).toEqual(['src/adapters/Adapter.ts', 'src/domain/ports/Port.ts']);
    expect(result.externalDependencies).toEqual(['node:path']);
    expect(result.edges).toContainEqual({ from: 'src/app/main.ts', to: 'src/adapters/Adapter.ts', kind: 'internal' });
    expect(result.edges).toContainEqual({ from: 'src/adapters/Adapter.ts', to: 'src/domain/ports/Port.ts', kind: 'internal' });
  });

  describe('symbol-anchor resolution (regression: bugs #2 + #3)', () => {
    it('findDefinitions anchors on the declaration even when the symbol first appears in a comment', () => {
      const result = findDefinitionsBySymbol(fixtureRoot, 'src/symbol-anchor.ts', 'targetSymbol');

      expect(result.count).toBeGreaterThan(0);
      const positions = result.byFile['src/symbol-anchor.ts'];
      expect(positions).toBeDefined();
      const declarationLine = Number(positions?.[0]?.split(':')[0]);
      expect(declarationLine).toBeGreaterThanOrEqual(10);
    });

    it('findReferences includes the local declaration and the cross-file consumer', () => {
      const result = findReferencesBySymbol(fixtureRoot, 'src/symbol-anchor.ts', 'targetSymbol');
      const filePaths = new Set(Object.keys(result.byFile));
      expect(filePaths.has('src/symbol-anchor.ts')).toBe(true);
      expect(filePaths.has('src/symbol-anchor-usage.ts')).toBe(true);
    });

    it('findReferences excludes node_modules and *.d.ts results by default', () => {
      const result = findReferencesBySymbol(fixtureRoot, 'src/symbol-anchor.ts', 'targetSymbol');
      for (const filePath of Object.keys(result.byFile)) {
        expect(filePath.includes('node_modules')).toBe(false);
        expect(filePath.endsWith('.d.ts')).toBe(false);
      }
    });

    it('getSymbolContent returns the declaration content even when the symbol first appears in a comment', () => {
      const result = getSymbolContent(fixtureRoot, 'src/symbol-anchor.ts', 'targetSymbol');
      expect(result.declarationFilePath).toBe('src/symbol-anchor.ts');
      expect(result.content).toContain('export function targetSymbol');
      expect(result.startLine).toBeGreaterThanOrEqual(10);
    });
  });

  describe('getFileOutline summaryOnly option (bug #1)', () => {
    it('omits the signature field when summaryOnly is true', () => {
      const result = getFileOutline(fixtureRoot, 'src/definitions.ts', { summaryOnly: true });
      const allItems = Object.values(result.symbolsByKind).flat();
      expect(allItems.length).toBeGreaterThan(0);
      for (const item of allItems) {
        expect(item.signature).toBeUndefined();
      }
    });

    it('includes the signature field when summaryOnly is omitted', () => {
      const result = getFileOutline(fixtureRoot, 'src/definitions.ts');
      const functionItems = result.symbolsByKind.function ?? [];
      expect(functionItems.length).toBeGreaterThan(0);
      expect(functionItems.some((item) => typeof item.signature === 'string' && item.signature.length > 0)).toBe(true);
    });
  });

  describe('getSymbolContent maxLines truncation (bug #2 follow-up)', () => {
    it('truncates content when maxLines is exceeded and exposes truncation metadata', () => {
      const result = getSymbolContent(fixtureRoot, 'src/large-symbol.ts', 'largeSymbol', { maxLines: 5 });
      expect(result.truncated).toBe(true);
      expect(typeof result.truncatedAtLine).toBe('number');
      const lineCount = result.content.split('\n').length;
      expect(lineCount).toBeLessThanOrEqual(6);
    });

    it('returns the full content when the declaration fits inside maxLines', () => {
      const result = getSymbolContent(fixtureRoot, 'src/large-symbol.ts', 'largeSymbol', { maxLines: 1000 });
      expect(result.truncated).toBe(false);
      expect(result.truncatedAtLine).toBeUndefined();
      expect(result.content).toContain('field20');
    });
  });
});

/** Writes a throwaway workspace from a `path -> content` map and returns its root. */
function createGraphWorkspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'dev-intel-dep-graph-'));
  tempDirs.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(root, ...relativePath.split('/'));
    mkdirSync(resolve(absolutePath, '..'), { recursive: true });
    writeFileSync(absolutePath, content, 'utf8');
  }
  return root;
}

describe('getDependencyGraph dependency-form coverage', () => {
  it('follows export * as ns, import = require, dynamic import and require', () => {
    const root = createGraphWorkspace({
      'src/star.ts': 'export const star = 1;\n',
      'src/legacy.ts': 'export const legacy = 1;\n',
      'src/lazy.ts': 'export const lazy = 1;\n',
      'src/required.ts': 'export const required = 1;\n',
      'src/main.ts': [
        "export * as star from './star';",
        "import legacy = require('./legacy');",
        'export const load = async () => {',
        "  const lazy = await import('./lazy');",
        "  const required = require('./required');",
        '  return [legacy, lazy, required];',
        '};',
        ''
      ].join('\n')
    });

    const result = getDependencyGraph(root, 'src/main.ts');

    expect(result.dependencies).toEqual(['src/lazy.ts', 'src/legacy.ts', 'src/required.ts', 'src/star.ts']);
    expect(result.unresolvedCount).toBe(0);
  });

  it('follows import() written in a type position, and through JSDoc in JavaScript', () => {
    const root = createGraphWorkspace({
      'src/payload.ts': 'export interface Payload { id: string }\n',
      'src/registry.ts': 'export const registry = 1;\n',
      'src/settings.ts': 'export interface Settings { on: boolean }\n',
      'src/documented.js': "/** @type {import('./settings').Settings} */\nexport let settings;\n",
      'src/main.ts': [
        "export type Echo = import('./payload').Payload;",
        "declare const whole: typeof import('./registry');",
        "import './documented.js';",
        'export const value = whole;',
        ''
      ].join('\n')
    });

    const result = getDependencyGraph(root, 'src/main.ts');

    // A dependency named only in a type position is still a dependency: it moves when
    // the target moves, and the file has to be re-checked when the target changes.
    expect(result.dependencies).toEqual([
      'src/documented.js',
      'src/payload.ts',
      'src/registry.ts',
      'src/settings.ts'
    ]);
    expect(result.unresolvedCount).toBe(0);
  });

  it('reports the same internal edges as the workspace graph for the same files', () => {
    const root = createGraphWorkspace({
      'src/port.ts': 'export interface Port { run(): void }\n',
      'src/adapter.ts': [
        "import type { Port } from './port';",
        "export * as portNamespace from './port';",
        'export class Adapter implements Port { run() {} }',
        ''
      ].join('\n'),
      'src/main.ts': "import { Adapter } from './adapter';\nexport const app = new Adapter();\n"
    });

    const graphResult = getDependencyGraph(root, 'src/main.ts');
    const workspaceGraph = buildWorkspaceGraph(root);

    const fromDependencyGraph = [
      ...new Set(
        graphResult.edges.filter((edge) => edge.kind === 'internal').map((edge) => `${edge.from} -> ${edge.to}`)
      )
    ].sort();
    const fromWorkspaceGraph = [
      ...new Set(workspaceGraph.imports.map((edge) => `${edge.sourceFile} -> ${edge.targetFile}`))
    ].sort();

    expect(fromDependencyGraph).toEqual(fromWorkspaceGraph);
    expect(fromDependencyGraph).toEqual(['src/adapter.ts -> src/port.ts', 'src/main.ts -> src/adapter.ts']);
  });

  it('resolves a workspace package symlinked into node_modules as an internal dependency', () => {
    const root = createGraphWorkspace({
      'packages/ui-kit/package.json': JSON.stringify({ name: '@workspace/ui-kit', main: './src/index.ts' }),
      'packages/ui-kit/src/index.ts': 'export const kit = 1;\n',
      'src/main.ts': "import { kit } from '@workspace/ui-kit';\nexport const x = kit;\n"
    });
    mkdirSync(join(root, 'node_modules', '@workspace'), { recursive: true });
    symlinkSync(
      join(root, 'packages', 'ui-kit'),
      join(root, 'node_modules', '@workspace', 'ui-kit'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    const result = getDependencyGraph(root, 'src/main.ts', { includeExternal: true });

    expect(result.dependencies).toEqual(['packages/ui-kit/src/index.ts']);
    expect(result.externalDependencies).toEqual([]);
  });
});

describe('getDependencyGraph unresolved reporting', () => {
  it('reports what it could not follow, and keeps packages and builtins out of it', () => {
    const root = createGraphWorkspace({
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
      'src/present.ts': 'export const present = 1;\n',
      'src/main.ts': [
        "import { present } from './present';",
        "import { gone } from './deleted-file';",
        "import { alias } from '@/also-gone';",
        "import { join } from 'node:path';",
        "import { pkg } from 'never-installed-package';",
        'const locale = "en";',
        'export const load = () => import(`./locales/${locale}.ts`);',
        'export const all = [present, gone, alias, join, pkg];',
        ''
      ].join('\n')
    });

    const result = getDependencyGraph(root, 'src/main.ts', { includeExternal: true });

    expect(result.dependencies).toEqual(['src/present.ts']);
    expect(result.externalDependencies).toEqual(['never-installed-package', 'node:path']);
    expect(result.unresolvedCount).toBe(3);
    expect(result.unresolved).toEqual([
      { from: 'src/main.ts', specifier: './deleted-file', reason: 'not-found' },
      { from: 'src/main.ts', specifier: '@/also-gone', reason: 'not-found' },
      { from: 'src/main.ts', specifier: '`./locales/${locale}.ts`', reason: 'dynamic-specifier' }
    ]);
  });

  it('separates a file it cannot read from a file that is not there', () => {
    const root = createGraphWorkspace({
      'src/Widget.vue': '<template />',
      'src/main.ts': [
        "import './Widget.vue';",
        "import './Missing.vue';",
        'export const app = 1;',
        ''
      ].join('\n')
    });

    const result = getDependencyGraph(root, 'src/main.ts');

    // `Widget.vue` is right there. Calling it not-found would be a false statement, and
    // on a component-per-file codebase it would bury the real breakage next to it.
    expect(result.unresolved).toEqual([
      { from: 'src/main.ts', specifier: './Widget.vue', reason: 'unsupported-file-type' },
      { from: 'src/main.ts', specifier: './Missing.vue', reason: 'not-found' }
    ]);
    expect(result.unresolvedCount).toBe(2);
  });

  it('reports a specifier that escapes the workspace root instead of following it', () => {
    const outside = mkdtempSync(join(tmpdir(), 'dev-intel-dep-outside-'));
    tempDirs.push(outside);
    writeFileSync(join(outside, 'secret.ts'), 'export const secret = 1;\n', 'utf8');
    const specifier = `../../${basename(outside)}/secret`;
    const root = createGraphWorkspace({
      'src/main.ts': `import { secret } from '${specifier}';\nexport const x = secret;\n`
    });

    const result = getDependencyGraph(root, 'src/main.ts');

    expect(result.dependencies).toEqual([]);
    expect(result.unresolved).toEqual([{ from: 'src/main.ts', specifier, reason: 'outside-workspace' }]);
  });

  it('counts every unresolved specifier but lists at most twenty', () => {
    const lines = Array.from({ length: 25 }, (_, index) => `import { gone${index} } from './missing${index}';`);
    lines.push(`export const all = [${Array.from({ length: 25 }, (_, index) => `gone${index}`).join(', ')}];`);
    const root = createGraphWorkspace({ 'src/main.ts': `${lines.join('\n')}\n` });

    const result = getDependencyGraph(root, 'src/main.ts');

    expect(result.unresolvedCount).toBe(25);
    expect(result.unresolved).toHaveLength(20);
  });

  it('reports unresolved specifiers found deeper in the traversal', () => {
    const root = createGraphWorkspace({
      'src/main.ts': "import { level1 } from './level1';\nexport const x = level1;\n",
      'src/level1.ts': "import { gone } from './missing';\nexport const level1 = gone;\n"
    });

    const result = getDependencyGraph(root, 'src/main.ts');

    expect(result.dependencies).toEqual(['src/level1.ts']);
    expect(result.unresolved).toEqual([{ from: 'src/level1.ts', specifier: './missing', reason: 'not-found' }]);
  });

  it('lists imported assets as dependencies and never expands them', () => {
    const root = createGraphWorkspace({
      'src/main.ts': "import './widget.module.css';\nimport { widget } from './widget';\nexport const main = widget;\n",
      'src/widget.ts': "import logo from './logo.svg?react';\nexport const widget = logo;\n",
      'src/widget.module.css': ".widget { background: url('./logo.svg'); }",
      'src/logo.svg': '<svg></svg>'
    });

    const result = getDependencyGraph(root, 'src/main.ts', { includeAssets: true });

    expect(result.dependencies).toEqual(['src/logo.svg', 'src/widget.module.css', 'src/widget.ts']);
    expect(result.unresolvedCount).toBe(0);
    // The stylesheet is a leaf: nothing is ever read out of it, so it has no outgoing edge.
    expect(result.edges.some((edge) => edge.from.endsWith('.css'))).toBe(false);
    expect(result.edges.filter((edge) => edge.to === 'src/logo.svg')).toEqual([
      { from: 'src/widget.ts', to: 'src/logo.svg', kind: 'internal' }
    ]);
  });

  it('leaves asset specifiers out of both the graph and the unresolved report when excluded', () => {
    const root = createGraphWorkspace({
      'src/main.ts': "import './widget.module.css';\nimport './nowhere.css';\nimport { widget } from './widget';\nexport const main = widget;\n",
      'src/widget.ts': 'export const widget = 1;\n',
      'src/widget.module.css': '.widget {}'
    });

    const result = getDependencyGraph(root, 'src/main.ts', { includeAssets: false });

    expect(result.dependencies).toEqual(['src/widget.ts']);
    expect(result.unresolvedCount).toBe(0);
  });

  it('answers with an empty graph for an asset root file instead of parsing it as code', () => {
    const root = createGraphWorkspace({
      'src/main.ts': 'export const main = 1;\n',
      'docs/guide.md': "# Guide\n\n```ts\nimport { main } from '../src/main';\n```\n"
    });

    const result = getDependencyGraph(root, 'docs/guide.md', { includeAssets: true });

    expect(result.rootFilePath).toBe('docs/guide.md');
    expect(result.dependencies).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.unresolvedCount).toBe(0);
  });

  it('reports the same asset edges as the workspace graph', () => {
    const root = createGraphWorkspace({
      'src/main.ts': "import './main.module.css';\nimport { widget } from './widget';\nexport const main = widget;\n",
      'src/widget.ts': "import data from './data.json';\nexport const widget = data;\n",
      'src/main.module.css': '.main {}',
      'src/data.json': '{ "a": 1 }'
    });

    const fromDependencyGraph = getDependencyGraph(root, 'src/main.ts', { includeAssets: true })
      .edges.filter((edge) => edge.kind === 'internal')
      .map((edge) => `${edge.from} -> ${edge.to}`)
      .sort((left, right) => left.localeCompare(right));
    const fromWorkspaceGraph = buildWorkspaceGraph(root, { includeAssets: true })
      .imports.map((edge) => `${edge.sourceFile} -> ${edge.targetFile}`)
      .sort((left, right) => left.localeCompare(right));

    expect(fromDependencyGraph).toEqual(fromWorkspaceGraph);
  });
});
