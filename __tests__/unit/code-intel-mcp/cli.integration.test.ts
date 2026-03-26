import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

interface CliProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const repoRoot = process.cwd();
const cliScriptPath = 'services/code-intel-mcp/src/server.ts';
const trackedPids = new Set<number>();

async function getAvailablePort(): Promise<number> {
  const server = createServer();

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('unable to allocate test port');
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  return address.port;
}

async function runCliProcess(args: string[], timeoutMs = 20_000): Promise<CliProcessResult> {
  return new Promise<CliProcessResult>((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', cliScriptPath, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODE_INTEL_LOG_LEVEL: 'error'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(new Error(`cli process timed out after ${timeoutMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);

    child.once('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      reject(error);
    });

    child.once('close', (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      resolve({
        exitCode,
        stdout,
        stderr
      });
    });
  });
}

async function waitForHealth(url: string, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.status === 200) {
        const payload = (await response.json()) as Record<string, unknown>;
        if (payload.ok === true && payload.status === 'up') {
          return;
        }
      }
    } catch {
      // Retry until timeout.
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`health endpoint did not become ready: ${url}`);
}

function terminateTrackedProcess(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    });
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Process may already be gone.
  }
}

afterEach(async () => {
  for (const pid of trackedPids) {
    terminateTrackedProcess(pid);
  }

  trackedPids.clear();
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
});

describe('code-dev-intel CLI integration', () => {
  it('ensure starts the server, status sees it healthy, and a second ensure is idempotent', async () => {
    const port = await getAvailablePort();
    const healthUrl = `http://127.0.0.1:${port}/health`;

    const ensureStarted = await runCliProcess([
      'ensure',
      '--workspaceRoot=.',
      `--port=${port}`,
      '--timeout=15000',
      '--verbose'
    ]);

    expect(ensureStarted.exitCode).toBe(0);
    expect(ensureStarted.stderr).toBe('');
    expect(ensureStarted.stdout).toContain('is ready');

    const pidMatch = /pid\s+(\d+)/i.exec(ensureStarted.stdout);
    expect(pidMatch?.[1]).toBeDefined();
    const pid = Number(pidMatch?.[1]);
    expect(Number.isFinite(pid)).toBe(true);
    trackedPids.add(pid);

    await waitForHealth(healthUrl);

    const statusResult = await runCliProcess(['status', `--port=${port}`]);
    expect(statusResult.exitCode).toBe(0);
    expect(statusResult.stdout).toContain('is healthy');

    const ensureAgain = await runCliProcess([
      'ensure',
      '--workspaceRoot=.',
      `--port=${port}`,
      '--timeout=3000'
    ]);
    expect(ensureAgain.exitCode).toBe(0);
    expect(ensureAgain.stdout).toContain('already healthy');
  });
});