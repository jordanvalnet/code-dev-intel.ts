import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
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
  // The walk starts from the CANONICAL root (`assertWithinWorkspace` realpaths it), so
  // every path it measures must be measured from that same spelling. Measuring from the
  // caller's spelling is silently wrong wherever the two differ — macOS reports a temp
  // directory as `/var/folders/…` for a real `/private/var/folders/…`, and a Windows
  // temp directory is often handed out in its 8.3 short form — and it does not merely
  // shift the strings: the relative path then starts with `../`, and picomatch does not
  // let `*` or `**` match a segment that begins with a dot, so EVERY exclude pattern
  // stops matching at once and `node_modules`, `dist`, `coverage` and the caller's
  // `.gitignore` entries are all walked and returned.
  const workspaceRoot = assertWithinWorkspace(options.workspaceRoot, '.');
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
        if (!isPathWithinWorkspace(workspaceRoot, realEntryPath)) {
          continue;
        }
      }

      if (!isPathWithinWorkspace(workspaceRoot, fullPath)) {
        continue;
      }

      const stats = statSync(fullPath);
      const relativePath = toUnixPath(relative(workspaceRoot, fullPath));

      if (stats.isDirectory()) {
        // Hidden directories and nested git checkouts (worktrees) are never scanned,
        // matching ripgrep's defaults — see impacted-files-engine.shouldSkipDirectory.
        if (excludeMatcher(relativePath) || basename(fullPath).startsWith('.') || existsSync(join(fullPath, '.git'))) {
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
    const safePath = assertWithinWorkspace(workspaceRoot, includePath);
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
