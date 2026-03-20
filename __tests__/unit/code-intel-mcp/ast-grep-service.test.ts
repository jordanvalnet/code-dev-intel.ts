import { afterEach, describe, expect, it } from 'vitest';
import {
  resetAstGrepPostinstallRunnerForTests,
  resetAstGrepRunnerForTests,
  searchStructWithAstGrep,
  setAstGrepPostinstallRunnerForTests,
  setAstGrepRunnerForTests
} from '../../../services/code-intel-mcp/src/ast-grep-service.ts';

afterEach(() => {
  resetAstGrepRunnerForTests();
  resetAstGrepPostinstallRunnerForTests();
});

describe('ast-grep-service', () => {
  it('parses stream json matches', () => {
    setAstGrepRunnerForTests(() => ({
      status: 0,
      stdout: [
        JSON.stringify({
          file: 'src/file.ts',
          text: 'buildGreeting(name)',
          range: {
            start: { line: 2, column: 10 },
            end: { line: 2, column: 28 }
          }
        })
      ].join('\n'),
      stderr: ''
    }));

    const result = searchStructWithAstGrep('E:/workspace', 'buildGreeting($A)', 'ts');

    expect(result.pattern).toBe('buildGreeting($A)');
    expect(result.matches.length).toBe(1);
    expect(result.matches[0]?.filePath).toBe('src/file.ts');
    expect(result.matches[0]?.startLine).toBe(3);
  });

  it('throws on ast-grep command failure', () => {
    setAstGrepRunnerForTests(() => ({
      status: 2,
      stdout: '',
      stderr: 'command failed'
    }));

    expect(() => searchStructWithAstGrep('E:/workspace', 'foo($A)', 'ts')).toThrow(
      'ast-grep execution failed'
    );
  });

  it('returns no matches when ast-grep exits with status 1', () => {
    setAstGrepRunnerForTests(() => ({
      status: 1,
      stdout: '',
      stderr: ''
    }));

    const result = searchStructWithAstGrep('E:/workspace', 'notFound($A)', 'ts');

    expect(result.matches).toEqual([]);
  });

  it('passes timeout and maxBuffer to ast-grep runner', () => {
    process.env.CODE_INTEL_SPAWN_TIMEOUT = '6001';
    process.env.CODE_INTEL_SPAWN_MAX_BUFFER = '333333';
    let receivedTimeout = 0;
    let receivedMaxBuffer = 0;

    setAstGrepRunnerForTests((_command, _args, options) => {
      receivedTimeout = options.timeout;
      receivedMaxBuffer = options.maxBuffer;
      return {
        status: 2,
        stdout: '',
        stderr: 'command failed'
      };
    });

    expect(() => searchStructWithAstGrep('E:/workspace', 'foo($A)', 'ts')).toThrow(
      'ast-grep execution failed'
    );
    expect(receivedTimeout).toBe(6001);
    expect(receivedMaxBuffer).toBe(333333);
    delete process.env.CODE_INTEL_SPAWN_TIMEOUT;
    delete process.env.CODE_INTEL_SPAWN_MAX_BUFFER;
  });

  it('falls back to pnpm dlx when local ast-grep shim is unavailable', () => {
    let invocation = 0;

    setAstGrepPostinstallRunnerForTests(() => ({
      status: 1,
      stdout: '',
      stderr: 'postinstall failed'
    }));

    setAstGrepRunnerForTests((_command, args) => {
      invocation += 1;

      if (invocation === 1) {
        expect(args[0]).toBe('run');
        return {
          status: 1,
          stdout: 'ast-grep shim file was executed',
          stderr: ''
        };
      }

      if (invocation === 2) {
        expect(args.slice(0, 3)).toEqual(['--ignore-workspace', 'exec', 'ast-grep']);
        return {
          status: 1,
          stdout: 'ast-grep shim file was executed',
          stderr: ''
        };
      }

      expect(args.slice(0, 4)).toEqual(['--ignore-workspace', 'dlx', '@ast-grep/cli', 'run']);
      return {
        status: 0,
        stdout: [
          JSON.stringify({
            file: 'src/file.ts',
            text: 'foo(name)',
            range: {
              start: { line: 1, column: 0 },
              end: { line: 1, column: 8 }
            }
          })
        ].join('\n'),
        stderr: ''
      };
    });

    const result = searchStructWithAstGrep('E:/workspace', 'foo($A)', 'ts');

    expect(result.matches.length).toBe(1);
    expect(result.matches[0]?.filePath).toBe('src/file.ts');
    expect(invocation).toBe(3);
  });

  it('repairs ast-grep link via postinstall before dlx fallback', () => {
    let invocation = 0;
    let postinstallInvoked = false;

    setAstGrepRunnerForTests((_command, args) => {
      invocation += 1;

      if (invocation === 1) {
        expect(args[0]).toBe('run');
        return {
          status: 1,
          stdout: 'ast-grep shim file was executed',
          stderr: ''
        };
      }

      if (invocation === 2) {
        expect(args.slice(0, 3)).toEqual(['--ignore-workspace', 'exec', 'ast-grep']);
        return {
          status: 1,
          stdout: 'ast-grep shim file was executed',
          stderr: ''
        };
      }

      expect(args.slice(0, 3)).toEqual(['--ignore-workspace', 'exec', 'ast-grep']);
      return {
        status: 0,
        stdout: [
          JSON.stringify({
            file: 'src/file.ts',
            text: 'foo(name)',
            range: {
              start: { line: 1, column: 0 },
              end: { line: 1, column: 8 }
            }
          })
        ].join('\n'),
        stderr: ''
      };
    });

    setAstGrepPostinstallRunnerForTests(() => {
      postinstallInvoked = true;
      return {
        status: 0,
        stdout: '',
        stderr: ''
      };
    });

    const result = searchStructWithAstGrep('E:/workspace', 'foo($A)', 'ts');

    expect(result.matches.length).toBe(1);
    expect(postinstallInvoked).toBe(true);
    expect(invocation).toBe(3);
  });

  it('returns actionable error when ast-grep shim is not linked', () => {
    setAstGrepRunnerForTests(() => ({
      status: 2,
      stdout: 'ast-grep shim file was executed',
      stderr: ''
    }));

    expect(() => searchStructWithAstGrep('E:/workspace', 'foo($A)', 'ts')).toThrow(
      'ast-grep binary is not linked'
    );
  });

  it('returns actionable error when ast-grep times out', () => {
    setAstGrepRunnerForTests(() => ({
      status: null,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('spawnSync timed out'), { code: 'ETIMEDOUT' })
    }));

    expect(() => searchStructWithAstGrep('E:/workspace', 'foo($A)', 'ts')).toThrow(
      'ast-grep timed out'
    );
  });
});
