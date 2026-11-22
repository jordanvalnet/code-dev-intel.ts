# 03 - Shared Memory Protocol (Mandatory)

## Purpose

Enable coordination across multiple AI agents without losing state.

Primary memory file:
- `docs/ai/memory/AGENT_MEMORY.md`

## Rules

1. Append-only updates.
2. Never delete prior entries. The one permitted edit to a past entry is a redaction under "Public repository" below, and the entry that makes it says what was redacted and why.
3. One entry per completed or blocked task event.
4. UTC timestamp required: the real time the entry is written, never a rounded or invented one.
5. Include touched files and next action.
6. Nothing the "Public repository" section forbids.

## Public repository

This repository is public. `AGENT_MEMORY.md`, `CHANGELOG.md`, commit messages and pull request descriptions are published with it and must stand on their own. They never contain:

- personal data: people's names, e-mail addresses, usernames or account identifiers;
- details of a developer's machine: absolute local paths, home or clone directory names, hostnames, hardware, local configuration (git, shell, editor, security software), other checkouts on the same machine;
- references to private repositories, organisations, projects, tickets or URLs, including the projects that use this package;
- secrets, tokens, keys, or values from a local `.env`.

Evidence records the command, the operating system, the Node version and the result, never whose machine ran it or how that machine is set up.

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
