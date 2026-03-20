import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

interface SafeSpawnSyncOptions {
  cwd: string;
  encoding?: BufferEncoding;
  timeoutMs?: number;
  maxBufferBytes?: number;
  allowedCommands: readonly string[];
}

interface SafeSpawnSyncResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: unknown;
}

type SpawnRunner = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions
) => SpawnSyncReturns<string>;

let spawnRunner: SpawnRunner = (command, args, options) =>
  spawnSync(command, args, options) as SpawnSyncReturns<string>;

export function setSpawnRunnerForTests(runner: SpawnRunner): void {
  spawnRunner = runner;
}

export function resetSpawnRunnerForTests(): void {
  spawnRunner = (command, args, options) =>
    spawnSync(command, args, options) as SpawnSyncReturns<string>;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function resolveTimeoutMs(timeoutMs?: number): number {
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return timeoutMs;
  }

  return parsePositiveInt(process.env.CODE_INTEL_SPAWN_TIMEOUT?.trim(), DEFAULT_TIMEOUT_MS);
}

function resolveMaxBufferBytes(maxBufferBytes?: number): number {
  if (typeof maxBufferBytes === 'number' && Number.isFinite(maxBufferBytes) && maxBufferBytes > 0) {
    return maxBufferBytes;
  }

  return parsePositiveInt(process.env.CODE_INTEL_SPAWN_MAX_BUFFER?.trim(), DEFAULT_MAX_BUFFER_BYTES);
}

function assertAllowedCommand(command: string, allowedCommands: readonly string[]): void {
  if (allowedCommands.length === 0) {
    return;
  }

  if (!allowedCommands.includes(command)) {
    throw new Error(`command not allowed: ${command}`);
  }
}

export function safeSpawnSync(
  command: string,
  args: readonly string[],
  options: SafeSpawnSyncOptions
): SafeSpawnSyncResult {
  assertAllowedCommand(command, options.allowedCommands);

  const timeout = resolveTimeoutMs(options.timeoutMs);
  const maxBuffer = resolveMaxBufferBytes(options.maxBufferBytes);
  const encoding = options.encoding ?? 'utf8';

  const runResult = spawnRunner(command, args, {
    cwd: options.cwd,
    encoding,
    shell: false,
    timeout,
    maxBuffer,
    windowsHide: true
  });

  return {
    status: runResult.status,
    stdout: runResult.stdout ?? '',
    stderr: runResult.stderr ?? '',
    error: runResult.error
  };
}

export function isCommandUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes('ENOENT');
}
