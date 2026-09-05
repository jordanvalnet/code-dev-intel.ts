import {
  TOOL_NAMES,
  type HealthResponse,
  type ToolDescriptor,
  type ToolsDescribeResponse
} from './contracts.ts';
import { ASSET_EXTENSION_LIST, DEFAULT_INCLUDE_ASSETS } from '../../indexer/src/asset-modules.ts';

/**
 * Both module-graph tools take this option under the same name, so the model learns it
 * once. The extension list is spelled out because the answer is only predictable if the
 * caller knows which files count as assets; everything else — exact-filename resolution,
 * why an asset is always a leaf, what `false` also drops — is in the README.
 */
const assetOptionDescription = `Imported non-code files count as leaf nodes: ${ASSET_EXTENSION_LIST}`;

/**
 * Both module-graph tools resolve specifiers the same way, so they say it in the same
 * words, once. Everything this clause compresses (the `extends` chain, the .mts/.cts
 * family, directory imports, the root-config fallback) is in the README.
 */
const resolutionClause =
  "Resolution is tsc's own, from the nearest tsconfig/jsconfig: path aliases (paths/baseUrl), " +
  'package exports, workspace packages.';

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

const RESOLUTION_OPTIONS = {
  includeNodeModules: {
    type: 'boolean' as const,
    required: false,
    default: false,
    description: 'Include matches inside node_modules (default false).'
  },
  includeDeclarationFiles: {
    type: 'boolean' as const,
    required: false,
    default: false,
    description: 'Include matches inside *.d.ts ambient files (default false).'
  }
};

// Every advertised tool genuinely works. Descriptions follow the formula
// [what it returns] · [use-when trigger] · [instead of which built-in] · [token/precision benefit]
// so an agent has a concrete reason to prefer this over reflexive Grep/Glob/Read.
//
// An MCP client injects every one of these strings into the model's context on EVERY
// session, so length here is a recurring cost paid by the users of a tool whose whole
// point is token economy. Budget: <= 480 characters per tool description, <= 160 per
// option description. Anything that does not change what the model DOES — enumerations
// of import forms, the reason-by-reason glossary, worked examples — belongs in the
// README, which a model can read on demand and only once.
export function createToolsDescribePayload(): ToolsDescribeResponse {
  const tools: ToolDescriptor[] = [
    {
      name: 'findDefinitions',
      endpoint: '/tools/findDefinitions',
      description:
        "Go-to-definition for a TS/JS symbol — the exact declaration site(s), type-checker resolved across re-exports and aliases. Use for 'where is X defined / declared' instead of grepping the name then Reading files; one call replaces a grep plus several Reads. Returns `{ count, byFile: { \"<path>\": [\"line:col\", ...] } }`.",
      requiredRequestFields: ['workspaceRoot', 'filePath', 'symbol'],
      options: RESOLUTION_OPTIONS
    },
    {
      name: 'findReferences',
      endpoint: '/tools/findReferences',
      description:
        "Every real usage of a TS/JS symbol (function/class/variable/type) across the repo, resolved by the type-checker — no false hits in comments, strings, or unrelated same-named symbols. Use for 'where is X used / all usages / all call sites' instead of Grep: not grep noise, and you skip opening whole files. Returns `{ count, byFile: { \"<path>\": [\"line:col\", ...] } }` — positions grouped by file, compact.",
      requiredRequestFields: ['workspaceRoot', 'filePath', 'symbol'],
      options: RESOLUTION_OPTIONS
    },
    {
      name: 'findImplementations',
      endpoint: '/tools/findImplementations',
      description:
        "All implementations of an interface, abstract class, or port/type — type-aware. Use for 'who implements this interface/port' instead of guessing with Grep on the name; returns the concrete implementation sites directly as `{ count, byFile: { \"<path>\": [\"line:col\", ...] } }`.",
      requiredRequestFields: ['workspaceRoot', 'filePath', 'symbol'],
      options: RESOLUTION_OPTIONS
    },
    {
      name: 'findSymbol',
      endpoint: '/tools/findSymbol',
      description:
        'Find a symbol by name alone — workspace symbol search / "go to symbol" by NAME ONLY, no filePath needed. Use this FIRST when you know the name of a function/class/type/var but not where it lives, instead of Grep for "where is X defined": the type-checker returns the exact declaration site(s) as a short name/kind/file:line list with containerName, so you skip grepping and reading whole files. Pair with findReferences/findCallers once you have the file.',
      requiredRequestFields: ['workspaceRoot', 'symbol']
    },
    {
      name: 'findCallers',
      endpoint: '/tools/findCallers',
      description:
        'Find who calls a function/method — incoming call hierarchy resolved by the type-checker (the real callers, not same-named noise). Use instead of Grep/findReferences for "who calls X / all callers / incoming calls / call sites of X": returns each caller symbol + the exact call-site file:line range, so you trace impact upward without reading every match.',
      requiredRequestFields: ['workspaceRoot', 'filePath', 'symbol']
    },
    {
      name: 'findCallees',
      endpoint: '/tools/findCallees',
      description:
        'Find what a function calls — outgoing call hierarchy resolved by the type-checker. Use for "what does X call / callees / outgoing calls / dependencies of this function" instead of reading the whole body: returns each callee symbol + the call-site file:line range inside the function, so you map a function\'s downstream calls fast.',
      requiredRequestFields: ['workspaceRoot', 'filePath', 'symbol']
    },
    {
      name: 'getSymbolContent',
      endpoint: '/tools/getSymbolContent',
      description:
        'Full source of ONE symbol (function/class/type) by name — just that declaration, not the whole file. Use instead of Read when you only need a single symbol body (typically 10-50 lines vs an entire file). Supports maxLines to cap large declarations.',
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
      name: 'getFileOutline',
      endpoint: '/tools/getFileOutline',
      description:
        "Structured outline of a file — every function/class/method/export with its signature and line range — WITHOUT reading the file. Use to grasp a file's shape or locate a member before a targeted read, instead of Read-ing hundreds of lines to find one symbol.",
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
      name: 'dependencyGraph',
      endpoint: '/tools/dependencyGraph',
      description:
        'Import/dependency graph rooted at a file: what it imports, transitively (internal; external on request). ' +
        resolutionClause +
        ' Anything unfollowed is reported in `unresolved` with a reason; `unresolvedCount` 0 means the graph is complete. ' +
        "Use for 'what does this file depend on' instead of Reading files to trace imports; options.includeAssets covers non-code imports.",
      requiredRequestFields: ['workspaceRoot', 'filePath'],
      options: {
        maxDepth: {
          type: 'number',
          required: false,
          default: 5,
          description: 'Maximum traversal depth for dependency expansion.'
        },
        includeExternal: {
          type: 'boolean',
          required: false,
          default: false,
          description: 'Include package/external dependencies in result.'
        },
        includeAssets: {
          type: 'boolean',
          required: false,
          default: DEFAULT_INCLUDE_ASSETS,
          description: assetOptionDescription
        }
      }
    },
    {
      name: 'impactedFiles',
      endpoint: '/tools/impactedFiles',
      description:
        'Blast radius: every file transitively importing options.changedFiles (repo-relative; stylesheets and JSON too, options.includeAssets). ' +
        resolutionClause +
        ' Unfollowed specifiers are reported with a reason; `unresolvedCount` 0 means no importer was missed. ' +
        'Use to scope a refactor or review, not hand-tracing importers; options.changedSymbolsByFile narrows by export name.',
      requiredRequestFields: ['workspaceRoot'],
      options: {
        changedFiles: {
          type: 'array',
          items: {
            type: 'string'
          },
          required: true,
          description: 'Repo-relative paths of the changed files to compute the impact set for.'
        },
        changedSymbolsByFile: {
          type: 'object',
          additionalProperties: {
            type: 'array',
            items: {
              type: 'string'
            }
          },
          required: false,
          description:
            'Repo-relative path -> changed export names, e.g. { "src/a.ts": ["X"] }: keeps only importers using one; ' +
            're-exports stay transparent. No entry = fully changed.'
        },
        includeAssets: {
          type: 'boolean',
          required: false,
          default: DEFAULT_INCLUDE_ASSETS,
          description: assetOptionDescription
        }
      }
    },
    {
      name: 'searchStruct',
      endpoint: '/tools/searchStruct',
      description:
        'Find code by AST shape, not text — ast-grep structural pattern matching with metavariables (e.g. `useState($A)`, `if ($C) { return $X }`). Use instead of Grep when you need syntax-aware matches that ignore whitespace/formatting and only hit real code (not comments/strings): returns file:line ranges + snippet. Degrades to an empty result with engineFallbackReason if the ast-grep binary is unavailable instead of erroring.',
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
      name: 'findDuplicates',
      endpoint: '/tools/findDuplicates',
      description:
        'Detect duplicated / copy-paste code blocks (type-1/2/3 clones) with similarity scores and an optional markdown report. Use to find extract-function opportunities or before refactoring, instead of eyeballing files.',
      requiredRequestFields: ['workspaceRoot']
    },
    {
      name: 'searchText',
      endpoint: '/tools/searchText',
      description:
        'Repo-wide text/regex search (ripgrep), .gitignore-aware, returning file:line plus a compact snippet per match. Prefer the symbol tools above when searching for a SYMBOL (findReferences/findDefinitions/findSymbol) — they avoid false positives; use this for non-symbol text: literals, comments, config keys, TODOs.',
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
