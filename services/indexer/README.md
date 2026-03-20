# indexer

Purpose: incremental indexing pipeline for local workspace intelligence.

Planned responsibilities:
- file change detection
- symbol/import extraction
- sqlite updates
- index run metadata

Current status:
- T-003 implemented for `git-diff` and `watch` modes in `src/change-detector.ts` and `src/indexer-runner.ts`.
- T-011 implemented for `impacted` mode in `src/impacted-files-engine.ts` + `src/indexer-runner.ts`.

Quick validation command:

```bash
node --experimental-strip-types ./services/indexer/src/indexer-runner.ts --mode=git-diff --baseRef=HEAD
```

Impacted files command:

```bash
node --experimental-strip-types ./services/indexer/src/indexer-runner.ts --mode=impacted --changed=src/a.ts,src/b.ts
```

Optional symbol-scoped impact (per file):

```bash
node --experimental-strip-types ./services/indexer/src/indexer-runner.ts --mode=impacted --changed=src/a.ts --changedSymbols=src/a.ts:foo,bar
```
