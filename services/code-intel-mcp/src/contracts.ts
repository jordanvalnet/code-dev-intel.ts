import { z } from 'zod';

export interface ToolRequest {
  workspaceRoot: string;
  query?: string;
  symbol?: string;
  filePath?: string;
  options?: Record<string, unknown>;
}

export interface ToolResponse<T = unknown> {
  ok: boolean;
  tool: ToolName;
  data: T;
  error?: string;
}

export type DuplicateMode = 'fast' | 'balanced' | 'strict';
export type DuplicateKind = 'type1' | 'type2' | 'type3';
export type DuplicateSuggestedAction = 'extract-function' | 'shared-util' | 'review';
export type DuplicateOutputFormat = 'json' | 'markdown';

export interface FindDuplicatesRequest {
  workspaceRoot: string;
  paths?: string[];
  exclude?: string[];
  minLines?: number;
  minTokens?: number;
  minSimilarity?: number;
  maxGroups?: number;
  includeIntraFile?: boolean;
  mode?: DuplicateMode;
  sinceGitRef?: string;
  outputFormat?: DuplicateOutputFormat;
}

export interface DuplicateOccurrence {
  filePath: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
  symbolName?: string;
  snippetPreview: string;
}

export interface DuplicateGroup {
  groupId: string;
  fingerprint: string;
  kind: DuplicateKind;
  similarity: number;
  occurrences: DuplicateOccurrence[];
  metrics: {
    linesPerOccurrence: number;
    tokenCount: number;
    occurrenceCount: number;
    estimatedDupLines: number;
    impactScore: number;
  };
  suggestedAction: DuplicateSuggestedAction;
}

export interface FindDuplicatesSummary {
  scannedFiles: number;
  candidateWindows: number;
  groupsFound: number;
  durationMs: number;
  mode: DuplicateMode;
  peakMemoryMb: number;
  truncated: boolean;
}

export interface FindDuplicatesResult {
  groups: DuplicateGroup[];
  summary: FindDuplicatesSummary;
  markdownReport?: string;
}

export interface SymbolLocation {
  filePath: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface SymbolQueryResult {
  symbol: string;
  sourceFilePath: string;
  locations: SymbolLocation[];
}

export interface FileOutlineItem {
  name: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  signature?: string;
}

export interface FileOutlineResult {
  filePath: string;
  appliedKinds: string[];
  symbolsByKind: Record<string, FileOutlineItem[]>;
}

export interface SymbolContentResult {
  symbol: string;
  sourceFilePath: string;
  declarationFilePath: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  content: string;
  truncated: boolean;
  truncatedAtLine?: number;
}

export interface DependencyEdge {
  from: string;
  to: string;
  kind: 'internal' | 'external';
}

export interface DependencyGraphResult {
  rootFilePath: string;
  maxDepth: number;
  dependencies: string[];
  externalDependencies: string[];
  edges: DependencyEdge[];
}

export interface StructMatch {
  filePath: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  snippet: string;
}

export interface StructSearchResult {
  pattern: string;
  language: string;
  matches: StructMatch[];
}

export interface TextMatch {
  filePath: string;
  line: number;
  column: number;
  snippet: string;
}

export interface TextSearchResult {
  query: string;
  engine: 'ripgrep' | 'node-fallback';
  matches: TextMatch[];
  engineFallbackReason?: string;
}

export interface HealthResponse {
  ok: true;
  status: 'up';
  tools: ToolName[];
  discovery: {
    toolsDescribePath: '/tools/describe';
    jsonRpcPath: '/mcp';
    mcpEquivalentMethod: 'tools/list';
  };
}

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export type JsonSchemaPrimitiveType = 'string' | 'number' | 'boolean';

export interface ToolOptionDescriptor {
  type: JsonSchemaPrimitiveType | 'array';
  items?: {
    type: JsonSchemaPrimitiveType;
  };
  required: boolean;
  default?: string | number | boolean | string[];
  description: string;
}

export interface ToolDescriptor {
  name: ToolName;
  endpoint: string;
  description: string;
  requiredRequestFields: Array<'workspaceRoot' | 'query' | 'symbol' | 'filePath' | 'options'>;
  options?: Record<string, ToolOptionDescriptor>;
}

export interface ToolsDescribeResponse {
  ok: true;
  standard: {
    protocol: 'model-context-protocol';
    equivalentMethod: 'tools/list';
  };
  tools: ToolDescriptor[];
}

export const TOOL_NAMES = [
  'findSymbol',
  'findDefinitions',
  'findReferences',
  'findImplementations',
  'getFileOutline',
  'getSymbolContent',
  'dependencyGraph',
  'findCallers',
  'findCallees',
  'searchStruct',
  'searchText',
  'findDuplicates',
  'impactedFiles',
  'health'
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(value: string): value is ToolName {
  return TOOL_NAMES.includes(value as ToolName);
}

const ToolOptionsSchema = z.record(z.string(), z.unknown());

export const ToolRequestBodySchema = z
  .object({
    workspaceRoot: z.string().trim().min(1).optional(),
    query: z.string().optional(),
    symbol: z.string().optional(),
    filePath: z.string().optional(),
    options: ToolOptionsSchema.optional()
  })
  .strict();

export type ToolRequestBody = z.infer<typeof ToolRequestBodySchema>;

export const FindDuplicatesRequestSchema = z
  .object({
    workspaceRoot: z.string().trim().min(1).optional(),
    paths: z.array(z.string().trim().min(1)).optional(),
    exclude: z.array(z.string().trim().min(1)).optional(),
    minLines: z.number().int().min(1).max(200).optional(),
    minTokens: z.number().int().min(1).max(5000).optional(),
    minSimilarity: z.number().min(0).max(1).optional(),
    maxGroups: z.number().int().min(1).max(1000).optional(),
    includeIntraFile: z.boolean().optional(),
    mode: z.enum(['fast', 'balanced', 'strict']).optional(),
    sinceGitRef: z.string().trim().min(1).optional(),
    outputFormat: z.enum(['json', 'markdown']).optional()
  })
  .strict();

export type FindDuplicatesRequestBody = z.infer<typeof FindDuplicatesRequestSchema>;
