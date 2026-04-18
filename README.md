# code-dev-intel

`code-dev-intel` is an npm package that exposes a self-hosted MCP and HTTP server for TypeScript code intelligence.

It gives AI agents and IDE assistants fast access to symbol definitions, references, implementations, file outlines, dependency graphs, structural search, text search, and duplicate detection without forcing the model to scan your whole repository every time.

## What The Package Brings To A Project

- Faster code navigation for AI agents in medium and large TypeScript repositories.
- A local-first MCP server you can plug into IDEs, coding agents, and CLI assistants.
- A stable automation entrypoint with `ensure`, so scripts and agents can start the server only when needed.
- An HTTP API for tools and health checks, plus MCP JSON-RPC for clients that speak MCP directly.
- A self-hosted alternative to remote code indexing for teams that want data to stay local.

## Good Use Cases

- Refactoring a symbol safely across many files.
- Reviewing a PR and tracing impact before commenting.
- Understanding a codebase entrypoint without opening dozens of files.
- Replacing repeated grep chains with semantic navigation.
- Running local automation in CI, hooks, or agent workflows.

## What The Package Exposes

### Tools

- `findDefinitions`
- `findReferences`
- `findImplementations`
- `getFileOutline`
- `getSymbolContent`
- `dependencyGraph`
- `searchStruct`
- `searchText`
- `findDuplicates`

### Protocols

- MCP over stdio
- MCP over JSON-RPC via `POST /mcp`
- Plain HTTP tool endpoints under `/tools/*`
- Health and discovery endpoints via `/health` and `/tools/describe`

## Installation

```bash
pnpm add -D code-dev-intel.ts
```

Requirements:

- Node.js `>=18`
- pnpm `>=10`
- A TypeScript or JavaScript repository where semantic navigation is useful

## Quick Start

### Recommended bootstrap command

```bash
pnpm exec code-dev-intel ensure --workspaceRoot=. --port=4545
```

This is the recommended command for agents, scripts, hooks, and CI because it:

- starts the service only if needed
- waits until the server is healthy
- exits successfully when the server is already running

### Other CLI commands

```bash
pnpm exec code-dev-intel start --workspaceRoot=. --port=4545
pnpm exec code-dev-intel status --port=4545
pnpm exec code-dev-intel ensure --workspaceRoot=. --port=4545 --timeout=15000 --verbose
```

## How To Use It In A Project

### HTTP example

```bash
curl -X POST http://127.0.0.1:4545/tools/findReferences \
	-H "Content-Type: application/json" \
	-d '{
		"workspaceRoot": "/absolute/path/to/project",
		"filePath": "src/feature/use-case.ts",
		"symbol": "runFeature"
	}'
```

### MCP JSON-RPC example

```json
{
	"jsonrpc": "2.0",
	"id": 1,
	"method": "tools/call",
	"params": {
		"name": "getFileOutline",
		"arguments": {
			"workspaceRoot": "/absolute/path/to/project",
			"filePath": "src/feature/use-case.ts",
			"options": {
				"symbolKinds": ["function", "class"]
			}
		}
	}
}
```

### Typical agent workflow

1. Call `getFileOutline` to understand file structure.
2. Call `getSymbolContent` for the exact function, class, or type you need.
3. Call `findReferences` or `findDefinitions` to trace impact.
4. Use `dependencyGraph` when imports and module flow matter.
5. Use `searchStruct` for AST-shaped code patterns.
6. Fall back to `searchText` for literal strings, comments, or error messages.

## Tool Guide

### `findDefinitions`

Use when you know the symbol name and want the canonical declaration site.

### `findReferences`

Use when you want call sites, usages, and cross-file impact.

### `findImplementations`

Use for interfaces, abstract contracts, and implementation discovery.

### `getFileOutline`

Use before reading a large file. This is the fastest way to understand the file structure.

### `getSymbolContent`

Use when you want the full declaration body of one symbol instead of the entire file.

### `dependencyGraph`

Use when you need import relationships and transitive module dependencies.

### `searchStruct`

Use when you need structural matching with `ast-grep` patterns instead of plain text.

Example:

```json
{
	"workspaceRoot": "/absolute/path/to/project",
	"query": "export interface $NAME { $$$BODY }",
	"options": {
		"language": "ts"
	}
}
```

### `searchText`

Use for literal strings, comments, log messages, config keys, or partial identifiers.

### `findDuplicates`

Use when you want code duplication clusters and optional markdown reporting.

## Prompting Recommendations For AI Agents

This package works best when the client prompt explicitly tells the model when to prefer semantic tools over raw text search.

### Minimal system prompt snippet

```text
Use code-dev-intel for non-trivial TypeScript exploration before falling back to grep or full-file reads.
Prefer:
- getFileOutline for large files
- getSymbolContent for targeted reads
- findDefinitions/findReferences for symbol tracing
- dependencyGraph for module flow
- searchStruct for AST-shaped patterns
- searchText only for literal text queries
```

### Review-focused prompt snippet

```text
Before reviewing TypeScript changes, use code-dev-intel to trace definitions, references, implementations, and dependency impact.
Do not rely only on text search when checking refactors or behavioral regressions.
```

### Refactor-focused prompt snippet

```text
When planning a refactor, first inspect file outlines and symbol content, then trace references and dependency impact.
Use structural search only for syntax-shaped patterns and plain text search only for literals.
```

### Practical guidance for prompt authors

- Tell the model that this server is for TypeScript semantic navigation.
- State when it should be preferred over grep.
- Mention the high-value tools by name so the model knows what to search for.
- Keep the instructions short and concrete. Long MCP instructions are easier for clients to truncate.

## IDE And Agent Configuration

The package can be exposed either as:

- a local stdio MCP server
- a local HTTP server with `/mcp` and `/tools/*`

### VS Code / GitHub Copilot

Create `.vscode/mcp.json`:

```json
{
	"servers": {
		"codeIntel": {
			"type": "stdio",
			"command": "pnpm",
			"args": [
				"exec",
				"code-dev-intel",
				"--stdio",
				"--workspaceRoot=${workspaceFolder}"
			]
		}
	}
}
```

Useful VS Code commands:

- `MCP: List Servers`
- `MCP: Reset Cached Tools`
- `MCP: Reset Trust`
- `MCP: Open Workspace Folder MCP Configuration`

Notes:

- VS Code expects `.vscode/mcp.json` with top-level `servers`.
- If tools do not appear after an update, reset cached tools and reload the window.

### Claude Code

Project-shared config in `.mcp.json`:

```json
{
	"mcpServers": {
		"code-intel": {
			"command": "pnpm",
			"args": [
				"exec",
				"code-dev-intel",
				"--stdio",
				"--workspaceRoot=."
			]
		}
	}
}
```

CLI setup example:

```bash
claude mcp add --transport stdio --scope project code-intel -- \
	pnpm exec code-dev-intel --stdio --workspaceRoot=.
```

On native Windows, Claude Code may require `cmd /c` for `npx`. With `pnpm`, the direct command usually remains cleaner.

Useful commands:

- `claude mcp list`
- `claude mcp get code-intel`
- `/mcp`

### Windsurf

Add the server in `~/.codeium/windsurf/mcp_config.json`:

```json
{
	"mcpServers": {
		"code-intel": {
			"command": "pnpm",
			"args": [
				"exec",
				"code-dev-intel",
				"--stdio",
				"--workspaceRoot=."
			]
		}
	}
}
```

Windsurf also supports remote HTTP MCP configuration if you prefer starting the server separately and pointing the client to `/mcp`.

### Generic MCP clients

Many clients and IDE agents can consume the same server even if their exact UI differs.

Use this stdio shape when the client expects a command-based MCP server:

```json
{
	"mcpServers": {
		"code-intel": {
			"command": "pnpm",
			"args": [
				"exec",
				"code-dev-intel",
				"--stdio",
				"--workspaceRoot=."
			]
		}
	}
}
```

Use this HTTP shape when the client expects a remote MCP endpoint:

```json
{
	"mcpServers": {
		"code-intel": {
			"type": "http",
			"url": "http://127.0.0.1:4545/mcp"
		}
	}
}
```

This generic approach usually applies to MCP-capable assistants and IDEs such as Cursor-like, Cline-like, Roo-like, or custom internal agent shells that can launch stdio or HTTP MCP servers.

### Non-MCP automation

If your tool does not support MCP yet, start the server with `ensure` and call the HTTP endpoints directly.

Examples:

- internal scripts
- CI jobs
- review bots
- custom agent frameworks
- editor plugins that can call HTTP but not MCP

## Recommended Operating Modes

### For local development

```bash
pnpm exec code-dev-intel ensure --workspaceRoot=. --port=4545
```

### For CI or hooks

```bash
pnpm exec code-dev-intel ensure --workspaceRoot=. --port=4545 --timeout=15000
```

### For containerized local isolation

```bash
pnpm docker:core:up
curl http://127.0.0.1:4545/health
```

## Security Notes

- The default host is `127.0.0.1`.
- If you bind to a non-local host, configure `CODE_INTEL_API_KEY`.
- All user-supplied paths are normalized and validated against workspace boundaries.
- The server is designed for local-first use. If you expose it remotely, put it behind your normal network controls.

## Package Validation

Before publishing a new version, these commands are the main confidence checks:

```bash
pnpm build
pnpm test:all
pnpm mcp:self-test
pnpm release:smoke
```

`release:smoke` is the most useful final check for the npm package because it validates the published package shape from a temporary consumer project.

## Contributor Docs

If you are working on the package itself rather than consuming it, start here:

- `docs/ai/00-context.md`
- `services/code-intel-mcp/README.md`
- `services/indexer/README.md`
- `docker/README.md`
