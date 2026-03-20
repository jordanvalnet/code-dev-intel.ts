import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  getDependencyGraph,
  getFileOutline,
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
});
