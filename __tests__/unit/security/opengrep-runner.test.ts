import { afterEach, describe, expect, it } from 'vitest';

import {
  resetCommandRunnerForTests,
  runOpenGrepScan,
  setCommandRunnerForTests
} from '../../../services/security/opengrep-runner.js';

describe('runOpenGrepScan', () => {
  afterEach(() => {
    resetCommandRunnerForTests();
  });

  it('returns failure when opengrep is unavailable', () => {
    setCommandRunnerForTests(() => ({ status: 1, stdout: '', stderr: 'not found' }));

    const result = runOpenGrepScan(process.cwd());

    expect(result.ok).toBe(false);
    expect(result.message).toContain('OpenGrep is not available');
  });

  it('returns success when scan exits with status 0', () => {
    setCommandRunnerForTests((command, args) => {
      if (args[0] === '--version' && command !== 'opengrep') {
        return { status: 1, stdout: '', stderr: 'missing candidate' };
      }

      if (args[0] === '--version' && command === 'opengrep') {
        return { status: 0, stdout: '0.1.0', stderr: '' };
      }

      return { status: 0, stdout: 'scan ok', stderr: '' };
    });

    const result = runOpenGrepScan(process.cwd());

    expect(result.ok).toBe(true);
    expect(result.message).toBe('OpenGrep scan completed successfully');
  });

  it('returns failure when scan fails', () => {
    setCommandRunnerForTests((command, args) => {
      if (args[0] === '--version' && command !== 'opengrep') {
        return { status: 1, stdout: '', stderr: 'missing candidate' };
      }

      if (args[0] === '--version' && command === 'opengrep') {
        return { status: 0, stdout: '0.1.0', stderr: '' };
      }

      return { status: 2, stdout: '', stderr: 'findings detected' };
    });

    const result = runOpenGrepScan(process.cwd());

    expect(result.ok).toBe(false);
    expect(result.message).toContain('findings detected');
  });
});
