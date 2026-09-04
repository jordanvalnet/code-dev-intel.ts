# Changelog

All notable changes to this package are documented in this file.

## 0.5.0 - 2026-09-04

### Added

- **`dependencyGraph` and `impactedFiles` now resolve `tsconfig` / `jsconfig` path aliases.** Until 0.4.0 both engines followed relative specifiers only, so on a codebase that imports through `@/domain/ports/Port` — the norm in a Next.js-shaped app — every alias was reported as an external dependency and the two tools returned an almost empty graph. Both now resolve `compilerOptions.paths` and `baseUrl` from the workspace `tsconfig.json` (falling back to `jsconfig.json`), through a new shared resolver in `services/indexer/src/import-resolver.ts`.
  - **TypeScript’s own precedence, verified against `ts.resolveModuleName`.** An exact (wildcard-free) key wins; otherwise the single-`*` pattern with the longest prefix wins, and its targets are tried in order with the first one that exists on disk taking the edge. A matched pattern is terminal — as in `tsc`, a matched-but-unresolved alias falls through to `node_modules` (external here), never back to `baseUrl`. `baseUrl` is tried only when no pattern matched at all. Keys with two or more wildcards are ignored, and a target keeps its literal `*` when the capture is empty, both exactly as TypeScript does.
  - **The config is parsed with the TypeScript API**, so `extends` chains, comments and trailing commas all work, and alias targets are resolved against `baseUrl` when set, else against the config that actually declared `paths` (TypeScript’s `pathsBasePath`), else the config directory. Config parsing never globs the workspace: the parse host reports no input files, so a large repo costs a single JSON read.
  - **Sandbox consistency:** a specifier that resolves to a file outside `workspaceRoot` is rejected and reported as external, including when an out-of-bounds target is the one that wins the lookup. This tightens 0.4.0, where a relative `../../` escape could put an out-of-root file in the MCP dependency graph and read it.
  - **Caching:** the parsed config is cached per workspace root and invalidated on the mtime of the config file *and* every file in its `extends` chain, so editing a base config is picked up by the long-lived server. Each engine call creates one resolver, which also memoizes non-relative lookups and workspace-boundary verdicts.
  - Relative imports keep their existing probing (exact file, `.js`/`.jsx`/`.mjs`/`.cjs` mapped to `.ts`/`.tsx`/`.d.ts`, source extensions, index files) and gain declaration files (`foo.d.ts`, `index.d.ts`) — which `tsc` resolves and both old resolvers missed. `impactedFiles` also picks up the `.js` → `.ts` specifier mapping that only `dependencyGraph` had; on this repository that is the whole delta (194 specifiers identical, 7 added, 0 lost, 0 changed).
  - Bare packages and `node:` builtins stay external. No public API change: `maxDepth`, `includeExternal` and `options.changedFiles` behave as before, and a workspace with neither `paths` nor `baseUrl` resolves exactly as it did in 0.4.0.

### Fixed

- **`impactedFiles` no longer ignored multi-line, type-only and re-export statements.** The module-graph extractor was a regex whose clause class excluded newlines, so every statement Prettier had wrapped across lines — the normal shape of an `import type { … }` list — produced no edge at all. On a formatted production codebase that is most of the graph: on a ~4,200-file Next.js-shaped codebase it found 13,440 edges where the parse tree has 15,294, and `impactedFiles` for a changed port answered *without* the adapters that implement it — the whole purpose of the tool. Imports and re-exports are now read off TypeScript’s own parse tree (`ts.createSourceFile`), so all of these produce the right edge with the right symbols: multi-line and `import type { … }` lists, inline type modifiers (`{ type A, B }` → `A`, `B`), default-plus-named clauses (`D, { A }` → `default`, `A`), namespace imports and side-effect `import 'x'` (→ `*`), `export { a, b as c } from 'x'` (multi-line included, recorded under the *source* name), and `export * from 'x'` / `export * as ns from 'x'` (→ `*`).
  - **The regex’s false positives are gone too.** `from '…'` inside a comment or a string literal no longer fabricates an edge; the parser cannot see into either. On that same repository three such edges existed — two JSDoc usage examples that made a file import *itself*, and one string fixture inside an architecture test that pointed at the real database module. Old-vs-new on it: **+1,857 real edges gained, 3 phantom edges dropped, 0 real edges lost.**
  - **Cost:** a full parse per file replaces a regex scan. On a synthetic 4,000-file × 5-import workspace `buildWorkspaceGraph` goes from 1,989 ms to 2,508 ms (**1.26×**); on a ~4,200-file / 20 MB private production codebase, from 1,899 ms to 3,852 ms (2.03×). `dependencyGraph` was already correct here — it has used `ts.preProcessFile` since 0.3.0 — so only `impactedFiles` changed.
- **A `tsconfig.json` / `jsconfig.json` with a JSON syntax error no longer fails the tool call on Windows.** Building the config path with `path.join` produced backslashes, which TypeScript’s diagnostic machinery asserts against its own forward-slash normalization — so `dependencyGraph`, `impactedFiles` and `calculateWorkspaceImpactedFiles` threw `Debug Failure` (surfacing as an MCP internal error) for any workspace whose config had an unclosed brace or a missing comma. The path is now normalized the way `ts.findConfigFile` returns it, and the parse is additionally wrapped so an unusable config degrades to "no aliases" while relative imports keep resolving.

### Docs

- README: the `dependencyGraph` and `impactedFiles` entries state that relative imports **and** `paths`/`baseUrl` aliases are resolved; the `dependencyGraph` Tool Guide section gained its options (`maxDepth`, default 5; `includeExternal`, default false) and the alias/precedence note, and `impactedFiles` gained a section of its own. Added the missing Tool Guide sections for `findSymbol` and `findCallers` / `findCallees` (shipped in 0.3.0, never documented there). Noted that `CODE_INTEL_SPAWN_TIMEOUT` (ms, default 15000) bounds the ripgrep run and that a timeout degrades to the node engine with `engineFallbackReason`. Added `pnpm audit --audit-level=high` to Package Validation.
- The `/tools/describe` and MCP `tools/list` descriptions for `dependencyGraph` and `impactedFiles` now say that path aliases are resolved — these are the strings an MCP client puts in front of the model, and the old wording steered agents away from both tools on exactly the codebases this release fixes.

## 0.4.0 - 2026-09-04

### Changed

- **Dependency refresh — every dependency bumped to its latest compatible version.**
  - Runtime: `typescript` 5.9.3 → **6.0.3** (the last JavaScript-based TypeScript; 7.x is the native Go compiler and ships no `createLanguageService` JS API, so it cannot back the symbol tools), `@ast-grep/cli` 0.40.5 → **0.45.3** (all seven platform binaries pinned to match), `zod` 4.3.6 → 4.5.4, `picomatch` 4.0.4 → 4.0.7.
  - Dev/test toolchain: `eslint` 9 → **10.10**, `@eslint/js` 10, `typescript-eslint` 8.69, `globals` 17, `vitest` / `@vitest/coverage-v8` 4 → **5**, `vite` 7 → **8**, `@types/node` 24 → 26, `@types/picomatch` 4.0.3.
  - Tooling: `packageManager` pnpm 10.28.2 → 10.34.5 (also in every workflow); GitHub Actions `actions/checkout`, `actions/setup-node`, `actions/upload-artifact` → v7 and `pnpm/action-setup` → v6 across all four workflows; Docker base images `node:24.20.0-alpine` and `alpine:3.23`.
- Build: `tsconfig.build.json` now sets `rootDir: ./services` explicitly — TypeScript 6 refuses to infer it (TS5011). The published `dist/` layout, `bin` and `exports` paths are unchanged.

### Security

- **Light security review — four pre-existing issues fixed** (found by a 4-lens review with adversarial verification; none were introduced by the dependency bumps):
  - **Arbitrary file read via `filePath` (high).** `findDefinitions` / `findReferences` / `findImplementations` / `findCallers` / `findCallees` / `getFileOutline` / `getSymbolContent` / `dependencyGraph` resolved `filePath` with `path.resolve()` and no boundary check, so an absolute path or `../` escaped the workspace and returned the outline or source of any readable file. `filePath` now goes through the same `assertWithinWorkspace` realpath + prefix check that `searchText` and `findDuplicates` already used, and answers `path outside workspace root`.
  - **ripgrep flag injection via `searchText.query` (high).** The query was appended to the `rg` argv as a bare positional, so a query such as `--pre=./evil.sh` was parsed as an option — and `--pre` executes a program per searched file. The pattern is now passed with `-e` and options are terminated with `--` before the search paths.
  - **git option injection via `findDuplicates.sinceGitRef` (medium).** A ref starting with `-` (e.g. `--output=<path>`) was passed straight to `git diff`, letting a caller write a file anywhere. The request schema now rejects values starting with `-`, and the service re-checks before spawning git.
  - **No `Origin` validation on `POST /tools/*` and `POST /mcp` (medium).** Any web page in the developer's browser could issue a preflight-free JSON POST to the (by default unauthenticated) localhost server. Requests carrying an `Origin` header are now accepted only from the server's own origin or from `CODE_INTEL_ALLOWED_ORIGINS` (new env var, `*` to disable); clients that send no `Origin` (IDEs, agents, curl, Node) are unaffected.
- **`pnpm audit` is fully clean** (was 13 high / 3 moderate, all in the dev toolchain: `brace-expansion`, `js-yaml`, `nanoid`, `postcss`, `@humanfs/node`). Overrides refreshed to the patched floors (`brace-expansion` ≥1.1.18 / ≥2.1.4, `postcss` ≥8.5.23, `js-yaml` ≥4.3.1, `nanoid` ≥3.3.18, `@humanfs/node` ≥0.16.8); the obsolete `picomatch` override was dropped because it broke `fdir`'s peer range now that the direct dependency is 4.0.7.

### Fixed

- **`impactedFiles` and `findDuplicates` no longer freeze the server on real repositories.** Their workspace walkers now skip hidden directories, nested git checkouts (a directory containing `.git`, e.g. worktrees under `.claude/worktrees/` or `.worktrees/`), `coverage/` and `.next/` — the same defaults ripgrep gives `searchText`. On a production Next.js repo the walk covered 66,563 files (a dozen nested worktrees plus ~110 MB of `.next/` bundles) and blocked the single-threaded server for over nine minutes per call; it now sees the ~4,000 real sources. Note: both engines still resolve relative imports only — `@/…` tsconfig path aliases are reported as external, so on alias-heavy codebases `dependencyGraph`/`impactedFiles` stay shallow.
- **`searchText` silently used the Node fallback engine instead of ripgrep under pnpm.** The bundled binary lives in `@vscode/ripgrep-<platform>-<arch>`, an optional dependency of `@vscode/ripgrep` that pnpm's isolated layout only exposes to `@vscode/ripgrep` itself; resolving it from this package failed and the service degraded (correct results, but the slow regex walker). The binary is now resolved from `@vscode/ripgrep`'s own location (the way its `rgPath` does), with the legacy postinstall path as a last resort. A real-binary integration test now guards the engine choice.
- `searchText` answered HTTP 500 `internal error` when ripgrep exceeded the spawn timeout (5 s by default; the first ripgrep launch from a fresh server takes ~5 s on Windows even though later searches take 0.2 s). The ripgrep default is now 15 s (ast-grep already used 30 s) and a timeout degrades to the Node engine with `engineFallbackReason: "ripgrep timed out…"`, the way `searchStruct` already reports an ast-grep timeout, and points at `CODE_INTEL_SPAWN_TIMEOUT`.
- Tests: the ast-grep fallback-chain tests assumed `node_modules/@ast-grep/cli/ast-grep.exe` exists, but that file is only created by `@ast-grep/cli`'s postinstall, which pnpm 10 blocks by default — a fresh Windows install failed them. The local-binary lookup is now injectable in tests (`setLocalAstGrepExecutableForTests`), mirroring the bundled-binary seam, so the chain is asserted deterministically on every platform.
- Lint under ESLint 10 / typescript-eslint 8.69: removed nine unnecessary type assertions, a dead initializer in the self-test, and two unused type imports. No behavior change.

## 0.3.7 - 2026-06-14

### Security

- **Dependency security update — `pnpm audit` is clean again (was 1 critical, 9 high, 6 moderate, 1 low).** The CI `pnpm audit --audit-level=high` gate is green. Changes, all in the dev/test toolchain except `picomatch`:
  - `vitest` / `@vitest/coverage-v8` upgraded 3.x → 4.x — clears the **critical** Vitest UI arbitrary-file-read advisory (GHSA-5xrq-8626-4rwp) and brings a patched Vite 7.3.x toolchain. Full test suite (153 tests) and v8 coverage verified green under Vitest 4.
  - `picomatch` (the only shipped runtime dependency touched) bumped 4.0.3 → 4.0.4 for the extglob ReDoS fix — a patch, no API change.
  - `vite` pinned to `^7.3.5` as an explicit devDependency. The vulnerable Vite (>=7.0.0 <=7.3.1) was an auto-installed peer of Vitest, which `pnpm.overrides` cannot reach; declaring it directly forces the patched version (GHSA-p9ff-h696-f583 and the dev-server file-read advisories).
  - Added scoped `pnpm.overrides` for the remaining transitive advisories: `esbuild` ≥0.28.1, `minimatch` ≥3.1.5 / ≥9.0.9, `flatted` ≥3.4.2, `brace-expansion` ≥1.1.15, `picomatch` ≥4.0.4, `postcss` ≥8.5.10.

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

- `findSymbol`: prefer exact-name matches. `getNavigateToItems` is fuzzy (substring/camelCase/prefix), so a query like `findSymbol("UserRepository")` previously returned ~100 unrelated same-prefix symbols (`userRepository`, `userSessionRepository`, …). It now returns only exact-name declarations, falling back to fuzzy matches only when there is no exact hit — so "go to symbol by name" is precise by default.

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

- `findReferences`, `findDefinitions`, `findImplementations`, `getSymbolContent`: the resolver no longer anchors on the first textual occurrence of the symbol (`indexOf`). It now walks the AST to find the actual *declaration* node, then falls back to identifier-only matches before the legacy text fallback. This fixes false positives where the symbol first appeared in a comment or in a module-specifier string (e.g. `import styles from './Widget.module.css'` was resolving to the Next.js `*.module.css` ambient declaration, returning a single result inside `node_modules/next/types/global.d.ts`).
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