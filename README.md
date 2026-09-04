# code-dev-intel

`code-dev-intel` is an npm package that exposes a self-hosted MCP and HTTP server for TypeScript code intelligence.

It gives AI agents and IDE assistants fast access to symbol definitions, references, implementations, file outlines, dependency graphs, structural search, text search, and duplicate detection without forcing the model to scan your whole repository every time.

## What The Package Brings To A Project

- Faster code navigation for AI agents in medium and large TypeScript repositories.
- A local-first MCP server you can plug into IDEs, coding agents, and CLI assistants.
- A stable automation entrypoint with `ensure`, so scripts and agents can start the server only when needed.
- An HTTP API for tools and health checks, plus MCP JSON-RPC for clients that speak MCP directly.
- A self-hosted alternative to remote code indexing for teams that want data to stay local.

## Benchmark: does it actually change agent behavior?

On a large production TypeScript repository, with fresh-context agents free to choose any tool:

- **11 of 11 agents adopted it on their own.** On real tasks against a production codebase, every one of the 11 fresh-context agents chose `code-intel` over Grep/Read — with no instruction to do so.
- **Fewer tokens, scaling with task difficulty:** roughly parity on simple grep-friendly lookups, but **13–34% fewer tokens (≈27% fewer on average) on debugging traces, large-file comprehension, and ambiguous-name searches** — the tasks that dominate real work.
- **Type-checked precision:** semantic results carry no grep false positives (the grep-only baseline had to manually enumerate and exclude ambiguous-name matches).
- **Compact, grep-beating output:** `findReferences`/`findDefinitions`/`findImplementations` group matches by file as `"line:col"` positions. On a 43-reference symbol that's **~72% smaller than the old format and ~60% smaller than `grep -n`** — so even raw text search no longer wins on tokens.

Full methodology and per-task numbers: [the benchmark write-up on GitHub](https://github.com/jordanvalnet/code-dev-intel.ts/blob/main/docs/benchmarks/2026-06-07-agent-token-economy.md).

## Good Use Cases

- Refactoring a symbol safely across many files.
- Reviewing a PR and tracing impact before commenting.
- Understanding a codebase entrypoint without opening dozens of files.
- Replacing repeated grep chains with semantic navigation.
- Running local automation in CI, hooks, or agent workflows.

## What The Package Exposes

### Tools

Semantic (type-aware — no native grep/read equivalent):

- `findDefinitions` — go-to-definition for a symbol
- `findReferences` — every real usage, resolved by the type-checker (no comment/string/same-name false positives)
- `findImplementations` — implementations of an interface, abstract class, or port
- `findSymbol` — find a symbol by name alone (no file path needed)
- `findCallers` / `findCallees` — incoming / outgoing call hierarchy
- `getSymbolContent` — the source of one symbol, not the whole file
- `getFileOutline` — a file's structure without reading it
- `dependencyGraph` — a file's import graph (relative imports **and** `tsconfig`/`jsconfig` `paths`/`baseUrl` aliases)
- `impactedFiles` — blast radius of a set of changed files (same alias-aware resolution)

Search & analysis:

- `searchStruct` — AST-shaped structural search (`ast-grep`)
- `searchText` — plain text / regex search (`ripgrep`)
- `findDuplicates` — copy-paste / clone detection

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

### `findSymbol`

Use when you know the symbol name but not the file it lives in — this removes the "grep for the name, then read the file" round trip. Takes `workspaceRoot` and `symbol`; no `filePath`.

The query is matched exactly first; if nothing matches exactly the fuzzy (substring / camelCase) hits are returned instead, so a partial name still finds something. Matches inside `node_modules` and ambient `*.d.ts` files are excluded. Each match carries `name`, `kind`, `filePath`, the line/column range, and `containerName` when the symbol is nested.

### `findCallers` / `findCallees`

Call-hierarchy questions: `findCallers` answers "who calls this", `findCallees` answers "what does this call". Both take `workspaceRoot`, `filePath`, and `symbol`, and resolve through the type-checker rather than by name matching.

Prefer these over `findReferences` when the call graph is what you actually want: references also include imports, type positions, and re-exports, while the call hierarchy returns real call sites with the caller/callee symbol next to each one.

### `getFileOutline`

Use before reading a large file. This is the fastest way to understand the file structure.

Options:

- `symbolKinds: string[]` — keep only the listed kinds (e.g. `["function", "class"]`).
- `summaryOnly: boolean` (default `false`) — omit the `signature` field for each symbol. Use this on large schema files to keep the response under MCP token limits.

### `getSymbolContent`

Use when you want the full declaration body of one symbol instead of the entire file.

Options:

- `maxLines: number` (default unlimited) — truncate the returned `content` after N lines. The result includes `truncated: boolean` and (when truncated) `truncatedAtLine: number`.

### `dependencyGraph`

Use when you need import relationships and transitive module dependencies.

Options:

- `maxDepth: number` (default `5`) — how many import hops to expand from the root file.
- `includeExternal: boolean` (default `false`) — also report package and node-builtin imports. Internal dependencies come back as repo-relative paths; external ones as the raw specifier.

Imports are resolved both ways: relative specifiers, **and** the workspace `tsconfig.json` (or `jsconfig.json`) `compilerOptions.paths` / `baseUrl` aliases. Precedence follows TypeScript — an exact key wins, otherwise the wildcard pattern with the longest prefix, and its targets are tried in order. So `@/domain/ports/Port` is an internal dependency, not an external one. Anything that still does not resolve (bare packages, `node:` builtins) stays external, and a target that resolves outside the workspace root is rejected and reported as external too.

### `impactedFiles`

Use to scope a refactor, a review, or a test run: given the files you changed, it returns every file transitively impacted (direct and indirect importers), including the changed files themselves.

Options:

- `changedFiles: string[]` (required) — repo-relative paths of the changed files.

The import graph behind it resolves the same alias forms as `dependencyGraph`, so an alias-only codebase reports a real blast radius instead of an empty one.

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

The ripgrep binary is bundled via `@vscode/ripgrep`, so the tool works out of the box on Windows, macOS, and Linux without `rg` on the PATH. Override with `CODE_INTEL_RIPGREP_PATH` if needed.

The result includes `engine: 'ripgrep' | 'node-fallback'` and (when falling back) `engineFallbackReason: string` so clients can debug why ripgrep was not used.

`CODE_INTEL_SPAWN_TIMEOUT` (milliseconds, default `15000`) bounds the ripgrep run; a search that exceeds it is killed and degrades to the node engine with `engineFallbackReason` set, so a pathological pattern costs a slower response rather than a hung tool call.

### `findDefinitions` / `findReferences` / `findImplementations` filtering

By default the resolver hides matches inside `node_modules/**` and `*.d.ts` ambient files. Opt back in with options:

- `includeNodeModules: boolean` (default `false`)
- `includeDeclarationFiles: boolean` (default `false`)

### `findDuplicates`

Use when you want code duplication clusters and optional markdown reporting.

## Prompting Recommendations For AI Agents

As of v0.3.0 the server **describes itself**: every tool ships a "use this instead of grep/read, and why" description, and the MCP `initialize` response returns an `instructions` block that routes symbol-level intents to the right tool. Clients that surface `instructions` (e.g. recent Claude Code) inject it into the model's context automatically — so **you usually need no prompt forcing at all**. The benchmark above measured 100% spontaneous adoption with zero consumer-side instructions.

For clients that do **not** surface server `instructions`, a short system-prompt snippet still helps. Keep it minimal — long MCP instructions are easy for clients to truncate, and the per-tool descriptions already carry the detail.

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

### Configuration notes (all clients)

- **`--workspaceRoot=.` is passed once at startup.** Do **not** pass `workspaceRoot` in individual tool calls — the startup value is applied automatically. (For VS Code, use `${workspaceFolder}`.)
- **Deferred tools:** some clients load MCP tool schemas on demand. If the `mcp__code-intel__*` tools aren't visible yet, have the agent load them first (in Claude Code, via `ToolSearch`); the server's `initialize.instructions` also prompt their use.
- **First call is slow, the rest are fast:** the first semantic call builds the TypeScript program (a few seconds on a large repo), then it's cached for the session.
- **Reconnect after upgrading:** when you change the version or config, reconnect/restart the MCP server so the client reloads the tools and instructions.
- **Working in a git worktree?** By default a request `workspaceRoot` must stay within the startup `--workspaceRoot`. To authorize a path outside it (e.g. a sibling git worktree), pass `--allowed-workspace-root=<glob>` (repeatable) or set `CODE_INTEL_ALLOWED_WORKSPACE_ROOTS` (comma/semicolon-separated globs) — e.g. `--workspaceRoot=. --allowed-workspace-root="/repos/myapp*"`. Patterns are matched against the canonical (realpath-resolved) path, so `..`/symlink escapes stay blocked; with no patterns configured, the strict default-boundary behavior is unchanged.

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
- Browser requests: a `POST` that carries an `Origin` header is only accepted when the origin is the server itself (`http://127.0.0.1:<port>`, `http://localhost:<port>`) or listed in `CODE_INTEL_ALLOWED_ORIGINS` (comma/semicolon-separated origins, or `*`). This blocks CSRF / DNS-rebinding pages from driving the local server; IDEs, agents, curl and Node clients send no `Origin` and are unaffected.
- All user-supplied paths are normalized and validated against workspace boundaries.
- The server is designed for local-first use. If you expose it remotely, put it behind your normal network controls.

## Package Validation

Before publishing a new version, these commands are the main confidence checks:

```bash
pnpm build
pnpm test:all
pnpm mcp:self-test
pnpm release:smoke
pnpm audit --audit-level=high
```

`release:smoke` is the most useful final check for the npm package because it validates the published package shape from a temporary consumer project.

## Contributor Docs

If you are working on the package itself rather than consuming it, start here:

- `docs/ai/00-context.md`
- `services/code-intel-mcp/README.md`
- `services/indexer/README.md`
- `docker/README.md`
