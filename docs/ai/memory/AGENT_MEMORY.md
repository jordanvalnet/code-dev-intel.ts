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
- Evidence: `pnpm --dir "E:\\dev\\github\\kilicasa-dev-intel" run test:all` passed (`4` test files, `10` tests).
- Risks: Runtime `ast-grep` execution still depends on local binary availability and OS environment.
- Next: Continue with T-007 (`searchText` via ripgrep fallback).
- Blockers: none

## [2026-02-22T14:55:00Z] CopilotAgent | T-007
- Status: done
- Summary: Implemented `searchText` with `ripgrep` first and resilient Node fallback, then exposed it via MCP endpoint.
- Decisions: Added injectable runner for text-search service tests to avoid environment-coupled command execution during unit tests.
- Files: services/code-intel-mcp/src/contracts.ts, services/code-intel-mcp/src/search-text-service.ts, services/code-intel-mcp/src/server.ts, __tests__/unit/code-intel-mcp/search-text-service.test.ts, __tests__/unit/code-intel-mcp/server.test.ts, services/code-intel-mcp/README.md
- Evidence: `pnpm --dir "E:\\dev\\github\\kilicasa-dev-intel" run test:all` passed (`5` test files, `14` tests).
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
- Evidence: `pnpm --dir "e:\\dev\\github\\kilicasa-dev-intel" run test:all` passed (`eslint` + `tsc --noEmit` + `vitest`, 6 test files / 17 tests).
- Risks: OpenGrep installation in CI depends on upstream installer availability.
- Next: Start T-010 shared memory enforcement checks and templates audit.
- Blockers: none

## [2026-02-22T23:42:00Z] CopilotAgent | T-010
- Status: done
- Summary: Enforced shared-memory reference requirements for task PRs via automated PR body validation and stronger templates.
- Decisions: Added a lightweight PR-body validator (task ID + UTC timestamp + memory file reference) and CI workflow trigger on pull request lifecycle events.
- Files: services/governance/pr-memory-reference-check.ts, __tests__/unit/governance/pr-memory-reference-check.test.ts, .github/workflows/pr-memory-reference.yml, docs/ai/templates/pr-template.md, docs/ai/templates/task-execution-report.md, docs/ai/03-shared-memory-protocol.md, package.json
- Evidence: `pnpm --dir "e:\\dev\\github\\kilicasa-dev-intel" run test:all` passed (`eslint` + `tsc --noEmit` + `vitest`, 7 test files / 20 tests).
- Risks: PR validation relies on pull request body quality; empty or malformed descriptions are now intentionally blocking.
- Next: Continue with T-011 impacted-files engine.
- Blockers: none

## [2026-02-22T23:52:00Z] CopilotAgent | T-011
- Status: done
- Summary: Implemented impacted-files engine with graph traversal from changed files and optional symbol-scoped propagation.
- Decisions: Built a lightweight local graph from source imports/exports and added an `impacted` mode to `indexer-runner` for direct CLI usage.
- Files: services/indexer/src/impacted-files-engine.ts, services/indexer/src/indexer-runner.ts, services/indexer/src/change-detector.ts, __tests__/unit/indexer/impacted-files-engine.test.ts, services/indexer/README.md, package.json, docs/ai/04-executable-task-backlog.md
- Evidence: `pnpm --dir "e:\\dev\\github\\kilicasa-dev-intel" run test:all` passed (`eslint` + `tsc --noEmit` + `vitest`, 8 test files / 23 tests).
- Risks: Import resolution currently handles relative paths only; alias-based imports can be added in a next increment.
- Next: Start T-012 optional Zoekt integration.
- Blockers: none

## [2026-02-23T01:10:00Z] CopilotAgent | T-012
- Status: done
- Summary: Added optional Zoekt Docker integration for on-demand full-text indexing and query serving.
- Decisions: Kept Zoekt completely opt-in through a dedicated `zoekt-optional` profile and one-shot indexing command to preserve low default footprint.
- Files: docker/docker-compose.yml, docker/README.md, package.json, README.md, docs/ai/04-executable-task-backlog.md
- Evidence: `pnpm --dir "e:\\dev\\github\\kilicasa-dev-intel" run test:all` passed (`eslint` + `tsc --noEmit` + `vitest`, 8 test files / 23 tests).
- Risks: Zoekt container image availability depends on upstream image registry tags.
- Next: Start T-013 CI pipelines consolidation.
- Blockers: none

## [2026-02-23T17:15:00Z] CopilotAgent | T-013
- Status: done
- Summary: Consolidated CI checks into a single workflow covering quality, security, and indexer smoke validation.
- Decisions: Replaced the standalone security workflow with `ci.yml` jobs to centralize status and keep `pr-memory-reference` as a dedicated policy workflow.
- Files: .github/workflows/ci.yml, .github/workflows/security-opengrep.yml (deleted), scripts/indexer-smoke.mjs, package.json, README.md, docs/ai/04-executable-task-backlog.md, docs/ai/memory/AGENT_MEMORY.md
- Evidence: `pnpm --dir "e:\\dev\\github\\kilicasa-dev-intel" run test:all` passed (`8` test files / `23` tests), and `pnpm --dir "e:\\dev\\github\\kilicasa-dev-intel" run indexer:smoke` returned `{ "ok": true, ... }`.
- Risks: CI security job still depends on OpenGrep install script availability at runtime.
- Next: Start T-014 performance budget targets.
- Blockers: none

## [2026-02-23T17:25:00Z] CopilotAgent | T-014
- Status: done
- Summary: Added low-cost performance benchmark framework with explicit local/CI budgets and non-frequent CI trigger policy.
- Decisions: Kept perf workflow outside push/PR pipelines to protect GitHub Actions credits (`workflow_dispatch` + weekly schedule only), and set CI benchmark job to non-blocking initially.
- Files: scripts/perf-benchmark.mjs, perf/budget.json, .github/workflows/perf-budget.yml, package.json, README.md, docs/ai/04-executable-task-backlog.md, docs/ai/memory/AGENT_MEMORY.md
- Evidence: `pnpm --dir "e:\\dev\\github\\kilicasa-dev-intel" run test:all` passed; local perf benchmark command added as `pnpm perf:benchmark` and CI mode as `pnpm perf:benchmark:ci`.
- Risks: Initial thresholds are baseline targets and may need tuning after observing a few weekly CI runs.
- Next: Proceed to T-015 hardening (secret exclusions and tool trust boundaries).
- Blockers: none

## [2026-02-23T17:33:00Z] CopilotAgent | T-014-VERIFY
- Status: done
- Summary: Fixed cross-platform command execution in perf benchmark script and validated successful local run.
- Decisions: Replaced nested `pnpm` process spawning with direct Node executable invocations for benchmark scenarios.
- Files: scripts/perf-benchmark.mjs, docs/ai/memory/AGENT_MEMORY.md
- Evidence: `node ./scripts/perf-benchmark.mjs --mode=local --iterations=1` returned `{ "ok": true, ... }`; `pnpm --dir "e:\\dev\\github\\kilicasa-dev-intel" run test:all` passed (`8` test files / `23` tests).
- Risks: Single-iteration sample is a smoke-level check; weekly CI runs will provide trend stability.
- Next: Proceed to T-015 hardening.
- Blockers: none
