import { describe, expect, it } from 'vitest';
import { writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { searchTextWithRipgrep } from '../../../services/code-intel-mcp/src/search-text-service.ts';

/**
 * What this measures is one ripgrep spawn, and what a spawn costs is a property of the
 * operating system rather than of this code — so the budget is resolved per platform.
 *
 * MEASURED, rather than assumed (the `[perf]` line below is what every run reports;
 * these are the numbers the budget was calibrated from):
 *   linux   8 / 12 / 13 / 21 ms   (ubuntu-latest, Node 22 and 24)
 *   darwin  15 / 17 / 17 ms       (macos-latest)
 *   win32   32 / 40 / 54 ms       (windows-latest, hosted runner)
 *   win32   40 / 62 / 114 / 159 ms when this file runs alone, but 678 ms and 2,225 ms
 *           inside the full parallel suite on a memory-pressured Windows machine
 *
 * A hosted Windows runner is only three to four times Linux here, so CI alone would have
 * suggested no change. A real Windows machine running the whole suite is what moves the
 * number: 2,225 ms — over the 2 s this test used to assert unconditionally, for the same
 * search that costs 114 ms when nothing else is running. Windows therefore gets 3,500 ms,
 * which is ~1.5x the slowest run ever observed and still fails a regression that pushes
 * this search into the multi-second range. Linux and macOS keep 2,000 ms, which is
 * already about a hundred times what they measure.
 *
 * `CODE_INTEL_PERF_BUDGET_MS` moves the budget for a host neither number fits — a Windows
 * machine with on-access antivirus over a freshly unpacked `rg.exe`, a container with a
 * cold page cache — without editing this file.
 */
const DEFAULT_PERF_BUDGET_MS = 2000;
const PLATFORM_PERF_BUDGET_MS: Partial<Record<NodeJS.Platform, number>> = {
  win32: 3500
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
