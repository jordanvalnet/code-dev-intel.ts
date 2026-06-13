# Changelog

All notable changes to this package are documented in this file.

## 0.3.6 - 2026-06-13

### Added

- **Explicit workspace-root allowlist for sibling worktrees.** A request `workspaceRoot` outside the configured default `--workspaceRoot` is still rejected by default, but operators can now authorize specific paths via repeatable `--allowed-workspace-root=<glob>` CLI args or the `CODE_INTEL_ALLOWED_WORKSPACE_ROOTS` env var (comma/semicolon-separated globs). Patterns are matched against the canonical (realpath-resolved) path, so `..`/symlink traversal stays blocked, and the strict default-boundary behavior is unchanged when no patterns are configured. This lets the MCP run against a git worktree that is a sibling of the main checkout (instead of falling back to grep).

## 0.3.5 - 2026-06-08

### Docs

- Clarified the benchmark wording so the gains read unambiguously: token results are now "X% fewer tokens" / "~parity" (no more "+X%" that read like an *increase*), and adoption is stated as "11 of 11 fresh-context agents chose it on their own, on real production-codebase tasks".
- README now links to the benchmark write-up via a full GitHub URL — relative repo paths don't resolve on the npm page (npm renders only the README).

## 0.3.4 - 2026-06-08

### Docs

- README benchmark section now also shows the compact-output result (`findReferences` ~72% smaller than the old format, ~60% smaller than `grep -n`), so every measured gain — adoption, token savings, type-checked precision, and compact output — is visible on the npm page.

## 0.3.3 - 2026-06-08

### Changed

- **Compact output for `findReferences` / `findDefinitions` / `findImplementations`** (breaking shape change). These three tools now return matches grouped by file instead of a flat `locations` array:
  `{ symbol, sourceFilePath, count, byFile: { "<path>": ["line:col", ...] } }`.
  The path is written once per file (not once per occurrence) and each position is the universal 1-based `"line:col"` string. On a 43-reference symbol the payload dropped **~72%** (5,793 → 1,634 chars) and is now **~60% smaller than the equivalent `grep -n`** — flipping find-references from a token loss to a clear win. The column is always present, so single-line / minified files stay unambiguous. Only consumers that read the old `.locations` array are affected; `findSymbol` / `findCallers` / `findCallees` are unchanged.

## 0.3.2 - 2026-06-08

### Docs

- Added an agent adoption / token-economy benchmark (`docs/benchmarks/2026-06-07-agent-token-economy.md`): **100% spontaneous adoption** (11/11 fresh-context agents chose code-intel unprompted), token savings that scale with task difficulty (**+13% to +34%** on debugging traces, large-file comprehension, and ambiguous-name searches; near-parity on simple grep-friendly lookups), and type-checked precision (no grep false positives).
- Refreshed the README: full 13-tool list, benchmark highlights, a self-describing-server note (the MCP `initialize.instructions` mean no consumer-side prompt forcing is needed), and configuration notes (`workspaceRoot`, deferred tools, cold-start, reconnect).

## 0.3.1 - 2026-06-07

### Fixed

- `findSymbol`: prefer exact-name matches. `getNavigateToItems` is fuzzy (substring/camelCase/prefix), so a query like `findSymbol("AgencyRepository")` previously returned ~100 unrelated same-prefix symbols (`agencyRepository`, `agencySeatRepository`, …). It now returns only exact-name declarations, falling back to fuzzy matches only when there is no exact hit — so "go to symbol by name" is precise by default.

## 0.3.0 - 2026-06-07

### Added

- **Adoption redesign**: tool descriptions rewritten to state, for each tool, *when* to use it, *instead of which* built-in (Grep/Read), and the token/precision benefit — so an agent has a concrete reason to prefer code-intel over reflexive Grep/Glob/Read. The persuasion now ships *with the server*; consumers need no `AGENTS.md` forcing.
- **MCP `initialize.instructions`**: the server now returns a usage guide routing symbol-level intents to the right tool. Clients that surface it inject it into the model's context automatically.
- `findCallers` / `findCallees`: real incoming/outgoing **call hierarchy** via the TS language service (were mock).
- `findSymbol`: **workspace symbol search by name alone** (no `filePath` needed) via `getNavigateToItems` — removes the "must know the file first" friction (was mock).
- `impactedFiles`: real transitive **blast-radius** analysis wired to the indexer engine (was mock).

### Fixed

- `searchStruct`: resolves the bundled `ast-grep` binary directly from `optionalDependencies` (or `CODE_INTEL_ASTGREP_PATH`), and degrades to an empty result with `engineFallbackReason` instead of throwing when the binary is unavailable. Previously it required `pnpm`/network at runtime and hard-failed in many consumer installs.
- The server now advertises **only tools that work** — the four formerly-mock endpoints are real, so an agent no longer loses trust in the whole server after one mock response.

## 0.2.0 - 2026-05-09

### Fixed

- `findReferences`, `findDefinitions`, `findImplementations`, `getSymbolContent`: the resolver no longer anchors on the first textual occurrence of the symbol (`indexOf`). It now walks the AST to find the actual *declaration* node, then falls back to identifier-only matches before the legacy text fallback. This fixes false positives where the symbol first appeared in a comment or in a module-specifier string (e.g. `import styles from './UserMenuCard.module.css'` was resolving to the Next.js `*.module.css` ambient declaration, returning a single result inside `node_modules/next/types/global.d.ts`).
- `findReferences` / `findDefinitions` / `findImplementations` now exclude `node_modules/**` and `*.d.ts` results by default. Use `includeNodeModules: true` and/or `includeDeclarationFiles: true` to opt back in.
- `searchText` ripgrep parser now handles Windows drive letters (e.g. `E:\path\file.ts:1:17:content`); previously the path was split on the drive-letter colon, returning zero matches.
- `searchText` now resolves the ripgrep binary from the bundled `@vscode/ripgrep` dependency (or `CODE_INTEL_RIPGREP_PATH` env var). Previously the spawn could fail silently on Windows because Node's `spawnSync(..., { shell: false })` does not honor `PATHEXT`, so `rg.cmd` and `rg.ps1` shims were never resolved.

### Added

- `getFileOutline` accepts `summaryOnly: true` to omit the `signature` field. On large schema files this typically cuts the payload by 60–80 % and avoids hitting the 25 000-token tool-result ceiling.
- `getSymbolContent` accepts `maxLines` to truncate the returned content. The result includes `truncated: boolean` and (when truncated) `truncatedAtLine: number`.
- `searchText` result includes `engineFallbackReason: string` when the call falls back to the Node implementation, so clients can debug why ripgrep was not used.
- New runtime dependency: `@vscode/ripgrep` (MIT). The `rg` binary is bundled with the package so `searchText` works out of the box on Windows, macOS, and Linux without requiring `rg` on `PATH`.

## 0.1.9 - 2026-04-30

### Fixed

- Surface the underlying error message when an MCP tool throws (e.g. `file not found: <path>` for `getFileOutline`, `getSymbolContent`, etc.) instead of the opaque `Internal error`.
- Log tool execution failures to stderr with tool name, message and stack trace so MCP clients can debug invalid input or workspace issues.

## 0.1.8 - 2026-04-18

### Fixed

- Fixed `searchStruct` in consumer projects by resolving the `ast-grep` binary from the package root instead of the consuming workspace root.
- Fixed the `pnpm dlx` fallback for `@ast-grep/cli` by selecting the `ast-grep` binary explicitly, avoiding the multiple-binaries failure.
- Added `@ast-grep/cli` as a runtime dependency so structural search works in installed package usage, not only in the package repository.

### Changed

- Extended the release smoke test to execute a real `searchStruct` call against a temporary consumer project before considering a release valid.

## 0.1.7 - 2026-04-18

### Fixed

- Fixed MCP `tools/list` schema generation for `getFileOutline` so `symbolKinds` is emitted as a valid JSON Schema array instead of the invalid `string[]` pseudo-type.
- Restored compatibility with VS Code MCP clients that reject invalid input schemas during tool discovery.

### Changed

- Reworked the main README so it documents the npm package itself rather than internal project delivery notes.
- Added package-oriented guidance for installation, usage, MCP client integration, prompt recommendations, and IDE setup.