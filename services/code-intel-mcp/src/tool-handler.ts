import {
  type DependencyGraphResult,
  type FindCalleesResult,
  type FindCallersResult,
  FindDuplicatesRequestSchema,
  type FindDuplicatesResult,
  type FindSymbolResult,
  ToolRequestBodySchema,
  type StructSearchResult,
  type TextSearchResult,
  type SymbolQueryResult,
  type ToolName,
  type ToolRequest,
  type ToolResponse
} from './contracts.ts';
import {
  findCalleesBySymbol,
  findCallersBySymbol,
  findDefinitionsBySymbol,
  findSymbolByName,
  getDependencyGraph,
  findImplementationsBySymbol,
  findReferencesBySymbol,
  getFileOutline,
  getSymbolContent
} from './typescript-symbol-service.ts';
import { searchStructWithAstGrep } from './ast-grep-service.ts';
import { searchTextWithRipgrep } from './search-text-service.ts';
import { findDuplicates } from './duplicate-detection-service.ts';
import { calculateWorkspaceImpactedFiles } from '../../indexer/src/impacted-files-engine.ts';
import { HttpError, resolveAndValidateWorkspaceRoot } from './server-utils.ts';

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

function readResolutionOptions(request: ToolRequest): {
  includeNodeModules?: boolean;
  includeDeclarationFiles?: boolean;
} {
  const includeNodeModules = request.options?.includeNodeModules;
  const includeDeclarationFiles = request.options?.includeDeclarationFiles;
  return {
    includeNodeModules: includeNodeModules === true,
    includeDeclarationFiles: includeDeclarationFiles === true
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

  const resolutionOptions = readResolutionOptions(request);
  let result: SymbolQueryResult;

  if (tool === 'findDefinitions') {
    result = findDefinitionsBySymbol(request.workspaceRoot, request.filePath, request.symbol, resolutionOptions);
  } else if (tool === 'findReferences') {
    result = findReferencesBySymbol(request.workspaceRoot, request.filePath, request.symbol, resolutionOptions);
  } else {
    result = findImplementationsBySymbol(request.workspaceRoot, request.filePath, request.symbol, resolutionOptions);
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
      },
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
      },
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
      },
      error: 'filePath is required for getFileOutline'
    };
  }

  const symbolKindsOption = request.options?.symbolKinds;
  const symbolKinds = Array.isArray(symbolKindsOption)
    ? symbolKindsOption.filter((item): item is string => typeof item === 'string')
    : undefined;
  const summaryOnly = request.options?.summaryOnly === true;

  const result = getFileOutline(request.workspaceRoot, request.filePath, {
    symbolKinds,
    summaryOnly
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
        content: '',
        truncated: false
      },
      error: 'filePath and symbol are required for getSymbolContent'
    };
  }

  const maxLinesOption = request.options?.maxLines;
  const maxLines =
    typeof maxLinesOption === 'number' && Number.isFinite(maxLinesOption) && maxLinesOption > 0
      ? Math.floor(maxLinesOption)
      : undefined;

  const result = getSymbolContent(request.workspaceRoot, request.filePath, request.symbol, { maxLines });

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
      },
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

function createCallHierarchyPayload(
  tool: 'findCallers' | 'findCallees',
  request: ToolRequest
): ToolResponse<FindCallersResult> | ToolResponse<FindCalleesResult> {
  if (!request.filePath || !request.symbol) {
    if (tool === 'findCallers') {
      return {
        ok: false,
        tool,
        data: { symbol: request.symbol ?? '', sourceFilePath: request.filePath ?? '', callers: [] },
        error: 'filePath and symbol are required for findCallers'
      };
    }
    return {
      ok: false,
      tool,
      data: { symbol: request.symbol ?? '', sourceFilePath: request.filePath ?? '', callees: [] },
      error: 'filePath and symbol are required for findCallees'
    };
  }

  if (tool === 'findCallers') {
    return {
      ok: true,
      tool,
      data: findCallersBySymbol(request.workspaceRoot, request.filePath, request.symbol)
    };
  }

  return {
    ok: true,
    tool,
    data: findCalleesBySymbol(request.workspaceRoot, request.filePath, request.symbol)
  };
}

function createFindSymbolPayload(request: ToolRequest): ToolResponse<FindSymbolResult> {
  if (!request.symbol) {
    return {
      ok: false,
      tool: 'findSymbol',
      data: { symbol: '', matches: [] },
      error: 'symbol is required for findSymbol'
    };
  }

  return {
    ok: true,
    tool: 'findSymbol',
    data: findSymbolByName(request.workspaceRoot, request.symbol)
  };
}

function createImpactedFilesPayload(request: ToolRequest): ToolResponse {
  const changedFilesOption = request.options?.changedFiles;
  const changedFiles = Array.isArray(changedFilesOption)
    ? changedFilesOption.filter((item): item is string => typeof item === 'string')
    : [];

  if (changedFiles.length === 0) {
    return {
      ok: false,
      tool: 'impactedFiles',
      data: { impactedFiles: [], count: 0 },
      error: 'options.changedFiles (non-empty array of repo-relative paths) is required for impactedFiles'
    };
  }

  const changedSymbolsOption = request.options?.changedSymbolsByFile;
  const changedSymbolsByFile =
    changedSymbolsOption && typeof changedSymbolsOption === 'object' && !Array.isArray(changedSymbolsOption)
      ? (changedSymbolsOption as Record<string, string[]>)
      : undefined;

  const impacted = calculateWorkspaceImpactedFiles({
    workspaceRoot: request.workspaceRoot,
    changedFiles,
    changedSymbolsByFile
  });

  return {
    ok: true,
    tool: 'impactedFiles',
    data: { impactedFiles: impacted, count: impacted.length }
  };
}

export async function createFindDuplicatesPayload(
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

export function createToolPayload(
  tool: ToolName,
  request: ToolRequest
):
  | ToolResponse
  | ToolResponse<SymbolQueryResult>
  | ToolResponse<StructSearchResult>
  | ToolResponse<TextSearchResult>
  | ToolResponse<DependencyGraphResult>
  | ToolResponse<FindCallersResult>
  | ToolResponse<FindCalleesResult>
  | ToolResponse<FindSymbolResult> {
  if (tool === 'findDefinitions' || tool === 'findReferences' || tool === 'findImplementations') {
    return createSymbolResolutionPayload(tool, request);
  }

  if (tool === 'findCallers' || tool === 'findCallees') {
    return createCallHierarchyPayload(tool, request);
  }

  if (tool === 'findSymbol') {
    return createFindSymbolPayload(request);
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

  if (tool === 'impactedFiles') {
    return createImpactedFilesPayload(request);
  }

  return createMockPayload(tool, request);
}

export function createToolRequestFromBody(value: unknown, defaultWorkspaceRoot?: string): ToolRequest | null {
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
