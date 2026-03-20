import {
  isToolName,
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ToolDescriptor,
  type ToolName,
  type ToolResponse
} from './contracts.ts';
import { createToolsDescribePayload } from './health-handler.ts';
import { createToolPayload, createToolRequestFromBody, createFindDuplicatesPayload } from './tool-handler.ts';
import { HttpError } from './server-utils.ts';

export type McpPostResponse = {
  statusCode: number;
  payload?: JsonRpcResponse;
  requestBody: unknown;
  skipResponse: boolean;
};

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

export function createMcpToolsListPayload(): {
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

export async function executeToolByName(
  tool: ToolName,
  body: unknown,
  startupWorkspaceRoot?: string
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

async function processMcpToolCall(
  requestBody: JsonRpcRequest,
  id: JsonRpcId,
  startupWorkspaceRoot?: string
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
    const toolExecution = await executeToolByName(name, (args as Record<string, unknown>) ?? {}, startupWorkspaceRoot);
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

async function dispatchMcpMethod(requestBody: JsonRpcRequest, startupWorkspaceRoot?: string): Promise<McpPostResponse> {
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

  return processMcpToolCall(requestBody, id, startupWorkspaceRoot);
}

export async function processMcpPostRequest(
  requestBody: unknown,
  startupWorkspaceRoot?: string
): Promise<McpPostResponse> {
  if (Array.isArray(requestBody)) {
    return createMcpErrorResponse(400, -32600, 'Batch requests are not supported', requestBody);
  }

  if (!isJsonRpcRequest(requestBody)) {
    return createMcpErrorResponse(400, -32600, 'Invalid Request', requestBody);
  }

  return dispatchMcpMethod(requestBody, startupWorkspaceRoot);
}
