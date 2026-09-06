import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startMcpSkeletonServer } from '../../../services/code-intel-mcp/src/server.ts';
import { assertWithinWorkspace } from '../../../services/code-intel-mcp/src/safe-path.ts';

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
  delete process.env.CODE_INTEL_ALLOWED_WORKSPACE_ROOTS;
  delete process.env.CODE_INTEL_ALLOWED_ORIGINS;
});

/** Raw HTTP POST so the test can set headers (such as Origin) that fetch() may refuse to forward. */
function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; payload: { ok: boolean; error?: string } }> {
  return new Promise((resolveResponse, rejectResponse) => {
    const target = new URL(url);
    const serialized = JSON.stringify(body);
    const clientRequest = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(serialized), ...headers }
      },
      (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (raw += chunk));
        response.on('end', () => {
          try {
            resolveResponse({ status: response.statusCode ?? 0, payload: JSON.parse(raw) as { ok: boolean; error?: string } });
          } catch (error) {
            rejectResponse(error instanceof Error ? error : new Error(String(error)));
          }
        });
      }
    );
    clientRequest.on('error', rejectResponse);
    clientRequest.end(serialized);
  });
}

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

  it('accepts a workspaceRoot outside the default when it matches an explicit allowlist pattern', async () => {
    const outsideRoot = mkdtempSync(join(tmpdir(), 'dev-intel-security-allowed-'));
    // Operator opt-in: authorize anything under the OS temp dir (a sibling of
    // the configured default). Without this, the same request is rejected by
    // the boundary test above.
    // assertWithinWorkspace canonicalizes exactly the way the server does; `fs.realpathSync`
    // would leave a Windows temp directory in its 8.3 short form and the allowlist pattern
    // would then never match the root the server resolves.
    process.env.CODE_INTEL_ALLOWED_WORKSPACE_ROOTS = `${assertWithinWorkspace(tmpdir(), '.')}/**`;
    const { baseUrl, close } = await startServer(fixtureWorkspaceRoot);

    const response = await fetch(`${baseUrl}/tools/searchText`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceRoot: outsideRoot, query: 'buildGreeting' })
    });

    const payload = (await response.json()) as { ok: boolean; error?: string };
    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);

    await close();
    runningServer = undefined;
  });

  it('rejects a filePath that escapes the workspace root in the symbol tools', async () => {
    const { baseUrl, close } = await startServer(fixtureWorkspaceRoot);
    // Exists on disk but lives outside the fixture workspace.
    const outsideAbsolute = resolve(process.cwd(), 'package.json');
    const outsideRelative = '../../../../package.json';

    for (const [tool, extra] of [
      ['getFileOutline', {}],
      ['getSymbolContent', { symbol: 'name' }],
      ['findReferences', { symbol: 'name' }],
      ['dependencyGraph', {}]
    ] as const) {
      for (const filePath of [outsideAbsolute, outsideRelative]) {
        const { payload } = await postJson(`${baseUrl}/tools/${tool}`, { workspaceRoot: fixtureWorkspaceRoot, filePath, ...extra });
        expect(payload.ok, `${tool} ${filePath}`).toBe(false);
        expect(String(payload.error), `${tool} ${filePath}`).toContain('path outside workspace root');
      }
    }

    await close();
    runningServer = undefined;
  });

  it('rejects browser cross-origin POSTs (Origin header) on tool and mcp endpoints', async () => {
    const { baseUrl, close } = await startServer(fixtureWorkspaceRoot);
    const body = { workspaceRoot: fixtureWorkspaceRoot, query: 'buildGreeting' };

    const crossOriginTool = await postJson(`${baseUrl}/tools/searchText`, body, { origin: 'http://evil.example' });
    expect(crossOriginTool.status).toBe(403);
    expect(crossOriginTool.payload.error).toBe('forbidden origin');

    const crossOriginMcp = await postJson(`${baseUrl}/mcp`, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { origin: 'http://evil.example' });
    expect(crossOriginMcp.status).toBe(403);

    // A DNS-rebinding page carries the attacker origin even though the request reaches 127.0.0.1.
    const rebinding = await postJson(`${baseUrl}/tools/searchText`, body, { origin: 'http://attacker.example:4545', host: 'attacker.example:4545' });
    expect(rebinding.status).toBe(403);

    const sameOrigin = await postJson(`${baseUrl}/tools/searchText`, body, { origin: baseUrl });
    expect(sameOrigin.status).toBe(200);

    const localhostOrigin = await postJson(`${baseUrl}/tools/searchText`, body, { origin: baseUrl.replace('127.0.0.1', 'localhost') });
    expect(localhostOrigin.status).toBe(200);

    // Non-browser clients (IDEs, curl, node fetch) send no Origin header and must keep working.
    const noOrigin = await postJson(`${baseUrl}/tools/searchText`, body);
    expect(noOrigin.status).toBe(200);

    await close();
    runningServer = undefined;
  });

  it('accepts extra origins listed in CODE_INTEL_ALLOWED_ORIGINS', async () => {
    process.env.CODE_INTEL_ALLOWED_ORIGINS = 'http://ide.example; https://dashboard.example:8443';
    const { baseUrl, close } = await startServer(fixtureWorkspaceRoot);
    const body = { workspaceRoot: fixtureWorkspaceRoot, query: 'buildGreeting' };

    expect((await postJson(`${baseUrl}/tools/searchText`, body, { origin: 'https://dashboard.example:8443' })).status).toBe(200);
    expect((await postJson(`${baseUrl}/tools/searchText`, body, { origin: 'http://IDE.example/' })).status).toBe(200);
    expect((await postJson(`${baseUrl}/tools/searchText`, body, { origin: 'http://evil.example' })).status).toBe(403);

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
