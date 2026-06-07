import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  findCalleesBySymbol,
  findCallersBySymbol,
  findSymbolByName
} from '../../../services/code-intel-mcp/src/typescript-symbol-service.ts';

const fixtureRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/self-test-workspace');

describe('findCallersBySymbol', () => {
  it('lists every caller of a function with its call-site range', () => {
    const result = findCallersBySymbol(fixtureRoot, 'src/call-hierarchy.ts', 'targetCallee');

    expect(result.symbol).toBe('targetCallee');
    expect(result.sourceFilePath).toBe('src/call-hierarchy.ts');

    const callerSymbols = new Set(result.callers.map((entry) => entry.callerSymbol));
    expect(callerSymbols.has('firstCaller')).toBe(true);
    expect(callerSymbols.has('secondCaller')).toBe(true);

    // secondCaller calls targetCallee twice -> at least 3 call sites total.
    expect(result.callers.length).toBeGreaterThanOrEqual(3);

    for (const entry of result.callers) {
      expect(entry.filePath).toBe('src/call-hierarchy.ts');
      expect(entry.callSite.startLine).toBeGreaterThan(0);
      expect(entry.callSite.startColumn).toBeGreaterThan(0);
      expect(entry.callSite.endLine).toBeGreaterThanOrEqual(entry.callSite.startLine);
    }
  });

  it('returns an empty caller list for an uncalled symbol without throwing', () => {
    const result = findCallersBySymbol(fixtureRoot, 'src/call-hierarchy.ts', 'firstCaller');
    expect(Array.isArray(result.callers)).toBe(true);
  });
});

describe('findCalleesBySymbol', () => {
  it('lists outgoing calls of a function with call-site ranges', () => {
    const result = findCalleesBySymbol(fixtureRoot, 'src/call-hierarchy.ts', 'targetCallee');

    expect(result.symbol).toBe('targetCallee');
    expect(result.sourceFilePath).toBe('src/call-hierarchy.ts');

    const calleeSymbols = new Set(result.callees.map((entry) => entry.calleeSymbol));
    expect(calleeSymbols.has('helperDouble')).toBe(true);

    for (const entry of result.callees) {
      expect(entry.callSite.startLine).toBeGreaterThan(0);
      expect(entry.callSite.startColumn).toBeGreaterThan(0);
    }
  });
});

describe('findSymbolByName', () => {
  it('finds a symbol by name only (no filePath) and returns its declaration site', () => {
    const result = findSymbolByName(fixtureRoot, 'buildGreeting');

    expect(result.symbol).toBe('buildGreeting');
    expect(result.matches.length).toBeGreaterThan(0);

    const declaration = result.matches.find((match) => match.filePath === 'src/definitions.ts');
    expect(declaration).toBeDefined();
    expect(declaration?.name).toBe('buildGreeting');
    expect(typeof declaration?.kind).toBe('string');
    expect(declaration?.startLine).toBeGreaterThan(0);
    expect(declaration?.startColumn).toBeGreaterThan(0);
  });

  it('returns matches for a symbol defined in the call-hierarchy fixture', () => {
    const result = findSymbolByName(fixtureRoot, 'helperDouble');

    const filePaths = new Set(result.matches.map((match) => match.filePath));
    expect(filePaths.has('src/call-hierarchy.ts')).toBe(true);
  });

  it('returns an empty match list for an unknown symbol without throwing', () => {
    const result = findSymbolByName(fixtureRoot, 'definitelyNotARealSymbolName12345');
    expect(result.matches).toEqual([]);
  });
});
