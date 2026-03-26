#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  isToolName,
  type ToolRequest,
  type ToolResponse
} from './contracts.ts';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawn as spawnChildProcess } from 'node:child_process';
import { logger, setLoggerSinkToStderr } from './logger.ts';
import {
  HttpError,
  isExistingDirectory,
  normalizeWorkspaceRoot,
  readJsonBody,
  summarizePayloadForLogs,
  toErrorMessage
} from './server-utils.ts';
import { processGetRequest } from './health-handler.ts';
import { processMcpPostRequest, executeToolByName } from './mcp-handler.ts';
import { startStdioTransport } from './stdio-transport.ts';
import { runCli } from './cli.ts';
import { DEFAULT_MAX_BODY_BYTES, DEFAULT_PORT } from './server-config.ts';

interface StartupOptions {
  workspaceRoot?: string;
  host: string;
  port: number;
  logRequests: boolean;
  apiKey?: string;
  maxBodyBytes: number;
}

interface RuntimeSecurityOptions {
  host: string;
  apiKey?: string;
  maxBodyBytes: number;
}

function getWorkspaceRootFromArgs(): string | undefined {
  const arg = process.argv.find((value) => value.startsWith('--workspaceRoot='));
  const raw = arg?.split('=')[1]?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

function parseHostFromArgs(): string | undefined {
  const arg = process.argv.find((value) => value.startsWith('--host='));
  const raw = arg?.split('=')[1]?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

function parseHostFromEnv(): string | undefined {
  const raw = process.env.CODE_INTEL_HOST?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

function parseApiKeyFromEnv(): string | undefined {
  const raw = process.env.CODE_INTEL_API_KEY?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

function parseMaxBodyBytesFromEnv(): number {
  const raw = process.env.CODE_INTEL_MAX_BODY_BYTES?.trim();
  if (!raw) {
    return DEFAULT_MAX_BODY_BYTES;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_BODY_BYTES;
  }

  return parsed;
}

async function promptWorkspaceRootIfMissingOrInvalid(initialWorkspaceRoot?: string): Promise<string | undefined> {
  if (initialWorkspaceRoot && isExistingDirectory(initialWorkspaceRoot)) {
    return initialWorkspaceRoot;
  }

  if (initialWorkspaceRoot) {
    logger.warn('workspaceRoot not found', { workspaceRoot: initialWorkspaceRoot });
  }

  const rl = createInterface({ input, output });

  try {
    const answer = await rl.question(
      '[code-intel-mcp] Enter workspace root path (empty to skip default workspace): '
    );
    const normalized = normalizeWorkspaceRoot(answer);
    if (!normalized) {
      return undefined;
    }

    if (!isExistingDirectory(normalized)) {
      logger.warn('workspaceRoot not found', { workspaceRoot: normalized });
      return undefined;
    }

    return normalized;
  } finally {
    rl.close();
  }
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

export function startMcpSkeletonServer(port = DEFAULT_PORT, defaultWorkspaceRoot?: string, logRequests = false) {
  const host = parseHostFromArgs() ?? parseHostFromEnv() ?? '127.0.0.1';
  const apiKey = parseApiKeyFromEnv();
  const maxBodyBytes = parseMaxBodyBytesFromEnv();

  return startMcpSkeletonServerWithOptions(port, defaultWorkspaceRoot, logRequests, {
    host,
    apiKey,
    maxBodyBytes
  });
}

export function startMcpSkeletonServerWithOptions(
  port: number,
  defaultWorkspaceRoot: string | undefined,
  logRequests: boolean,
  runtimeOptions: RuntimeSecurityOptions
) {
  const startupWorkspaceRoot =
    defaultWorkspaceRoot ?? normalizeWorkspaceRoot(process.env.CODE_INTEL_WORKSPACE_ROOT) ?? getWorkspaceRootFromArgs();
  const { host, apiKey, maxBodyBytes } = runtimeOptions;
  const isNonLocalHost = host !== '127.0.0.1' && host !== 'localhost';

  function createUnauthorizedPayload(): { statusCode: number; payload: { ok: false; error: string } } | null {
    if (isNonLocalHost && !apiKey) {
      return {
        statusCode: 401,
        payload: { ok: false, error: 'api key required for non-local host' }
      };
    }

    return null;
  }

  function createInvalidApiKeyPayload(request: IncomingMessage): { statusCode: number; payload: { ok: false; error: string } } | null {
    if (!apiKey) {
      return null;
    }

    const requestApiKey = request.headers['x-api-key'];
    if (typeof requestApiKey === 'string' &&
      requestApiKey.length === apiKey.length &&
      timingSafeEqual(Buffer.from(requestApiKey), Buffer.from(apiKey))) {
      return null;
    }

    return {
      statusCode: 401,
      payload: { ok: false, error: 'unauthorized' }
    };
  }

  async function processToolPostRequest(
    request: IncomingMessage,
    pathname: string
  ): Promise<{ statusCode: number; payload: unknown; requestBody: unknown }> {
    const unauthorized = createUnauthorizedPayload();
    if (unauthorized) {
      return {
        ...unauthorized,
        requestBody: undefined
      };
    }

    const invalidApiKey = createInvalidApiKeyPayload(request);
    if (invalidApiKey) {
      return {
        ...invalidApiKey,
        requestBody: undefined
      };
    }

    const tool = pathname.replace('/tools/', '').trim();
    if (!isToolName(tool)) {
      return {
        statusCode: 404,
        payload: { ok: false, error: `unknown tool: ${tool}` },
        requestBody: undefined
      };
    }

    const requestBody = await readJsonBody(request, maxBodyBytes);
    const toolExecution = await executeToolByName(tool, requestBody, startupWorkspaceRoot);

    return {
      statusCode: 200,
      payload: toolExecution.payload,
      requestBody: toolExecution.requestBody
    };
  }

  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const startedAt = Date.now();
    const method = request.method ?? 'GET';
    const requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    let requestBody: unknown;
    let responseStatus = 200;
    let responsePayload: unknown;

    const respond = (statusCode: number, payload: unknown): void => {
      responseStatus = statusCode;
      responsePayload = payload;
      sendJson(response, statusCode, payload);
    };

    try {
      if (method === 'GET') {
        const getResponse = processGetRequest(requestUrl.pathname);
        if (getResponse) {
          respond(getResponse.statusCode, getResponse.payload);
          return;
        }
      }

      if (method === 'POST' && requestUrl.pathname.startsWith('/tools/')) {
        const toolResponse = await processToolPostRequest(request, requestUrl.pathname);
        requestBody = toolResponse.requestBody;
        respond(toolResponse.statusCode, toolResponse.payload);
        return;
      }

      if (method === 'POST' && requestUrl.pathname === '/mcp') {
        const unauthorized = createUnauthorizedPayload();
        if (unauthorized) {
          respond(unauthorized.statusCode, unauthorized.payload);
          return;
        }

        const invalidApiKey = createInvalidApiKeyPayload(request);
        if (invalidApiKey) {
          respond(invalidApiKey.statusCode, invalidApiKey.payload);
          return;
        }

        const mcpRequestBody = await readJsonBody(request, maxBodyBytes);
        requestBody = mcpRequestBody;
        const mcpResponse = await processMcpPostRequest(mcpRequestBody, startupWorkspaceRoot);
        if (mcpResponse.skipResponse) {
          responseStatus = mcpResponse.statusCode;
          responsePayload = undefined;
          response.writeHead(mcpResponse.statusCode);
          response.end();
          return;
        }

        respond(mcpResponse.statusCode, mcpResponse.payload);
        return;
      }

      respond(404, { ok: false, error: 'not found' });
    } catch (error) {
      if (error instanceof HttpError) {
        respond(error.statusCode, {
          ok: false,
          error: error.message
        });
        return;
      }

      logger.error('request failed', {
        path: requestUrl.pathname,
        method,
        error: toErrorMessage(error)
      });
      respond(500, {
        ok: false,
        error: 'internal error'
      });
    } finally {
      if (logRequests) {
        const durationMs = Date.now() - startedAt;
        logger.info('request completed', {
          scope: 'code-intel-mcp',
          method,
          path: requestUrl.pathname,
          status: responseStatus,
          durationMs,
          requestBody: summarizePayloadForLogs(requestBody),
          responsePayload: summarizePayloadForLogs(responsePayload)
        });
      }
    }
  };

  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });

  server.listen(port, host);
  return server;
}

async function runSelfTest(): Promise<void> {
  const server = startMcpSkeletonServer(0);

  await new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('unable to resolve local server address');
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;
  const healthResponse = await fetch(`${baseUrl}/health`);
  const healthJson = (await healthResponse.json()) as Record<string, unknown>;

  const fixtureWorkspaceRoot = resolve(process.cwd(), 'services/code-intel-mcp/fixtures/self-test-workspace');

  const toolResponse = await fetch(`${baseUrl}/tools/findReferences`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workspaceRoot: fixtureWorkspaceRoot,
      filePath: 'src/usage.ts',
      symbol: 'buildGreeting'
    } satisfies ToolRequest)
  });
  const toolJson = (await toolResponse.json()) as ToolResponse;

  const definitionResponse = await fetch(`${baseUrl}/tools/findDefinitions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workspaceRoot: fixtureWorkspaceRoot,
      filePath: 'src/usage.ts',
      symbol: 'buildGreeting'
    } satisfies ToolRequest)
  });
  const definitionJson = (await definitionResponse.json()) as ToolResponse;

  const textResponse = await fetch(`${baseUrl}/tools/searchText`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workspaceRoot: fixtureWorkspaceRoot,
      query: 'buildGreeting',
      options: { maxResults: 20 }
    } satisfies ToolRequest)
  });
  const textJson = (await textResponse.json()) as ToolResponse;

  let structStatus = 0;
  let structJson: ToolResponse | { ok: false; skipped: true; reason: string } = {
    ok: false,
    skipped: true,
    reason: 'not executed'
  };

  try {
    const structResponse = await fetch(`${baseUrl}/tools/searchStruct`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceRoot: fixtureWorkspaceRoot,
        query: 'buildGreeting($A)',
        options: {
          language: 'ts'
        }
      } satisfies ToolRequest)
    });

    structStatus = structResponse.status;
    structJson = (await structResponse.json()) as ToolResponse;
  } catch (error) {
    structJson = {
      ok: false,
      skipped: true,
      reason: error instanceof Error ? error.message : 'searchStruct self-test skipped'
    };
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

  logger.info('self-test completed', {
    ok: true,
    mode: 'self-test',
    health: healthJson,
    sampleTool: {
      status: toolResponse.status,
      payload: toolJson
    },
    sampleDefinition: {
      status: definitionResponse.status,
      payload: definitionJson
    },
    sampleText: {
      status: textResponse.status,
      payload: textJson
    },
    sampleStruct: {
      status: structStatus,
      payload: structJson
    }
  });
}

async function startForegroundServer(
  startupOptions: StartupOptions,
  executionMode: { allowPrompt: boolean }
): Promise<void> {
  const startupWorkspaceRoot = executionMode.allowPrompt
    ? await promptWorkspaceRootIfMissingOrInvalid(startupOptions.workspaceRoot)
    : startupOptions.workspaceRoot;

  if (startupOptions.host !== '127.0.0.1' && startupOptions.host !== 'localhost' && !startupOptions.apiKey) {
    logger.warn('non-local host configured without API key; tool requests will be rejected');
  }

  const server = startMcpSkeletonServerWithOptions(
    startupOptions.port,
    startupWorkspaceRoot,
    startupOptions.logRequests,
    {
      host: startupOptions.host,
      apiKey: startupOptions.apiKey,
      maxBodyBytes: startupOptions.maxBodyBytes
    }
  );
  logger.info('server listening', { url: `http://${startupOptions.host}:${startupOptions.port}` });
  if (startupWorkspaceRoot) {
    logger.info('default workspace root configured', { workspaceRoot: startupWorkspaceRoot });
  }
  logger.info('request logs configuration', {
    enabled: startupOptions.logRequests
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const argPath = (process.argv[1] ?? '').replaceAll('\\', '/');
const isDirectExecution =
  argPath.endsWith('server.ts') ||
  argPath.endsWith('server.js') ||
  argPath.endsWith('code-dev-intel') ||
  argPath.endsWith('code-dev-intel.ts');
if (isDirectExecution) {
  const shouldUseStdio = process.argv.includes('--stdio');
  const shouldSelfTest = process.argv.includes('--self-test');

  if (shouldUseStdio) {
    setLoggerSinkToStderr();
    const workspaceRoot =
      normalizeWorkspaceRoot(process.env.CODE_INTEL_WORKSPACE_ROOT) ?? getWorkspaceRootFromArgs();
    startStdioTransport(workspaceRoot);
  } else if (shouldSelfTest) {
    try {
      await runSelfTest();
    } catch (error: unknown) {
      logger.error('self-test failed', {
        error: toErrorMessage(error)
      });
      process.exit(1);
    }
  } else {
    try {
      const exitCode = await runCli(process.argv.slice(2), {
        env: process.env,
        fetchImpl: fetch,
        spawnImpl: spawnChildProcess,
        stdout: process.stdout,
        stderr: process.stderr,
        execPath: process.execPath,
        execArgv: process.execArgv,
        scriptPath: process.argv[1],
        platform: process.platform,
        cwd: process.cwd(),
        startForegroundServer: (options, executionMode) =>
          startForegroundServer(
            {
              workspaceRoot: options.workspaceRoot,
              host: options.host,
              port: options.port,
              logRequests: options.logRequests,
              apiKey: options.apiKey,
              maxBodyBytes: options.maxBodyBytes
            },
            executionMode
          )
      });

      if (exitCode !== 0) {
        process.exit(exitCode);
      }
    } catch (error: unknown) {
      logger.error('cli command failed', {
        error: toErrorMessage(error)
      });
      process.exit(1);
    }
  }
}
