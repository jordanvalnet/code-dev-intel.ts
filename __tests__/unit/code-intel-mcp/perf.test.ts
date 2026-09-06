import { describe, expect, it } from 'vitest';
import { writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { searchTextWithRipgrep } from '../../../services/code-intel-mcp/src/search-text-service.ts';

/**
 * What this measures is one cold ripgrep spawn, and what a spawn costs is a property of
 * the operating system rather than of this code: on Windows the first launch of a
 * freshly unpacked binary pays process creation plus an on-access antivirus scan, which
 * is several times what the same binary costs on Linux or macOS. A single number for
 * every platform therefore either passes vacuously on the fast ones or fails on the slow
 * one, so the budget is chosen per platform. Linux and macOS keep the original 2 s.
 *
 * `CODE_INTEL_PERF_BUDGET_MS` overrides it for a runner whose spawn cost is not one of
 * these — a shared machine, a container with a cold page cache — without editing this
 * file. The override is deliberately not a way to make the assertion pass in CI: the
 * committed per-platform numbers are what the pipeline runs on.
 */
const DEFAULT_PERF_BUDGET_MS = 2000;
const PLATFORM_PERF_BUDGET_MS: Partial<Record<NodeJS.Platform, number>> = {
  win32: 4000
};

function resolvePerfBudgetMs(): number {
  const rawOverride = process.env.CODE_INTEL_PERF_BUDGET_MS?.trim();
  if (rawOverride) {
    const parsedOverride = Number.parseInt(rawOverride, 10);
    if (Number.isFinite(parsedOverride) && parsedOverride > 0) {
      return parsedOverride;
    }
  }

  return PLATFORM_PERF_BUDGET_MS[process.platform] ?? DEFAULT_PERF_BUDGET_MS;
}

describe('code-intel-mcp perf budget', () => {
  it('searchText baseline stays under the platform budget on the fixture workspace', () => {
    const workspaceRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/self-test-workspace');
    const budgetMs = resolvePerfBudgetMs();

    const startedAt = performance.now();
    const result = searchTextWithRipgrep(workspaceRoot, 'buildGreeting', 100);
    const durationMs = performance.now() - startedAt;

    // Reported so a CI run states the number it actually observed on its runner — the
    // per-OS budgets above were calibrated from these lines, and recalibrating them needs
    // the same evidence. Written to the real stderr descriptor rather than through
    // `console`, because vitest's default reporter keeps a passing test's console output
    // to itself, and re-running this file with `--reporter=verbose` would measure a
    // filesystem cache the first run has already warmed.
    writeSync(
      2,
      `[perf] searchText platform=${process.platform} engine=${result.engine} durationMs=${Math.round(durationMs)} budgetMs=${budgetMs}\n`
    );

    expect(result.matches.length).toBeGreaterThan(0);
    expect(
      durationMs,
      `searchText took ${Math.round(durationMs)}ms on ${process.platform}, budget ${budgetMs}ms`
    ).toBeLessThan(budgetMs);
  });
});
