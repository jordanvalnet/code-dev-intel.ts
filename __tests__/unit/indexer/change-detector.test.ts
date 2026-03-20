import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runIndexer } from '../../../services/indexer/src/indexer-runner.ts';
import { isRelevantFile, listChangedFilesFromGitDiff } from '../../../services/indexer/src/change-detector.ts';
import { setLoggerSinkForTests, resetLoggerSinkForTests } from '../../../services/code-intel-mcp/src/logger.ts';
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

function createTempGitRepo(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'dev-intel-indexer-'));
  spawnSync('git', ['init'], { cwd: repoRoot, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 'bot@example.com'], { cwd: repoRoot, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.name', 'Bot'], { cwd: repoRoot, encoding: 'utf8' });

  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'src', 'seed.ts'), 'export const seed = 1;\n', 'utf8');
  spawnSync('git', ['add', '.'], { cwd: repoRoot, encoding: 'utf8' });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, encoding: 'utf8' });

  writeFileSync(join(repoRoot, 'src', 'seed.ts'), 'export const seed = 2;\n', 'utf8');
  writeFileSync(join(repoRoot, 'src', 'new-file.ts'), 'export const n = 1;\n', 'utf8');
  writeFileSync(join(repoRoot, 'README.md'), '# ignored\n', 'utf8');

  return repoRoot;
}

describe('change-detector', () => {
  it('filters files by relevant extension', () => {
    expect(isRelevantFile('src/test.ts')).toBe(true);
    expect(isRelevantFile('src/test.tsx')).toBe(true);
    expect(isRelevantFile('README.md')).toBe(false);
  });

  it('returns tracked and untracked relevant files in git-diff mode', () => {
    const repoRoot = createTempGitRepo();
    const changed = listChangedFilesFromGitDiff({ workspaceRoot: repoRoot, baseRef: 'HEAD' });

    expect(changed).toContain('src/seed.ts');
    expect(changed).toContain('src/new-file.ts');
    expect(changed.some((entry) => entry.endsWith('.md'))).toBe(false);
  });

  it('runner prints changedCount in git-diff mode', () => {
    const repoRoot = createTempGitRepo();
    const captured: string[] = [];
    setLoggerSinkForTests((line) => {
      captured.push(line);
    });

    runIndexer({ mode: 'git-diff', workspaceRoot: repoRoot, baseRef: 'HEAD' });

    const printed = captured.join('\n');
    expect(printed).toContain('"changedCount"');

    resetLoggerSinkForTests();
  });
});
