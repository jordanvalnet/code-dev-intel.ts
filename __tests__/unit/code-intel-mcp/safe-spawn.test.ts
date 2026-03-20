import { afterEach, describe, expect, it } from 'vitest';
import {
  resetSpawnRunnerForTests,
  safeSpawnSync,
  setSpawnRunnerForTests
} from '../../../services/code-intel-mcp/src/safe-spawn.ts';

afterEach(() => {
  resetSpawnRunnerForTests();
});

describe('safe-spawn', () => {
  it('passes timeout and maxBuffer to underlying runner', () => {
    let receivedTimeout = 0;
    let receivedMaxBuffer = 0;

    setSpawnRunnerForTests((_command, _args, options) => {
      receivedTimeout = options.timeout ?? 0;
      receivedMaxBuffer = options.maxBuffer ?? 0;
      return {
        pid: 1,
        output: [],
        stdout: 'ok',
        stderr: '',
        status: 0,
        signal: null
      };
    });

    const result = safeSpawnSync('rg', ['foo', '.'], {
      cwd: process.cwd(),
      timeoutMs: 1234,
      maxBufferBytes: 2222,
      allowedCommands: ['rg']
    });

    expect(result.status).toBe(0);
    expect(receivedTimeout).toBe(1234);
    expect(receivedMaxBuffer).toBe(2222);
  });

  it('uses environment defaults when explicit limits are absent', () => {
    process.env.CODE_INTEL_SPAWN_TIMEOUT = '4444';
    process.env.CODE_INTEL_SPAWN_MAX_BUFFER = '5555';
    let receivedTimeout = 0;
    let receivedMaxBuffer = 0;

    setSpawnRunnerForTests((_command, _args, options) => {
      receivedTimeout = options.timeout ?? 0;
      receivedMaxBuffer = options.maxBuffer ?? 0;
      return {
        pid: 1,
        output: [],
        stdout: 'ok',
        stderr: '',
        status: 0,
        signal: null
      };
    });

    safeSpawnSync('rg', ['foo', '.'], {
      cwd: process.cwd(),
      allowedCommands: ['rg']
    });

    expect(receivedTimeout).toBe(4444);
    expect(receivedMaxBuffer).toBe(5555);

    delete process.env.CODE_INTEL_SPAWN_TIMEOUT;
    delete process.env.CODE_INTEL_SPAWN_MAX_BUFFER;
  });

  it('rejects disallowed command', () => {
    expect(() =>
      safeSpawnSync('curl', ['--version'], {
        cwd: process.cwd(),
        allowedCommands: ['rg']
      })
    ).toThrow('command not allowed');
  });
});
