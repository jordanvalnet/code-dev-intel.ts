$ErrorActionPreference = 'Stop'

Write-Host '[bootstrap] validating workspace'

$requiredPaths = @(
  'docs/ai/00-context.md',
  'docs/ai/01-target-architecture.md',
  'docs/ai/03-shared-memory-protocol.md',
  'docs/ai/04-executable-task-backlog.md',
  'docs/ai/memory/AGENT_MEMORY.md'
)

foreach ($path in $requiredPaths) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Missing required file: $path"
  }
}

$dirs = @(
  'services/code-intel-mcp/src',
  'services/indexer/src',
  'schemas/sqlite',
  'docker',
  'scripts',
  'docs/ai/templates'
)

foreach ($dir in $dirs) {
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir | Out-Null
    Write-Host "[bootstrap] created $dir"
  }
}

Write-Host '[bootstrap] done'
