import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import picomatch from 'picomatch';
import { assertWithinWorkspace, isPathWithinWorkspace } from './safe-path.ts';

interface CollectWorkspaceFilesOptions {
  workspaceRoot: string;
  includePaths?: string[];
  excludePatterns?: string[];
  allowedExtensions: Set<string>;
}

function toUnixPath(value: string): string {
  return value.replaceAll('\\', '/');
}

export function collectWorkspaceFiles(options: CollectWorkspaceFilesOptions): string[] {
  const includePaths = options.includePaths && options.includePaths.length > 0 ? options.includePaths : ['.'];
  const excludeMatcher = picomatch(options.excludePatterns ?? []);
  const result: string[] = [];
  const visitedDirectories = new Set<string>();

  function walk(currentPath: string): void {
    const realCurrentPath = realpathSync(currentPath);
    if (visitedDirectories.has(realCurrentPath)) {
      return;
    }

    visitedDirectories.add(realCurrentPath);

    for (const entry of readdirSync(currentPath)) {
      const fullPath = join(currentPath, entry);
      const lstat = lstatSync(fullPath);

      if (lstat.isSymbolicLink()) {
        const realEntryPath = realpathSync(fullPath);
        if (!isPathWithinWorkspace(options.workspaceRoot, realEntryPath)) {
          continue;
        }
      }

      if (!isPathWithinWorkspace(options.workspaceRoot, fullPath)) {
        continue;
      }

      const stats = statSync(fullPath);
      const relativePath = toUnixPath(relative(options.workspaceRoot, fullPath));

      if (stats.isDirectory()) {
        if (excludeMatcher(relativePath)) {
          continue;
        }

        walk(fullPath);
        continue;
      }

      if (excludeMatcher(relativePath)) {
        continue;
      }

      if (options.allowedExtensions.has(extname(fullPath).toLowerCase())) {
        result.push(fullPath);
      }
    }
  }

  for (const includePath of includePaths) {
    const safePath = assertWithinWorkspace(options.workspaceRoot, includePath);
    const stats = statSync(safePath);
    if (stats.isDirectory()) {
      walk(safePath);
      continue;
    }

    if (stats.isFile()) {
      result.push(safePath);
    }
  }

  return Array.from(new Set(result)).sort((a, b) => a.localeCompare(b));
}
