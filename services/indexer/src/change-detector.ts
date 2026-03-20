import { spawnSync } from 'node:child_process';
import { watch } from 'node:fs';
import { extname, resolve } from 'node:path';

export type DetectorMode = 'git-diff' | 'watch' | 'impacted';

export interface ChangeDetectorOptions {
  workspaceRoot: string;
  baseRef?: string;
  includeExtensions?: string[];
}

const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.json'];

export function isRelevantFile(filePath: string, includeExtensions = DEFAULT_EXTENSIONS): boolean {
  const extension = extname(filePath).toLowerCase();
  return includeExtensions.includes(extension);
}

export function listChangedFilesFromGitDiff(options: ChangeDetectorOptions): string[] {
  const baseRef = options.baseRef ?? 'HEAD';
  const includeExtensions = options.includeExtensions ?? DEFAULT_EXTENSIONS;

  const diffResult = spawnSync('git', ['diff', '--name-only', baseRef], {
    cwd: options.workspaceRoot,
    encoding: 'utf-8'
  });

  if (diffResult.status !== 0) {
    const stderr = diffResult.stderr?.trim() || 'unknown git diff error';
    throw new Error(`git diff failed: ${stderr}`);
  }

  const trackedChangedFiles = diffResult.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((filePath) => isRelevantFile(filePath, includeExtensions));

  const untrackedResult = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: options.workspaceRoot,
    encoding: 'utf-8'
  });

  if (untrackedResult.status !== 0) {
    const stderr = untrackedResult.stderr?.trim() || 'unknown git ls-files error';
    throw new Error(`git ls-files failed: ${stderr}`);
  }

  const untrackedRelevantFiles = untrackedResult.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((filePath) => isRelevantFile(filePath, includeExtensions));

  return [...new Set([...trackedChangedFiles, ...untrackedRelevantFiles])];
}

export function watchChangedFiles(
  options: ChangeDetectorOptions,
  onChangedFiles: (files: string[]) => void
): () => void {
  const includeExtensions = options.includeExtensions ?? DEFAULT_EXTENSIONS;
  const pendingFiles = new Set<string>();

  const watcher = watch(options.workspaceRoot, { recursive: true }, (_eventType, filename) => {
    if (!filename) {
      return;
    }

    const normalizedPath = filename.replaceAll('\\', '/');
    if (!isRelevantFile(normalizedPath, includeExtensions)) {
      return;
    }

    pendingFiles.add(normalizedPath);
  });

  const timer = setInterval(() => {
    if (pendingFiles.size === 0) {
      return;
    }

    const files = [...pendingFiles].map((filePath) => resolve(options.workspaceRoot, filePath));
    pendingFiles.clear();
    onChangedFiles(files);
  }, 400);

  return () => {
    clearInterval(timer);
    watcher.close();
  };
}
