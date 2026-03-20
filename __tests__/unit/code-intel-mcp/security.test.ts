import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startMcpSkeletonServer } from '../../../services/code-intel-mcp/src/server.ts';

let runningServer: Server | undefined;

async function startServer(defaultWorkspaceRoot?: string): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = startMcpSkeletonServer(0, defaultWorkspaceRoot);
  runningServer = server;

  await new Promise<void>((resolveReady) => {
    server.once('listening', () => resolveReady());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('invalid server address');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      })
  };
}

afterEach(async () => {
  if (runningServer) {
    await new Promise<void>((resolveClose) => {
      runningServer?.close(() => resolveClose());
    });
  }

  runningServer = undefined;
  delete process.env.CODE_INTEL_MAX_BODY_BYTES;
  delete process.env.CODE_INTEL_HOST;
  delete process.env.CODE_INTEL_API_KEY;
});

describe('mcp security hardening', () => {
  const fixtureWorkspaceRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/self-test-workspace');

  it('rejects payload larger than configured limit', async () => {
    process.env.CODE_INTEL_MAX_BODY_BYTES = '1024';
    const { baseUrl, close } = await startServer();

    const response = await fetch(`${baseUrl}/tools/searchText`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceRoot: fixtureWorkspaceRoot, query: 'x'.repeat(5000) })
    });

    const payload = (await response.json()) as { ok: boolean; error: string };
    expect(response.status).toBe(413);
    expect(payload.error).toBe('payload too large');

    await close();
    runningServer = undefined;
  });

  it('rejects invalid json bodies with HTTP 400', async () => {
    const { baseUrl, close } = await startServer();

    const response = await fetch(`${baseUrl}/tools/searchText`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"workspaceRoot":"bad"'
    });

    const payload = (await response.json()) as { ok: boolean; error: string };
    expect(response.status).toBe(400);
    expect(payload.error).toBe('invalid json body');

    await close();
    runningServer = undefined;
  });

  it('rejects unknown body fields due to strict schema', async () => {
    const { baseUrl, close } = await startServer();

    const response = await fetch(`${baseUrl}/tools/searchText`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceRoot: fixtureWorkspaceRoot,
        query: 'buildGreeting',
        unsupported: true
      })
    });

    const payload = (await response.json()) as { ok: boolean; error: string };
    expect(response.status).toBe(400);
    expect(payload.error).toBe('invalid tool request body');

    await close();
    runningServer = undefined;
  });

  it('rejects workspaceRoot escaping configured default boundary', async () => {
    const outsideRoot = mkdtempSync(join(tmpdir(), 'dev-intel-security-outside-'));
    const { baseUrl, close } = await startServer(fixtureWorkspaceRoot);

    const response = await fetch(`${baseUrl}/tools/searchText`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceRoot: outsideRoot,
        query: 'buildGreeting'
      })
    });

    const payload = (await response.json()) as { ok: boolean; error: string };
    expect(response.status).toBe(400);
    expect(payload.error).toBe('workspaceRoot must stay within configured default workspace root');

    await close();
    runningServer = undefined;
  });

  it('requires api key when non-local host is configured', async () => {
    process.env.CODE_INTEL_HOST = '0.0.0.0';
    const { baseUrl, close } = await startServer();

    const response = await fetch(`${baseUrl}/tools/searchText`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceRoot: fixtureWorkspaceRoot, query: 'buildGreeting' })
    });

    const payload = (await response.json()) as { ok: boolean; error: string };
    expect(response.status).toBe(401);
    expect(payload.error).toBe('api key required for non-local host');

    await close();
    runningServer = undefined;
  });

  it('enforces x-api-key header when api key is configured', async () => {
    process.env.CODE_INTEL_API_KEY = 'security-key';
    const { baseUrl, close } = await startServer();

    const unauthorized = await fetch(`${baseUrl}/tools/searchText`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceRoot: fixtureWorkspaceRoot, query: 'buildGreeting' })
    });

    const authorized = await fetch(`${baseUrl}/tools/searchText`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'security-key'
      },
      body: JSON.stringify({ workspaceRoot: fixtureWorkspaceRoot, query: 'buildGreeting' })
    });

    expect(unauthorized.status).toBe(401);
    expect(authorized.status).toBe(200);

    await close();
    runningServer = undefined;
  });
});
