# 02 - Multi-agent Orchestration (VS Code + Copilot)

## Recommended model

Use a **hub-and-spoke** setup:
- 1 orchestrator agent
- N specialist agents

Why:
- lower conflict risk,
- better task sequencing,
- easier quality control.

## Roles

### Orchestrator

Responsibilities:
- maintain global plan,
- assign tasks,
- enforce memory updates,
- validate cross-task consistency.

Suggested model:
- GPT-5.3-Codex (implementation orchestration)

### Specialist agents

1. `indexing-agent`
   - incremental indexing, SQLite schema, perf tuning
2. `mcp-agent`
   - MCP server, tool contracts, response shape
3. `devops-agent`
   - Docker compose/profiles, scripts, health checks
4. `security-agent`
   - OpenGrep rules, CI security gates, threat checks
5. `docs-agent`
   - runbooks, troubleshooting, onboarding docs

## Working mode

- Small tasks, short-lived branches.
- One task = one measurable outcome.
- Mandatory handoff in shared memory file after each task.
- PR template must include: scope, test evidence, risk notes.

## Conflict prevention

- Orchestrator declares ownership per task area.
- Specialists do not edit shared contracts without lock.
- Shared memory is append-only (no rewriting history).

## Suggested prompting mode by model

- GPT-5.3-Codex: instruct mode (precise implementation commands)
- Claude 3.6: reflection mode (architecture and risk reviews)
- Gemini 3.1 Pro: reflection mode (alternative designs/perf audits)
