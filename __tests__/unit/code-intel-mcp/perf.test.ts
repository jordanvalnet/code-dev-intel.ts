import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { searchTextWithRipgrep } from '../../../services/code-intel-mcp/src/search-text-service.ts';

describe('code-intel-mcp perf budget', () => {
  it('searchText baseline stays under 2s on fixture workspace', () => {
    const workspaceRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/self-test-workspace');

    const startedAt = performance.now();
    const result = searchTextWithRipgrep(workspaceRoot, 'buildGreeting', 100);
    const durationMs = performance.now() - startedAt;

    expect(result.matches.length).toBeGreaterThan(0);
    expect(durationMs).toBeLessThan(2000);
  });
});
