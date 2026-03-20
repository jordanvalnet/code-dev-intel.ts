# 06 - Bootstrap Execution Kit (T-001 to T-004)

## Objective

Provide exact commands, file targets, and acceptance checks for the first four tasks.

## Prerequisites

- Git
- Node.js >= 20
- pnpm >= 10
- Docker Desktop (optional for later tasks)

Policy:
- Use `pnpm` only.
- Do not use `npm` or `yarn` for install/run scripts.
- Before closing any task, run `pnpm test:all`.

## Quick start

From the repository root:

### Windows PowerShell

```powershell
Set-Location -LiteralPath "<repo-root>"
./scripts/bootstrap.ps1
```

### Bash

```bash
cd <repo-root>
bash ./scripts/bootstrap.sh
```

---

## T-001 - Bootstrap repo conventions

### Commands

```powershell
git checkout -b task/T-001-bootstrap-conventions
```

### Expected files

- `CONTRIBUTING.md`
- `docs/ai/03-shared-memory-protocol.md`
- `docs/ai/memory/AGENT_MEMORY.md`
- `docs/ai/templates/pr-template.md`

### Acceptance checks

- Contributing rules reference memory protocol.
- Shared memory file exists and is append-only.
- PR template includes memory update checkbox.

---

## T-002 - Implement SQLite schema for code intelligence

### Commands

```powershell
git checkout -b task/T-002-sqlite-schema
```

Optional local validation (if sqlite is installed):

```powershell
sqlite3 .\tmp-dev-intel.sqlite ".read .\schemas\sqlite\001_initial.sql"
sqlite3 .\tmp-dev-intel.sqlite ".tables"
```

### Target file

- `schemas/sqlite/001_initial.sql`

### Acceptance checks

- Tables exist: `files`, `symbols`, `references_map`, `imports_map`, `index_runs`.
- Primary and foreign keys are defined.
- Useful indexes are present.

---

## T-003 - Implement incremental file change detector

### Commands

```powershell
git checkout -b task/T-003-incremental-detector
```

### Target files

- `services/indexer/src/change-detector.ts`
- `services/indexer/src/indexer-runner.ts`

### Minimal behavior

- `--mode=git-diff`: list changed files from git.
- `--mode=watch`: detect changed files via watcher.
- Filter to relevant extensions (`.ts`, `.tsx`, `.js`, `.jsx`, `.json`).

### Acceptance checks

- Editing one file triggers targeted update list.
- No full-repo reindex on single-file change.

---

## T-004 - Implement MCP server skeleton

### Commands

```powershell
git checkout -b task/T-004-mcp-skeleton
```

### Target files

- `services/code-intel-mcp/src/server.ts`
- `services/code-intel-mcp/src/contracts.ts`

### Minimal behavior

- Start MCP server.
- Expose tool contracts for all planned tools.
- Return deterministic mock payloads.
- Provide health check endpoint/tool.

### Acceptance checks

- Server boots without runtime error.
- Every tool returns valid JSON payload.
- Contract file is single source of truth.

---

## Mandatory handoff step (all tasks)

After each task:
1. Append entry to `docs/ai/memory/AGENT_MEMORY.md`
2. Include commands + evidence
3. Add next action for next agent
