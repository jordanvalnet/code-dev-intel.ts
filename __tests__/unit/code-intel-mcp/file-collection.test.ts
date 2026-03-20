import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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

describe('file-collection', () => {
  it('collects allowed files and respects excludes', () => {
    const workspaceRoot = createFixture();
    const files = collectWorkspaceFiles({
      workspaceRoot,
      includePaths: ['.'],
      excludePatterns: ['**/dist/**'],
      allowedExtensions: new Set(['.ts', '.js'])
    });

    expect(files.some((path) => path.endsWith('src\\a.ts') || path.endsWith('src/a.ts'))).toBe(true);
    expect(files.some((path) => path.endsWith('src\\b.js') || path.endsWith('src/b.js'))).toBe(true);
    expect(files.some((path) => path.endsWith('dist\\c.ts') || path.endsWith('dist/c.ts'))).toBe(false);
  });
});
