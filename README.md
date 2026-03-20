# code-dev-intel

Self-hosted AI code intelligence stack for TypeScript projects.

## Goal

Provide AI agents with IDE-grade code understanding (symbols, references, impact analysis, structured queries) without scanning the whole codebase every time.

Constraints:
- 100% self-hosted
- Local-first for each developer
- Keep resource usage reasonable on 16GB machines
- Docker-first where possible

## Docs index

- `docs/ai/00-context.md`
- `docs/ai/01-target-architecture.md`
- `docs/ai/02-agent-orchestration.md`
- `docs/ai/03-shared-memory-protocol.md`
- `docs/ai/04-executable-task-backlog.md`
- `docs/ai/05-agent-prompts.md`
- `docs/ai/06-bootstrap-execution-kit.md`
- `docs/ai/memory/AGENT_MEMORY.md`

## First run

1. Read context and architecture docs.
2. Follow task backlog in order.
3. Every agent must update `docs/ai/memory/AGENT_MEMORY.md` after each task.

## Docker quick start

- Core only (recommended): `pnpm docker:core:up`
- Core + optional search helpers: `pnpm docker:all:up`
- Core + Zoekt webserver (optional): `pnpm docker:zoekt:up`
- Build Zoekt index (on-demand): `pnpm docker:zoekt:index`
- Stop containers: `pnpm docker:all:down`

See `docker/README.md` for details.

### MCP server in Docker (recommended for local isolation)

```bash
pnpm docker:core:up
curl http://127.0.0.1:4545/health
```

Stop:

```bash
pnpm docker:core:down
```

## Sub-README index

- [services/code-intel-mcp/README.md](services/code-intel-mcp/README.md) - MCP server setup, startup flags, endpoints, and TypeScript integration guidance.
- [services/indexer/README.md](services/indexer/README.md) - Incremental indexer modes (`git-diff`, `watch`, `impacted`) and validation commands.
- [docker/README.md](docker/README.md) - Docker profiles (`core`, `search-optional`, `zoekt-optional`) and resource considerations.

## Security baseline

- Run local security scan: `pnpm security:scan`
- Baseline rules: `security/opengrep-rules.yml`
- Optional override if OpenGrep is installed outside PATH: set `OPENGREP_BIN` to the full binary path
- Common install-script path: `~/.opengrep/cli/latest/opengrep`

## CI baseline

- Consolidated CI workflow: `.github/workflows/ci.yml`
- Local indexer smoke command: `pnpm indexer:smoke`

## Performance budget (low-cost)

- Budget config: `perf/budget.json`
- Local benchmark: `pnpm perf:benchmark`
- CI benchmark workflow: `.github/workflows/perf-budget.yml`
- Trigger policy: manual (`workflow_dispatch`) + weekly schedule only (no push/PR trigger)
