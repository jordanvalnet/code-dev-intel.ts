import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectWorkspaceFiles } from '../../../services/code-intel-mcp/src/file-collection.ts';

function createFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dev-intel-file-collection-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  writeFileSync(join(root, 'src', 'b.js'), 'export const b = 2;\n', 'utf8');
  writeFileSync(join(root, 'dist', 'c.ts'), 'export const c = 3;\n', 'utf8');
  return root;
}

function collectFixture(workspaceRoot: string): string[] {
  return collectWorkspaceFiles({
    workspaceRoot,
    includePaths: ['.'],
    excludePatterns: ['**/dist/**'],
    allowedExtensions: new Set(['.ts', '.js'])
  });
}

function includes(files: string[], suffix: string): boolean {
  return files.some((path) => path.endsWith(suffix.replaceAll('/', '\\')) || path.endsWith(suffix));
}

describe('file-collection', () => {
  it('collects allowed files and respects excludes', () => {
    const files = collectFixture(createFixture());

    expect(includes(files, 'src/a.ts')).toBe(true);
    expect(includes(files, 'src/b.js')).toBe(true);
    expect(includes(files, 'dist/c.ts')).toBe(false);
  });

  /**
   * The walk starts from the canonical root, so measuring relative paths from the
   * caller's spelling breaks the moment the two differ — and they differ on every macOS
   * runner (`/var/folders/…` for a real `/private/var/folders/…`) and on a Windows one
   * (an 8.3 short form for the temp directory). The relative path then starts with
   * `../`, picomatch will not let `*`/`**` match a dot-leading segment, and every
   * exclude pattern silently stops matching: `dist` here, `node_modules` in the tools
   * that walk a user's workspace. A symlinked root reproduces that shape on any
   * platform.
   */
  it('applies exclude patterns when the workspace root is reached through a symlink', () => {
    const realRoot = createFixture();
    const linkRoot = join(mkdtempSync(join(tmpdir(), 'dev-intel-file-collection-link-')), 'workspace');
    symlinkSync(realRoot, linkRoot, process.platform === 'win32' ? 'junction' : 'dir');

    const files = collectFixture(linkRoot);

    expect(includes(files, 'src/a.ts')).toBe(true);
    expect(includes(files, 'src/b.js')).toBe(true);
    expect(includes(files, 'dist/c.ts')).toBe(false);
  });
});
