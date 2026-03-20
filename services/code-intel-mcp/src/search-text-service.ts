import { existsSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { TextMatch, TextSearchResult } from './contracts.ts';
import { assertWithinWorkspace } from './safe-path.ts';
import { isCommandUnavailableError, safeSpawnSync } from './safe-spawn.ts';
import { collectWorkspaceFiles } from './file-collection.ts';

const DEFAULT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.json']);
const DEFAULT_MAX_RESULTS = 200;

type RipgrepRunner = (
  command: string,
  args: string[],
  options: { cwd: string; encoding: BufferEncoding; timeout: number; maxBuffer: number }
) => { status: number | null; stdout: string; stderr: string; error?: unknown };

let ripgrepRunner: RipgrepRunner = (command, args, options) =>
  safeSpawnSync(command, args, {
    cwd: options.cwd,
    encoding: options.encoding,
    timeoutMs: options.timeout,
    maxBufferBytes: options.maxBuffer,
    allowedCommands: ['rg']
  });

export function setRipgrepRunnerForTests(runner: RipgrepRunner): void {
  ripgrepRunner = runner;
}

export function resetRipgrepRunnerForTests(): void {
  ripgrepRunner = (command, args, options) =>
    safeSpawnSync(command, args, {
      cwd: options.cwd,
      encoding: options.encoding,
      timeoutMs: options.timeout,
      maxBufferBytes: options.maxBuffer,
      allowedCommands: ['rg']
    });
}

function parseRipgrepLine(workspaceRoot: string, line: string): TextMatch | undefined {
  const [filePath, lineRaw, columnRaw, ...rest] = line.split(':');
  if (!filePath || !lineRaw || !columnRaw) {
    return undefined;
  }

  const lineNumber = Number(lineRaw);
  const columnNumber = Number(columnRaw);
  if (!Number.isFinite(lineNumber) || !Number.isFinite(columnNumber)) {
    return undefined;
  }

  const snippet = rest.join(':').trim();
  return {
    filePath: relative(workspaceRoot, resolve(workspaceRoot, filePath)).replaceAll('\\', '/'),
    line: lineNumber,
    column: columnNumber,
    snippet
  };
}

function collectFiles(rootPath: string, searchPath?: string): string[] {
  const canonicalRoot = assertWithinWorkspace(rootPath, '.');
  const includePaths = resolveSearchIncludePaths(canonicalRoot, searchPath);
  const gitignorePatterns = loadGitignoreExcludePatterns(canonicalRoot);

  return collectWorkspaceFiles({
    workspaceRoot: canonicalRoot,
    includePaths,
    excludePatterns: [
      '**/.git/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.next/**',
      ...gitignorePatterns
    ],
    allowedExtensions: DEFAULT_EXTENSIONS
  });
}

function resolveSearchIncludePaths(workspaceRoot: string, searchPath?: string): string[] {
  const normalizedSearchPath = searchPath?.trim();
  if (!normalizedSearchPath || normalizedSearchPath === '.') {
    return ['.'];
  }

  try {
    const resolvedSearchPath = assertWithinWorkspace(workspaceRoot, normalizedSearchPath);
    if (statSync(resolvedSearchPath).isDirectory()) {
      return [normalizedSearchPath];
    }
  } catch {
    return ['.'];
  }

  return ['.'];
}

function loadGitignoreExcludePatterns(workspaceRoot: string): string[] {
  const gitignorePath = resolve(workspaceRoot, '.gitignore');
  if (!existsSync(gitignorePath)) {
    return [];
  }

  const content = readFileSync(gitignorePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const patterns: string[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) {
      continue;
    }

    const withoutLeadingSlash = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
    const normalized = withoutLeadingSlash.replaceAll('\\', '/');

    if (!normalized) {
      continue;
    }

    if (normalized.endsWith('/')) {
      patterns.push(`${normalized}**`);
    } else {
      patterns.push(normalized, `${normalized}/**`);
    }
  }

  return patterns;
}

function parseSpawnTimeoutFromEnv(): number {
  const raw = process.env.CODE_INTEL_SPAWN_TIMEOUT?.trim();
  if (!raw) {
    return 5000;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 5000;
  }

  return parsed;
}

function parseSpawnMaxBufferFromEnv(): number {
  const raw = process.env.CODE_INTEL_SPAWN_MAX_BUFFER?.trim();
  if (!raw) {
    return 4 * 1024 * 1024;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 4 * 1024 * 1024;
  }

  return parsed;
}

function searchWithNodeFallback(
  workspaceRoot: string,
  query: string,
  maxResults = DEFAULT_MAX_RESULTS,
  searchPath?: string
): TextSearchResult {
  const files = collectFiles(workspaceRoot, searchPath);
  const matches: TextMatch[] = [];

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
      const lineContent = lines[index] ?? '';
      const columnIndex = lineContent.indexOf(query);
      if (columnIndex < 0) {
        continue;
      }

      matches.push({
        filePath: relative(workspaceRoot, filePath).replaceAll('\\', '/'),
        line: index + 1,
        column: columnIndex + 1,
        snippet: lineContent.trim()
      });

      if (matches.length >= maxResults) {
        return {
          query,
          engine: 'node-fallback',
          matches
        };
      }
    }
  }

  return {
    query,
    engine: 'node-fallback',
    matches
  };
}

export function searchTextWithRipgrep(
  workspaceRoot: string,
  query: string,
  maxResults = DEFAULT_MAX_RESULTS,
  searchPath?: string
): TextSearchResult {
  const safeWorkspaceRoot = assertWithinWorkspace(workspaceRoot, '.');
  const includePaths = resolveSearchIncludePaths(safeWorkspaceRoot, searchPath);
  const gitignorePath = resolve(safeWorkspaceRoot, '.gitignore');
  const hasGitignore = existsSync(gitignorePath) && statSync(gitignorePath).isFile();
  const args = [
    '--line-number',
    '--column',
    '--no-heading',
    '--color',
    'never',
    '--fixed-strings',
    '--glob',
    '!**/.git/**',
    '--glob',
    '!**/node_modules/**',
    '--glob',
    '!**/dist/**',
    '--glob',
    '!**/coverage/**',
    '--glob',
    '!**/.next/**'
  ];

  if (hasGitignore) {
    args.push('--ignore-file', gitignorePath);
  }

  args.push(query, ...includePaths.map((includePath) => resolve(safeWorkspaceRoot, includePath)));

  const result = ripgrepRunner('rg', args, {
    cwd: safeWorkspaceRoot,
    encoding: 'utf8',
    timeout: parseSpawnTimeoutFromEnv(),
    maxBuffer: parseSpawnMaxBufferFromEnv()
  });

  if (typeof result.status === 'number' && result.status === 0) {
    const matches = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseRipgrepLine(safeWorkspaceRoot, line))
      .filter((value): value is TextMatch => Boolean(value))
      .slice(0, maxResults);

    return {
      query,
      engine: 'ripgrep',
      matches
    };
  }

  if (typeof result.status === 'number' && result.status === 1) {
    return {
      query,
      engine: 'ripgrep',
      matches: []
    };
  }

  if (result.error && !isCommandUnavailableError(result.error)) {
    throw new Error('ripgrep execution failed');
  }

  return searchWithNodeFallback(safeWorkspaceRoot, query, maxResults, searchPath);
}
