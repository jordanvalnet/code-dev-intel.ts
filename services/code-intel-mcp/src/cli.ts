import { spawn as spawnChildProcess, type ChildProcess, type SpawnOptions } from 'node:child_process';
import {
  DEFAULT_ENSURE_TIMEOUT_MS,
  DEFAULT_HEALTH_PATH,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_PORT
} from './server-config.ts';
import { isExistingDirectory, normalizeWorkspaceRoot, toErrorMessage } from './server-utils.ts';

export type CliCommand = 'start' | 'status' | 'ensure' | 'help' | 'self-test' | 'stdio';

export interface CliStartOptions {
  workspaceRoot?: string;
  host: string;
  port: number;
  logRequests: boolean;
  apiKey?: string;
  maxBodyBytes: number;
}

export interface ResolvedCliOptions {
  command: CliCommand;
  legacyMode: boolean;
  startOptions: CliStartOptions;
  timeoutMs: number;
  healthUrl?: string;
  verbose: boolean;
}

export interface HealthCheckSuccess {
  ok: true;
  url: string;
  statusCode: number;
  payload: unknown;
}

export interface HealthCheckFailure {
  ok: false;
  url: string;
  statusCode?: number;
  error: string;
  payload?: unknown;
}

export type HealthCheckResult = HealthCheckSuccess | HealthCheckFailure;

export interface WaitForHealthOptions {
  timeoutMs: number;
  intervalMs?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, result: HealthCheckFailure) => void;
}

export interface CliRunDependencies {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  stdout?: Pick<NodeJS.WriteStream, 'write'>;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
  execPath?: string;
  execArgv?: string[];
  scriptPath?: string;
  platform?: NodeJS.Platform;
  cwd?: string;
  startForegroundServer: (options: CliStartOptions, executionMode: { allowPrompt: boolean }) => Promise<void> | void;
}

const KNOWN_COMMANDS = new Set<CliCommand>(['start', 'status', 'ensure', 'help', 'self-test', 'stdio']);
const DEFAULT_HEALTH_REQUEST_TIMEOUT_MS = 1_000;

function parsePositiveInteger(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function readOption(argv: string[], optionName: string): string | undefined {
  const prefix = `--${optionName}=`;

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current) {
      continue;
    }

    if (current.startsWith(prefix)) {
      const raw = current.slice(prefix.length).trim();
      return raw.length > 0 ? raw : undefined;
    }

    if (current === `--${optionName}`) {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) {
        return undefined;
      }
      return next.trim() || undefined;
    }
  }

  return undefined;
}

function hasFlag(argv: string[], optionName: string): boolean {
  return argv.includes(`--${optionName}`);
}

function readFirstPositional(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current) {
      continue;
    }

    if (!current.startsWith('--')) {
      const previous = argv[index - 1];
      if (previous === '--workspaceRoot' || previous === '--port' || previous === '--timeout' || previous === '--host' || previous === '--health-url') {
        continue;
      }
      return current;
    }
  }

  return undefined;
}

function parseBooleanEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseHost(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function formatDurationMs(durationMs: number): string {
  return `${durationMs}ms`;
}

function writeLine(stream: Pick<NodeJS.WriteStream, 'write'> | undefined, message: string): void {
  stream?.write(`${message}\n`);
}

function isHealthPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const candidate = payload as Record<string, unknown>;
  return candidate.ok === true && candidate.status === 'up';
}

function resolveHealthCheckUrl(startOptions: CliStartOptions, healthUrlOverride?: string): string {
  const trimmed = healthUrlOverride?.trim();
  if (trimmed) {
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return trimmed;
    }

    const normalizedPath = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    return new URL(normalizedPath, `http://${startOptions.host}:${startOptions.port}`).toString();
  }

  return new URL(DEFAULT_HEALTH_PATH, `http://${startOptions.host}:${startOptions.port}`).toString();
}

function createRequestTimeoutSignal(timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timeoutId)
  };
}

export async function probeHealthEndpoint(
  startOptions: CliStartOptions,
  healthUrlOverride?: string,
  fetchImpl: typeof fetch = fetch,
  requestTimeoutMs = DEFAULT_HEALTH_REQUEST_TIMEOUT_MS
): Promise<HealthCheckResult> {
  const url = resolveHealthCheckUrl(startOptions, healthUrlOverride);
  const { signal, cancel } = createRequestTimeoutSignal(requestTimeoutMs);

  try {
    const response = await fetchImpl(url, { signal });
    let payload: unknown;

    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }

    if (response.status === 200 && isHealthPayload(payload)) {
      return {
        ok: true,
        url,
        statusCode: response.status,
        payload
      };
    }

    const statusSuffix = response.status ? ` (HTTP ${response.status})` : '';

    return {
      ok: false,
      url,
      statusCode: response.status,
      payload,
      error: `unexpected health response${statusSuffix}`
    };
  } catch (error) {
    return {
      ok: false,
      url,
      error: toErrorMessage(error)
    };
  } finally {
    cancel();
  }
}

export async function waitForHealthyEndpoint(
  startOptions: CliStartOptions,
  healthUrlOverride: string | undefined,
  options: WaitForHealthOptions
): Promise<HealthCheckResult> {
  const timeoutMs = options.timeoutMs;
  const intervalMs = options.intervalMs ?? 250;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_HEALTH_REQUEST_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  let attempt = 0;
  let lastFailure: HealthCheckFailure | undefined;

  while (now() - startedAt <= timeoutMs) {
    attempt += 1;
    const result = await probeHealthEndpoint(startOptions, healthUrlOverride, fetchImpl, requestTimeoutMs);
    if (result.ok) {
      return result;
    }

    lastFailure = result;
    options.onRetry?.(attempt, result);

    const elapsedMs = now() - startedAt;
    const remainingMs = timeoutMs - elapsedMs;
    if (remainingMs <= 0) {
      break;
    }

    await sleep(Math.min(intervalMs, remainingMs));
  }

  return lastFailure ?? {
    ok: false,
    url: resolveHealthCheckUrl(startOptions, healthUrlOverride),
    error: 'health check did not complete'
  };
}

export function createDetachedStartSpawnOptions(platform: NodeJS.Platform, cwd?: string): SpawnOptions {
  return {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: platform === 'win32'
  };
}

export function buildStartChildArguments(startOptions: CliStartOptions): string[] {
  const args = [
    'start',
    `--host=${startOptions.host}`,
    `--port=${startOptions.port}`
  ];

  if (startOptions.workspaceRoot) {
    args.push(`--workspaceRoot=${startOptions.workspaceRoot}`);
  }

  if (startOptions.logRequests) {
    args.push('--log-requests');
  }

  return args;
}

export function spawnDetachedStartProcess(
  startOptions: CliStartOptions,
  dependencies: Pick<CliRunDependencies, 'spawnImpl' | 'execArgv' | 'execPath' | 'platform' | 'scriptPath' | 'cwd'>
): ChildProcess {
  const spawnImpl = dependencies.spawnImpl ?? spawnChildProcess;
  const execPath = dependencies.execPath;
  const scriptPath = dependencies.scriptPath;
  if (!execPath || !scriptPath) {
    throw new Error('unable to resolve current executable entrypoint');
  }

  const commandArguments = [...(dependencies.execArgv ?? []), scriptPath, ...buildStartChildArguments(startOptions)];
  const child = spawnImpl(
    execPath,
    commandArguments,
    createDetachedStartSpawnOptions(dependencies.platform ?? process.platform, dependencies.cwd)
  );
  child.unref();
  return child;
}

export function parseCliOptions(argv: string[], env: NodeJS.ProcessEnv = process.env): ResolvedCliOptions {
  let requestedCommand: string | undefined;
  if (hasFlag(argv, 'stdio')) {
    requestedCommand = 'stdio';
  } else if (hasFlag(argv, 'self-test')) {
    requestedCommand = 'self-test';
  } else {
    requestedCommand = readFirstPositional(argv);
  }

  let command: CliCommand | undefined;
  if (!requestedCommand) {
    command = 'start';
  } else if (KNOWN_COMMANDS.has(requestedCommand as CliCommand)) {
    command = requestedCommand as CliCommand;
  }

  if (!command) {
    throw new Error(`unknown command: ${requestedCommand}`);
  }

  const legacyMode = !requestedCommand;
  const workspaceRoot =
    readOption(argv, 'workspaceRoot') ?? normalizeWorkspaceRoot(env.CODE_INTEL_WORKSPACE_ROOT);
  const host = parseHost(readOption(argv, 'host')) ?? parseHost(env.CODE_INTEL_HOST) ?? '127.0.0.1';
  const port = parsePositiveInteger(readOption(argv, 'port')) ?? parsePositiveInteger(env.CODE_INTEL_PORT) ?? DEFAULT_PORT;
  const timeoutMs = parsePositiveInteger(readOption(argv, 'timeout')) ?? DEFAULT_ENSURE_TIMEOUT_MS;
  const healthUrl = readOption(argv, 'health-url');
  const verbose = hasFlag(argv, 'verbose');
  const logRequests = hasFlag(argv, 'log-requests') || hasFlag(argv, 'logRequests') || parseBooleanEnv(env.CODE_INTEL_LOG_REQUESTS);
  const apiKey = parseHost(env.CODE_INTEL_API_KEY);
  const maxBodyBytes = parsePositiveInteger(env.CODE_INTEL_MAX_BODY_BYTES) ?? DEFAULT_MAX_BODY_BYTES;

  return {
    command,
    legacyMode,
    startOptions: {
      workspaceRoot,
      host,
      port,
      logRequests,
      apiKey,
      maxBodyBytes
    },
    timeoutMs,
    healthUrl,
    verbose
  };
}

function renderHelp(): string {
  return [
    'Usage: code-dev-intel <command> [options]',
    '',
    'Commands:',
    '  start    Start the code-intel HTTP server in the foreground.',
    '  status   Check whether the code-intel HTTP server is healthy.',
    '  ensure   Start the server if needed and wait until it is healthy.',
    '',
    'Common options:',
    '  --workspaceRoot <path>   Default workspace root for tool requests.',
    '  --port <number>          Server port. Default: 4545.',
    '  --timeout <ms>           Health wait timeout for ensure/status helpers.',
    '  --host <host>            Server host. Default: 127.0.0.1.',
    '  --health-url <url>       Override the health endpoint URL/path.',
    '  --verbose                Print progress details for helper commands.'
  ].join('\n');
}

async function runStatusCommand(options: ResolvedCliOptions, dependencies: CliRunDependencies): Promise<number> {
  const stdout = dependencies.stdout;
  const stderr = dependencies.stderr;
  const result = await probeHealthEndpoint(options.startOptions, options.healthUrl, dependencies.fetchImpl);

  if (result.ok) {
    writeLine(stdout, `code-dev-intel is healthy at ${result.url}`);
    return 0;
  }

  writeLine(stderr, `code-dev-intel is not healthy at ${result.url}: ${result.error}`);
  return 1;
}

async function runEnsureCommand(options: ResolvedCliOptions, dependencies: CliRunDependencies): Promise<number> {
  const stdout = dependencies.stdout;
  const stderr = dependencies.stderr;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep;
  const initialHealth = await probeHealthEndpoint(options.startOptions, options.healthUrl, dependencies.fetchImpl);

  if (initialHealth.ok) {
    writeLine(stdout, `code-dev-intel is already healthy at ${initialHealth.url}`);
    return 0;
  }

  if (options.startOptions.workspaceRoot && !isExistingDirectory(options.startOptions.workspaceRoot)) {
    writeLine(stderr, `workspaceRoot not found: ${options.startOptions.workspaceRoot}`);
    return 1;
  }

  try {
    const child = spawnDetachedStartProcess(options.startOptions, {
      spawnImpl: dependencies.spawnImpl,
      execArgv: dependencies.execArgv,
      execPath: dependencies.execPath,
      platform: dependencies.platform,
      scriptPath: dependencies.scriptPath,
      cwd: dependencies.cwd
    });

    if (options.verbose) {
      const pidSuffix = child.pid ? ` (pid ${child.pid})` : '';
      writeLine(stdout, `spawned background code-dev-intel process${pidSuffix}`);
    }
  } catch (error) {
    writeLine(stderr, `failed to start code-dev-intel in background: ${toErrorMessage(error)}`);
    return 1;
  }

  const healthResult = await waitForHealthyEndpoint(options.startOptions, options.healthUrl, {
    timeoutMs: options.timeoutMs,
    fetchImpl: dependencies.fetchImpl,
    now,
    sleep,
    onRetry: options.verbose
      ? (_attempt, result) => {
          writeLine(stdout, `waiting for code-dev-intel at ${result.url}: ${result.error}`);
        }
      : undefined
  });

  if (healthResult.ok) {
    writeLine(stdout, `code-dev-intel is ready at ${healthResult.url}`);
    return 0;
  }

  writeLine(
    stderr,
    `code-dev-intel did not become healthy within ${formatDurationMs(options.timeoutMs)} at ${healthResult.url}: ${healthResult.error}`
  );
  return 1;
}

export async function runCli(argv: string[], dependencies: CliRunDependencies): Promise<number> {
  const options = parseCliOptions(argv, dependencies.env);

  if (options.command === 'help') {
    writeLine(dependencies.stdout, renderHelp());
    return 0;
  }

  if (options.command === 'status') {
    return runStatusCommand(options, dependencies);
  }

  if (options.command === 'ensure') {
    return runEnsureCommand(options, dependencies);
  }

  if (options.command === 'self-test' || options.command === 'stdio') {
    return 0;
  }

  if (!options.legacyMode && options.startOptions.workspaceRoot && !isExistingDirectory(options.startOptions.workspaceRoot)) {
    writeLine(dependencies.stderr, `workspaceRoot not found: ${options.startOptions.workspaceRoot}`);
    return 1;
  }

  await dependencies.startForegroundServer(options.startOptions, {
    allowPrompt: options.legacyMode
  });
  return 0;
}