import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertWithinWorkspace,
  createWorkspaceBoundaryCheck,
  isPathWithinWorkspace
} from '../../../services/code-intel-mcp/src/safe-path.ts';

function createWorkspaceFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dev-intel-safe-path-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'file.ts'), 'export const value = 1;\n', 'utf8');
  return root;
}

describe('safe-path', () => {
  it('allows path within workspace root', () => {
    const workspaceRoot = createWorkspaceFixture();

    const safePath = assertWithinWorkspace(workspaceRoot, 'src/file.ts');

    expect(safePath.endsWith('src/file.ts') || safePath.endsWith('src\\file.ts')).toBe(true);
  });

  it('rejects traversal outside workspace root', () => {
    const workspaceRoot = createWorkspaceFixture();

    expect(() => assertWithinWorkspace(workspaceRoot, '../../../etc/passwd')).toThrow(
      'path outside workspace root'
    );
  });

  it('detects path containment for absolute paths', () => {
    const workspaceRoot = createWorkspaceFixture();
    const insidePath = resolve(workspaceRoot, 'src/file.ts');
    const outsidePath = resolve(workspaceRoot, '../outside.ts');

    expect(isPathWithinWorkspace(workspaceRoot, insidePath)).toBe(true);
    expect(isPathWithinWorkspace(workspaceRoot, outsidePath)).toBe(false);
  });

  it('gives the same verdict when the root is canonicalized once up front', () => {
    const workspaceRoot = createWorkspaceFixture();
    const insidePath = resolve(workspaceRoot, 'src/file.ts');
    const outsidePath = resolve(workspaceRoot, '../outside.ts');

    const isWithinRoot = createWorkspaceBoundaryCheck(workspaceRoot);

    expect(isWithinRoot(insidePath)).toBe(isPathWithinWorkspace(workspaceRoot, insidePath));
    expect(isWithinRoot(outsidePath)).toBe(isPathWithinWorkspace(workspaceRoot, outsidePath));
    expect(isWithinRoot(insidePath)).toBe(true);
    expect(isWithinRoot(outsidePath)).toBe(false);
    expect(isWithinRoot(workspaceRoot)).toBe(true);
  });
});
