import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runIndexer } from '../../../services/indexer/src/indexer-runner.ts';
import { isRelevantFile, listChangedFilesFromGitDiff } from '../../../services/indexer/src/change-detector.ts';
import { setLoggerSinkForTests, resetLoggerSinkForTests } from '../../../services/code-intel-mcp/src/logger.ts';
import { describe, expect, it, afterEach } from 'vitest';
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

afterEach(() => {
  resetLoggerSinkForTests();
});

describe('change-detector', () => {
  describe('isRelevantFile', () => {
    it('accepts .ts and .tsx files', () => {
      expect(isRelevantFile('src/test.ts')).toBe(true);
      expect(isRelevantFile('src/test.tsx')).toBe(true);
    });

    it('accepts .js, .jsx, and .json files', () => {
      expect(isRelevantFile('index.js')).toBe(true);
      expect(isRelevantFile('Component.jsx')).toBe(true);
      expect(isRelevantFile('tsconfig.json')).toBe(true);
    });

    it('rejects non-code files', () => {
      expect(isRelevantFile('README.md')).toBe(false);
      expect(isRelevantFile('style.css')).toBe(false);
      expect(isRelevantFile('image.png')).toBe(false);
      expect(isRelevantFile('Dockerfile')).toBe(false);
      expect(isRelevantFile('.gitignore')).toBe(false);
    });

    it('is case-insensitive on extension', () => {
      expect(isRelevantFile('file.TS')).toBe(true);
      expect(isRelevantFile('file.Tsx')).toBe(true);
      expect(isRelevantFile('file.JSON')).toBe(true);
    });

    it('supports custom extensions', () => {
      expect(isRelevantFile('style.css', ['.css', '.scss'])).toBe(true);
      expect(isRelevantFile('code.ts', ['.css', '.scss'])).toBe(false);
    });

    it('handles files without extensions', () => {
      expect(isRelevantFile('Makefile')).toBe(false);
    });
  });

  describe('listChangedFilesFromGitDiff', () => {
    it('returns tracked and untracked relevant files', () => {
      const repoRoot = createTempGitRepo();
      const changed = listChangedFilesFromGitDiff({ workspaceRoot: repoRoot, baseRef: 'HEAD' });

      expect(changed).toContain('src/seed.ts');
      expect(changed).toContain('src/new-file.ts');
      expect(changed.some((entry) => entry.endsWith('.md'))).toBe(false);
    });

    it('deduplicates files that appear in both diff and untracked', () => {
      const repoRoot = createTempGitRepo();
      const changed = listChangedFilesFromGitDiff({ workspaceRoot: repoRoot, baseRef: 'HEAD' });

      const uniqueSet = new Set(changed);
      expect(uniqueSet.size).toBe(changed.length);
    });

    it('respects custom includeExtensions', () => {
      const repoRoot = createTempGitRepo();
      writeFileSync(join(repoRoot, 'src', 'extra.css'), 'body {}', 'utf8');

      const tsOnly = listChangedFilesFromGitDiff({
        workspaceRoot: repoRoot,
        baseRef: 'HEAD',
        includeExtensions: ['.ts']
      });

      expect(tsOnly.every((file) => file.endsWith('.ts'))).toBe(true);
      expect(tsOnly).not.toContain('src/extra.css');
    });

    it('defaults to HEAD when baseRef is not specified', () => {
      const repoRoot = createTempGitRepo();
      const changed = listChangedFilesFromGitDiff({ workspaceRoot: repoRoot });

      expect(changed.length).toBeGreaterThan(0);
    });

    it('returns empty array when nothing has changed', () => {
      const repoRoot = mkdtempSync(join(tmpdir(), 'empty-repo-'));
      spawnSync('git', ['init'], { cwd: repoRoot, encoding: 'utf8' });
      spawnSync('git', ['config', 'user.email', 'bot@example.com'], { cwd: repoRoot, encoding: 'utf8' });
      spawnSync('git', ['config', 'user.name', 'Bot'], { cwd: repoRoot, encoding: 'utf8' });
      writeFileSync(join(repoRoot, 'index.ts'), 'export const a = 1;\n', 'utf8');
      spawnSync('git', ['add', '.'], { cwd: repoRoot, encoding: 'utf8' });
      spawnSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, encoding: 'utf8' });

      const changed = listChangedFilesFromGitDiff({ workspaceRoot: repoRoot, baseRef: 'HEAD' });
      expect(changed).toEqual([]);
    });
  });

  describe('runIndexer', () => {
    it('outputs changedCount in git-diff mode', () => {
      const repoRoot = createTempGitRepo();
      const captured: string[] = [];
      setLoggerSinkForTests((line) => {
        captured.push(line);
      });

      runIndexer({ mode: 'git-diff', workspaceRoot: repoRoot, baseRef: 'HEAD' });

      const printed = captured.join('\n');
      expect(printed).toContain('"changedCount"');
    });

    it('throws on unsupported mode', () => {
      const repoRoot = createTempGitRepo();
      expect(() => {
        runIndexer({ mode: 'unknown' as 'git-diff', workspaceRoot: repoRoot });
      }).toThrow('Unsupported mode');
    });

    it('throws in impacted mode without changed files', () => {
      const repoRoot = createTempGitRepo();
      expect(() => {
        runIndexer({ mode: 'impacted', workspaceRoot: repoRoot });
      }).toThrow('--changed=');
    });

    it('outputs impacted files in impacted mode', () => {
      const repoRoot = mkdtempSync(join(tmpdir(), 'impacted-runner-'));
      mkdirSync(join(repoRoot, 'src'), { recursive: true });
      writeFileSync(join(repoRoot, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
      writeFileSync(join(repoRoot, 'src', 'b.ts'), "import { a } from './a';\nexport const b = a;\n", 'utf8');

      const captured: string[] = [];
      setLoggerSinkForTests((line) => {
        captured.push(line);
      });

      runIndexer({
        mode: 'impacted',
        workspaceRoot: repoRoot,
        changedFiles: ['src/a.ts']
      });

      const printed = captured.join('\n');
      expect(printed).toContain('"impactedCount"');
      expect(printed).toContain('src/a.ts');
    });
  });
});
