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
- `dependencyGraph` — a file's import graph (every static import form, imported assets included, resolved the way `tsc` resolves it, and it reports what it could not follow)
- `impactedFiles` — blast radius of a set of changed files, code or asset (same resolution, same completeness report, cached between calls)

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
- `includeAssets: boolean` (default `true`) — follow imports of non-code files. See [Assets as leaves](#assets-as-leaves).

**Every static form is followed:**

- `import` / `import type` clauses, `export … from`, `export * from`, `export * as ns from`
- `import x = require('…')`
- `import()` / `require()` calls with a string literal anywhere in the file — a nested closure, a class method, a `declare module` body
- `import()` in a **type** position: `type X = import('./m').Y`, `typeof import('./m')`, a generic argument, a mapped type, a `declare global` member. A dependency named only in a type position still moves when its target moves.
- JSDoc `@type {import('./m').T}` **in JavaScript files**, where JSDoc is the type system. In a `.ts` file the checker ignores JSDoc types, so neither does this.

**Resolution is TypeScript's own** (`ts.resolveModuleName`), using the options of the **nearest** `tsconfig.json` / `jsconfig.json` walking up from the importing file — not just the workspace root's. That covers relative specifiers, `compilerOptions.paths` and `baseUrl` aliases with TypeScript's precedence, `extends` chains, package `main` / `exports` and directory imports, declaration-only modules, the `.mts` / `.cts` / `.mjs` / `.cjs` family, and workspace packages symlinked into `node_modules` (reported as the real file inside the workspace, not as a package). If a nested project redefines `paths` without re-declaring an alias the root config maps, the root config is tried as a fallback so the edge is not lost. Targets that resolve outside `workspaceRoot` are never followed. On a case-insensitive filesystem a mis-cased import (`./notifications/sender` for `Sender.ts`) resolves to the file's real on-disk name, so its importer joins the graph instead of pointing at a node nothing walked.

**Completeness is reported, not assumed.** Whatever the graph could not follow comes back in `unresolved` (up to 20 entries of `{ from, specifier, reason }`) with the full tally in `unresolvedCount`:

- `not-found` — a specifier that names a file and finds none: relative, absolute, alias-shaped, or `baseUrl`-shaped (`billing/invoice` when a `billing/` directory sits under `baseUrl`). A deleted module or a broken alias.
- `unsupported-file-type` — the file is **there**, and this graph does not read that kind: `./Widget.vue`, `./engine.wasm`, `./Page.mdx`. A real dependency, reported as one, instead of being called missing.
- `outside-workspace` — the target exists but lies outside `workspaceRoot`.
- `dynamic-specifier` — a non-literal `import()` / `require()` argument, e.g. ``import(`./locales/${lang}`)``; the source text is quoted back.

Packages and `node:` builtins are external dependencies, never "unresolved", so `unresolvedCount: 0` means the graph is complete.

### `impactedFiles`

Use to scope a refactor, a review, or a test run: given the files you changed, it returns every file transitively impacted (direct and indirect importers), including the changed files themselves.

Options:

- `changedFiles: string[]` (required) — repo-relative paths of the changed files. A changed file may be an asset: pass a stylesheet, a JSON fixture or an icon and you get the code that imports it.
- `changedSymbolsByFile: Record<string, string[]>` (optional) — e.g. `{ "src/a.ts": ["ChangedExport"] }`, to keep only the importers that use one of those exports.
- `includeAssets: boolean` (default `true`) — see [Assets as leaves](#assets-as-leaves).

`changedSymbolsByFile` narrows the answer without truncating it:

- **A re-export carries the change on.** `export * from './impl'` passes `foo` through as `foo`; `export { foo as publicFoo } from './impl'` passes it on as `publicFoo`. So a barrel is transparent, and the consumers behind it stay in the answer.
- **Anything else is opaque.** A file that *uses* a changed symbol in its own code may have changed in any way, so all of its exports count as changed from there on.
- **A file listed in `changedFiles` with no entry counts as changed in full** — no list means you did not narrow it down, not that nothing in it changed.
- **Assets and modules with no readable exports are never filtered out.** An asset has no exports; a CommonJS module's `module.exports` is not on the parse tree. Missing knowledge is not evidence that nothing matches.

The import graph behind it is built by the same extractor and resolver as `dependencyGraph`, so the two tools cannot disagree about the same repository. The result carries the same completeness signal: `unresolvedCount` plus an `unresolvedSample` of up to 10 entries, counted across the whole workspace rather than only inside the impact set — every one is a specifier that could have been a missing importer.

### Assets as leaves

Both module-graph tools follow imports of non-code files, under the same option name and the same rules. The extensions that count:

```
.css .scss .sass .less .json .svg .png .jpg .jpeg .gif .webp .avif .woff .woff2 .graphql .gql .md .txt .yaml .yml
```

Only the last extension matters, so `Button.module.css` is a `.css` asset.

- **Resolved by exact filename, and nothing else.** No extension guessing, no directory index, no `node_modules` walk — `./button.css` resolves if and only if `button.css` sits next to the importer. Path aliases and `baseUrl` are substituted (so `@shared/icons/logo.svg` works), and a bundler query suffix is ignored (`./logo.svg?react` resolves `logo.svg`), but every candidate still has to be a file that exists. The graph never invents an asset edge. The single exception is `.json`, the one extension Node and every bundler append by themselves: `./data/fixture` resolves `fixture.json` if that file is there. `./button` never resolves `button.css`.
- **Always a leaf.** Assets are never read, never parsed and never a source of edges, so a `.md` file whose fenced examples contain `import` statements contributes nothing. They do not appear in the workspace graph's `files` list either — only as the target of an edge.
- **A changed asset lists its importers.** That is the point of the default: with `includeAssets: false`, `impactedFiles` for a changed stylesheet answers with the stylesheet alone, which is a confidently wrong answer rather than an incomplete one.
- **Excluding them excludes them from the unresolved report too.** With `includeAssets: false` you asked for a code graph, so an asset import the graph did not follow is not a gap in what you asked for. With assets on, an asset import that names no file *is* reported as `not-found`, because it is genuinely broken.

Cost, measured on a 4,000-file synthetic workspace with ~3,600 asset imports: turning assets on adds nothing to the build (they are resolved either way; the option filters the answer), adds ~0.6% to an `impactedFiles` response for a code change, and ~21% to a `dependencyGraph` response for a file that actually imports assets. Resolving them by exact filename is *cheaper* than leaving them to TypeScript's module resolution, which probes a dozen candidate paths per asset specifier and fails.

### Workspace graph cache

`impactedFiles` builds a graph of the whole workspace, which on a few thousand files takes seconds. That graph is cached per workspace root — in memory for the life of the process, and on disk between processes — and every call re-walks the directory tree to decide what to reuse:

- **Files** are stamped with `(mtime, size)` at parse time; only files whose stamp moved are re-read. A rename is detected as a removal plus an addition with the same stamp, and the parse moves across once the content confirms it — a stamp is a hint (an archive restored with its timestamps produces the same one), so the bytes decide.
- **Resolutions carry their evidence.** Every specifier records what its answer actually depended on: the file it landed on, every path TypeScript probed and did not find, the manifests TypeScript read, and any directory whose existence decided the verdict. When the walk reports files appearing or vanishing, a file is resolved again if and only if the change intersects that record — the rule a language server uses to decide which resolutions a file event invalidates. Adding a file to a 4,000-file workspace re-resolves one file instead of four thousand.
  - The walk tracks directories as well as files, because `billing/gone` is an uninstalled package when nothing called `billing` exists under `baseUrl` and a lost workspace edge when something does — and an empty directory appearing or being removed is a change no file event reports.
  - **What the walk cannot watch is never reused.** The walk does not enter `node_modules`, `dist`, `coverage`, `.next`, dot-directories or nested checkouts, and does not follow symlinks; the resolver reads all of them. A resolution that landed in, or probed inside, one of those places — a workspace package built into its own `dist/` after the first index — is therefore taken again on every call, as is any edge naming a file the walk does not report. `unwatchableFiles` in the cache stats is how many such files a workspace has (zero here).
- **A config edit still redoes every resolution.** `compilerOptions.paths` moves every aliased edge at once, so a content change to any `tsconfig.json` / `jsconfig.json` / `package.json` re-resolves the workspace. Package manifests carry their own provenance and could in principle be narrowed the same way; they are not, because TypeScript records only the manifests a lookup actually read, and being wrong there would move edges in silence.
- **Recently written files are always re-read.** Filesystem timestamps are quantized — measured here at 0.5–18.7 ms, with 358 of 500 same-length rewrites indistinguishable by `(mtime, size)` — so any file whose recorded mtime is within 2 s of when it was cached is read again rather than trusted. Edit a file and ask immediately, and you get the file you just saved.
- **The graph survives the process.** Every editor or agent session spawns a fresh stdio server, so the cold build used to be paid once per session. After a call that changed anything, the workspace's graph — stamps, module facts, resolutions and their provenance — is written to the OS user cache directory (`%LOCALAPPDATA%\code-dev-intel\graph-cache\` on Windows, `$XDG_CACHE_HOME` or `~/.cache/code-dev-intel/graph-cache/` elsewhere), one file per workspace named by a digest of its root path. The next process loads it, then runs the same walk diff: stamps that still match are reused, everything else follows the rules above.
  - **Never inside the workspace.** A cache file decides which files import which, so a repository that could ship one could plant edges an agent then acts on. It lives in the user's own cache directory, and it is read as untrusted input anyway — versions, root, and every field validated, every path required to be workspace-relative. Anything unexpected is a cold build, never a wrong graph.
  - **Never a failure.** A read-only home directory or a full disk logs nothing into the tool call; the write is skipped and the process carries on. Writes are atomic (temp file plus rename), so a process killed mid-write leaves either the old file or the new one.
  - **It stores no source.** Workspace-relative paths, `(mtime, size)` and a content digest per file, the specifiers each file imports and the names it exports, where each specifier resolved and the evidence behind it. Nothing in it can reconstruct a line of code.
  - `CODE_INTEL_CACHE_DIR` moves the directory; `CODE_INTEL_GRAPH_CACHE=off` (or `false`, `0`, `no`) switches persistence off entirely. Cache files are invalidated by the package version, the TypeScript version and a schema version, so an upgrade never reuses answers the new resolver would not give — and the directory is swept on write (nothing older than 30 days, at most the 32 most recent workspaces), so it cannot grow one file per abandoned worktree forever.
- **Bounded:** at most 50,000 tracked files across at most 16 workspace roots, least-recently-used roots evicted first.

`dependencyGraph` shares the same per-file parse cache, so the two tools never parse the same file twice and still cannot disagree.

Measured on a large private consumer codebase (~4,200 files) and on a 4,000-file synthetic workspace. The real repository is the one that matters: a cold build there costs about 11 s, of which ~9 s is TypeScript's own module resolution, and **the first call of a new process now reads that graph back in ~1.1 s instead of building it**. Every editor or agent session spawns a fresh server, so that was the larger of the two costs.

The synthetic workspace is where the per-event gains are visible, medians of 5 fresh processes each, both columns measured in one session on one (busy) machine — pre-T-020 build → this one:

| | before | after |
| --- | --- | --- |
| cold build | 8,069 ms | 8,342 ms |
| unchanged workspace | 399 ms | 380 ms |
| one file edited | 417 ms | 454 ms |
| **one file added** | 5,035 ms | **462 ms** |
| **one file deleted** | 4,449 ms | **502 ms** |
| **one file renamed** | 6,244 ms | **384 ms** |
| **one asset added** | 5,535 ms | **415 ms** |
| `tsconfig` alias edited | 5,055 ms | 5,843 ms |
| **first call of a new process** | 8,342 ms (no such thing existed) | **1,113 ms** |

The four bold rows in the middle are the common events of an agent's editing loop, and they were the most expensive ones — a file appearing or vanishing cost as much as a cold build. The `tsconfig` row stays a full re-resolution on purpose: an alias edit really does move every edge. The cold row is unchanged, so recording the evidence is free. The graph is identical in every row (3,986 files, 17,954 edges, 327 unresolved — the numbers the previous engine produced).

Absolute timings depend heavily on what else the machine is doing: the same code measured 3.5 s for that cold build on an idle machine and 8.3 s here, so read the ratios rather than the milliseconds. The persisted file is 6.9 MB for the synthetic workspace (7.7 MB for the ~4,200-file repository, 89 KB for this one), read and validated field by field in 163–281 ms, and written in 94–411 ms on the calls that changed something — never on the calls that did not. Resident memory for the 4,000-file workspace is 213 MB, or 205 MB for a process that loads the graph instead of building it. On this repository (76 files): ~800 ms cold, 12–55 ms warm, 20–44 ms for the first call of a new process, and `dependencyGraph` at 18–24 ms per call. The directory walk is most of every warm call.

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
- **First call is slow, the rest are fast:** the first semantic call builds the TypeScript program (a few seconds on a large repo), then it's cached for the session. The *module graph* behind `impactedFiles` and `dependencyGraph` outlives the session: the first call of a new server reads the graph the last one left in your user cache directory, which on a 4,200-file repository is ~1 s instead of ~11 s.
- **The module-graph cache lives outside the repository**, one file per workspace root, named by a digest of that path: `%LOCALAPPDATA%\code-dev-intel\graph-cache\` on Windows, `$XDG_CACHE_HOME/code-dev-intel/graph-cache/` (or `~/.cache/…`) elsewhere.
  - `CODE_INTEL_CACHE_DIR=<dir>` puts it somewhere else — a scratch directory in CI, for instance.
  - `CODE_INTEL_GRAPH_CACHE=off` (also `false`, `0`, `no`) turns it off: nothing is read, nothing is written, no directory is created. Every call then rebuilds from the process's own memory as before.
  - **To clear it**, delete the directory (or the one `.json` file for your workspace); the next call rebuilds it. Nothing has to be told about it. Files older than 30 days, and everything past the 32 most recent workspaces, are swept on the next write.
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
