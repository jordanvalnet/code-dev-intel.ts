import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { relative, resolve } from 'node:path';
import type { StructMatch, StructSearchResult } from './contracts.ts';
import { assertWithinWorkspace } from './safe-path.ts';
import { isCommandUnavailableError, safeSpawnSync } from './safe-spawn.ts';
import { logger } from './logger.ts';

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

interface CommandSpec {
  command: string;
  args: string[];
}

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

let cachedResolvedAstGrepPath: string | undefined;
let resolvedAstGrepPathChecked = false;
let bundledAstGrepPathOverrideForTests: string | null | undefined;

function resolveAstGrepPlatformPackage(): { packageName: string; binaryName: string } {
  const arch = process.env.npm_config_arch || process.arch;
  const binaryName = process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep';

  let abi: string | undefined;
  if (process.platform === 'win32') {
    abi = 'msvc';
  } else if (process.platform === 'linux') {
    abi = arch === 'arm' ? 'gnueabihf' : 'gnu';
  }

  const suffix = abi ? `${process.platform}-${arch}-${abi}` : `${process.platform}-${arch}`;
  return { packageName: `@ast-grep/cli-${suffix}`, binaryName };
}

function resolveBundledAstGrepPath(): string | undefined {
  if (bundledAstGrepPathOverrideForTests !== undefined) {
    return bundledAstGrepPathOverrideForTests ?? undefined;
  }

  if (resolvedAstGrepPathChecked) {
    return cachedResolvedAstGrepPath;
  }
  resolvedAstGrepPathChecked = true;

  const overridePath = process.env.CODE_INTEL_ASTGREP_PATH?.trim();
  if (overridePath && existsSync(overridePath)) {
    cachedResolvedAstGrepPath = overridePath;
    return cachedResolvedAstGrepPath;
  }

  try {
    const requireFromHere = createRequire(import.meta.url);
    const { packageName, binaryName } = resolveAstGrepPlatformPackage();
    const resolved = requireFromHere.resolve(`${packageName}/${binaryName}`);
    if (existsSync(resolved)) {
      cachedResolvedAstGrepPath = resolved;
      return cachedResolvedAstGrepPath;
    }
  } catch (error) {
    logger.warn('failed to resolve bundled @ast-grep/cli platform binary', {
      message: error instanceof Error ? error.message : String(error)
    });
  }

  return undefined;
}

export function resetBundledAstGrepPathCacheForTests(): void {
  cachedResolvedAstGrepPath = undefined;
  resolvedAstGrepPathChecked = false;
  bundledAstGrepPathOverrideForTests = undefined;
}

/**
 * Force the bundled-binary resolution result in tests.
 * Pass `null` to simulate "no bundled binary available" so the pnpm exec/dlx
 * fallback chain can be asserted deterministically across platforms.
 */
export function setBundledAstGrepPathForTests(path: string | null): void {
  bundledAstGrepPathOverrideForTests = path;
}

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

function quotePowerShellArgument(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function createPnpmCommandSpec(args: string[]): CommandSpec {
  const pnpmCommand = getPnpmExecutable();

  if (process.platform !== 'win32') {
    return {
      command: pnpmCommand,
      args
    };
  }

  const commandLine = ['&', ...[pnpmCommand, ...args].map((value) => quotePowerShellArgument(value))].join(' ');
  return {
    command: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', commandLine]
  };
}

function getPackageRoot(): string {
  let currentPath = resolve(fileURLToPath(import.meta.url), '..');

  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(resolve(currentPath, 'package.json'))) {
      return currentPath;
    }

    const parentPath = resolve(currentPath, '..');
    if (parentPath === currentPath) {
      break;
    }

    currentPath = parentPath;
  }

  return process.cwd();
}

let localAstGrepExecutableOverrideForTests: string | null | undefined;

/**
 * Force the local `node_modules/@ast-grep/cli/<binary>` lookup result in tests.
 * That file only exists once @ast-grep/cli's postinstall has run (pnpm 10 blocks
 * build scripts by default), so the fallback chain must not depend on disk state.
 */
export function setLocalAstGrepExecutableForTests(path: string | null): void {
  localAstGrepExecutableOverrideForTests = path;
}

export function resetLocalAstGrepExecutableForTests(): void {
  localAstGrepExecutableOverrideForTests = undefined;
}

function getLocalAstGrepExecutable(toolRoot: string): string | null {
  if (localAstGrepExecutableOverrideForTests !== undefined) {
    return localAstGrepExecutableOverrideForTests;
  }

  const executableName = process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep';
  const executablePath = resolve(toolRoot, 'node_modules', '@ast-grep', 'cli', executableName);
  return existsSync(executablePath) ? executablePath : null;
}

function createAstGrepRunArgs(workspaceRoot: string, pattern: string, language: string): string[] {
  return ['run', '--pattern', pattern, '--lang', language, '--json=stream', workspaceRoot];
}

function createPnpmExecArgs(workspaceRoot: string, pattern: string, language: string): string[] {
  return ['--ignore-workspace', 'exec', 'ast-grep', ...createAstGrepRunArgs(workspaceRoot, pattern, language)];
}

function createPnpmDlxArgs(workspaceRoot: string, pattern: string, language: string): string[] {
  return [
    '--ignore-workspace',
    '--package=@ast-grep/cli',
    'dlx',
    'ast-grep',
    ...createAstGrepRunArgs(workspaceRoot, pattern, language)
  ];
}

function resolveExecAstGrepResult(
  initialResult: { status: number | null; stdout: string; stderr: string; error?: unknown },
  command: string,
  execArgs: string[],
  toolRoot: string,
  timeout: number,
  maxBuffer: number
): { status: number | null; stdout: string; stderr: string; error?: unknown } | null {
  if (!isAstGrepUnavailable(initialResult)) {
    return initialResult;
  }

  const repaired = tryRepairAstGrepBinary(toolRoot, timeout, maxBuffer);
  if (!repaired) {
    return null;
  }

  return astGrepRunner(command, execArgs, {
    cwd: toolRoot,
    encoding: 'utf8',
    timeout,
    maxBuffer
  });
}

function runAstGrep(
  workspaceRoot: string,
  pattern: string,
  language: string
): { status: number | null; stdout: string; stderr: string; error?: unknown } {
  const timeout = parseSpawnTimeoutFromEnv();
  const maxBuffer = parseSpawnMaxBufferFromEnv();
  const packageRoot = getPackageRoot();

  // Preferred path: a directly-resolved bundled platform binary (no pnpm/network at runtime).
  const bundledAstGrepPath = resolveBundledAstGrepPath();
  if (bundledAstGrepPath) {
    const bundledResult = astGrepRunner(bundledAstGrepPath, createAstGrepRunArgs(workspaceRoot, pattern, language), {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout,
      maxBuffer
    });

    if (bundledResult.status === 0 || !isAstGrepUnavailable(bundledResult)) {
      return bundledResult;
    }
  }

  const localAstGrepExecutable = getLocalAstGrepExecutable(packageRoot);
  const execArgs = createPnpmExecArgs(workspaceRoot, pattern, language);
  const execCommand = createPnpmCommandSpec(execArgs);

  if (localAstGrepExecutable) {
    const localBinaryResult = astGrepRunner(localAstGrepExecutable, createAstGrepRunArgs(workspaceRoot, pattern, language), {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout,
      maxBuffer
    });

    if (localBinaryResult.status === 0) {
      return localBinaryResult;
    }

    if (!isAstGrepUnavailable(localBinaryResult)) {
      return localBinaryResult;
    }
  }

  const localExecResult = astGrepRunner(execCommand.command, execCommand.args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    timeout,
    maxBuffer
  });

  if (localExecResult.status === 0) {
    return localExecResult;
  }

  const resolvedExecResult = resolveExecAstGrepResult(
    localExecResult,
    execCommand.command,
    execCommand.args,
    packageRoot,
    timeout,
    maxBuffer
  );

  if (resolvedExecResult) {
    return resolvedExecResult;
  }

  const dlxCommand = createPnpmCommandSpec(createPnpmDlxArgs(workspaceRoot, pattern, language));

  return astGrepRunner(dlxCommand.command, dlxCommand.args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    timeout,
    maxBuffer
  });
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
    // Graceful degrade: when the ast-grep binary is simply unavailable in this
    // install (platform binary never fetched / shim not linked), do NOT 500.
    // Mirror searchText's node-fallback behaviour and return an empty result
    // annotated with the reason so callers can fall back to searchText/Grep.
    if (isAstGrepUnavailable(runResult)) {
      return {
        pattern,
        language,
        matches: [],
        engineFallbackReason: buildAstGrepError(runResult)
      };
    }

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
