#!/usr/bin/env bash
set -euo pipefail

echo "[bootstrap] validating workspace"

required_paths=(
  "docs/ai/00-context.md"
  "docs/ai/01-target-architecture.md"
  "docs/ai/03-shared-memory-protocol.md"
  "docs/ai/04-executable-task-backlog.md"
  "docs/ai/memory/AGENT_MEMORY.md"
)

for path in "${required_paths[@]}"; do
  if [[ ! -f "$path" ]]; then
    echo "Missing required file: $path" >&2
    exit 1
  fi
done

dirs=(
  "services/code-intel-mcp/src"
  "services/indexer/src"
  "schemas/sqlite"
  "docker"
  "scripts"
  "docs/ai/templates"
)

for dir in "${dirs[@]}"; do
  mkdir -p "$dir"
done

echo "[bootstrap] done"
