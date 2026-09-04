import { afterEach, describe, expect, it } from 'vitest';
import {
  resetBundledRipgrepPathCacheForTests,
  resetRipgrepRunnerForTests,
  searchTextWithRipgrep,
  setRipgrepRunnerForTests
} from '../../../services/code-intel-mcp/src/search-text-service.ts';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function createWorkspaceFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dev-intel-text-search-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'file.ts'), "const message = buildGreeting('A');\n", 'utf8');
  return root;
}

afterEach(() => {
  resetRipgrepRunnerForTests();
});

describe('search-text-service', () => {
  it('returns parsed ripgrep matches', () => {
    setRipgrepRunnerForTests(() => ({
      status: 0,
      stdout: 'src/file.ts:1:17:const message = buildGreeting(\'A\');',
      stderr: ''
    }));

    const result = searchTextWithRipgrep('E:/workspace', 'buildGreeting');

    expect(result.engine).toBe('ripgrep');
    expect(result.matches.length).toBe(1);
    expect(result.matches[0]?.filePath).toBe('src/file.ts');
    expect(result.matches[0]?.line).toBe(1);
  });

  it('returns no matches for ripgrep status 1', () => {
    setRipgrepRunnerForTests(() => ({
      status: 1,
      stdout: '',
      stderr: ''
    }));

    const result = searchTextWithRipgrep('E:/workspace', 'buildGreeting');

    expect(result.engine).toBe('ripgrep');
    expect(result.matches).toEqual([]);
  });

  it('passes timeout and maxBuffer to ripgrep runner', () => {
    process.env.CODE_INTEL_SPAWN_TIMEOUT = '7777';
    process.env.CODE_INTEL_SPAWN_MAX_BUFFER = '123456';
    let receivedTimeout = 0;
    let receivedMaxBuffer = 0;

    setRipgrepRunnerForTests((_command, _args, options) => {
      receivedTimeout = options.timeout;
      receivedMaxBuffer = options.maxBuffer;
      return {
        status: 1,
        stdout: '',
        stderr: ''
      };
    });

    searchTextWithRipgrep('E:/workspace', 'buildGreeting');

    expect(receivedTimeout).toBe(7777);
    expect(receivedMaxBuffer).toBe(123456);
    delete process.env.CODE_INTEL_SPAWN_TIMEOUT;
    delete process.env.CODE_INTEL_SPAWN_MAX_BUFFER;
  });

  it('uses node fallback when ripgrep is unavailable', () => {
    const workspaceRoot = createWorkspaceFixture();

    setRipgrepRunnerForTests(() => ({
      status: null,
      stdout: '',
      stderr: 'spawn rg ENOENT',
      error: new Error('spawn rg ENOENT')
    }));

    const result = searchTextWithRipgrep(workspaceRoot, 'buildGreeting');

    expect(result.engine).toBe('node-fallback');
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]?.filePath).toBe('src/file.ts');
  });

  it('degrades to the node engine with a reason when ripgrep exceeds the spawn timeout', () => {
    const workspaceRoot = createWorkspaceFixture();
    setRipgrepRunnerForTests(() => ({
      status: null,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('spawnSync rg ETIMEDOUT'), { code: 'ETIMEDOUT' })
    }));

    const result = searchTextWithRipgrep(workspaceRoot, 'buildGreeting');

    expect(result.engine).toBe('node-fallback');
    expect(result.engineFallbackReason).toContain('ripgrep timed out');
    expect(result.engineFallbackReason).toContain('CODE_INTEL_SPAWN_TIMEOUT');
    expect(result.matches.map((match) => match.filePath)).toEqual(['src/file.ts']);
  });

  it('uses the bundled ripgrep binary in a real install (never the node fallback)', () => {
    // Real runner + real resolution: under pnpm the platform package is only visible from
    // @vscode/ripgrep's own location, which used to silently degrade to the node fallback.
    resetRipgrepRunnerForTests();
    resetBundledRipgrepPathCacheForTests();
    const workspaceRoot = createWorkspaceFixture();

    const result = searchTextWithRipgrep(workspaceRoot, 'buildGreeting');

    expect(result.engineFallbackReason).toBeUndefined();
    expect(result.engine).toBe('ripgrep');
    expect(result.matches.map((match) => match.filePath)).toEqual(['src/file.ts']);
  });

  it('passes the query as a pattern operand (-e) and terminates options with -- so a leading-dash query cannot inject ripgrep flags', () => {
    const workspaceRoot = createWorkspaceFixture();
    let receivedArgs: readonly string[] = [];

    setRipgrepRunnerForTests((_command, args) => {
      receivedArgs = args;
      return { status: 1, stdout: '', stderr: '' };
    });

    searchTextWithRipgrep(workspaceRoot, '--pre=./evil.sh');

    const patternFlagIndex = receivedArgs.indexOf('-e');
    expect(patternFlagIndex).toBeGreaterThan(-1);
    expect(receivedArgs[patternFlagIndex + 1]).toBe('--pre=./evil.sh');
    expect(receivedArgs[patternFlagIndex + 2]).toBe('--');
    // Everything after '--' is a search path inside the workspace, never a flag.
    expect(receivedArgs.slice(patternFlagIndex + 3).every((value) => !value.startsWith('-'))).toBe(true);
  });

  it('searches workspace root by default', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'dev-intel-text-search-root-default-'));
    mkdirSync(join(workspaceRoot, 'src'), { recursive: true });
    mkdirSync(join(workspaceRoot, 'lib'), { recursive: true });
    mkdirSync(join(workspaceRoot, '.next'), { recursive: true });
    writeFileSync(join(workspaceRoot, 'src', 'keep.ts'), 'const value = patchProfile();\n', 'utf8');
    writeFileSync(join(workspaceRoot, 'lib', 'also-keep.ts'), 'const value = patchProfile();\n', 'utf8');
    writeFileSync(join(workspaceRoot, '.next', 'generated.js'), 'patchProfile();\n', 'utf8');

    setRipgrepRunnerForTests(() => ({
      status: null,
      stdout: '',
      stderr: 'spawn rg ENOENT',
      error: new Error('spawn rg ENOENT')
    }));

    const result = searchTextWithRipgrep(workspaceRoot, 'patchProfile');

    expect(result.engine).toBe('node-fallback');
    const filePaths = new Set(result.matches.map((match) => match.filePath));
    expect(filePaths.has('src/keep.ts')).toBe(true);
    expect(filePaths.has('lib/also-keep.ts')).toBe(true);
    expect(filePaths.has('.next/generated.js')).toBe(false);
  });

  it('limits search to searchPath when provided', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'dev-intel-text-search-scope-'));
    mkdirSync(join(workspaceRoot, 'src'), { recursive: true });
    mkdirSync(join(workspaceRoot, 'lib'), { recursive: true });
    writeFileSync(join(workspaceRoot, 'src', 'keep.ts'), 'const value = patchProfile();\n', 'utf8');
    writeFileSync(join(workspaceRoot, 'lib', 'skip.ts'), 'const value = patchProfile();\n', 'utf8');

    setRipgrepRunnerForTests(() => ({
      status: null,
      stdout: '',
      stderr: 'spawn rg ENOENT',
      error: new Error('spawn rg ENOENT')
    }));

    const result = searchTextWithRipgrep(workspaceRoot, 'patchProfile', 200, 'src');

    expect(result.engine).toBe('node-fallback');
    expect(result.matches.length).toBe(1);
    expect(result.matches[0]?.filePath).toBe('src/keep.ts');
  });

  describe('engine fallback reason (regression: bug #4)', () => {
    it('reports the underlying spawn error when falling back to node', () => {
      const workspaceRoot = createWorkspaceFixture();

      setRipgrepRunnerForTests(() => ({
        status: null,
        stdout: '',
        stderr: 'spawn rg ENOENT',
        error: new Error('spawn rg ENOENT')
      }));

      const result = searchTextWithRipgrep(workspaceRoot, 'buildGreeting');

      expect(result.engine).toBe('node-fallback');
      expect(result.engineFallbackReason).toBeDefined();
      expect(result.engineFallbackReason).toContain('ENOENT');
    });

    it('does not set engineFallbackReason when ripgrep succeeds', () => {
      setRipgrepRunnerForTests(() => ({
        status: 0,
        stdout: '',
        stderr: ''
      }));

      const result = searchTextWithRipgrep('E:/workspace', 'buildGreeting');

      expect(result.engine).toBe('ripgrep');
      expect(result.engineFallbackReason).toBeUndefined();
    });
  });

  it('ignores gitignore patterns in node fallback', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'dev-intel-text-search-gitignore-'));
    mkdirSync(join(workspaceRoot, 'src'), { recursive: true });
    writeFileSync(join(workspaceRoot, '.gitignore'), 'src/ignored.ts\n', 'utf8');
    writeFileSync(join(workspaceRoot, 'src', 'ignored.ts'), 'patchProfile();\n', 'utf8');
    writeFileSync(join(workspaceRoot, 'src', 'included.ts'), 'patchProfile();\n', 'utf8');

    setRipgrepRunnerForTests(() => ({
      status: null,
      stdout: '',
      stderr: 'spawn rg ENOENT',
      error: new Error('spawn rg ENOENT')
    }));

    const result = searchTextWithRipgrep(workspaceRoot, 'patchProfile');

    expect(result.engine).toBe('node-fallback');
    expect(result.matches.length).toBe(1);
    expect(result.matches[0]?.filePath).toBe('src/included.ts');
  });
});
