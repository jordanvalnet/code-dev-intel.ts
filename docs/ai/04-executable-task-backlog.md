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

## Agent execution card (for each task)

- Read: context + architecture + memory protocol.
- Execute only current task scope.
- Produce evidence (commands and results).
- Append memory entry.
- Hand off next action.
