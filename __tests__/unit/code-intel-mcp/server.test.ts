import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startMcpSkeletonServer } from '../../../services/code-intel-mcp/src/server.ts';
import * as astGrepService from '../../../services/code-intel-mcp/src/ast-grep-service.ts';
import * as textSearchService from '../../../services/code-intel-mcp/src/search-text-service.ts';

let runningServer: Server | undefined;

async function startServer(
  defaultWorkspaceRoot?: string
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
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
  if (!runningServer) {
    delete process.env.CODE_INTEL_HOST;
    delete process.env.CODE_INTEL_API_KEY;
    return;
  }

  await new Promise<void>((resolveClose) => {
    runningServer?.close(() => resolveClose());
  });

  runningServer = undefined;
  delete process.env.CODE_INTEL_HOST;
  delete process.env.CODE_INTEL_API_KEY;
});

describe('mcp skeleton server', () => {
  it('rejects unknown fields in request body with HTTP 400', async () => {
    const { baseUrl, close } = await startServer();
    const workspaceRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/self-test-workspace');

    const response = await fetch(`${baseUrl}/tools/searchText`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceRoot,
        query: 'buildGreeting',
        unexpectedField: 'nope'
      })
    });

    const json = (await response.json()) as { ok: boolean; error: string };

    expect(response.status).toBe(400);
    expect(json.ok).toBe(false);
    expect(json.error).toBe('invalid tool request body');

    await close();
    runningServer = undefined;
  });

  it('rejects workspaceRoot outside configured default root', async () => {
    const workspaceRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/self-test-workspace');
    const outsideRoot = mkdtempSync(join(tmpdir(), 'dev-intel-outside-root-'));
    const { baseUrl, close } = await startServer(workspaceRoot);

    const response = await fetch(`${baseUrl}/tools/searchText`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceRoot: outsideRoot,
        query: 'buildGreeting'
      })
    });

    const json = (await response.json()) as { ok: boolean; error: string };

    expect(response.status).toBe(400);
    expect(json.ok).toBe(false);
    expect(json.error).toBe('workspaceRoot must stay within configured default workspace root');

    await close();
    runningServer = undefined;
  });

  it('rejects oversized payload with HTTP 413', async () => {
    process.env.CODE_INTEL_MAX_BODY_BYTES = '1024';
    const { baseUrl, close } = await startServer();
    const workspaceRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/self-test-workspace');
    const oversized = 'x'.repeat(1200);

    const response = await fetch(`${baseUrl}/tools/searchText`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceRoot,
        query: oversized
      })
    });

    const json = (await response.json()) as { ok: boolean; error: string };

    expect(response.status).toBe(413);
    expect(json.ok).toBe(false);
    expect(json.error).toBe('payload too large');

    delete process.env.CODE_INTEL_MAX_BODY_BYTES;
    await close();
    runningServer = undefined;
  });

  it('rejects invalid json body with HTTP 400', async () => {
    const { baseUrl, close } = await startServer();

    const response = await fetch(`${baseUrl}/tools/searchText`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"workspaceRoot":"bad"'
    });

    const json = (await response.json()) as { ok: boolean; error: string };

    expect(response.status).toBe(400);
    expect(json.ok).toBe(false);
    expect(json.error).toBe('invalid json body');

    await close();
    runningServer = undefined;
  });

  it('rejects tool requests on non-local host when API key is missing', async () => {
    process.env.CODE_INTEL_HOST = '0.0.0.0';
    delete process.env.CODE_INTEL_API_KEY;
    const { baseUrl, close } = await startServer();
    const workspaceRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/self-test-workspace');

    const response = await fetch(`${baseUrl}/tools/searchText`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceRoot,
        query: 'buildGreeting'
      })
    });

    const json = (await response.json()) as { ok: boolean; error: string };

    expect(response.status).toBe(401);
    expect(json.ok).toBe(false);
    expect(json.error).toBe('api key required for non-local host');

    await close();
    runningServer = undefined;
  });

  it('enforces x-api-key when CODE_INTEL_API_KEY is configured', async () => {
    process.env.CODE_INTEL_API_KEY = 'dev-secret';
    const { baseUrl, close } = await startServer();
    const workspaceRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/self-test-workspace');

    const unauthorizedResponse = await fetch(`${baseUrl}/tools/searchText`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceRoot,
        query: 'buildGreeting'
      })
    });

    const authorizedResponse = await fetch(`${baseUrl}/tools/searchText`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'dev-secret'
      },
      body: JSON.stringify({
        workspaceRoot,
        query: 'buildGreeting'
      })
    });

    expect(unauthorizedResponse.status).toBe(401);
    expect(authorizedResponse.status).toBe(200);

    await close();
    runningServer = undefined;
  });

  it('returns health payload', async () => {
    const { baseUrl, close } = await startServer();

    const response = await fetch(`${baseUrl}/health`);
    const json = (await response.json()) as {
      ok: boolean;
      status: string;
      tools: string[];
      discovery: { toolsDescribePath: string; mcpEquivalentMethod: string };
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.status).toBe('up');
    expect(json.tools).toContain('findDefinitions');
    expect(json.discovery.toolsDescribePath).toBe('/tools/describe');
    expect(json.discovery.mcpEquivalentMethod).toBe('tools/list');

    await close();
    runningServer = undefined;
  });

  it('returns machine-readable tool descriptions', async () => {
    const { baseUrl, close } = await startServer();

    const response = await fetch(`${baseUrl}/tools/describe`);
    const json = (await response.json()) as {
      ok: boolean;
      standard: { protocol: string; equivalentMethod: string };
      tools: Array<{
        name: string;
        endpoint: string;
        requiredRequestFields: string[];
        options?: Record<string, unknown>;
      }>;
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.standard.protocol).toBe('model-context-protocol');
    expect(json.standard.equivalentMethod).toBe('tools/list');

    const searchText = json.tools.find((tool) => tool.name === 'searchText');
    expect(searchText?.endpoint).toBe('/tools/searchText');
    expect(searchText?.requiredRequestFields).toContain('workspaceRoot');
    expect(searchText?.requiredRequestFields).toContain('query');
    expect(searchText?.options?.searchPath).toBeDefined();

    await close();
    runningServer = undefined;
  });

  it('supports MCP initialize over JSON-RPC', async () => {
    const { baseUrl, close } = await startServer();

    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      })
    });

    const json = (await response.json()) as {
      jsonrpc: string;
      id: number;
      result: {
        protocolVersion: string;
        capabilities: { tools: { listChanged: boolean } };
      };
    };

    expect(response.status).toBe(200);
    expect(json.jsonrpc).toBe('2.0');
    expect(json.id).toBe(1);
    expect(json.result.protocolVersion).toBe('2024-11-05');
    expect(json.result.capabilities.tools.listChanged).toBe(false);

    await close();
    runningServer = undefined;
  });

  it('supports MCP tools/list over JSON-RPC', async () => {
    const { baseUrl, close } = await startServer();

    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list'
      })
    });

    const json = (await response.json()) as {
      jsonrpc: string;
      id: number;
      result: {
        tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
      };
    };

    expect(response.status).toBe(200);
    expect(json.jsonrpc).toBe('2.0');
    expect(json.id).toBe(2);
    const searchTextTool = json.result.tools.find((tool) => tool.name === 'searchText');
    const fileOutlineTool = json.result.tools.find((tool) => tool.name === 'getFileOutline');
    expect(searchTextTool).toBeDefined();
    expect(searchTextTool?.inputSchema.properties.options).toBeDefined();
    expect(fileOutlineTool?.inputSchema.properties.options).toBeDefined();
    expect(fileOutlineTool?.inputSchema.properties.options).toMatchObject({
      type: 'object',
      properties: {
        symbolKinds: {
          type: 'array',
          items: {
            type: 'string'
          }
        }
      }
    });

    await close();
    runningServer = undefined;
  });

  it('supports MCP tools/call over JSON-RPC', async () => {
    const textSpy = vi.spyOn(textSearchService, 'searchTextWithRipgrep').mockReturnValue({
      query: 'buildGreeting',
      engine: 'ripgrep',
      matches: [
        {
          filePath: 'src/usage.ts',
          line: 3,
          column: 17,
          snippet: "const message = buildGreeting('SampleProject');"
        }
      ]
    });

    const { baseUrl, close } = await startServer();
    const workspaceRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/self-test-workspace');

    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'searchText',
          arguments: {
            workspaceRoot,
            query: 'buildGreeting',
            options: { maxResults: 20 }
          }
        }
      })
    });

    const json = (await response.json()) as {
      jsonrpc: string;
      id: number;
      result: {
        isError: boolean;
        structuredContent: { matches: Array<{ filePath: string }> };
      };
    };

    expect(response.status).toBe(200);
    expect(json.jsonrpc).toBe('2.0');
    expect(json.id).toBe(3);
    expect(json.result.isError).toBe(false);
    expect(json.result.structuredContent.matches[0]?.filePath).toBe('src/usage.ts');
    expect(textSpy).toHaveBeenCalledTimes(1);

    textSpy.mockRestore();
    await close();
    runningServer = undefined;
  });

  it('surfaces underlying error message when an MCP tool throws', async () => {
    const { baseUrl, close } = await startServer();
    const workspaceRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/self-test-workspace');

    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/call',
        params: {
          name: 'getFileOutline',
          arguments: {
            workspaceRoot,
            filePath: 'src/does-not-exist.ts'
          }
        }
      })
    });

    const json = (await response.json()) as {
      jsonrpc: string;
      id: number;
      error: { code: number; message: string };
    };

    expect(response.status).toBe(500);
    expect(json.jsonrpc).toBe('2.0');
    expect(json.id).toBe(99);
    expect(json.error.code).toBe(-32603);
    expect(json.error.message).toContain('file not found');
    expect(json.error.message).not.toBe('Internal error');

    await close();
    runningServer = undefined;
  });

  it('returns JSON-RPC method not found for unknown MCP method', async () => {
    const { baseUrl, close } = await startServer();

    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'unknown/method'
      })
    });

    const json = (await response.json()) as {
      jsonrpc: string;
      id: number;
      error: { code: number; message: string };
    };

    expect(response.status).toBe(404);
    expect(json.jsonrpc).toBe('2.0');
    expect(json.id).toBe(4);
    expect(json.error.code).toBe(-32601);

    await close();
    runningServer = undefined;
  });

  it('accepts initialized notification without JSON body response', async () => {
    const { baseUrl, close } = await startServer();

    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized'
      })
    });

    expect(response.status).toBe(204);

    await close();
    runningServer = undefined;
  });

  it('resolves definitions and references through tool endpoints', async () => {
    const { baseUrl, close } = await startServer();
    const workspaceRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/self-test-workspace');

    const definitionResponse = await fetch(`${baseUrl}/tools/findDefinitions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceRoot,
        filePath: 'src/usage.ts',
        symbol: 'buildGreeting'
      })
    });

    const refsResponse = await fetch(`${baseUrl}/tools/findReferences`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceRoot,
        filePath: 'src/usage.ts',
        symbol: 'buildGreeting'
      })
    });

    const definitionJson = (await definitionResponse.json()) as {
      ok: boolean;
      data: { count: number; byFile: Record<string, string[]> };
    };
    const refsJson = (await refsResponse.json()) as {
      ok: boolean;
      data: { count: number; byFile: Record<string, string[]> };
    };

    expect(definitionResponse.status).toBe(200);
    expect(refsResponse.status).toBe(200);
    expect(definitionJson.ok).toBe(true);
    expect(Object.keys(definitionJson.data.byFile)).toContain('src/definitions.ts');

    const refFiles = new Set(Object.keys(refsJson.data.byFile));
    expect(refFiles.has('src/usage.ts')).toBe(true);
    expect(refFiles.has('src/definitions.ts')).toBe(true);

    await close();
    runningServer = undefined;
  });

  it('uses startup workspaceRoot when request body omits workspaceRoot', async () => {
    const workspaceRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/self-test-workspace');
    const { baseUrl, close } = await startServer(workspaceRoot);

    const refsResponse = await fetch(`${baseUrl}/tools/findReferences`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filePath: 'src/usage.ts',
        symbol: 'buildGreeting'
      })
    });

    const refsJson = (await refsResponse.json()) as {
      ok: boolean;
      data: { count: number; byFile: Record<string, string[]> };
    };

    expect(refsResponse.status).toBe(200);
    expect(refsJson.ok).toBe(true);

    const refFiles = new Set(Object.keys(refsJson.data.byFile));
    expect(refFiles.has('src/usage.ts')).toBe(true);
    expect(refFiles.has('src/definitions.ts')).toBe(true);

    await close();
    runningServer = undefined;
  });

  it('resolves structural search through searchStruct endpoint', async () => {
    const searchSpy = vi.spyOn(astGrepService, 'searchStructWithAstGrep').mockReturnValue({
      pattern: 'buildGreeting($A)',
      language: 'ts',
      matches: [
        {
          filePath: 'src/usage.ts',
          startLine: 3,
          startColumn: 17,
          endLine: 3,
          endColumn: 30,
          snippet: "buildGreeting('SampleProject')"
        }
      ]
    });

    const { baseUrl, close } = await startServer();
    const workspaceRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/self-test-workspace');

    const response = await fetch(`${baseUrl}/tools/searchStruct`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceRoot,
        query: 'buildGreeting($A)',
        options: { language: 'ts' }
      })
    });

    const json = (await response.json()) as {
      ok: boolean;
      data: { matches: Array<{ filePath: string }> };
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.matches[0]?.filePath).toBe('src/usage.ts');
    expect(searchSpy).toHaveBeenCalledTimes(1);

    searchSpy.mockRestore();
    await close();
    runningServer = undefined;
  });

  it('resolves text search through searchText endpoint', async () => {
    const textSpy = vi.spyOn(textSearchService, 'searchTextWithRipgrep').mockReturnValue({
      query: 'buildGreeting',
      engine: 'ripgrep',
      matches: [
        {
          filePath: 'src/usage.ts',
          line: 3,
          column: 17,
          snippet: "const message = buildGreeting('SampleProject');"
        }
      ]
    });

    const { baseUrl, close } = await startServer();
    const workspaceRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/self-test-workspace');

    const response = await fetch(`${baseUrl}/tools/searchText`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceRoot,
        query: 'buildGreeting',
        options: { maxResults: 20 }
      })
    });

    const json = (await response.json()) as {
      ok: boolean;
      data: { matches: Array<{ filePath: string }> };
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.matches[0]?.filePath).toBe('src/usage.ts');
    expect(textSpy).toHaveBeenCalledTimes(1);

    textSpy.mockRestore();
    await close();
    runningServer = undefined;
  });

  it('returns file outline symbols for a TypeScript file', async () => {
    const { baseUrl, close } = await startServer();
    const workspaceRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/self-test-workspace');

    const response = await fetch(`${baseUrl}/tools/getFileOutline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceRoot,
        filePath: 'src/definitions.ts'
      })
    });

    const json = (await response.json()) as {
      ok: boolean;
      data: { symbolsByKind: Record<string, Array<{ name: string }>> };
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.symbolsByKind.function?.some((item) => item.name === 'buildGreeting')).toBe(true);

    await close();
    runningServer = undefined;
  });

  it('filters outline symbols by kind and returns grouped symbols', async () => {
    const { baseUrl, close } = await startServer();
    const workspaceRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/self-test-workspace');

    const response = await fetch(`${baseUrl}/tools/getFileOutline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceRoot,
        filePath: 'src/definitions.ts',
        options: {
          symbolKinds: ['function']
        }
      })
    });

    const json = (await response.json()) as {
      ok: boolean;
      data: {
        appliedKinds: string[];
        symbolsByKind: Record<string, Array<{ name: string; signature?: string }>>;
      };
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.appliedKinds).toEqual(['function']);
    expect(Object.keys(json.data.symbolsByKind)).toEqual(['function']);
    expect(json.data.symbolsByKind.function?.length).toBeGreaterThan(0);
    expect(json.data.symbolsByKind.function?.[0]?.signature).toContain('function');

    await close();
    runningServer = undefined;
  });

  it('returns full symbol content for a definition', async () => {
    const { baseUrl, close } = await startServer();
    const workspaceRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/self-test-workspace');

    const response = await fetch(`${baseUrl}/tools/getSymbolContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceRoot,
        filePath: 'src/usage.ts',
        symbol: 'buildGreeting'
      })
    });

    const json = (await response.json()) as {
      ok: boolean;
      data: { declarationFilePath: string; content: string };
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.declarationFilePath).toBe('src/definitions.ts');
    expect(json.data.content).toContain('function buildGreeting');

    await close();
    runningServer = undefined;
  });

  it('resolves implementations through findImplementations endpoint', async () => {
    const { baseUrl, close } = await startServer();
    const workspaceRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/self-test-workspace');

    const response = await fetch(`${baseUrl}/tools/findImplementations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceRoot,
        filePath: 'src/contract.ts',
        symbol: 'GreetingContract'
      })
    });

    const json = (await response.json()) as {
      ok: boolean;
      data: { count: number; byFile: Record<string, string[]> };
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);

    const filePaths = new Set(Object.keys(json.data.byFile));
    expect(filePaths.has('src/greeting-implementation.ts')).toBe(true);

    await close();
    runningServer = undefined;
  });

  it('returns dependency graph through dependencyGraph endpoint', async () => {
    const { baseUrl, close } = await startServer();
    const workspaceRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/self-test-workspace');

    const response = await fetch(`${baseUrl}/tools/dependencyGraph`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceRoot,
        filePath: 'src/dep-level2.ts',
        options: {
          maxDepth: 3,
          includeExternal: true
        }
      })
    });

    const json = (await response.json()) as {
      ok: boolean;
      data: {
        dependencies: string[];
        externalDependencies: string[];
      };
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.dependencies).toContain('src/dep-level1.ts');
    expect(json.data.dependencies).toContain('src/definitions.ts');
    expect(json.data.externalDependencies).toContain('node:path');

    await close();
    runningServer = undefined;
  });

  it('returns duplicate groups through findDuplicates endpoint', async () => {
    const { baseUrl, close } = await startServer();
    const workspaceRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/duplicates-workspace');

    const response = await fetch(`${baseUrl}/tools/findDuplicates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceRoot,
        paths: ['src'],
        minLines: 4,
        minTokens: 12,
        mode: 'fast'
      })
    });

    const json = (await response.json()) as {
      ok: boolean;
      data: { groups: Array<{ kind: string }>; summary: { scannedFiles: number } };
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.data.groups)).toBe(true);
    expect(typeof json.data.summary.scannedFiles).toBe('number');
    if (json.data.groups.length > 0) {
      expect(json.data.groups.some((group) => group.kind === 'type1' || group.kind === 'type2')).toBe(true);
    }

    await close();
    runningServer = undefined;
  });

  it('resolves callers through findCallers endpoint', async () => {
    const { baseUrl, close } = await startServer();
    const workspaceRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/self-test-workspace');

    const response = await fetch(`${baseUrl}/tools/findCallers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceRoot,
        filePath: 'src/call-hierarchy.ts',
        symbol: 'targetCallee'
      })
    });

    const json = (await response.json()) as {
      ok: boolean;
      data: { callers: Array<{ callerSymbol: string; filePath: string; callSite: { startLine: number } }> };
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    const callerSymbols = new Set(json.data.callers.map((entry) => entry.callerSymbol));
    expect(callerSymbols.has('firstCaller')).toBe(true);
    expect(callerSymbols.has('secondCaller')).toBe(true);
    expect(json.data.callers[0]?.callSite.startLine).toBeGreaterThan(0);

    await close();
    runningServer = undefined;
  });

  it('returns an error payload when findCallers omits filePath/symbol', async () => {
    const { baseUrl, close } = await startServer();
    const workspaceRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/self-test-workspace');

    const response = await fetch(`${baseUrl}/tools/findCallers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceRoot })
    });

    const json = (await response.json()) as { ok: boolean; error?: string };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(false);
    expect(json.error).toContain('findCallers');

    await close();
    runningServer = undefined;
  });

  it('resolves callees through findCallees endpoint', async () => {
    const { baseUrl, close } = await startServer();
    const workspaceRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/self-test-workspace');

    const response = await fetch(`${baseUrl}/tools/findCallees`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceRoot,
        filePath: 'src/call-hierarchy.ts',
        symbol: 'targetCallee'
      })
    });

    const json = (await response.json()) as {
      ok: boolean;
      data: { callees: Array<{ calleeSymbol: string }> };
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    const calleeSymbols = new Set(json.data.callees.map((entry) => entry.calleeSymbol));
    expect(calleeSymbols.has('helperDouble')).toBe(true);

    await close();
    runningServer = undefined;
  });

  it('resolves a symbol by name only through findSymbol endpoint', async () => {
    const { baseUrl, close } = await startServer();
    const workspaceRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/self-test-workspace');

    const response = await fetch(`${baseUrl}/tools/findSymbol`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceRoot,
        symbol: 'buildGreeting'
      })
    });

    const json = (await response.json()) as {
      ok: boolean;
      data: { symbol: string; matches: Array<{ name: string; filePath: string; kind: string }> };
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.symbol).toBe('buildGreeting');
    expect(json.data.matches.some((match) => match.filePath === 'src/definitions.ts')).toBe(true);

    await close();
    runningServer = undefined;
  });

  it('describes findSymbol as requiring symbol but not filePath', async () => {
    const { baseUrl, close } = await startServer();

    const response = await fetch(`${baseUrl}/tools/describe`);
    const json = (await response.json()) as {
      tools: Array<{ name: string; requiredRequestFields: string[] }>;
    };

    const findSymbol = json.tools.find((tool) => tool.name === 'findSymbol');
    expect(findSymbol?.requiredRequestFields).toContain('workspaceRoot');
    expect(findSymbol?.requiredRequestFields).toContain('symbol');
    expect(findSymbol?.requiredRequestFields).not.toContain('filePath');

    const findCallers = json.tools.find((tool) => tool.name === 'findCallers');
    expect(findCallers?.requiredRequestFields).toContain('filePath');
    expect(findCallers?.requiredRequestFields).toContain('symbol');

    await close();
    runningServer = undefined;
  });

  it('describes the module-graph tools as resolving tsconfig path aliases', async () => {
    const { baseUrl, close } = await startServer();

    const response = await fetch(`${baseUrl}/tools/describe`);
    const json = (await response.json()) as {
      tools: Array<{ name: string; description: string; options?: Record<string, { default?: unknown }> }>;
    };

    // These descriptions are what an MCP client puts in front of the model: if they
    // still claim relative-only resolution, agents keep avoiding the tools on the
    // alias-heavy codebases the resolution was built for.
    const dependencyGraph = json.tools.find((tool) => tool.name === 'dependencyGraph');
    expect(dependencyGraph?.description).toContain('path aliases');
    expect(dependencyGraph?.description).toContain('baseUrl');
    expect(dependencyGraph?.options?.maxDepth?.default).toBe(5);

    const impactedFiles = json.tools.find((tool) => tool.name === 'impactedFiles');
    expect(impactedFiles?.description).toContain('path aliases');
    expect(impactedFiles?.description).toContain('baseUrl');

    await close();
    runningServer = undefined;
  });

  it('rejects invalid findDuplicates body with HTTP 400', async () => {
    const { baseUrl, close } = await startServer();

    const response = await fetch(`${baseUrl}/tools/findDuplicates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        minLines: 4
      })
    });

    const json = (await response.json()) as { ok: boolean; error: string };

    expect(response.status).toBe(400);
    expect(json.ok).toBe(false);
    expect(json.error).toContain('workspaceRoot is required');

    await close();
    runningServer = undefined;
  });
});
