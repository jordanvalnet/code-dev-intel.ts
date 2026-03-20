import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { DuplicateCache } from '../../../services/code-intel-mcp/src/duplicate-cache.ts';

function createWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'dev-intel-dup-cache-'));
}

describe('duplicate-cache', () => {
  it('persists entries and reloads them when mtime/size match', () => {
    const workspaceRoot = createWorkspace();
    const cache = new DuplicateCache(workspaceRoot);

    cache.set('src/file.ts', 123, 456, [
      {
        startLine: 1,
        endLine: 4,
        startColumn: 1,
        endColumn: 1,
        tokenCount: 10,
        normalizedHash: 'n1',
        rawHash: 'r1',
        signatureKey: 's1',
        normalizedTokenString: 'ID ID',
        snippetPreview: 'const a = 1'
      }
    ]);
    cache.save();

    const reloaded = new DuplicateCache(workspaceRoot);
    const hit = reloaded.get('src/file.ts', 123, 456);

    expect(hit?.length).toBe(1);
    expect(hit?.[0]?.normalizedHash).toBe('n1');
  });

  it('prunes stale entries and writes atomically', () => {
    const workspaceRoot = createWorkspace();
    const cache = new DuplicateCache(workspaceRoot);

    cache.set('src/stale.ts', 1, 1, [
      {
        startLine: 1,
        endLine: 2,
        startColumn: 1,
        endColumn: 1,
        tokenCount: 2,
        normalizedHash: 'x',
        rawHash: 'y',
        signatureKey: 'z',
        normalizedTokenString: 'ID',
        snippetPreview: 'x'
      }
    ]);
    cache.prune(new Set(['src/active.ts']));
    cache.save();

    const cacheFilePath = join(workspaceRoot, '.code-intel-cache', 'dup-cache.json');
    const tmpFilePath = `${cacheFilePath}.tmp`;
    const raw = readFileSync(cacheFilePath, 'utf8');

    expect(raw).toContain('"files":{}');
    expect(existsSync(tmpFilePath)).toBe(false);
  });

  it('does not create cache file when nothing changed', () => {
    const workspaceRoot = createWorkspace();
    const cache = new DuplicateCache(workspaceRoot);
    cache.save();

    const cacheFilePath = join(workspaceRoot, '.code-intel-cache', 'dup-cache.json');
    expect(existsSync(cacheFilePath)).toBe(false);
  });

  it('recovers gracefully from corrupted cache json', () => {
    const workspaceRoot = createWorkspace();
    const cacheDir = join(workspaceRoot, '.code-intel-cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'dup-cache.json'), '{bad-json', 'utf8');

    const cache = new DuplicateCache(workspaceRoot);
    expect(cache.get('src/file.ts', 1, 1)).toBeUndefined();
  });
});
