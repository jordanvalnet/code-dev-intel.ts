import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  getAllowedWorkspaceRoots,
  HttpError,
  parseAllowedWorkspaceRootsFromArgs,
  parseAllowedWorkspaceRootsFromEnv,
  resolveAndValidateWorkspaceRoot
} from '../../../services/code-intel-mcp/src/server-utils.ts';

function makeDir(prefix: string): string {
  // realpathSync so the path matches the canonical form resolveAndValidate produces.
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

describe('parseAllowedWorkspaceRootsFromEnv', () => {
  it('returns [] for missing/blank', () => {
    expect(parseAllowedWorkspaceRootsFromEnv({})).toEqual([]);
    expect(parseAllowedWorkspaceRootsFromEnv({ CODE_INTEL_ALLOWED_WORKSPACE_ROOTS: '   ' })).toEqual([]);
  });

  it('splits on comma or semicolon and trims, dropping empties', () => {
    expect(
      parseAllowedWorkspaceRootsFromEnv({
        CODE_INTEL_ALLOWED_WORKSPACE_ROOTS: ' /a/* , /b/** ;; /c '
      })
    ).toEqual(['/a/*', '/b/**', '/c']);
  });
});

describe('parseAllowedWorkspaceRootsFromArgs', () => {
  it('collects every --allowed-workspace-root= occurrence (repeatable)', () => {
    expect(
      parseAllowedWorkspaceRootsFromArgs([
        '--stdio',
        '--allowed-workspace-root=/a/*',
        '--workspaceRoot=.',
        '--allowed-workspace-root= /b/** '
      ])
    ).toEqual(['/a/*', '/b/**']);
  });

  it('returns [] when none are present', () => {
    expect(parseAllowedWorkspaceRootsFromArgs(['--stdio', '--workspaceRoot=.'])).toEqual([]);
  });
});

describe('getAllowedWorkspaceRoots', () => {
  it('merges env then argv', () => {
    expect(
      getAllowedWorkspaceRoots(
        { CODE_INTEL_ALLOWED_WORKSPACE_ROOTS: '/env/*' },
        ['--allowed-workspace-root=/argv/*']
      )
    ).toEqual(['/env/*', '/argv/*']);
  });
});

describe('resolveAndValidateWorkspaceRoot — allowlist bypass', () => {
  const dirs: string[] = [];
  afterEach(() => {
    dirs.length = 0;
  });

  it('returns the request root when it is within the default (no allowlist needed)', () => {
    const root = makeDir('su-default-');
    expect(resolveAndValidateWorkspaceRoot(root, root, [])).toBe(root);
  });

  it('throws WORKSPACE_ROOT_OUT_OF_BOUNDARY for an outside root with no allowlist', () => {
    const defaultRoot = makeDir('su-default-');
    const outside = makeDir('su-outside-');
    try {
      resolveAndValidateWorkspaceRoot(outside, defaultRoot, []);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).code).toBe('WORKSPACE_ROOT_OUT_OF_BOUNDARY');
    }
  });

  it('accepts an outside root that matches an explicit allowlist pattern', () => {
    const defaultRoot = makeDir('su-default-');
    const outside = makeDir('su-outside-');
    // Exact path is a valid (literal) pattern; also covers the glob case below.
    expect(resolveAndValidateWorkspaceRoot(outside, defaultRoot, [outside])).toBe(outside);
    expect(
      resolveAndValidateWorkspaceRoot(outside, defaultRoot, [`${realpathSync(tmpdir())}/**`])
    ).toBe(outside);
  });

  it('still rejects an outside root when the allowlist does not match', () => {
    const defaultRoot = makeDir('su-default-');
    const outside = makeDir('su-outside-');
    expect(() =>
      resolveAndValidateWorkspaceRoot(outside, defaultRoot, ['/somewhere/else/**'])
    ).toThrow('workspaceRoot must stay within configured default workspace root');
  });

  it('rejects a non-existent request root regardless of allowlist', () => {
    const defaultRoot = makeDir('su-default-');
    const missing = join(defaultRoot, 'does-not-exist-xyz');
    try {
      resolveAndValidateWorkspaceRoot(missing, defaultRoot, [`${realpathSync(tmpdir())}/**`]);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).code).toBe('INVALID_WORKSPACE_ROOT');
    }
  });
});
