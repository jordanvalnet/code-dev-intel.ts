# Contributing

## Workflow

- Follow `docs/ai/04-executable-task-backlog.md` in order.
- Respect shared memory protocol in `docs/ai/03-shared-memory-protocol.md`.
- Every task event must append to `docs/ai/memory/AGENT_MEMORY.md`.
- Use `pnpm` only. `npm` and `yarn` are not allowed in this repository.

## Branching

- Use short-lived branches: `task/T-00X-short-name`.
- One task per branch and pull request.

## Definition of done

1. Acceptance criteria from backlog met.
2. Evidence collected (commands + outputs).
3. Shared memory updated.
4. Next handoff action written.
5. Mandatory quality gates pass: `pnpm lint`, `pnpm type-check`, and `pnpm test`.
