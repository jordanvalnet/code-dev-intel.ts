# 00 - Context

## Target project profile

- Product repo: `<target-typescript-project-root>` (a private consumer repository, outside this package)
- Tech stack: Next.js / React / TypeScript, pnpm, Vitest
- Architecture: hexagonal (domain/application/adapters/infrastructure/presentation)

## Problem to solve

AI agents lose time and context by repeatedly:
- searching with basic grep/glob,
- opening many files,
- recomputing symbol relationships.

Expected outcome:
- persistent local code intelligence,
- precise symbol/function/file relationship access,
- faster and more reliable agent interventions.

## Non-functional constraints

- 100% self-hosted.
- Local-first for each developer (branch-aware, workspace-aware).
- Must run on common dev machines (16GB RAM already loaded by VS Code, Docker, local services, browser).
- Priorities:
  1) Agent effectiveness + code quality
  2) Precision over raw speed
  3) Security with no major risk

## Scope boundaries (phase 1)

In scope:
- local indexing and query APIs for agents,
- incremental updates,
- shared conventions for multi-agent work,
- Dockerized optional services.

Out of scope:
- cloud SaaS dependencies,
- full enterprise SAST platform migration,
- replacing existing CI/CD entirely.
