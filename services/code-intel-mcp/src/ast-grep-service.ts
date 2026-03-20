import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { StructMatch, StructSearchResult } from './contracts.ts';
import { assertWithinWorkspace } from './safe-path.ts';
import { isCommandUnavailableError, safeSpawnSync } from './safe-spawn.ts';

interface AstGrepJsonMatch {
  file?: string;
  path?: string;
  text?: string;
  lines?: string;
  range?: {
    start?: { line?: number; column?: number };
    end?: { line?: number; column?: number };
  };
}

type AstGrepRunner = (
  command: string,
  args: string[],
  options: { cwd: string; encoding: BufferEncoding; timeout: number; maxBuffer: number }
) => { status: number | null; stdout: string; stderr: string; error?: unknown };

type AstGrepPostinstallRunner = (
  scriptPath: string,
  options: { cwd: string; encoding: BufferEncoding; timeout: number; maxBuffer: number }
) => { status: number | null; stdout: string; stderr: string; error?: unknown };

let astGrepRunner: AstGrepRunner = (command, args, options) =>
  safeSpawnSync(command, args, {
    cwd: options.cwd,
    encoding: options.encoding,
    timeoutMs: options.timeout,
    maxBufferBytes: options.maxBuffer,
    allowedCommands: [command]
  });

let astGrepPostinstallRunner: AstGrepPostinstallRunner = (scriptPath, options) => {
  const nodeCommand = process.platform === 'win32' ? 'node.exe' : 'node';
  const runResult = spawnSync(nodeCommand, [scriptPath], {
    cwd: options.cwd,
    encoding: options.encoding,
    shell: false,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    windowsHide: true
  });

  return {
    status: runResult.status,
    stdout: runResult.stdout ?? '',
    stderr: runResult.stderr ?? '',
    error: runResult.error
  };
};

export function setAstGrepRunnerForTests(runner: AstGrepRunner): void {
  astGrepRunner = runner;
}

export function resetAstGrepRunnerForTests(): void {
  astGrepRunner = (command, args, options) =>
    safeSpawnSync(command, args, {
      cwd: options.cwd,
      encoding: options.encoding,
      timeoutMs: options.timeout,
      maxBufferBytes: options.maxBuffer,
      allowedCommands: [command]
    });
}

export function setAstGrepPostinstallRunnerForTests(runner: AstGrepPostinstallRunner): void {
  astGrepPostinstallRunner = runner;
}

export function resetAstGrepPostinstallRunnerForTests(): void {
  astGrepPostinstallRunner = (scriptPath, options) => {
    const nodeCommand = process.platform === 'win32' ? 'node.exe' : 'node';
    const runResult = spawnSync(nodeCommand, [scriptPath], {
      cwd: options.cwd,
      encoding: options.encoding,
      shell: false,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      windowsHide: true
    });

    return {
      status: runResult.status,
      stdout: runResult.stdout ?? '',
      stderr: runResult.stderr ?? '',
      error: runResult.error
    };
  };
}

function getPnpmExecutable(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function getLocalAstGrepExecutable(toolRoot: string): string | null {
  const executableName = process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep';
  const executablePath = resolve(toolRoot, 'node_modules', '@ast-grep', 'cli', executableName);
  return existsSync(executablePath) ? executablePath : null;
}

function runAstGrep(
  workspaceRoot: string,
  pattern: string,
  language: string
): { status: number | null; stdout: string; stderr: string; error?: unknown } {
  const timeout = parseSpawnTimeoutFromEnv();
  const maxBuffer = parseSpawnMaxBufferFromEnv();
  const command = getPnpmExecutable();
  const toolRoot = process.cwd();
  const localAstGrepExecutable = getLocalAstGrepExecutable(toolRoot);

  if (localAstGrepExecutable) {
    const localBinaryResult = astGrepRunner(
      localAstGrepExecutable,
      ['run', '--pattern', pattern, '--lang', language, '--json=stream', workspaceRoot],
      {
        cwd: toolRoot,
        encoding: 'utf8',
        timeout,
        maxBuffer
      }
    );

    if (localBinaryResult.status === 0) {
      return localBinaryResult;
    }

    if (!isAstGrepUnavailable(localBinaryResult)) {
      return localBinaryResult;
    }
  }

  const localExecResult = astGrepRunner(
    command,
    [
      '--ignore-workspace',
      'exec',
      'ast-grep',
      'run',
      '--pattern',
      pattern,
      '--lang',
      language,
      '--json=stream',
      workspaceRoot
    ],
    {
      cwd: toolRoot,
      encoding: 'utf8',
      timeout,
      maxBuffer
    }
  );

  if (localExecResult.status === 0) {
    return localExecResult;
  }

  if (isAstGrepUnavailable(localExecResult)) {
    const repaired = tryRepairAstGrepBinary(toolRoot, timeout, maxBuffer);
    if (repaired) {
      const rerunResult = astGrepRunner(
        command,
        [
          '--ignore-workspace',
          'exec',
          'ast-grep',
          'run',
          '--pattern',
          pattern,
          '--lang',
          language,
          '--json=stream',
          workspaceRoot
        ],
        {
          cwd: toolRoot,
          encoding: 'utf8',
          timeout,
          maxBuffer
        }
      );

      if (rerunResult.status === 0) {
        return rerunResult;
      }

      if (!isAstGrepUnavailable(rerunResult)) {
        return rerunResult;
      }
    }
  }

  if (!isAstGrepUnavailable(localExecResult)) {
    return localExecResult;
  }

  return astGrepRunner(
    command,
    [
      '--ignore-workspace',
      'dlx',
      '@ast-grep/cli',
      'run',
      '--pattern',
      pattern,
      '--lang',
      language,
      '--json=stream',
      workspaceRoot
    ],
    {
      cwd: toolRoot,
      encoding: 'utf8',
      timeout,
      maxBuffer
    }
  );
}

function tryRepairAstGrepBinary(toolRoot: string, timeout: number, maxBuffer: number): boolean {
  const postinstallPath = resolve(toolRoot, 'node_modules', '@ast-grep', 'cli', 'postinstall.js');
  if (!existsSync(postinstallPath)) {
    return false;
  }

  const postinstallResult = astGrepPostinstallRunner(postinstallPath, {
    cwd: toolRoot,
    encoding: 'utf8',
    timeout,
    maxBuffer
  });

  return postinstallResult.status === 0;
}

function isAstGrepUnavailable(runResult: {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: unknown;
}): boolean {
  if (runResult.error && isCommandUnavailableError(runResult.error)) {
    return true;
  }

  const output = `${runResult.stderr}\n${runResult.stdout}`.toLowerCase();
  return (
    output.includes('shim file was executed') ||
    output.includes('not recognized as an internal or external command') ||
    output.includes("n'est pas reconnu") ||
    output.includes('n’est pas reconnu')
  );
}

function isTimeoutLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.message.toLowerCase().includes('timed out')) {
    return true;
  }

  const maybeErrno = error as NodeJS.ErrnoException;
  return maybeErrno.code === 'ETIMEDOUT';
}

function buildAstGrepError(runResult: {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: unknown;
}): string {
  const message = runResult.stderr?.trim() || runResult.stdout?.trim() || '';

  if (runResult.error && isCommandUnavailableError(runResult.error)) {
    return 'ast-grep executable not found. Install dependencies with scripts enabled (pnpm install) or ensure @ast-grep/cli is available.';
  }

  if (message.toLowerCase().includes('shim file was executed')) {
    return 'ast-grep binary is not linked. Reinstall with scripts enabled (pnpm install) or run pnpm rebuild @ast-grep/cli.';
  }

  if (isTimeoutLikeError(runResult.error) || runResult.status === null) {
    return 'ast-grep timed out. Increase CODE_INTEL_SPAWN_TIMEOUT (milliseconds) for large workspaces.';
  }

  return message || 'unknown ast-grep error';
}

function parseSpawnTimeoutFromEnv(): number {
  const raw = process.env.CODE_INTEL_SPAWN_TIMEOUT?.trim();
  if (!raw) {
    return 30000;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 30000;
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

function toOneBased(value: number | undefined): number {
  if (typeof value !== 'number') {
    return 1;
  }
  return value >= 0 ? value + 1 : 1;
}

function normalizeMatch(workspaceRoot: string, input: AstGrepJsonMatch): StructMatch | undefined {
  const rawFilePath = input.file ?? input.path;
  if (!rawFilePath) {
    return undefined;
  }

  const absolutePath = resolve(workspaceRoot, rawFilePath);
  const normalizedPath = relative(workspaceRoot, absolutePath).replaceAll('\\', '/');

  return {
    filePath: normalizedPath,
    startLine: toOneBased(input.range?.start?.line),
    startColumn: toOneBased(input.range?.start?.column),
    endLine: toOneBased(input.range?.end?.line),
    endColumn: toOneBased(input.range?.end?.column),
    snippet: (input.text ?? input.lines ?? '').trim()
  };
}

export function searchStructWithAstGrep(
  workspaceRoot: string,
  pattern: string,
  language = 'ts'
): StructSearchResult {
  const safeWorkspaceRoot = assertWithinWorkspace(workspaceRoot, '.');
  const runResult = runAstGrep(safeWorkspaceRoot, pattern, language);

  if (runResult.status === 1) {
    return {
      pattern,
      language,
      matches: []
    };
  }

  if (runResult.status !== 0) {
    throw new Error(`ast-grep execution failed: ${buildAstGrepError(runResult)}`);
  }

  const lines = runResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const matches = lines
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as AstGrepJsonMatch;
        return normalizeMatch(safeWorkspaceRoot, parsed);
      } catch {
        return undefined;
      }
    })
    .filter((value): value is StructMatch => Boolean(value));

  return {
    pattern,
    language,
    matches
  };
}
