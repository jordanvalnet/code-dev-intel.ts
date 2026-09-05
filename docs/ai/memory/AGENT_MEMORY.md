# AGENT MEMORY (Append-only)

LOCK: none

## Usage

- This file is append-only.
- Every agent task event must append one entry using the protocol in `docs/ai/03-shared-memory-protocol.md`.

---

## [2026-02-21T00:00:00Z] BootstrapAgent | INIT
- Status: done
- Summary: Initialized shared memory file.
- Decisions: Append-only policy enforced from project start.
- Files: docs/ai/memory/AGENT_MEMORY.md
- Evidence: File created.
- Risks: none
- Next: Start task T-001 from backlog.
- Blockers: none

## [2026-02-22T00:00:00Z] CopilotAgent | KIT-T001-T004
- Status: done
- Summary: Delivered execution kit for tasks T-001 to T-004 with scaffolding, templates, and runbook.
- Decisions: Kept stack lightweight and local-first; provided optional tooling boundaries in docs.
- Files: README.md, CONTRIBUTING.md, .gitignore, scripts/bootstrap.ps1, scripts/bootstrap.sh, docs/ai/06-bootstrap-execution-kit.md, docs/ai/templates/task-execution-report.md, docs/ai/templates/memory-entry-template.md, docs/ai/templates/pr-template.md, schemas/sqlite/001_initial.sql, services/code-intel-mcp/src/contracts.ts, services/code-intel-mcp/src/server.ts, services/code-intel-mcp/README.md, services/indexer/README.md, services/indexer/src/README.md
- Evidence: Repository scaffolding created and verified by directory listings.
- Risks: Placeholder mock server still requires real MCP wiring in T-004 implementation.
- Next: Execute T-001 on branch task/T-001-bootstrap-conventions and open first PR.
- Blockers: none

## [2026-02-22T00:15:00Z] CopilotAgent | T-001
- Status: done
- Summary: Finalized repository conventions and contribution contract for multi-agent workflow.
- Decisions: Kept task granularity small and enforced append-only memory protocol.
- Files: CONTRIBUTING.md, docs/ai/03-shared-memory-protocol.md, docs/ai/templates/pr-template.md
- Evidence: Conventions and protocol files present and aligned with backlog acceptance criteria.
- Risks: none
- Next: Execute T-002 schema validation with reproducible script evidence.
- Blockers: none

## [2026-02-22T00:20:00Z] CopilotAgent | T-002
- Status: done
- Summary: Implemented migration strategy documentation and validated SQLite schema with executable smoke test.
- Decisions: Used Node 24 `node:sqlite` to avoid extra dependency and keep setup lightweight.
- Files: schemas/sqlite/001_initial.sql, schemas/sqlite/README.md, scripts/sqlite-smoke.mjs
- Evidence: `node .\\scripts\\sqlite-smoke.mjs` output `ok: true`, with seeded counts for files/symbols/imports/index_runs.
- Risks: `node:sqlite` is experimental in Node 24; acceptable for internal smoke check but monitor Node updates.
- Next: Start T-003 incremental change detector implementation.
- Blockers: none

## [2026-02-22T00:40:00Z] CopilotAgent | T-003
- Status: done
- Summary: Implemented incremental change detector with `git-diff` and `watch` modes plus CLI runner.
- Decisions: Added untracked relevant files to git-diff results so local new TS/TSX files are indexed without full scan.
- Files: services/indexer/src/change-detector.ts, services/indexer/src/indexer-runner.ts, services/indexer/README.md
- Evidence: `node --trace-uncaught --experimental-strip-types .\\services\\indexer\\src\\indexer-runner.ts --mode=git-diff --baseRef=HEAD` returned JSON with targeted changed files and `changedCount: 2`.
- Risks: `watch` mode not live-tested in this session to avoid long-running terminal process.
- Next: Start T-004 MCP server skeleton hardening and health contract validation.
- Blockers: none

## [2026-02-22T12:20:00Z] CopilotAgent | T-004
- Status: done
- Summary: Implemented MCP skeleton server with health endpoint and tool endpoint using stable JSON contracts.
- Decisions: Used lightweight Node HTTP server and self-test mode to avoid long-running manual validation.
- Files: services/code-intel-mcp/src/contracts.ts, services/code-intel-mcp/src/server.ts, services/code-intel-mcp/README.md
- Evidence: `node --experimental-strip-types .\\services\\code-intel-mcp\\src\\server.ts --self-test` returned `ok: true`, healthy tool list, and `sampleTool.status: 200`.
- Risks: HTTP skeleton is intentionally minimal and not yet full MCP protocol transport.
- Next: Start T-005 TypeScript symbol resolution wiring for `findDefinitions` and `findReferences`.
- Blockers: none

## [2026-02-22T12:35:00Z] CopilotAgent | T-005
- Status: done
- Summary: Wired `findDefinitions` and `findReferences` to TypeScript Language Service with cross-file lookup.
- Decisions: Added a dedicated symbol service module and a deterministic fixture workspace for repeatable self-tests.
- Files: package.json, services/code-intel-mcp/src/contracts.ts, services/code-intel-mcp/src/typescript-symbol-service.ts, services/code-intel-mcp/src/server.ts, services/code-intel-mcp/fixtures/self-test-workspace/tsconfig.json, services/code-intel-mcp/fixtures/self-test-workspace/src/definitions.ts, services/code-intel-mcp/fixtures/self-test-workspace/src/usage.ts, services/code-intel-mcp/README.md
- Evidence: `node --experimental-strip-types .\\services\\code-intel-mcp\\src\\server.ts --self-test` returned `sampleTool.payload.data.locations` across `src/usage.ts` + `src/definitions.ts` and `sampleDefinition` pointing to definition in `src/definitions.ts`.
- Risks: Symbol offset currently targets first text occurrence of `symbol` in the source file; richer position-based queries can improve precision later.
- Next: Start T-006 `searchStruct` integration with ast-grep.
- Blockers: none

## [2026-02-22T13:45:00Z] CopilotAgent | QUALITY-GATES-BASELINE
- Status: done
- Summary: Added mandatory lint/type-check/unit-test workflow and pnpm-only enforcement; created unit tests for all implemented TS modules.
- Decisions: Enforced package-manager policy with dependency-free preinstall guard and documented constraints across backlog/prompts/protocol.
- Files: package.json, tsconfig.json, eslint.config.mjs, vitest.config.ts, CONTRIBUTING.md, docs/ai/03-shared-memory-protocol.md, docs/ai/04-executable-task-backlog.md, docs/ai/05-agent-prompts.md, docs/ai/06-bootstrap-execution-kit.md, __tests__/unit/indexer/change-detector.test.ts, __tests__/unit/code-intel-mcp/typescript-symbol-service.test.ts, __tests__/unit/code-intel-mcp/server.test.ts, services/code-intel-mcp/fixtures/self-test-workspace/src/usage.ts, services/code-intel-mcp/src/server.ts, services/code-intel-mcp/src/typescript-symbol-service.ts
- Evidence: `pnpm run test:all` passed (`eslint` + `tsc --noEmit` + `vitest`, 3 test files / 7 tests passed).
- Risks: Type-aware ESLint is strict and may require occasional targeted fixes when adding new TS modules.
- Next: Resume backlog with T-006 (`searchStruct` via ast-grep) under mandatory quality gates.
- Blockers: none

## [2026-02-22T14:40:00Z] CopilotAgent | T-006
- Status: done
- Summary: Completed `searchStruct` integration via `ast-grep` and stabilized unit testing for ESM constraints.
- Decisions: Replaced ESM `spyOn(node:child_process.spawnSync)` with an injectable runner in `ast-grep-service` to keep tests deterministic and compatible.
- Files: package.json, services/code-intel-mcp/src/ast-grep-service.ts, services/code-intel-mcp/src/server.ts, services/code-intel-mcp/src/contracts.ts, __tests__/unit/code-intel-mcp/ast-grep-service.test.ts, __tests__/unit/code-intel-mcp/server.test.ts
- Evidence: `pnpm run test:all` passed (`4` test files, `10` tests).
- Risks: Runtime `ast-grep` execution still depends on local binary availability and OS environment.
- Next: Continue with T-007 (`searchText` via ripgrep fallback).
- Blockers: none

## [2026-02-22T14:55:00Z] CopilotAgent | T-007
- Status: done
- Summary: Implemented `searchText` with `ripgrep` first and resilient Node fallback, then exposed it via MCP endpoint.
- Decisions: Added injectable runner for text-search service tests to avoid environment-coupled command execution during unit tests.
- Files: services/code-intel-mcp/src/contracts.ts, services/code-intel-mcp/src/search-text-service.ts, services/code-intel-mcp/src/server.ts, __tests__/unit/code-intel-mcp/search-text-service.test.ts, __tests__/unit/code-intel-mcp/server.test.ts, services/code-intel-mcp/README.md
- Evidence: `pnpm run test:all` passed (`5` test files, `14` tests).
- Risks: Actual `ripgrep` availability still depends on machine PATH; fallback mitigates unavailability but may be slower.
- Next: Start T-008 Docker profiles (`core`, `search-optional`) with minimal footprint.
- Blockers: none

## [2026-02-22T15:10:00Z] CopilotAgent | T-008
- Status: done
- Summary: Added Docker profiles `core` and `search-optional` with low default resource limits and documented local usage.
- Decisions: Kept `search-optional` as a lightweight helper container to avoid heavy always-on stack on 16GB dev machines.
- Files: docker/docker-compose.yml, docker/Dockerfile.mcp, docker/README.md, .dockerignore, package.json, README.md
- Evidence: Compose profiles and pnpm scripts are in place; quality gates passed after changes.
- Risks: `search-optional` currently provides helper tooling shell and is not a full indexed search engine service.
- Next: Proceed to T-009 local security checks baseline.
- Blockers: none

## [2026-02-22T23:35:00Z] CopilotAgent | T-009
- Status: done
- Summary: Implemented local and CI OpenGrep baseline scanning with testable runner and initial ruleset.
- Decisions: Kept security baseline lightweight (single ruleset + wrapper) and produced SARIF artifact in CI for later review workflows.
- Files: security/opengrep-rules.yml, services/security/opengrep-runner.ts, __tests__/unit/security/opengrep-runner.test.ts, .github/workflows/security-opengrep.yml, package.json, README.md
- Evidence: `pnpm run test:all` passed (`eslint` + `tsc --noEmit` + `vitest`, 6 test files / 17 tests).
- Risks: OpenGrep installation in CI depends on upstream installer availability.
- Next: Start T-010 shared memory enforcement checks and templates audit.
- Blockers: none

## [2026-02-22T23:42:00Z] CopilotAgent | T-010
- Status: done
- Summary: Enforced shared-memory reference requirements for task PRs via automated PR body validation and stronger templates.
- Decisions: Added a lightweight PR-body validator (task ID + UTC timestamp + memory file reference) and CI workflow trigger on pull request lifecycle events.
- Files: services/governance/pr-memory-reference-check.ts, __tests__/unit/governance/pr-memory-reference-check.test.ts, .github/workflows/pr-memory-reference.yml, docs/ai/templates/pr-template.md, docs/ai/templates/task-execution-report.md, docs/ai/03-shared-memory-protocol.md, package.json
- Evidence: `pnpm run test:all` passed (`eslint` + `tsc --noEmit` + `vitest`, 7 test files / 20 tests).
- Risks: PR validation relies on pull request body quality; empty or malformed descriptions are now intentionally blocking.
- Next: Continue with T-011 impacted-files engine.
- Blockers: none

## [2026-02-22T23:52:00Z] CopilotAgent | T-011
- Status: done
- Summary: Implemented impacted-files engine with graph traversal from changed files and optional symbol-scoped propagation.
- Decisions: Built a lightweight local graph from source imports/exports and added an `impacted` mode to `indexer-runner` for direct CLI usage.
- Files: services/indexer/src/impacted-files-engine.ts, services/indexer/src/indexer-runner.ts, services/indexer/src/change-detector.ts, __tests__/unit/indexer/impacted-files-engine.test.ts, services/indexer/README.md, package.json, docs/ai/04-executable-task-backlog.md
- Evidence: `pnpm run test:all` passed (`eslint` + `tsc --noEmit` + `vitest`, 8 test files / 23 tests).
- Risks: Import resolution currently handles relative paths only; alias-based imports can be added in a next increment.
- Next: Start T-012 optional Zoekt integration.
- Blockers: none

## [2026-02-23T01:10:00Z] CopilotAgent | T-012
- Status: done
- Summary: Added optional Zoekt Docker integration for on-demand full-text indexing and query serving.
- Decisions: Kept Zoekt completely opt-in through a dedicated `zoekt-optional` profile and one-shot indexing command to preserve low default footprint.
- Files: docker/docker-compose.yml, docker/README.md, package.json, README.md, docs/ai/04-executable-task-backlog.md
- Evidence: `pnpm run test:all` passed (`eslint` + `tsc --noEmit` + `vitest`, 8 test files / 23 tests).
- Risks: Zoekt container image availability depends on upstream image registry tags.
- Next: Start T-013 CI pipelines consolidation.
- Blockers: none

## [2026-02-23T17:15:00Z] CopilotAgent | T-013
- Status: done
- Summary: Consolidated CI checks into a single workflow covering quality, security, and indexer smoke validation.
- Decisions: Replaced the standalone security workflow with `ci.yml` jobs to centralize status and keep `pr-memory-reference` as a dedicated policy workflow.
- Files: .github/workflows/ci.yml, .github/workflows/security-opengrep.yml (deleted), scripts/indexer-smoke.mjs, package.json, README.md, docs/ai/04-executable-task-backlog.md, docs/ai/memory/AGENT_MEMORY.md
- Evidence: `pnpm run test:all` passed (`8` test files / `23` tests), and `pnpm run indexer:smoke` returned `{ "ok": true, ... }`.
- Risks: CI security job still depends on OpenGrep install script availability at runtime.
- Next: Start T-014 performance budget targets.
- Blockers: none

## [2026-02-23T17:25:00Z] CopilotAgent | T-014
- Status: done
- Summary: Added low-cost performance benchmark framework with explicit local/CI budgets and non-frequent CI trigger policy.
- Decisions: Kept perf workflow outside push/PR pipelines to protect GitHub Actions credits (`workflow_dispatch` + weekly schedule only), and set CI benchmark job to non-blocking initially.
- Files: scripts/perf-benchmark.mjs, perf/budget.json, .github/workflows/perf-budget.yml, package.json, README.md, docs/ai/04-executable-task-backlog.md, docs/ai/memory/AGENT_MEMORY.md
- Evidence: `pnpm run test:all` passed; local perf benchmark command added as `pnpm perf:benchmark` and CI mode as `pnpm perf:benchmark:ci`.
- Risks: Initial thresholds are baseline targets and may need tuning after observing a few weekly CI runs.
- Next: Proceed to T-015 hardening (secret exclusions and tool trust boundaries).
- Blockers: none

## [2026-02-23T17:33:00Z] CopilotAgent | T-014-VERIFY
- Status: done
- Summary: Fixed cross-platform command execution in perf benchmark script and validated successful local run.
- Decisions: Replaced nested `pnpm` process spawning with direct Node executable invocations for benchmark scenarios.
- Files: scripts/perf-benchmark.mjs, docs/ai/memory/AGENT_MEMORY.md
- Evidence: `node ./scripts/perf-benchmark.mjs --mode=local --iterations=1` returned `{ "ok": true, ... }`; `pnpm run test:all` passed (`8` test files / `23` tests).
- Risks: Single-iteration sample is a smoke-level check; weekly CI runs will provide trend stability.
- Next: Proceed to T-015 hardening.
- Blockers: none

## [2026-06-13T18:20:00Z] ClaudeOpus | T-016
- Status: done
- Summary: Added an explicit operator allowlist so a request workspaceRoot outside the configured default (e.g. a sibling git worktree) can be authorized via repeatable `--allowed-workspace-root=<glob>` or the `CODE_INTEL_ALLOWED_WORKSPACE_ROOTS` env var, without weakening the default sandbox.
- Decisions: Chose explicit operator config over auto-detecting a `.git` entry — a planted `.git` could widen the sandbox and is non-auditable. Patterns are matched (picomatch) against the canonical realpath of the request root, so `..`/symlink escapes stay blocked; an empty allowlist preserves the original strict behavior.
- Files: services/code-intel-mcp/src/safe-path.ts, services/code-intel-mcp/src/server-utils.ts, services/code-intel-mcp/src/cli.ts, __tests__/unit/code-intel-mcp/server-utils.test.ts, __tests__/unit/code-intel-mcp/security.test.ts, __tests__/unit/code-intel-mcp/cli.test.ts, README.md, CHANGELOG.md, package.json, docs/ai/04-executable-task-backlog.md, docs/ai/memory/AGENT_MEMORY.md
- Evidence: `pnpm lint` (eslint --max-warnings 0) clean; `pnpm type-check` clean; `pnpm test` 20 files / 153 tests passed (new server-utils allowlist unit tests + security accept-case integration test + cli forwarding tests).
- Risks: Operator-provided globs are trusted by design; an over-broad pattern (e.g. `/**`) widens access — documented in README.
- Next: Publish v0.3.6 and pass `--allowed-workspace-root` in the consuming `.mcp.json` for worktree use.
- Blockers: none

## [2026-09-04T16:20:00Z] ClaudeFable | T-017
- Status: done
- Summary: Refreshed every dependency (typescript 6.0.3 — 7.x is the native compiler without a JS API —, @ast-grep/cli 0.45.3, zod 4.5.4, picomatch 4.0.7, eslint 10, vitest 5, vite 8, typescript-eslint 8.69, @types/node 26, pnpm 10.34.5, GitHub Actions v7/v6, node:24.20.0-alpine, alpine:3.23), cleared pnpm audit (13 high / 3 moderate → 0), ran a light security review (4 Sonnet lenses + 2 Opus adversarial verifiers) and fixed its four confirmed findings, then fixed what the live run on a large private consumer codebase exposed. Released as 0.4.0.
- Decisions: (1) filePath in every symbol tool now goes through assertWithinWorkspace (arbitrary-file read, HIGH); (2) ripgrep query passed as `-e <query> --` (flag injection → --pre command execution, HIGH); (3) sinceGitRef rejected when it starts with `-` at schema + service level (git --output file write, MEDIUM); (4) POST /tools/* and /mcp reject requests whose Origin header is not the server itself or CODE_INTEL_ALLOWED_ORIGINS (browser CSRF / DNS rebinding, MEDIUM) — non-browser clients send no Origin and are unaffected. (5) Workspace walkers of impactedFiles/findDuplicates skip hidden dirs and nested git checkouts (the verification target has 59k files under .claude/worktrees/ → one call blocked the server 555 s; now 1.3 s). (6) The ripgrep binary is resolved from @vscode/ripgrep's own location (pnpm isolated layout hid the platform package; searchText had been silently on the Node fallback in every pnpm install) and a timeout now degrades with engineFallbackReason instead of HTTP 500; ripgrep default timeout 5 s → 15 s (first launch on Windows ≈ 5 s). (7) tsconfig.build.json sets rootDir=./services (TS 6 TS5011). (8) ast-grep fallback tests no longer depend on the postinstall having copied ast-grep.exe (pnpm 10 blocks it).
- Files: package.json, pnpm-lock.yaml, tsconfig.build.json, .github/workflows/*.yml, docker/Dockerfile.mcp, docker/docker-compose.yml, services/code-intel-mcp/src/{typescript-symbol-service,search-text-service,duplicate-detection-service,contracts,server,server-utils,safe-spawn,file-collection,ast-grep-service,tool-handler,mcp-handler}.ts, services/indexer/src/impacted-files-engine.ts, __tests__/unit/code-intel-mcp/{security,search-text-service,duplicate-detection-service,ast-grep-service,cli}.test.ts, __tests__/unit/indexer/impacted-files-engine.test.ts, README.md, services/code-intel-mcp/README.md, CHANGELOG.md, docs/ai/04-executable-task-backlog.md
- Evidence: `pnpm lint` clean; `pnpm type-check` clean; `pnpm test` 20 files / 162 tests passed; `pnpm build` ok; `pnpm audit` "No known vulnerabilities found"; release smoke from a packed tarball ok (ensure/status/searchStruct); live run of the built server against a large private consumer codebase (~4,200 scanned files): 23/23 checks — health, tools/describe, getFileOutline, findSymbol, findImplementations (5), findReferences (19 refs / 9 files), findDefinitions, getSymbolContent, findCallers (4), findCallees, dependencyGraph (3 deps / 8 edges), impactedFiles (11 files, 1.3 s), searchText (ripgrep, 219 ms), searchStruct ts+tsx (5 / 293 matches, ast-grep 0.45.3), findDuplicates (3 groups, 3.4 s), both sandbox rejections (400), MCP over HTTP (initialize/tools/list/tools/call) and MCP over stdio.
- Risks: Both graph engines resolve relative imports only, so on alias-heavy codebases (the verification target uses `@/`) dependencyGraph/impactedFiles stay shallow — tsconfig `paths` support is the next functional gap. The Origin check could reject an HTTP MCP client that sends a non-local Origin; CODE_INTEL_ALLOWED_ORIGINS (or `*`) is the escape hatch. Node 18/20 are EOL; engines still says >=18.
- Next: bump the exact `code-dev-intel.ts` pin in the consumer codebase to 0.4.0; consider tsconfig paths alias resolution (T-018) and the still-open T-015 hardening items.
- Blockers: none

## [2026-09-04T17:30:00Z] ClaudeOpus | T-018
- Status: done
- Summary: Both module-graph engines now resolve tsconfig/jsconfig `paths` and `baseUrl` aliases, not only relative specifiers — the functional gap T-017 flagged. `dependencyGraph` (services/code-intel-mcp) and `impactedFiles`/`buildWorkspaceGraph` (services/indexer) share a new resolver, `services/indexer/src/import-resolver.ts`, so `@/domain/ports/Port` becomes an internal edge instead of an external dependency and the two tools stop returning near-empty graphs on alias-heavy codebases. Released as 0.5.0.
- Decisions: (1) TypeScript is the oracle, not an approximation — the resolver was differentially tested against `ts.resolveModuleName` on TS 6.0.3 and matches it on exact-key precedence, longest-prefix wildcards, suffix patterns, multiple targets in order, extends chains and baseUrl fallback. (2) A matched `paths` pattern is terminal (tsc falls through to node_modules, never back to baseUrl), so `matchAliasCandidates` distinguishes "nothing matched" (null → try baseUrl) from "matched, no usable target" ([] → external). (3) The first candidate that EXISTS wins, and if it is outside `workspaceRoot` the specifier is external rather than silently taking a later inside target — TS-faithful and sandbox-consistent; this also closes a pre-existing hole where a relative `../../` escape put an out-of-root file into the MCP graph and read it. (4) Config parsing uses `ts.readJsonConfigFile` + `parseJsonSourceFileConfigFileContent` with a ParseConfigHost whose `readDirectory` returns [] — never globs the workspace, and exposes `extendedSourceFiles` so the cache fingerprint covers the whole `extends` chain, not just the root config (a long-lived server otherwise serves stale aliases after a base-config edit). The root config is stat-ed BEFORE the parse, so a rewrite landing mid-parse is not stamped as already-parsed. (5) REVIEW BLOCKER, Windows-only regression: `join()` built the config path with backslashes, and TypeScript asserts its diagnostics’ file name against its own forward-slash normalization — so ANY workspace with a JSON syntax error in tsconfig/jsconfig made all three entry points throw `Debug Failure` (pre-T018 they returned the graph normally). Fixed by normalizing the path the way `ts.findConfigFile` does, plus a defensive try/catch that degrades to "no aliases". (6) Empty wildcard captures now use the target verbatim and keys with 2+ wildcards are ignored, both matching TS — previously `@/` fabricated an internal edge to `src/index.ts` and `a*b*c` matched literally. (7) Relative and alias probing gained `.d.ts` / `index.d.ts` (tsc resolves them; both deleted resolvers did not) — strictly additive, appended after the source extensions so a real `.ts` still wins. (8) `createWorkspaceBoundaryCheck` added to safe-path.ts so the workspace root is canonicalized (realpath) once per engine call instead of once per unique resolved file; the boundary logic itself stays in one module.
- Files: services/indexer/src/import-resolver.ts (new), services/indexer/src/impacted-files-engine.ts, services/code-intel-mcp/src/typescript-symbol-service.ts, services/code-intel-mcp/src/safe-path.ts, services/code-intel-mcp/src/health-handler.ts, __tests__/unit/indexer/import-resolver.test.ts (new), __tests__/unit/indexer/impacted-files-engine.test.ts, __tests__/unit/code-intel-mcp/typescript-symbol-service.test.ts, __tests__/unit/code-intel-mcp/safe-path.test.ts, __tests__/unit/code-intel-mcp/server.test.ts, README.md, services/code-intel-mcp/README.md, CHANGELOG.md, package.json, docs/ai/04-executable-task-backlog.md, docs/ai/memory/AGENT_MEMORY.md
- Evidence: `pnpm lint` (eslint --max-warnings 0) clean; `pnpm type-check` (tsc --noEmit) clean; `pnpm test` **21 files / 185 tests passed** (baseline before T-018: 20 files / 162 tests — 16 new import-resolver tests plus alias, malformed-config, boundary-check and tools/describe tests); `pnpm build` ok; `pnpm indexer:smoke` `{"ok": true, "gitDiffChangedCount": 11, "impactedCount": 2}`; `pnpm audit --audit-level=high` "No known vulnerabilities found". Differential oracle vs `ts.resolveModuleName` on TS 6.0.3: 9/9 cases identical after the fixes (empty capture, multi-wildcard keys, exact key with a `*` target, and the three declaration-file cases all diverged before). Blocker reproduced through the public entry points and confirmed fixed: unclosed brace / missing comma in tsconfig.json and jsconfig.json all threw `Debug Failure. Expected <config path>...` before, all return the graph after. Old-vs-new regression on this repository over every import specifier: 194 identical, 7 added, 0 lost, 0 changed — all seven are `.js` specifiers now mapped to their `.ts` file (the mapping `dependencyGraph` already had and `impactedFiles` lacked); the `.d.ts` probing adds no edge here. Repo graph: 63 files / 64 unique edges in 41 ms.
- Risks: `impactedFiles` output changes on repositories with no `paths`/`baseUrl` at all, because the two engines now share the richer relative probing (`.js` → `.ts`, `.d.ts`) — additive on this repo, but a consumer pinning exact impact sets will see more files. A directory reached through an alias that resolves to a `package.json` "main" is still external (not in the probe list, unlike tsc). Alias targets pointing into directories the walker skips (node_modules/, dist/, .next/) would create edges whose targetFile is absent from `graph.files`. mtime invalidation has ~1 ms granularity, so a config rewritten inside the same millisecond as the previous parse is missed. `dependencyGraph` parses the tsconfig twice per call (once for the language service via resolveProjectContext, once via the resolver’s process-cached loader); both are cheap but the two parse paths could be unified. No live run against the private consumer codebase was permitted in this task, so the real-world numbers for the alias-heavy consumer are still unverified — a synthetic Next.js-shaped workspace is the closest evidence.
- Next: publish v0.5.0, then bump the exact `code-dev-intel.ts` pin in the consumer codebase and re-run the T-017 live checklist there to measure `dependencyGraph`/`impactedFiles` on real `@/` imports. Still open: T-015 hardening items.
- Blockers: none

## [2026-09-04T18:20:00Z] ClaudeOpus | T-018-FOLLOWUP
- Status: done
- Summary: `impactedFiles` was blind to every Prettier-wrapped import. `extractImports` in services/indexer/src/impacted-files-engine.ts matched `/(?:import|export)\s+([^;\n]*?)\s+from\s+['"]([^'"]+)['"]/g`, whose clause class excludes newlines, so a multi-line `import type { … }` — the normal shape in a formatted codebase — produced no edge, and changing a port did not mark the adapters implementing it. Extraction now reads TypeScript’s parse tree instead of the file text.
- Decisions: (1) Measured all three candidate strategies before choosing. Isolated extraction cost over 4,080 synthetic files / 4.4 MB: current regex 20.7 ms, corrected regex `[^;'"]*?` 33.9 ms, `ts.preProcessFile` + clause slice 128.9 ms, `ts.createSourceFile` walk 323.2 ms. (2) Rejected the corrected regex (c): it fixes newlines but keeps the comment/string false positive — measured 32,160 specifiers vs the parser’s 28,160 on the same synthetic set, i.e. one fabricated specifier per file, all from an in-function comment containing `from '@/legacy/Store'`. (3) Rejected `ts.preProcessFile` (a): it silently omits `export * as ns from 'x'` (verified on a probe — `./starns` absent from `importedFiles` while `./star` is present), which is a required case; it also reports `require()` / dynamic `import()` / `import x = require()`, an unrequested behaviour change, and recovering the clause needs a backward text slice that is heuristic again. (4) Chose `ts.createSourceFile` (b): exact on every required case, no false positives, and bindings, `default`, namespace bindings and inline `type` modifiers come already separated — `parseImportedSymbols` and its clause re-splitting are deleted outright rather than patched. Named bindings are recorded under `propertyName ?? name`, i.e. the name the TARGET module exports, which is what `exportsByFile` and `changedSymbolsByFile` are keyed on (`{ original as alias }` stays `original`, unchanged from before). (5) `ScriptKind` is derived from the extension so `.tsx`/`.jsx` parse as JSX rather than resynchronizing on `<T>`. (6) `declare module 'x' { import … }` bodies are walked, because the old whole-file text scan saw those and a top-level-only walk would have silently dropped them. (7) `extractExports`, `calculateImpactedFiles`, symbol filtering and the T-018 alias resolution are untouched; the change is confined to `extractImports` and its helpers plus the one call site that now passes the file name.
- Files: services/indexer/src/impacted-files-engine.ts, __tests__/unit/indexer/impacted-files-engine.test.ts, CHANGELOG.md, docs/ai/memory/AGENT_MEMORY.md
- Evidence: TDD — 12 new tests written first and seen red: 7 failed against the old regex (multi-line named, multi-line type-only, inline `type` modifier, default+named, multi-line re-export, comment/string false positive, and the end-to-end multi-line type-only alias propagation), 5 passed as pre-existing behaviour (namespace, side-effect, single-line re-export, `export *`, `export * as ns`) and were kept as regression guards. All 12 green after the change. Gates: `pnpm lint` (eslint --max-warnings 0) clean; `pnpm type-check` (tsc --noEmit) clean; `pnpm test` **21 files / 197 tests passed** (baseline 21 files / 185 tests). Performance, `buildWorkspaceGraph` median of 5 runs after a warm-up, synthetic workspace of 4,000 files × 5 imports + 80 barrels (generated outside the repository): **1,989.4 ms → 2,507.5 ms = 1.26×**, inside the 2× budget (3,978.8 ms); edges **12,080 → 20,160**, i.e. the old regex was missing 40.1% of that graph. Read-only differential on a large private consumer codebase (~4,200 files, 20.3 MB, `@/` aliases), both extractors through the same resolver: unique edges **13,440 → 15,294** — 1,857 gained, 3 lost, and all 3 lost are confirmed false positives (two are JSDoc usage examples that made each file import itself; the third is a string fixture inside an architecture test, `"import { db } from '@/…';"`). The reported blocker reproduced and fixed end to end: `impactedFiles` for a single changed port interface returned 50 files WITHOUT the adapter that implements it before, and 55 files WITH it after. Real-repo graph build 1,899.2 ms → 3,852.0 ms (2.03×); extraction-only cost there is 21 ms regex vs 1,413.7 ms parse over 20.3 MB.
- Risks: On a large real repository the full parse roughly doubles `buildWorkspaceGraph` (1.9 s → 3.9 s per `impactedFiles` call on a 20 MB / ~4,200-file workspace) — within the stated synthetic budget but worth watching, since the graph is rebuilt on every call and nothing caches it. If that becomes a problem the lever is a `ts.createScanner` token sweep (measured 276 ms on the same 20 MB, and `ts.preProcessFile` 367 ms, vs 1,414 ms for the parse), at the cost of a hand-written clause state machine. Consumers pinning exact impact sets will see larger answers, by design. `import x = require('./y')` still produces no edge (it produced none before either, though `ts.preProcessFile` would report it) and neither does a dynamic `import()`; both are deliberate scope limits, not oversights. A non-literal module specifier (template string) is skipped. The parser is error-tolerant, so a file that does not compile still yields whatever import statements parsed.
- Next: publish the patch release, then re-run the T-017 live checklist against the private consumer codebase to confirm the 55-file impact set on real changed ports. Consider caching `buildWorkspaceGraph` per workspace+mtime if the 3.9 s call cost is felt, and revisit whether `dependencyGraph`’s `ts.preProcessFile` should move to the same parse-tree extractor so the two engines cannot diverge again (it currently misses `export * as ns from`).
- Blockers: none

## [2026-09-04T22:00:00Z] ClaudeOpus | T-019
- Status: done
- Summary: Applied the T-019 review (1 blocker, 4 major, 3 minor, 1 nit) on top of the exhaustive-module-graph work, then documented the whole task. The blocker was silent edge loss: `import()` in a TYPE position (`type X = import('./m').Y`, `typeof import('./m')`, generic arguments, mapped types, `declare global` / `declare module` bodies) produced no edge in either engine while `unresolvedCount` still reported 0 — a false answer, and for `dependencyGraph` a regression against the `ts.preProcessFile` it had replaced. The majors were three further ways to answer confidently and wrongly (a broken `baseUrl` import filed as an installed package; a mis-cased import resolving to a node no walk produced; `changedSymbolsByFile` truncating the impact set at the first re-export) plus an MCP input schema that forbade an option its own description told the model to send. Gates green: 23 files / 288 tests.
- Decisions: (1) Type-position `import()` is a real edge and is now extracted, with the LEFTMOST identifier of the qualifier as the imported symbol (`import('./m').Outer.Inner` records `Outer`, the export it reaches into) and a non-literal argument reported as `dynamic-specifier` like any other. JSDoc `import()` types are followed in JavaScript files ONLY, where JSDoc is the type system; in a `.ts` file the checker ignores them, so following one would invent an edge `tsc` does not have. (2) A fourth reason, `unsupported-file-type`, separates "the file is there and this graph does not read that kind" (`.vue`, `.svelte`, `.wasm`, `.mdx`) from "nothing is there". Calling an existing file not-found is factually wrong and, on a component-per-file codebase, fills the 10/20-entry sample ahead of real breakage; the count still signals a hole, so completeness is not weakened. (3) `baseUrl`-shaped bare specifiers are separated from package names by the filesystem, not by syntax: the first segment must name an existing entry under `baseUrl`. `billing/deleted` with a `billing/` directory is a lost workspace edge and is reported; `some-lib` with nothing of that name stays external, so an uninstalled node_modules still does not look like breakage. (4) Canonical paths now come from `fs.realpathSync.native`, which returns the on-disk casing; the JavaScript `realpathSync` returned the caller's spelling, so on a case-insensitive filesystem a mis-cased import (which compiles and runs) resolved to a string no walk ever produced. A test asserts the invariant directly — no internal edge may point outside the walked file list. (5) `changedSymbolsByFile` now propagates instead of stopping: the extractor records, per re-export edge, which of the target's names travel onwards and under which name, so `export * from` passes `foo` through as `foo` and `export { foo as publicFoo } from` passes it on as `publicFoo`, while any non-re-export importer counts as fully changed from there on. Rejected the precise-looking alternative (deciding which of an importer's own exports depend on a used symbol) because it needs data-flow analysis and one missed case silently drops a real importer. Also dropped the rule that a changed symbol had to appear in the target's parsed export list: a CommonJS module has no parse-tree exports, and a DELETED export matches nothing — both dropped every importer, which is exactly the case where a blast radius matters most. (6) `.json` is the one asset extension appended to an extensionless specifier, because Node's own loader and every bundler do; nothing else is guessed at, so `./data/fixture` finds `fixture.json` while `./button` still never finds `button.css`. (7) `ToolOptionDescriptor` gained `'object'` plus `additionalProperties`, so `changedSymbolsByFile` is declared in `/tools/describe` and in the MCP input schema; a test pins that every `options.X` a tool description mentions is a property that tool declares, since the schema is generated with `additionalProperties: false`. (8) The nit was accepted as-is with a comment rather than a change: an `extends` chain is followed outside the workspace root, deliberately, because that is what `tsc` does and a shared base config beside the repository is a normal monorepo shape; it is bounded to config JSON, nothing from it reaches a payload, and a `paths` target outside the root is still refused.
- Files: services/indexer/src/module-graph-extractor.ts, services/indexer/src/import-resolver.ts, services/indexer/src/impacted-files-engine.ts, services/indexer/src/workspace-graph-cache.ts, services/indexer/src/asset-modules.ts, services/code-intel-mcp/src/safe-path.ts, services/code-intel-mcp/src/contracts.ts, services/code-intel-mcp/src/mcp-handler.ts, services/code-intel-mcp/src/health-handler.ts, __tests__/unit/indexer/module-graph-extractor.test.ts, __tests__/unit/indexer/import-resolver.test.ts, __tests__/unit/indexer/impacted-files-engine.test.ts, __tests__/unit/code-intel-mcp/typescript-symbol-service.test.ts, __tests__/unit/code-intel-mcp/server.test.ts, __tests__/unit/code-intel-mcp/cli.integration.test.ts, README.md, services/code-intel-mcp/README.md, CHANGELOG.md, docs/ai/04-executable-task-backlog.md, docs/ai/memory/AGENT_MEMORY.md
- Evidence: Gates — `pnpm lint` (eslint --max-warnings 0) exit 0; `pnpm type-check` (tsc --noEmit) exit 0; `pnpm test` **23 files / 288 tests passed** (T-019 phase-2 baseline 23 files / 271 tests; +17 tests, each written red first). Also green: `pnpm build` exit 0, `pnpm indexer:smoke` `{"ok": true, "gitDiffChangedCount": 22, "impactedCount": 3}`, `pnpm mcp:self-test` ok for every sample tool. Differential A/B in ONE process over a generated 3,994-file workspace (generic notifications/billing/catalog domains, a three-config extends chain, `baseUrl` plus three `paths` patterns, 798 type-position imports, 1,242 asset imports, 237 `.vue` imports, 309 extensionless JSON imports, 174 broken relative imports), old extractor+resolver against new, alternating rounds: specifiers extracted **13,551 → 14,349 (+798, 0 lost)**, exactly the planted type-position imports; classification **internal 11,628 → 12,426, asset 933 → 1,242, external 162 → 0, not-found 828 → 444, unsupported-file-type 0 → 237**. Every delta is accounted for: +798 type-position edges, +309 extensionless-JSON asset edges, 237 existing files relabelled off a false `not-found`, and **162 specifiers that were silently `external` are now reported `not-found`** — real broken workspace imports the `baseUrl` rule made visible. Cost of all of it, same process, steady-state rounds: extraction 274/380 ms before vs 264/440 ms after; resolution 10,908/10,590 ms before vs 10,889/11,212 ms after — no measurable change either way. Impact-set A/B: on a barrel fixture (`export * from` and `export { x } from` over one implementation) `changedSymbolsByFile` returned **4 files before, 6 after**, the two recovered ones being the consumers behind the barrels, while the consumer of a re-export that republishes a DIFFERENT symbol is still excluded; on the 3,994-file workspace, one changed export returned **3 files before and 71 after** — and 71 is exactly what the same query returns with no symbol filter at all, so the filter had been cutting the answer by 23x. Extractor oracle on this repository: specifiers compared against `ts.preProcessFile` over all 73 module files (minus the `declare module 'x'` names it wrongly reports as imports) — **0 missing, 0 surplus**. This repository's graph: 73 files, 107 edges, 213 export names, **unresolvedCount 0**, no edge pointing outside the walked file list, and two consecutive builds byte-identical. Timings here, on a noisy machine this session: warm `buildWorkspaceGraph` 14–39 ms; `dependencyGraph` on the server entry point 34–217 ms per call for an unchanged 22 internal / 13 external / 106 edges / unresolvedCount 0. The flaky CLI integration test (which failed on the suite's 15 s default about two runs in three, at `main` as well) now passes 3/3 at 16.5–20.9 s with its own deadline.
- Risks: `unsupported-file-type` is a new member of the published `UnresolvedReason` union — additive, but a consumer switching exhaustively on the three old values has no branch for it. `changedSymbolsByFile` now returns strictly larger sets than before (it never shrinks one), so a caller pinning exact impact sets sees more files; that is the point, but it is a behaviour change, as is a file listed in `changedFiles` with no symbol entry counting as fully changed instead of stopping the walk. The `baseUrl` first-segment test would misfile a genuine package whose name matches a top-level directory under `baseUrl` — reported as unresolved rather than silently dropped, so the failure mode is visible, but it is a heuristic. `realpathSync.native` now backs every canonicalized path; it falls back to the JavaScript implementation on error, but it can return a differently shaped path on exotic mounts. JSDoc `import()` types are followed only in JavaScript files, so a `.ts` file that names a dependency solely in JSDoc still contributes no edge (correct against the checker, surprising to a reader). The `.json` append does not cover a directory index (`./data` → `data/index.json`), which Node's CommonJS loader does resolve.
- Next: publish 0.5.0 (the version was already set and unpublished, so the CHANGELOG's 0.5.0 section was amended in place instead of a new section being added), then re-run the live checklist against a large private codebase to see the type-position, `baseUrl` and barrel-propagation changes on real code. Still open from the earlier phases: an added or deleted file costs a full re-resolution pass; the directory walk is the floor of every warm call without a filesystem watcher; `pnpm security:scan` cannot run here because the OpenGrep binary is absent.
- Blockers: none
