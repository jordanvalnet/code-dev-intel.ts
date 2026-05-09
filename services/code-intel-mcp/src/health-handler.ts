import {
  TOOL_NAMES,
  type HealthResponse,
  type ToolDescriptor,
  type ToolsDescribeResponse
} from './contracts.ts';

export function createHealthPayload(): HealthResponse {
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

export function createToolsDescribePayload(): ToolsDescribeResponse {
  const tools: ToolDescriptor[] = [
    {
      name: 'findDefinitions',
      endpoint: '/tools/findDefinitions',
      description: 'Find symbol definitions from filePath + symbol.',
      requiredRequestFields: ['workspaceRoot', 'filePath', 'symbol'],
      options: {
        includeNodeModules: {
          type: 'boolean',
          required: false,
          default: false,
          description: 'Include matches inside node_modules (default false).'
        },
        includeDeclarationFiles: {
          type: 'boolean',
          required: false,
          default: false,
          description: 'Include matches inside *.d.ts ambient files (default false).'
        }
      }
    },
    {
      name: 'findReferences',
      endpoint: '/tools/findReferences',
      description: 'Find symbol references from filePath + symbol.',
      requiredRequestFields: ['workspaceRoot', 'filePath', 'symbol'],
      options: {
        includeNodeModules: {
          type: 'boolean',
          required: false,
          default: false,
          description: 'Include matches inside node_modules (default false).'
        },
        includeDeclarationFiles: {
          type: 'boolean',
          required: false,
          default: false,
          description: 'Include matches inside *.d.ts ambient files (default false).'
        }
      }
    },
    {
      name: 'findImplementations',
      endpoint: '/tools/findImplementations',
      description: 'Find symbol implementations from filePath + symbol.',
      requiredRequestFields: ['workspaceRoot', 'filePath', 'symbol'],
      options: {
        includeNodeModules: {
          type: 'boolean',
          required: false,
          default: false,
          description: 'Include matches inside node_modules (default false).'
        },
        includeDeclarationFiles: {
          type: 'boolean',
          required: false,
          default: false,
          description: 'Include matches inside *.d.ts ambient files (default false).'
        }
      }
    },
    {
      name: 'getFileOutline',
      endpoint: '/tools/getFileOutline',
      description: 'Get grouped symbols for a file.',
      requiredRequestFields: ['workspaceRoot', 'filePath'],
      options: {
        symbolKinds: {
          type: 'array',
          items: {
            type: 'string'
          },
          required: false,
          description: 'Optional list of symbol kinds to include.'
        },
        summaryOnly: {
          type: 'boolean',
          required: false,
          default: false,
          description: 'Omit signature field to keep payload small on large files.'
        }
      }
    },
    {
      name: 'getSymbolContent',
      endpoint: '/tools/getSymbolContent',
      description: 'Get full declaration content for a symbol.',
      requiredRequestFields: ['workspaceRoot', 'filePath', 'symbol'],
      options: {
        maxLines: {
          type: 'number',
          required: false,
          description: 'Truncate content after N lines and set truncated=true (default: no truncation).'
        }
      }
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

export function processGetRequest(pathname: string): { statusCode: number; payload: unknown } | null {
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
