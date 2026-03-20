# 03 - Shared Memory Protocol (Mandatory)

## Purpose

Enable coordination across multiple AI agents without losing state.

Primary memory file:
- `docs/ai/memory/AGENT_MEMORY.md`

## Rules

1. Append-only updates.
2. Never delete prior entries.
3. One entry per completed or blocked task event.
4. UTC timestamp required.
5. Include touched files and next action.

## Entry format (strict)

```md
## [YYYY-MM-DDTHH:mm:ssZ] AgentName | Task-ID
- Status: done | in-progress | blocked
- Summary: <what was done>
- Decisions: <important choices>
- Files: <file list>
- Evidence: <tests/commands/results>
- Risks: <known risks, if any>
- Next: <single next action>
- Blockers: <none | details>
```

## Lock protocol (soft lock)

Before modifying shared contracts (API schema, DB schema, compose files):
- add lock marker in memory file header section:
  - `LOCK: <AgentName> | <Task-ID> | <start timestamp>`
- remove lock marker after completion.

If lock is older than 2 hours with no update:
- orchestrator may reassign and record override decision.

## Quality gates before marking done

- Output is reproducible.
- `pnpm lint` passes.
- `pnpm type-check` passes.
- `pnpm test` passes.
- Acceptance criteria met.
- Memory entry added.
- PR description references memory entry with `Task-ID`, UTC timestamp, and `docs/ai/memory/AGENT_MEMORY.md`.
- No unresolved blocker hidden.
