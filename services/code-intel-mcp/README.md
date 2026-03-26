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

Installed as a package, the native CLI entrypoint is:

```bash
pnpm exec code-dev-intel start --workspaceRoot=. --port=4545
```

## CLI commands

### `start`

Starts the HTTP server in the foreground.

- Use it for manual local runs.
- The process stays attached to the current terminal.
- Exit code `0` means the server started and kept running until it was stopped normally.
- Exit code non-zero means startup failed.

Example:

```bash
pnpm exec code-dev-intel start --workspaceRoot=. --port=4545
```

### `status`

Checks whether a server is already healthy on the requested host/port.

- Exit code `0`: healthy server detected.
- Exit code non-zero: no healthy server detected.

Example:

```bash
pnpm exec code-dev-intel status --port=4545
```

### `ensure`

Ensures a healthy server is available on the requested host/port.

- If the server is already healthy, the command returns immediately with exit code `0`.
- If the server is not healthy, the CLI starts it in the background, waits for the health endpoint, then returns `0` once ready.
- If the service does not become healthy before timeout, the command exits non-zero with a clear error message.

`ensure` is the recommended command for AI agents, CI jobs, hooks, and automation because it is idempotent and removes the need for repo-local wrapper scripts.

Cross-platform consumer example:

```bash
pnpm exec code-dev-intel ensure --workspaceRoot=. --port=4545
```

Verbose example with explicit timeout:

```bash
pnpm exec code-dev-intel ensure --workspaceRoot=. --port=4545 --timeout=15000 --verbose
```

### Migrating from local wrapper scripts

If a consumer repository previously used a repo-local script to:

1. check whether code-intel was already running,
2. start it when missing,
3. wait for `/health`,
4. fail on timeout,

replace that wrapper with the native CLI command below:

```bash
pnpm exec code-dev-intel ensure --workspaceRoot=. --port=4545
```

That is now the supported and recommended entrypoint for automation.

### Recommended usage by context

- Manual local debugging: `start`
- Health probe only: `status`
- AI agents, CI, hooks, automation: `ensure`

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

### Ensure timeout

- CLI: `--timeout=<MILLISECONDS>`

Used by `ensure` while waiting for the health endpoint to become ready.

Example:

```bash
pnpm exec code-dev-intel ensure --workspaceRoot=. --port=4545 --timeout=15000
```

### Host and health URL

- CLI: `--host=<HOST>`
- CLI: `--health-url=<URL_OR_PATH>`

`--health-url` accepts either a full URL or a path such as `/health`.

Examples:

```bash
pnpm exec code-dev-intel ensure --workspaceRoot=. --host=127.0.0.1 --port=4545
pnpm exec code-dev-intel ensure --workspaceRoot=. --port=4545 --health-url=/health
```

### Verbose helper output

- CLI: `--verbose`

Useful with `ensure` to print retry progress while waiting for health.

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

## Exit codes

- `start`: `0` on normal process shutdown, non-zero on startup failure.
- `status`: `0` when the server is healthy, `1` otherwise.
- `ensure`: `0` when the server is already healthy or becomes healthy after startup, `1` when startup or health validation fails.

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

