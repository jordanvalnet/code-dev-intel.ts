# Contributing

## Workflow

- Follow `docs/ai/04-executable-task-backlog.md` in order.
- Respect shared memory protocol in `docs/ai/03-shared-memory-protocol.md`.
- Every task event must append to `docs/ai/memory/AGENT_MEMORY.md`.
- Every pull request description cites the task ID, the memory entry's UTC timestamp and `docs/ai/memory/AGENT_MEMORY.md`; the `pr-memory-reference` workflow checks all three.
- Use `pnpm` only. `npm` and `yarn` are not allowed in this repository.

## Public repository

This repository is public, and so is everything posted to it. Code, docs, the shared memory, the changelog, commit messages and pull request descriptions never contain personal data, details of a developer's machine (local paths, directory names, hostnames, local configuration) or references to private repositories, projects or tickets. The full rule is in `docs/ai/03-shared-memory-protocol.md`.

## Branching

- Use short-lived branches: `task/T-00X-short-name`.
- One task per branch and pull request.

## Releases

A release is a `release: vX.Y.Z — …` commit on `main` and a pushed `vX.Y.Z` tag. `.github/workflows/publish.yml` publishes it once a maintainer approves the run, and nobody runs `pnpm publish` by hand. The procedure, and `pnpm security:patch` for dependency advisories, are in `docs/releasing.md`.

## Definition of done

1. Acceptance criteria from backlog met.
2. Evidence collected (commands + outputs).
3. Shared memory updated.
4. Next handoff action written.
5. Mandatory quality gates pass: `pnpm lint`, `pnpm type-check`, and `pnpm test`.
