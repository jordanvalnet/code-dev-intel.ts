# AGENTS.md

Instructions for AI coding agents working on this repository. They restate `CONTRIBUTING.md` and `docs/ai/03-shared-memory-protocol.md` for agents: if this file and those two ever disagree, those two win and this file gets fixed.

## What this repository is

`code-dev-intel.ts` is the `code-intel` MCP server and its npm package: semantic navigation over TypeScript and JavaScript code (references, definitions, callers, module graph, structural search), licensed AGPL-3.0. The default branch is `main`.

## This repository is public

Everything committed or posted here is public and has to stand on its own: code, docs, the shared memory, the changelog, commit messages, pull requests and review comments. None of them ever contains:

- personal data: people's names, e-mail addresses, usernames or account identifiers, beyond the public author and repository URLs already in `package.json`;
- details of a developer's machine: absolute local paths, home or clone directory names, hostnames, hardware, local configuration (git, shell, editor, security software), other checkouts on the same machine;
- references to private repositories, organisations, projects, tickets or URLs, including the projects that use this package;
- secrets, tokens, keys, or values from a local `.env`.

Evidence names the command, the operating system, the Node version and the result, for example "`pnpm test` on Windows, Node 24: 25 files / 338 tests passed". It never says whose machine ran it or how that machine is set up.

## Hard rules

1. **One backlog task at a time, in order** (`docs/ai/04-executable-task-backlog.md`). Work that is not in the backlog gets its `T-0NN` entry first.
2. **Every task event appends one entry** to `docs/ai/memory/AGENT_MEMORY.md`, in the strict format of `docs/ai/03-shared-memory-protocol.md` (template: `docs/ai/templates/memory-entry-template.md`). The file is append-only, and the timestamp is the real UTC time the entry is written.
3. **A pull request description cites the task ID, the entry's UTC timestamp and the memory file**: `T-0NN`, `YYYY-MM-DDTHH:mm:ssZ` and `docs/ai/memory/AGENT_MEMORY.md`. The `pr-memory-reference` workflow fails when any of the three is missing. Template: `docs/ai/templates/pr-template.md`.
4. **`pnpm` only**, never `npm` or `yarn`.
5. **Nothing is done without evidence**: `pnpm lint`, `pnpm type-check` and `pnpm test` pass, and the commands with their results go into the memory entry.

## Git

One short-lived branch per task (`task/T-0NN-short-name`) and one pull request per task, against `main`. CI runs on Ubuntu, Windows and macOS (`.github/workflows/ci.yml`).

## Commands

Developing on this repository needs Node 22.12 or later (vitest 5, `node --experimental-strip-types`). The compiled package needs Node 20 or later.

| Command | What it does |
| --- | --- |
| `pnpm lint`, `pnpm type-check`, `pnpm test` | The three mandatory gates (`pnpm test:all` runs them in sequence) |
| `pnpm build` | Compiles `dist/` (`prepack` runs it too) |
| `pnpm mcp:start`, `pnpm mcp:self-test` | Starts the server from the sources, or checks that it boots and answers |
| `pnpm indexer:smoke` | Smoke test of the indexer |
| `pnpm release:smoke` | Installs a packed tarball into a throwaway project and drives the installed server |
| `pnpm security:scan` | Opengrep scan with the rules in `security/` |

## Where to find what

| Question | Where |
| --- | --- |
| Installing and using the package | `README.md`, `services/code-intel-mcp/README.md` |
| Context and target architecture | `docs/ai/00-context.md`, `docs/ai/01-target-architecture.md` |
| Agent orchestration and prompts | `docs/ai/02-agent-orchestration.md`, `docs/ai/05-agent-prompts.md` |
| What was done and decided, task by task | `docs/ai/memory/AGENT_MEMORY.md`, `CHANGELOG.md` |
