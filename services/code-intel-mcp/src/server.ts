import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import {
  type DependencyGraphResult,
  FindDuplicatesRequestSchema,
  type FindDuplicatesResult,
  type FileOutlineResult,
  isToolName,
  ToolRequestBodySchema,
  type StructSearchResult,
  type SymbolContentResult,
  type TextSearchResult,
  TOOL_NAMES,
  type HealthResponse,
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type SymbolQueryResult,
  type ToolDescriptor,
  type ToolsDescribeResponse,
  type ToolName,
  type ToolRequest,
  type ToolResponse
} from './contracts.ts';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  findDefinitionsBySymbol,
  getDependencyGraph,
  findImplementationsBySymbol,
  findReferencesBySymbol,
  getFileOutline,
  getSymbolContent
} from './typescript-symbol-service.ts';
import { searchStructWithAstGrep } from './ast-grep-service.ts';
import { searchTextWithRipgrep } from './search-text-service.ts';
import { assertWithinWorkspace, isPathWithinWorkspace } from './safe-path.ts';
import { logger } from './logger.ts';
import { findDuplicates } from './duplicate-detection-service.ts';

const DEFAULT_PORT = 4545;
const DEFAULT_MAX_BODY_BYTES = 512 * 1024;

class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, message: string, code: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

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

function parsePortFromArgs(): number | undefined {
  const arg = process.argv.find((value) => value.startsWith('--port='));
  const raw = arg?.split('=')[1]?.trim();
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function parsePortFromEnv(): number | undefined {
  const raw = process.env.CODE_INTEL_PORT?.trim();
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
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

function parseLogRequestsFromArgs(): boolean {
  return process.argv.includes('--log-requests') || process.argv.includes('--logRequests');
}

function parseLogRequestsFromEnv(): boolean {
  const raw = process.env.CODE_INTEL_LOG_REQUESTS?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
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

function isExistingDirectory(pathToCheck: string): boolean {
  if (!existsSync(pathToCheck)) {
    return false;
  }

  return statSync(pathToCheck).isDirectory();
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

function resolveStartupOptions(): StartupOptions {
  const workspaceRoot =
    normalizeWorkspaceRoot(process.env.CODE_INTEL_WORKSPACE_ROOT) ?? getWorkspaceRootFromArgs();
  const host = parseHostFromArgs() ?? parseHostFromEnv() ?? '127.0.0.1';
  const port = parsePortFromArgs() ?? parsePortFromEnv() ?? DEFAULT_PORT;
  const logRequests = parseLogRequestsFromArgs() || parseLogRequestsFromEnv();
  const apiKey = parseApiKeyFromEnv();
  const maxBodyBytes = parseMaxBodyBytesFromEnv();

  return {
    workspaceRoot,
    host,
    port,
    logRequests,
    apiKey,
    maxBodyBytes
  };
}

function normalizeWorkspaceRoot(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveAndValidateWorkspaceRoot(
  requestWorkspaceRoot: string | undefined,
  defaultWorkspaceRoot?: string
): string | undefined {
  const canonicalDefaultRoot = defaultWorkspaceRoot ? assertWithinWorkspace(defaultWorkspaceRoot, '.') : undefined;
  const canonicalRequestRoot = requestWorkspaceRoot ? assertWithinWorkspace(requestWorkspaceRoot, '.') : undefined;
  const effectiveRoot = canonicalRequestRoot ?? canonicalDefaultRoot;

  if (!effectiveRoot) {
    return undefined;
  }

  if (!isExistingDirectory(effectiveRoot)) {
    throw new HttpError(400, 'invalid workspaceRoot', 'INVALID_WORKSPACE_ROOT');
  }

  if (canonicalDefaultRoot && canonicalRequestRoot && !isPathWithinWorkspace(canonicalDefaultRoot, canonicalRequestRoot)) {
    throw new HttpError(
      400,
      'workspaceRoot must stay within configured default workspace root',
      'WORKSPACE_ROOT_OUT_OF_BOUNDARY'
    );
  }

  return effectiveRoot;
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function summarizePayloadForLogs(payload: unknown): unknown {
  if (payload === undefined) {
    return undefined;
  }

  const serialized = JSON.stringify(payload);
  if (serialized.length <= 5000) {
    return payload;
  }

  return {
    truncated: true,
    totalChars: serialized.length,
    preview: serialized.slice(0, 5000)
  };
}

function toErrorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return 'unknown error';
  }
}

async function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    if (typeof chunk === 'string') {
      const bufferChunk = Buffer.from(chunk);
      totalBytes += bufferChunk.length;
      if (totalBytes > maxBodyBytes) {
        throw new HttpError(413, 'payload too large', 'PAYLOAD_TOO_LARGE');
      }
      chunks.push(bufferChunk);
      continue;
    }

    if (Buffer.isBuffer(chunk)) {
      totalBytes += chunk.length;
      if (totalBytes > maxBodyBytes) {
        throw new HttpError(413, 'payload too large', 'PAYLOAD_TOO_LARGE');
      }
      chunks.push(chunk);
    } else {
      throw new HttpError(400, 'invalid request body', 'INVALID_REQUEST_CHUNK');
    }
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid json body', 'INVALID_JSON_BODY');
  }
}

function createToolRequestFromBody(value: unknown, defaultWorkspaceRoot?: string): ToolRequest | null {
  const parsed = ToolRequestBodySchema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(400, 'invalid tool request body', 'INVALID_TOOL_REQUEST_BODY');
  }

  const workspaceRoot = resolveAndValidateWorkspaceRoot(parsed.data.workspaceRoot, defaultWorkspaceRoot);

  if (!workspaceRoot) {
    return null;
  }

  return {
    workspaceRoot,
    query: parsed.data.query,
    symbol: parsed.data.symbol,
    filePath: parsed.data.filePath,
    options: parsed.data.options
  };
}

function createMockPayload(tool: ToolName, request: ToolRequest): ToolResponse {
  return {
    ok: true,
    tool,
    data: {
      message: 'mock response',
      request,
      timestamp: new Date().toISOString()
    }
  };
}

function createSymbolResolutionPayload(
  tool: 'findDefinitions' | 'findReferences' | 'findImplementations',
  request: ToolRequest
): ToolResponse {
  if (!request.filePath || !request.symbol) {
    return {
      ok: false,
      tool,
      data: { message: 'missing filePath or symbol' },
      error: 'filePath and symbol are required for symbol resolution tools'
    };
  }

  let result: SymbolQueryResult;

  if (tool === 'findDefinitions') {
    result = findDefinitionsBySymbol(request.workspaceRoot, request.filePath, request.symbol);
  } else if (tool === 'findReferences') {
    result = findReferencesBySymbol(request.workspaceRoot, request.filePath, request.symbol);
  } else {
    result = findImplementationsBySymbol(request.workspaceRoot, request.filePath, request.symbol);
  }

  return {
    ok: true,
    tool,
    data: result
  };
}

function createStructPayload(request: ToolRequest): ToolResponse {
  if (!request.query) {
    return {
      ok: false,
      tool: 'searchStruct',
      data: {
        pattern: '',
        language: 'ts',
        matches: []
      } as StructSearchResult,
      error: 'query is required for searchStruct'
    };
  }

  const languageOption = request.options?.language;
  const language = typeof languageOption === 'string' && languageOption.length > 0 ? languageOption : 'ts';
  const result: StructSearchResult = searchStructWithAstGrep(request.workspaceRoot, request.query, language);

  return {
    ok: true,
    tool: 'searchStruct',
    data: result
  };
}

function createTextPayload(request: ToolRequest): ToolResponse {
  if (!request.query) {
    return {
      ok: false,
      tool: 'searchText',
      data: {
        query: '',
        engine: 'ripgrep',
        matches: []
      } as TextSearchResult,
      error: 'query is required for searchText'
    };
  }

  const maxResultsOption = request.options?.maxResults;
  const maxResults =
    typeof maxResultsOption === 'number' && Number.isFinite(maxResultsOption)
      ? Math.max(1, Math.floor(maxResultsOption))
      : undefined;
  const searchPathOption = request.options?.searchPath;
  const searchPath = typeof searchPathOption === 'string' && searchPathOption.trim().length > 0
    ? searchPathOption.trim()
    : undefined;

  const result = searchTextWithRipgrep(request.workspaceRoot, request.query, maxResults, searchPath);

  return {
    ok: true,
    tool: 'searchText',
    data: result
  };
}

function createFileOutlinePayload(request: ToolRequest): ToolResponse {
  if (!request.filePath) {
    return {
      ok: false,
      tool: 'getFileOutline',
      data: {
        filePath: '',
        appliedKinds: [],
        symbolsByKind: {}
      } as FileOutlineResult,
      error: 'filePath is required for getFileOutline'
    };
  }

  const symbolKindsOption = request.options?.symbolKinds;
  const symbolKinds = Array.isArray(symbolKindsOption)
    ? symbolKindsOption.filter((item): item is string => typeof item === 'string')
    : undefined;

  const result = getFileOutline(request.workspaceRoot, request.filePath, {
    symbolKinds
  });

  return {
    ok: true,
    tool: 'getFileOutline',
    data: result
  };
}

function createSymbolContentPayload(request: ToolRequest): ToolResponse {
  if (!request.filePath || !request.symbol) {
    return {
      ok: false,
      tool: 'getSymbolContent',
      data: {
        symbol: request.symbol ?? '',
        sourceFilePath: request.filePath ?? '',
        declarationFilePath: '',
        startLine: 0,
        startColumn: 0,
        endLine: 0,
        endColumn: 0,
        content: ''
      } as SymbolContentResult,
      error: 'filePath and symbol are required for getSymbolContent'
    };
  }

  const result = getSymbolContent(request.workspaceRoot, request.filePath, request.symbol);

  return {
    ok: true,
    tool: 'getSymbolContent',
    data: result
  };
}

function createDependencyGraphPayload(request: ToolRequest): ToolResponse {
  if (!request.filePath) {
    return {
      ok: false,
      tool: 'dependencyGraph',
      data: {
        rootFilePath: '',
        maxDepth: 0,
        dependencies: [],
        externalDependencies: [],
        edges: []
      } as DependencyGraphResult,
      error: 'filePath is required for dependencyGraph'
    };
  }

  const maxDepthOption = request.options?.maxDepth;
  const includeExternalOption = request.options?.includeExternal;

  const result = getDependencyGraph(request.workspaceRoot, request.filePath, {
    maxDepth: typeof maxDepthOption === 'number' ? maxDepthOption : undefined,
    includeExternal: includeExternalOption === true
  });

  return {
    ok: true,
    tool: 'dependencyGraph',
    data: result
  };
}

async function createFindDuplicatesPayload(
  body: unknown,
  defaultWorkspaceRoot?: string
): Promise<ToolResponse<FindDuplicatesResult>> {
  const parsed = FindDuplicatesRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(400, 'invalid findDuplicates request body', 'INVALID_FIND_DUPLICATES_REQUEST_BODY');
  }

  const workspaceRoot = resolveAndValidateWorkspaceRoot(parsed.data.workspaceRoot, defaultWorkspaceRoot);
  if (!workspaceRoot) {
    throw new HttpError(
      400,
      'invalid tool request body: workspaceRoot is required in body or via CODE_INTEL_WORKSPACE_ROOT/--workspaceRoot',
      'WORKSPACE_ROOT_REQUIRED'
    );
  }

  const result = await findDuplicates({
    ...parsed.data,
    workspaceRoot
  });

  return {
    ok: true,
    tool: 'findDuplicates',
    data: result
  };
}

function createToolPayload(
  tool: ToolName,
  request: ToolRequest
):
  | ToolResponse
  | ToolResponse<SymbolQueryResult>
  | ToolResponse<StructSearchResult>
  | ToolResponse<TextSearchResult>
  | ToolResponse<DependencyGraphResult> {
  if (tool === 'findDefinitions' || tool === 'findReferences' || tool === 'findImplementations') {
    return createSymbolResolutionPayload(tool, request);
  }

  if (tool === 'getFileOutline') {
    return createFileOutlinePayload(request);
  }

  if (tool === 'getSymbolContent') {
    return createSymbolContentPayload(request);
  }

  if (tool === 'dependencyGraph') {
    return createDependencyGraphPayload(request);
  }

  if (tool === 'searchStruct') {
    return createStructPayload(request);
  }

  if (tool === 'searchText') {
    return createTextPayload(request);
  }

  return createMockPayload(tool, request);
}

function createHealthPayload(): HealthResponse {
  return {
    ok: true,
    status: 'up',
    tools: [...TOOL_NAMES],
    discovery: {
      toolsDescribePath: '/tools/describe',
      jsonRpcPath: '/mcp',
      mcpEquivalentMethod: 'tools/list'
    }
  };
}

function createToolsDescribePayload(): ToolsDescribeResponse {
  const tools: ToolDescriptor[] = [
    {
      name: 'findDefinitions',
      endpoint: '/tools/findDefinitions',
      description: 'Find symbol definitions from filePath + symbol.',
      requiredRequestFields: ['workspaceRoot', 'filePath', 'symbol']
    },
    {
      name: 'findReferences',
      endpoint: '/tools/findReferences',
      description: 'Find symbol references from filePath + symbol.',
      requiredRequestFields: ['workspaceRoot', 'filePath', 'symbol']
    },
    {
      name: 'findImplementations',
      endpoint: '/tools/findImplementations',
      description: 'Find symbol implementations from filePath + symbol.',
      requiredRequestFields: ['workspaceRoot', 'filePath', 'symbol']
    },
    {
      name: 'getFileOutline',
      endpoint: '/tools/getFileOutline',
      description: 'Get grouped symbols for a file.',
      requiredRequestFields: ['workspaceRoot', 'filePath'],
      options: {
        symbolKinds: {
          type: 'string[]',
          required: false,
          description: 'Optional list of symbol kinds to include.'
        }
      }
    },
    {
      name: 'getSymbolContent',
      endpoint: '/tools/getSymbolContent',
      description: 'Get full declaration content for a symbol.',
      requiredRequestFields: ['workspaceRoot', 'filePath', 'symbol']
    },
    {
      name: 'dependencyGraph',
      endpoint: '/tools/dependencyGraph',
      description: 'Build dependency graph for a file.',
      requiredRequestFields: ['workspaceRoot', 'filePath'],
      options: {
        maxDepth: {
          type: 'number',
          required: false,
          description: 'Maximum traversal depth for dependency expansion.'
        },
        includeExternal: {
          type: 'boolean',
          required: false,
          default: false,
          description: 'Include package/external dependencies in result.'
        }
      }
    },
    {
      name: 'searchStruct',
      endpoint: '/tools/searchStruct',
      description: 'Structural search via ast-grep pattern matching.',
      requiredRequestFields: ['workspaceRoot', 'query'],
      options: {
        language: {
          type: 'string',
          required: false,
          default: 'ts',
          description: 'ast-grep language identifier.'
        }
      }
    },
    {
      name: 'searchText',
      endpoint: '/tools/searchText',
      description: 'Plain text search via ripgrep with Node fallback.',
      requiredRequestFields: ['workspaceRoot', 'query'],
      options: {
        maxResults: {
          type: 'number',
          required: false,
          default: 200,
          description: 'Maximum number of returned matches.'
        },
        searchPath: {
          type: 'string',
          required: false,
          default: '.',
          description: 'Optional relative directory/file scope, e.g. src.'
        }
      }
    },
    {
      name: 'findDuplicates',
      endpoint: '/tools/findDuplicates',
      description: 'Detect duplicate code groups and optional markdown report.',
      requiredRequestFields: ['workspaceRoot']
    },
    {
      name: 'findSymbol',
      endpoint: '/tools/findSymbol',
      description: 'Reserved endpoint; currently returns mock payload.',
      requiredRequestFields: ['workspaceRoot']
    },
    {
      name: 'findCallers',
      endpoint: '/tools/findCallers',
      description: 'Reserved endpoint; currently returns mock payload.',
      requiredRequestFields: ['workspaceRoot']
    },
    {
      name: 'findCallees',
      endpoint: '/tools/findCallees',
      description: 'Reserved endpoint; currently returns mock payload.',
      requiredRequestFields: ['workspaceRoot']
    },
    {
      name: 'impactedFiles',
      endpoint: '/tools/impactedFiles',
      description: 'Reserved endpoint; currently returns mock payload.',
      requiredRequestFields: ['workspaceRoot']
    },
    {
      name: 'health',
      endpoint: '/health',
      description: 'Server health check endpoint.',
      requiredRequestFields: []
    }
  ];

  return {
    ok: true,
    standard: {
      protocol: 'model-context-protocol',
      equivalentMethod: 'tools/list'
    },
    tools
  };
}

function processGetRequest(pathname: string): { statusCode: number; payload: unknown } | null {
  if (pathname === '/health') {
    return {
      statusCode: 200,
      payload: createHealthPayload()
    };
  }

  if (pathname === '/tools/describe') {
    return {
      statusCode: 200,
      payload: createToolsDescribePayload()
    };
  }

  return null;
}

function createMcpToolsListPayload(): {
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
} {
  const describePayload = createToolsDescribePayload();
  const tools = describePayload.tools
    .filter((tool) => tool.name !== 'health')
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: createMcpToolInputSchema(tool)
    }));

  return { tools };
}

function createMcpToolInputSchema(tool: ToolDescriptor): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required = tool.requiredRequestFields.filter((field) => field !== 'options');

  if (tool.requiredRequestFields.includes('workspaceRoot')) {
    properties.workspaceRoot = {
      type: 'string',
      description: 'Absolute workspace path where the tool runs.'
    };
  }

  if (tool.requiredRequestFields.includes('query')) {
    properties.query = {
      type: 'string',
      description: 'Query string or structural pattern depending on the tool.'
    };
  }

  if (tool.requiredRequestFields.includes('symbol')) {
    properties.symbol = {
      type: 'string',
      description: 'Symbol name to resolve in TypeScript sources.'
    };
  }

  if (tool.requiredRequestFields.includes('filePath')) {
    properties.filePath = {
      type: 'string',
      description: 'Path relative to workspaceRoot.'
    };
  }

  if (tool.options) {
    const optionProperties: Record<string, unknown> = {};
    for (const [optionName, descriptor] of Object.entries(tool.options)) {
      const optionSchema: Record<string, unknown> = {
        type: descriptor.type,
        description: descriptor.description
      };
      if (descriptor.default === undefined) {
        optionProperties[optionName] = optionSchema;
      } else {
        optionSchema.default = descriptor.default;
        optionProperties[optionName] = optionSchema;
      }
    }

    properties.options = {
      type: 'object',
      additionalProperties: false,
      properties: optionProperties,
      required: Object.entries(tool.options)
        .filter(([, descriptor]) => descriptor.required)
        .map(([optionName]) => optionName)
    };
  }

  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required
  };
}

function createJsonRpcError(code: number, message: string, id: JsonRpcId = null, data?: unknown): JsonRpcResponse {
  const error: JsonRpcError = { code, message };
  if (data === undefined) {
    return {
      jsonrpc: '2.0',
      id,
      error
    };
  }

  error.data = data;
  return {
    jsonrpc: '2.0',
    id,
    error
  };
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return candidate.jsonrpc === '2.0' && typeof candidate.method === 'string';
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
    if (requestApiKey === apiKey) {
      return null;
    }

    return {
      statusCode: 401,
      payload: { ok: false, error: 'unauthorized' }
    };
  }

  async function executeToolByName(
    tool: ToolName,
    body: unknown
  ): Promise<{ payload: ToolResponse; requestBody: unknown }> {
    if (tool === 'findDuplicates') {
      const duplicatesPayload = await createFindDuplicatesPayload(body, startupWorkspaceRoot);
      return {
        payload: duplicatesPayload,
        requestBody: body
      };
    }

    const toolRequest = createToolRequestFromBody(body, startupWorkspaceRoot);
    if (!toolRequest) {
      throw new HttpError(
        400,
        'invalid tool request body: workspaceRoot is required in body or via CODE_INTEL_WORKSPACE_ROOT/--workspaceRoot',
        'WORKSPACE_ROOT_REQUIRED'
      );
    }

    return {
      payload: createToolPayload(tool, toolRequest),
      requestBody: body
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
    const toolExecution = await executeToolByName(tool, requestBody);

    return {
      statusCode: 200,
      payload: toolExecution.payload,
      requestBody: toolExecution.requestBody
    };
  }

  type McpPostResponse = { statusCode: number; payload?: JsonRpcResponse; requestBody: unknown; skipResponse: boolean };

  function createMcpNotificationResponse(requestBody: unknown): McpPostResponse {
    return {
      statusCode: 204,
      payload: undefined,
      requestBody,
      skipResponse: true
    };
  }

  function createMcpSuccessResponse(id: JsonRpcId, requestBody: unknown, result: unknown): McpPostResponse {
    return {
      statusCode: 200,
      payload: {
        jsonrpc: '2.0',
        id,
        result
      },
      requestBody,
      skipResponse: false
    };
  }

  function createMcpErrorResponse(
    statusCode: number,
    code: number,
    message: string,
    requestBody: unknown,
    id: JsonRpcId = null
  ): McpPostResponse {
    return {
      statusCode,
      payload: createJsonRpcError(code, message, id),
      requestBody,
      skipResponse: false
    };
  }

  async function processMcpToolCall(
    requestBody: JsonRpcRequest,
    id: JsonRpcId
  ): Promise<McpPostResponse> {
    const params = requestBody.params;
    if (!params || typeof params !== 'object') {
      return createMcpErrorResponse(400, -32602, 'Invalid params', requestBody, id);
    }

    const name = (params as { name?: unknown }).name;
    const args = (params as { arguments?: unknown }).arguments;

    if (typeof name !== 'string' || !isToolName(name)) {
      return createMcpErrorResponse(400, -32602, 'Invalid params: unknown tool name', requestBody, id);
    }

    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
      return createMcpErrorResponse(400, -32602, 'Invalid params: arguments must be an object', requestBody, id);
    }

    try {
      const toolExecution = await executeToolByName(name, (args as Record<string, unknown>) ?? {});
      const toolPayload = toolExecution.payload;
      const text = toolPayload.ok
        ? JSON.stringify(toolPayload.data)
        : JSON.stringify({ error: toolPayload.error, data: toolPayload.data });

      return createMcpSuccessResponse(id, requestBody, {
        content: [{ type: 'text', text }],
        structuredContent: toolPayload.data,
        isError: !toolPayload.ok
      });
    } catch (error) {
      if (error instanceof HttpError) {
        return createMcpErrorResponse(error.statusCode, -32602, error.message, requestBody, id);
      }

      return createMcpErrorResponse(500, -32603, 'Internal error', requestBody, id);
    }
  }

  async function dispatchMcpMethod(requestBody: JsonRpcRequest): Promise<McpPostResponse> {
    const id = requestBody.id ?? null;
    const isNotification = requestBody.id === undefined;

    if (requestBody.method === 'notifications/initialized') {
      return createMcpNotificationResponse(requestBody);
    }

    if (requestBody.method === 'initialize') {
      if (isNotification) {
        return createMcpNotificationResponse(requestBody);
      }

      return createMcpSuccessResponse(id, requestBody, {
        protocolVersion: '2024-11-05',
        serverInfo: {
          name: 'code-intel-mcp',
          version: '0.1.0'
        },
        capabilities: {
          tools: {
            listChanged: false
          }
        }
      });
    }

    if (requestBody.method === 'tools/list') {
      if (isNotification) {
        return createMcpNotificationResponse(requestBody);
      }

      return createMcpSuccessResponse(id, requestBody, createMcpToolsListPayload());
    }

    if (requestBody.method !== 'tools/call') {
      if (isNotification) {
        return createMcpNotificationResponse(requestBody);
      }

      return createMcpErrorResponse(404, -32601, 'Method not found', requestBody, id);
    }

    if (isNotification) {
      return createMcpNotificationResponse(requestBody);
    }

    return processMcpToolCall(requestBody, id);
  }

  async function processMcpPostRequest(request: IncomingMessage): Promise<McpPostResponse> {
    const unauthorized = createUnauthorizedPayload();
    if (unauthorized) {
      return createMcpErrorResponse(unauthorized.statusCode, -32001, unauthorized.payload.error, undefined);
    }

    const invalidApiKey = createInvalidApiKeyPayload(request);
    if (invalidApiKey) {
      return createMcpErrorResponse(invalidApiKey.statusCode, -32001, invalidApiKey.payload.error, undefined);
    }

    const requestBody = await readJsonBody(request, maxBodyBytes);
    if (Array.isArray(requestBody)) {
      return createMcpErrorResponse(400, -32600, 'Batch requests are not supported', requestBody);
    }

    if (!isJsonRpcRequest(requestBody)) {
      return createMcpErrorResponse(400, -32600, 'Invalid Request', requestBody);
    }

    return dispatchMcpMethod(requestBody);
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
        const mcpResponse = await processMcpPostRequest(request);
        requestBody = mcpResponse.requestBody;
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
  const healthJson = (await healthResponse.json()) as HealthResponse;

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

const isDirectExecution = (process.argv[1] ?? '').replaceAll('\\', '/').endsWith('server.ts');
if (isDirectExecution) {
  const shouldSelfTest = process.argv.includes('--self-test');
  if (shouldSelfTest) {
    try {
      await runSelfTest();
    } catch (error: unknown) {
      logger.error('self-test failed', {
        error: toErrorMessage(error)
      });
      process.exit(1);
    }
  } else {
    const startupOptions = resolveStartupOptions();
    const startupWorkspaceRoot = await promptWorkspaceRootIfMissingOrInvalid(startupOptions.workspaceRoot);

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
}
