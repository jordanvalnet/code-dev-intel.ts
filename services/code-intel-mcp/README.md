# code-intel-mcp

`code-intel-mcp` is a lightweight HTTP server exposing TypeScript code-intelligence tools for AI agents and automation.

## Best fit

- Project stack: **TypeScript / JavaScript** codebases
- Runtime: **Node.js 24+**
- Package manager: **pnpm 10+**

The server is project-agnostic and can be reused in any TypeScript repository.

## Available endpoints

- `GET /health`
- `GET /tools/describe`
- `POST /mcp` (JSON-RPC 2.0)
- `POST /tools/findDefinitions`
- `POST /tools/findReferences`
- `POST /tools/findImplementations`
- `POST /tools/getFileOutline`
- `POST /tools/getSymbolContent`
- `POST /tools/dependencyGraph`
- `POST /tools/searchStruct`
- `POST /tools/searchText`
- `POST /tools/findDuplicates`

## Quick start

From repo root:

```bash
pnpm install
pnpm mcp:start
```

Server default URL: `http://127.0.0.1:4545`

## Startup options

You can configure startup via CLI args or environment variables.

### Workspace root

- CLI: `--workspaceRoot=<ABSOLUTE_PROJECT_PATH>`
- ENV: `CODE_INTEL_WORKSPACE_ROOT=<ABSOLUTE_PROJECT_PATH>`

If the provided workspace path is missing/invalid at launch, the server prompts for a valid path (no hardcoded repository paths in source).

### Port

- CLI: `--port=<NUMBER>`
- ENV: `CODE_INTEL_PORT=<NUMBER>`

Example:

```bash
pnpm mcp:start -- --port=4600
```

### Request logging (debug mode)

- CLI: `--log-requests` (or `--logRequests`)
- ENV: `CODE_INTEL_LOG_REQUESTS=true`

Example:

```bash
pnpm mcp:start:logs -- --workspaceRoot=/absolute/path/to/project
```

When enabled, each request logs method, path, status, duration, request body, and response payload.

### Security/runtime environment variables

- `CODE_INTEL_HOST` (default: `127.0.0.1`)
- `CODE_INTEL_PORT` (default: `4545`)
- `CODE_INTEL_API_KEY` (optional; when set, clients must send `x-api-key`)
- `CODE_INTEL_MAX_BODY_BYTES` (default: `524288`)
- `CODE_INTEL_SPAWN_TIMEOUT` (default: `5000`)
- `CODE_INTEL_SPAWN_MAX_BUFFER` (default: `4194304`)
- `CODE_INTEL_LOG_LEVEL` (default: `info`)

If `CODE_INTEL_HOST` is non-local (`0.0.0.0`, LAN host, etc.) and no API key is configured,
tool requests are rejected with HTTP 401 for safety.

## `findDuplicates` request example

```http
POST /tools/findDuplicates
Content-Type: application/json

{
	"workspaceRoot": "/absolute/path/to/project",
	"paths": ["src"],
	"minLines": 6,
	"minTokens": 40,
	"mode": "balanced",
	"maxGroups": 20,
	"outputFormat": "markdown"
}
```

## `searchText` request examples

Default scope (search from workspace root `.`):

```http
POST /tools/searchText
Content-Type: application/json

{
	"workspaceRoot": "/absolute/path/to/project",
	"query": "patchProfile",
	"options": {
		"maxResults": 200
	}
}
```

Scoped search in `src` only:

```http
POST /tools/searchText
Content-Type: application/json

{
	"workspaceRoot": "/absolute/path/to/project",
	"query": "patchProfile",
	"options": {
		"searchPath": "src",
		"maxResults": 200
	}
}
```

## Self-test

```bash
pnpm mcp:self-test
```

## Basic usage example

Request:

```http
POST /tools/getSymbolContent
Content-Type: application/json

{
	"workspaceRoot": "/absolute/path/to/project",
	"filePath": "src/foo.ts",
	"symbol": "buildFoo"
}
```

## MCP JSON-RPC usage

This server exposes a JSON-RPC endpoint compatible with core MCP tool workflows.

### Initialize

```http
POST /mcp
Content-Type: application/json

{
	"jsonrpc": "2.0",
	"id": 1,
	"method": "initialize",
	"params": {
		"protocolVersion": "2024-11-05",
		"capabilities": {},
		"clientInfo": { "name": "client", "version": "1.0.0" }
	}
}
```

### List tools (`tools/list`)

```http
POST /mcp
Content-Type: application/json

{
	"jsonrpc": "2.0",
	"id": 2,
	"method": "tools/list"
}
```

### Call a tool (`tools/call`)

```http
POST /mcp
Content-Type: application/json

{
	"jsonrpc": "2.0",
	"id": 3,
	"method": "tools/call",
	"params": {
		"name": "searchText",
		"arguments": {
			"workspaceRoot": "/absolute/path/to/project",
			"query": "patchProfile",
			"options": {
				"searchPath": "src"
			}
		}
	}
}
```

## Integration guidance for any TypeScript project

1. Start server with your project root as `workspaceRoot` (CLI arg or env).
2. Keep tool requests file-relative to that root (`src/...`).
3. Ensure your target project has a valid `tsconfig.json` for best symbol resolution.
4. Use `getFileOutline` + `getSymbolContent` before broad text searches to reduce context noise.
5. Enable `--log-requests` temporarily when wiring a new agent/client.

## Notes

- `searchText` uses `ripgrep` when available and falls back to a Node implementation.
- `searchText` supports `options.searchPath` (default: `.`).
- `dependencyGraph` supports `options.maxDepth` and `options.includeExternal`.
- `getFileOutline` supports `options.symbolKinds` filtering.
- `/health` stays lightweight (liveness + tool list + discovery links).
- `/tools/describe` is machine-readable discovery and maps to MCP `tools/list` semantics.
- `/mcp` supports JSON-RPC methods: `initialize`, `notifications/initialized`, `tools/list`, `tools/call`.

