# SQLite schema migrations

## Strategy

- Migration files are ordered with numeric prefixes:
  - `001_initial.sql`
  - `002_*.sql`
  - etc.
- Migrations are append-only. Never rewrite applied migrations.
- Breaking changes must be done via additive migration + data backfill + cleanup migration.

## Local apply options

### Option A (Node smoke script)

Run:

```bash
node ./scripts/sqlite-smoke.mjs
```

This script creates a temporary local database, applies `001_initial.sql`, performs sample inserts and runs validation queries.

### Option B (sqlite3 CLI)

```bash
sqlite3 ./tmp-dev-intel.sqlite ".read ./schemas/sqlite/001_initial.sql"
sqlite3 ./tmp-dev-intel.sqlite ".tables"
```

## Conventions

- Table names use snake_case.
- FK constraints are mandatory when relationally applicable.
- Add indexes for primary query patterns.
