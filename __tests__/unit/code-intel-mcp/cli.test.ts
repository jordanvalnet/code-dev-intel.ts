import type { ChildProcess } from 'node:child_process';
import type { Mock } from 'vitest';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildStartChildArguments,
  createDetachedStartSpawnOptions,
  parseCliOptions,
  probeHealthEndpoint,
  runCli
} from '../../../services/code-intel-mcp/src/cli.ts';
import { DEFAULT_MAX_BODY_BYTES } from '../../../services/code-intel-mcp/src/server-config.ts';
import { startMcpSkeletonServer } from '../../../services/code-intel-mcp/src/server.ts';

function createJsonResponse(status: number, payload: unknown): Response {
  return {
    status,
    json: () => Promise.resolve(payload)
  } as Response;
}

function createWritableCapture(): { lines: string[]; write: (chunk: string) => boolean } {
  const lines: string[] = [];

  return {
    lines,
    write: (chunk: string) => {
      lines.push(chunk);
      return true;
    }
  };
}

function createDetachedChild(pid = 1234): ChildProcess {
  return {
    pid,
    unref: vi.fn()
  } as unknown as ChildProcess;
}

function createFetchMock(responses: Response[]): typeof fetch {
  const mock = vi.fn(() => Promise.resolve(responses.shift() ?? createJsonResponse(503, { ok: false, status: 'down' })));
  return mock as unknown as typeof fetch;
}

function createSpawnMock(child: ChildProcess): (command: string, args: readonly string[], options: object) => ChildProcess {
  const mock = vi.fn(() => child);
  return mock as unknown as (command: string, args: readonly string[], options: object) => ChildProcess;
}

let runningServer: Server | undefined;

afterEach(async () => {
  if (!runningServer) {
    return;
  }

  await new Promise<void>((resolveClose) => {
    runningServer?.close(() => resolveClose());
  });

  runningServer = undefined;
});

describe('code-dev-intel CLI', () => {
  it('parses ensure options including overrides', () => {
    const options = parseCliOptions(
      [
        'ensure',
        '--workspaceRoot=.',
        '--port=4545',
        '--timeout=3000',
        '--host=localhost',
        '--health-url=/health',
        '--verbose'
      ],
      {}
    );

    expect(options.command).toBe('ensure');
    expect(options.legacyMode).toBe(false);
    expect(options.startOptions.workspaceRoot).toBe('.');
    expect(options.startOptions.port).toBe(4545);
    expect(options.startOptions.host).toBe('localhost');
    expect(options.timeoutMs).toBe(3000);
    expect(options.healthUrl).toBe('/health');
    expect(options.verbose).toBe(true);
  });

  it('builds detached spawn options with explicit Windows handling', () => {
    const windowsOptions = createDetachedStartSpawnOptions('win32', process.cwd());
    const unixOptions = createDetachedStartSpawnOptions('linux', process.cwd());

    expect(windowsOptions.detached).toBe(true);
    expect(windowsOptions.stdio).toBe('ignore');
    expect(windowsOptions.windowsHide).toBe(true);
    expect(unixOptions.windowsHide).toBe(false);
  });

  it('builds start child arguments without ensure-only flags', () => {
    const args = buildStartChildArguments({
      workspaceRoot: '.',
      host: '127.0.0.1',
      port: 4545,
      logRequests: true,
      apiKey: undefined,
      maxBodyBytes: DEFAULT_MAX_BODY_BYTES
    });

    expect(args).toEqual([
      'start',
      '--host=127.0.0.1',
      '--port=4545',
      '--workspaceRoot=.',
      '--log-requests'
    ]);
  });

  it('probes the real health endpoint successfully', async () => {
    const server = startMcpSkeletonServer(0);
    runningServer = server;

    await new Promise<void>((resolveReady) => {
      server.once('listening', () => resolveReady());
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('invalid server address');
    }

    const result = await probeHealthEndpoint({
      host: '127.0.0.1',
      port: address.port,
      logRequests: false,
      apiKey: undefined,
      maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
      workspaceRoot: undefined
    });

    expect(result.ok).toBe(true);
    expect(result.url).toContain(`/health`);
  });

  it('returns 0 when ensure finds an already healthy server', async () => {
    const stdout = createWritableCapture();
    const stderr = createWritableCapture();
    const spawnImpl = vi.fn();
    const fetchImpl = createFetchMock([createJsonResponse(200, { ok: true, status: 'up' })]);

    const exitCode = await runCli(['ensure', '--workspaceRoot=.', '--port=4545'], {
      env: {},
      fetchImpl,
      spawnImpl,
      stdout,
      stderr,
      execPath: process.execPath,
      execArgv: [],
      scriptPath: process.argv[1],
      platform: process.platform,
      cwd: process.cwd(),
      startForegroundServer: vi.fn()
    });

    expect(exitCode).toBe(0);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(stdout.lines.join('')).toContain('already healthy');
    expect(stderr.lines).toHaveLength(0);
  });

  it('returns 0 when ensure starts the server and it becomes healthy', async () => {
    const stdout = createWritableCapture();
    const stderr = createWritableCapture();
    const spawnImpl = createSpawnMock(createDetachedChild());
    const fetchImpl = createFetchMock([
      createJsonResponse(503, { ok: false, status: 'down' }),
      createJsonResponse(200, { ok: true, status: 'up' })
    ]);
    let currentTime = 0;
    const now = () => {
      currentTime += 100;
      return currentTime;
    };

    const exitCode = await runCli(
      ['ensure', '--workspaceRoot=.', '--port=4545', '--timeout=2000'],
      {
        env: {},
        fetchImpl,
        now,
        sleep: () => Promise.resolve(),
        spawnImpl,
        stdout,
        stderr,
        execPath: process.execPath,
        execArgv: [],
        scriptPath: process.argv[1],
        platform: process.platform,
        cwd: process.cwd(),
        startForegroundServer: vi.fn()
      }
    );

    expect(exitCode).toBe(0);
    expect((spawnImpl as unknown as Mock).mock.calls).toHaveLength(1);
    expect(stdout.lines.join('')).toContain('is ready');
    expect(stderr.lines).toHaveLength(0);
  });

  it('returns non-zero when ensure times out before health becomes available', async () => {
    const stdout = createWritableCapture();
    const stderr = createWritableCapture();
    const spawnImpl = createSpawnMock(createDetachedChild());
    const fetchImpl = createFetchMock([createJsonResponse(503, { ok: false, status: 'down' })]);
    let currentTime = 0;
    const now = () => {
      currentTime += 300;
      return currentTime;
    };

    const exitCode = await runCli(
      ['ensure', '--workspaceRoot=.', '--port=4545', '--timeout=500'],
      {
        env: {},
        fetchImpl,
        now,
        sleep: () => Promise.resolve(),
        spawnImpl,
        stdout,
        stderr,
        execPath: process.execPath,
        execArgv: [],
        scriptPath: process.argv[1],
        platform: process.platform,
        cwd: process.cwd(),
        startForegroundServer: vi.fn()
      }
    );

    expect(exitCode).toBe(1);
    expect((spawnImpl as unknown as Mock).mock.calls).toHaveLength(1);
    expect(stderr.lines.join('')).toContain('did not become healthy');
  });

  it('returns non-zero when status detects an unhealthy server', async () => {
    const stdout = createWritableCapture();
    const stderr = createWritableCapture();
    const fetchImpl = createFetchMock([createJsonResponse(503, { ok: false, status: 'down' })]);

    const exitCode = await runCli(['status', '--port=4545'], {
      env: {},
      fetchImpl,
      stdout,
      stderr,
      execPath: process.execPath,
      execArgv: [],
      scriptPath: process.argv[1],
      platform: process.platform,
      cwd: process.cwd(),
      startForegroundServer: vi.fn()
    });

    expect(exitCode).toBe(1);
    expect(stdout.lines).toHaveLength(0);
    expect(stderr.lines.join('')).toContain('is not healthy');
  });
});