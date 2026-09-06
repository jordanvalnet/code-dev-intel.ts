# 04 - Executable Task Backlog (Agent-ready)

## Execution policy

- Execute tasks in order unless explicitly parallelizable.
- Update memory file after each task.
- Keep PRs small and testable.
- Use `pnpm` only (no `npm`, no `yarn`).
- For every task, quality gates must pass before handoff:
	- `pnpm lint`
	- `pnpm type-check`
	- `pnpm test`

## Phase A - Foundation (MVP week 1)

### T-001 Bootstrap repo conventions
Owner: orchestrator-agent
- Create base folder structure (`services/`, `docker/`, `scripts/`, `docs/`).
- Add `CONTRIBUTING.md` with multi-agent protocol references.
Acceptance:
- Project structure committed.
- Contribution rules documented.

### T-002 Implement SQLite schema for code intelligence
Owner: indexing-agent
- Create schema for `files`, `symbols`, `references`, `imports`, `index_runs`.
- Include migration strategy.
Acceptance:
- Schema created.
- Sample insert/query script works.

### T-003 Implement incremental file change detector
Owner: indexing-agent
- Build watcher and git-diff mode.
- Only changed files are re-indexed.
Acceptance:
- Modified file triggers targeted update.

### T-004 Implement MCP server skeleton
Owner: mcp-agent
- Expose tool endpoints with JSON contracts.
- Add health endpoint.
Acceptance:
- Local MCP server starts and returns mock responses.

### T-005 Wire LSP-based symbol resolution
Owner: mcp-agent
- Implement `findDefinitions`, `findReferences` via TS language services.
Acceptance:
- Queries resolve symbols across files.

### T-006 Add ast-grep integration
Owner: mcp-agent
- Implement `searchStruct` tool.
Acceptance:
- Pattern query returns file + range + snippet.

### T-007 Add text search integration
Owner: mcp-agent
- Implement `searchText` via ripgrep fallback.
Acceptance:
- Fast text search available when symbolic search misses.

### T-008 Docker local profiles
Owner: devops-agent
- Add compose profiles: `core`, `search-optional`.
- Keep default footprint low.
Acceptance:
- `core` boots with minimal resources.

### T-009 Local security checks
Owner: security-agent
- Add OpenGrep baseline rules and script wrapper.
Acceptance:
- Security scan runs locally and in CI.

### T-010 Shared memory enforcement
Owner: docs-agent
- Add task template and memory update checklist.
Acceptance:
- Every task PR references memory entry.

## Phase B - Reliability (weeks 2-4)

### T-011 impacted-files engine
Owner: indexing-agent
- Graph traversal from changed symbols/imports to impacted files.
Status: done (2026-02-22)

### T-012 Zoekt optional integration
Owner: devops-agent
- Dockerized on-demand full-text index for large-scale queries.
Status: done (2026-02-23)

### T-013 CI pipelines
Owner: devops-agent
- Validate lint/test/security/index smoke checks.
Status: done (2026-02-23)

### T-014 Performance budget
Owner: indexing-agent
- Set budget targets for RAM/CPU and query latency.
Status: done (2026-02-23)

### T-015 Hardening
Owner: security-agent
- Secret exclusion filters and trust boundaries for tools.

### T-016 Workspace-root allowlist for worktrees
Owner: tooling-agent
- Allow an explicit operator allowlist (`--allowed-workspace-root` / `CODE_INTEL_ALLOWED_WORKSPACE_ROOTS`) so a request workspaceRoot outside the default (e.g. a sibling git worktree) is authorized without weakening the default sandbox. Match canonical realpath; keep `..`/symlink escapes blocked.
Status: done (2026-06-13)

### T-017 Dependency refresh + light security review (2026-09)
Owner: tooling-agent
- Bump every dependency to its latest compatible version (runtime: typescript 6.0.3, @ast-grep/cli 0.45.3, zod, picomatch; dev: eslint 10, vitest 5, vite 8, typescript-eslint, @types/node 26; pnpm 10.34.5; GitHub Actions v7/v6; Docker base images), clear `pnpm audit`, fix the TS 6 `rootDir` build requirement, and de-flake the ast-grep fallback tests.
- Light security review (path sandbox, subprocess execution, network/auth exposure, supply chain) with adversarial verification.
- Verify end-to-end against a large private consumer repository (HTTP tools, MCP over HTTP, MCP over stdio, packed-tarball consumer install) before publishing.
Status: done (2026-09-04)

### T-018 tsconfig paths alias resolution
Owner: tooling-agent
- Resolve `compilerOptions.paths` / `baseUrl` aliases (e.g. `@/domain/ports/Port`) in both module-graph engines (`dependencyGraph` in services/code-intel-mcp, `impactedFiles`/`buildWorkspaceGraph` in services/indexer), which until 0.4.0 followed relative specifiers only and reported every alias as external.
- Share one resolver (`services/indexer/src/import-resolver.ts`): load `tsconfig.json` (else `jsconfig.json`) with the TypeScript API (handles `extends`, comments, trailing commas, `pathsBasePath`), apply TypeScript precedence (exact key wins, else longest-prefix wildcard; matched pattern is terminal; `baseUrl` only when nothing matched), cache per workspace root on the mtimes of the whole `extends` chain, and reject any target outside `workspaceRoot`.
- Keep the public API unchanged (`maxDepth`, `includeExternal`, `options.changedFiles`); bare packages and `node:` builtins stay external.
Status: done (2026-09-04)

### T-019 Exhaustive module graph
Owner: tooling-agent
- Cover every statically resolvable dependency form in one shared extractor (`services/indexer/src/module-graph-extractor.ts`), read from a single parse per file: import/export clauses in all shapes, `export * as ns from`, `import x = require()`, `import()`/`require()` string literals anywhere in the file, `import()` in a type position, and JSDoc `import()` types in JavaScript. `dependencyGraph` and `impactedFiles` must not be able to disagree about the same repository.
- Resolve with TypeScript's own `ts.resolveModuleName` from the **nearest** `tsconfig`/`jsconfig`, and never drop what cannot be resolved: results carry `unresolved`/`unresolvedCount` (`dependencyGraph`) and `unresolvedCount`/`unresolvedSample` (`impactedFiles`) with reasons `not-found`, `unsupported-file-type`, `outside-workspace`, `dynamic-specifier`. Packages and `node:` builtins stay external.
- Treat imported non-code files as graph leaves behind `options.includeAssets` (default true), resolved by exact filename only.
- Cache the workspace graph per root for the life of the process, with parses and resolutions invalidated by different signals, and share the per-file parse cache with `dependencyGraph`.
- Keep additions to the public API additive and documented (`services/code-intel-mcp/src/contracts.ts`, `/tools/describe`, MCP `tools/list`, README).
Status: done (2026-09-04)

### T-020 Incremental resolution invalidation + persisted graph cache
Owner: tooling-agent
- Replace "any change to the file set re-resolves everything" with the rule a language server uses: capture each resolution's provenance (resolved target, TypeScript's failed lookup locations and affecting locations, the exact candidates asset resolution probed, and any directory whose existence decided a `baseUrl`-shaped verdict), normalised to the walk's spelling, and re-resolve only the files whose provenance the walk diff intersects. Keep full re-resolution for a `tsconfig`/`jsconfig`/`package.json` content change.
- Read TypeScript's provenance fields through a widening view (they are `@internal`) and fail a test loudly if a resolution that can only have been reached by probing comes back without them.
- Prove equality rather than assert it: every scenario, and a seeded property test over a generated 300-file workspace (60 mutations by default, `CODE_INTEL_MUTATION_STEPS` for a long soak), must deep-equal a from-scratch build of the same workspace state.
- Persist the entry to the OS user cache directory (never inside the workspace), keyed by a digest of the canonical root, validated field by field on load, written atomically, tolerating an unwritable or full disk, and swept so the directory cannot grow without bound; `CODE_INTEL_CACHE_DIR` and `CODE_INTEL_GRAPH_CACHE=off` control it.
- Do not let persistence make the walk's blind spots permanent: a resolution whose target or probed paths lie where the walk never looks (build output, hidden directories, nested checkouts, symlinks), or which names a file the walk does not report at all, is re-resolved on every call instead of being trusted from memory or from disk.
- Confirm a suspected rename with the content before adopting the deleted file's parse: `(mtime, size, extension)` is a hint, and an archive restored with its timestamps is the ordinary way it lies.
- Report `invalidatedByProvenance`, `unwatchableFiles`, `persistedLoad` and `persistedSave` in the cache stats so the rule can be seen working.
Status: done (2026-09-05)

### T-021 Cross-platform CI matrix + multi-OS release smoke + per-OS perf budget
Owner: tooling-agent
- Run the `quality` gate on `ubuntu-latest`, `windows-latest` and `macos-latest` with `fail-fast: false`, so the ~21 `process.platform` branches (native ripgrep/ast-grep binaries, `realpath` and case handling, `LOCALAPPDATA` vs `XDG_CACHE_HOME`, spawn shapes and timeouts, atomic rename, line endings) are exercised by CI instead of by one machine. Coverage is produced once (ubuntu + Node 24).
- Broaden the Node coverage the `engines.node` field implies: Node 22 and 24 run the full gate, Node 20 runs a `runtime-compat` gate (lint, type-check, build, `--self-test` of the COMPILED server) because the dev toolchain cannot run there - vitest 5 requires `^22.12 || ^24 || >=26`, and `node --experimental-strip-types`, which the CLI integration test spawns, only exists from 22.6.
- Add a `release-smoke` job on the same three OS: pack the tarball a publish would produce (`pnpm pack` runs `prepack`), install it into a throwaway project, start the installed server on a free port and drive `/health` plus one `searchStruct`. This is where a `files` mistake, a missing per-platform optional dependency or a Windows-only path bug in the shipped code becomes visible.
- Make the searchText perf budget platform-aware (`__tests__/unit/code-intel-mcp/perf.test.ts`): 2000 ms on linux/darwin, a calibrated Windows number, and `CODE_INTEL_PERF_BUDGET_MS` as an operator override. The test must REPORT the duration it measured, so the budget can be recalibrated from evidence rather than from feel.
- Leave `perf-budget.yml`, `security.yml`, `pr-memory-reference.yml` and the `indexer-smoke`/`security` jobs on ubuntu: their thresholds and their tooling are calibrated for one runner.
Status: done (2026-09-06)

## Agent execution card (for each task)

- Read: context + architecture + memory protocol.
- Execute only current task scope.
- Produce evidence (commands and results).
- Append memory entry.
- Hand off next action.
