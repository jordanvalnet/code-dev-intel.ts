import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { calculateWorkspaceImpactedFiles } from '../../../services/indexer/src/impacted-files-engine.js';

const tempDirs: string[] = [];

function createWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'impacted-engine-'));
  tempDirs.push(root);
  return root;
}

function writeSourceFile(root: string, relativePath: string, content: string): void {
  const parts = relativePath.split('/');
  const fileName = parts.pop();
  if (!fileName) {
    throw new Error('Invalid file path');
  }

  const dirPath = join(root, ...parts);
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(join(dirPath, fileName), content, 'utf8');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('calculateWorkspaceImpactedFiles', () => {
  it('propagates impact transitively through importers', () => {
    const root = createWorkspace();

    writeSourceFile(
      root,
      'src/a.ts',
      ['export function core() {', '  return 1;', '}', ''].join('\n')
    );
    writeSourceFile(
      root,
      'src/b.ts',
      ["import { core } from './a';", 'export const b = core();', ''].join('\n')
    );
    writeSourceFile(
      root,
      'src/c.ts',
      ["import { b } from './b';", 'export const c = b + 1;', ''].join('\n')
    );

    const impacted = calculateWorkspaceImpactedFiles({
      workspaceRoot: root,
      changedFiles: ['src/a.ts']
    });

    expect(impacted).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('filters importers when changed symbols are provided', () => {
    const root = createWorkspace();

    writeSourceFile(
      root,
      'src/base.ts',
      ['export const foo = 1;', 'export const bar = 2;', ''].join('\n')
    );
    writeSourceFile(
      root,
      'src/uses-foo.ts',
      ["import { foo } from './base';", 'export const value = foo;', ''].join('\n')
    );
    writeSourceFile(
      root,
      'src/uses-bar.ts',
      ["import { bar } from './base';", 'export const value = bar;', ''].join('\n')
    );

    const impacted = calculateWorkspaceImpactedFiles({
      workspaceRoot: root,
      changedFiles: ['src/base.ts'],
      changedSymbolsByFile: {
        'src/base.ts': ['foo']
      }
    });

    expect(impacted).toEqual(['src/base.ts', 'src/uses-foo.ts']);
  });

  it('handles import cycles without infinite traversal', () => {
    const root = createWorkspace();

    writeSourceFile(
      root,
      'src/a.ts',
      ["import { b } from './b';", 'export const a = b + 1;', ''].join('\n')
    );
    writeSourceFile(
      root,
      'src/b.ts',
      ["import { a } from './a';", 'export const b = a + 1;', ''].join('\n')
    );

    const impacted = calculateWorkspaceImpactedFiles({
      workspaceRoot: root,
      changedFiles: ['src/a.ts']
    });

    expect(impacted).toEqual(['src/a.ts', 'src/b.ts']);
  });
});
