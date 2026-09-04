import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findDuplicates } from '../../../services/code-intel-mcp/src/duplicate-detection-service.ts';
import { FindDuplicatesRequestSchema } from '../../../services/code-intel-mcp/src/contracts.ts';

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

  it('rejects a sinceGitRef that starts with "-" so it cannot be parsed as a git option', async () => {
    // Schema layer (HTTP/MCP requests are validated here first).
    expect(FindDuplicatesRequestSchema.safeParse({ sinceGitRef: '--output=../../pwned' }).success).toBe(false);
    expect(FindDuplicatesRequestSchema.safeParse({ sinceGitRef: '-o' }).success).toBe(false);
    expect(FindDuplicatesRequestSchema.safeParse({ sinceGitRef: 'HEAD~1' }).success).toBe(true);

    // Service layer (defense in depth for direct callers).
    await expect(
      findDuplicates({ workspaceRoot, paths: ['src'], sinceGitRef: '--output=../../pwned' })
    ).rejects.toThrow(/sinceGitRef/);
  });

  it('does not scan hidden directories or nested git checkouts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dev-intel-duplicates-hidden-'));
    const body = [
      'export function compute(left: number, right: number): number {',
      '  const total = left + right;',
      '  const doubled = total * 2;',
      '  const shifted = doubled - left;',
      '  return shifted + right;',
      '}',
      ''
    ].join('\n');

    for (const relativePath of ['src/a.ts', '.claude/worktrees/w1/src/a.ts', 'vendor/checkout/src/a.ts']) {
      mkdirSync(join(root, relativePath, '..'), { recursive: true });
      writeFileSync(join(root, relativePath), body, 'utf8');
    }
    mkdirSync(join(root, 'vendor/checkout/.git'), { recursive: true });
    writeFileSync(join(root, 'vendor/checkout/.git/HEAD'), 'ref: refs/heads/main\n', 'utf8');

    const result = await findDuplicates({ workspaceRoot: root, minLines: 4, minTokens: 12, mode: 'fast' });

    expect(result.summary.scannedFiles).toBe(1);
    expect(result.groups).toEqual([]);
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
