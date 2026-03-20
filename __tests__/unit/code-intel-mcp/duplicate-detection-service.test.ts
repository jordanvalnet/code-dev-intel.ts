import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findDuplicates } from '../../../services/code-intel-mcp/src/duplicate-detection-service.ts';

describe('duplicate-detection-service', () => {
  const workspaceRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/duplicates-workspace');

  it('finds exact and renamed duplicate groups', async () => {
    const result = await findDuplicates({
      workspaceRoot,
      paths: ['src'],
      minLines: 4,
      minTokens: 12,
      mode: 'fast',
      maxGroups: 20
    });

    expect(result.groups.length).toBeGreaterThan(0);
    expect(result.groups.some((group) => group.kind === 'type2')).toBe(true);
  });

  it('supports markdown output format', async () => {
    const result = await findDuplicates({
      workspaceRoot,
      paths: ['src'],
      minLines: 4,
      minTokens: 12,
      mode: 'balanced',
      outputFormat: 'markdown'
    });

    expect(typeof result.markdownReport).toBe('string');
    expect(result.markdownReport).toContain('# Duplicate code report');
  });

  it('supports scan filtering through sinceGitRef without crashing', async () => {
    const result = await findDuplicates({
      workspaceRoot,
      paths: ['src'],
      minLines: 4,
      minTokens: 12,
      mode: 'balanced',
      sinceGitRef: 'HEAD'
    });

    expect(Array.isArray(result.groups)).toBe(true);
    expect(result.summary.scannedFiles).toBeGreaterThanOrEqual(0);
  });

  it('matches expected golden fingerprint projection', async () => {
    const goldenPath = resolve(
      process.cwd(),
      '__tests__/unit/code-intel-mcp/fixtures/duplicates/expected-output.json'
    );
    const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as {
      mode: 'balanced';
      minLines: number;
      minTokens: number;
      groups: Array<{ kind: string; fingerprint: string; occurrenceCount: number }>;
    };

    const result = await findDuplicates({
      workspaceRoot,
      paths: ['src'],
      minLines: golden.minLines,
      minTokens: golden.minTokens,
      mode: golden.mode,
      maxGroups: 4
    });

    const projection = result.groups.map((group) => ({
      kind: group.kind,
      fingerprint: group.fingerprint,
      occurrenceCount: group.metrics.occurrenceCount
    }));

    expect(projection).toEqual(golden.groups);
  });
});
