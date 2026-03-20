# 01 - Target Architecture (Local-first, Self-hosted)

## Design principles

- Keep always-on services minimal.
- Favor incremental/index-on-change over heavy full scans.
- Prefer precise symbolic data (LSP/SCIP) for agent decisions.
- Keep optional heavy analyzers off local dev hot path.

## Core components

### A. Agent Query Layer

`code-intel-mcp` (Node service) exposing tools:
- `findSymbol`
- `findDefinitions`
- `findReferences`
- `findCallers`
- `findCallees`
- `searchStruct` (AST)
- `searchText`
- `impactedFiles`

This is the single entry point for AI agents.

### B. Precision Engine (symbolic)

- TypeScript language intelligence via `tsserver`/LSP.
- Optional periodic SCIP generation (`scip-typescript`) for persisted snapshots.

### C. Structural Search Engine

- `ast-grep` for syntax-aware queries/codemods.

### D. Fast Text Search

- `ripgrep` + `fd` for cheap fallback and broad search.

### E. Lightweight Relationship Store

- `SQLite` local DB per workspace.
- Tables: symbols, references, imports graph, files metadata, index runs.

### F. Optional Search Acceleration

- `Zoekt` via Docker profile (`on-demand`, not default always-on).

### G. Security Gates

- `OpenGrep` locally (pre-commit/PR checks).
- `CodeQL` in CI or optional VPS runner only.

## Resource profile strategy

Default mode (recommended on 16GB):
- Always-on: MCP + SQLite + tsserver reuse.
- On-demand: ast-grep scans, OpenGrep full scan, Zoekt index.
- CI-only: CodeQL.

## Data flow

1. File change detected.
2. Incremental index pipeline updates symbol/import metadata.
3. MCP tools query cached graph first.
4. Missing precision details are resolved through LSP live query.
5. Agent receives compact, actionable context.
