import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  getDependencyGraph,
  getFileOutline,
  getSymbolContent,
  findDefinitionsBySymbol,
  findImplementationsBySymbol,
  findReferencesBySymbol
} from '../../../services/code-intel-mcp/src/typescript-symbol-service.ts';

const fixtureRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/self-test-workspace');

describe('typescript-symbol-service', () => {
  it('finds definition across files', () => {
    const result = findDefinitionsBySymbol(fixtureRoot, 'src/usage.ts', 'buildGreeting');

    expect(result.locations.length).toBeGreaterThan(0);
    expect(result.locations[0]?.filePath).toBe('src/definitions.ts');
  });

  it('finds references in usage and definition files', () => {
    const result = findReferencesBySymbol(fixtureRoot, 'src/usage.ts', 'buildGreeting');

    const filePaths = new Set(result.locations.map((entry) => entry.filePath));
    expect(filePaths.has('src/usage.ts')).toBe(true);
    expect(filePaths.has('src/definitions.ts')).toBe(true);
  });

  it('finds class implementations of an interface symbol', () => {
    const result = findImplementationsBySymbol(fixtureRoot, 'src/contract.ts', 'GreetingContract');

    const filePaths = new Set(result.locations.map((entry) => entry.filePath));
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

  describe('symbol-anchor resolution (regression: bugs #2 + #3)', () => {
    it('findDefinitions anchors on the declaration even when the symbol first appears in a comment', () => {
      const result = findDefinitionsBySymbol(fixtureRoot, 'src/symbol-anchor.ts', 'targetSymbol');

      expect(result.locations.length).toBeGreaterThan(0);
      const declarationLocation = result.locations.find(
        (location) => location.filePath === 'src/symbol-anchor.ts'
      );
      expect(declarationLocation).toBeDefined();
      expect(declarationLocation?.startLine).toBeGreaterThanOrEqual(10);
    });

    it('findReferences includes the local declaration and the cross-file consumer', () => {
      const result = findReferencesBySymbol(fixtureRoot, 'src/symbol-anchor.ts', 'targetSymbol');
      const filePaths = new Set(result.locations.map((entry) => entry.filePath));
      expect(filePaths.has('src/symbol-anchor.ts')).toBe(true);
      expect(filePaths.has('src/symbol-anchor-usage.ts')).toBe(true);
    });

    it('findReferences excludes node_modules and *.d.ts results by default', () => {
      const result = findReferencesBySymbol(fixtureRoot, 'src/symbol-anchor.ts', 'targetSymbol');
      for (const location of result.locations) {
        expect(location.filePath.includes('node_modules')).toBe(false);
        expect(location.filePath.endsWith('.d.ts')).toBe(false);
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
