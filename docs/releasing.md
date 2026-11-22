# Releasing and security patches

Releases are published to npm by `.github/workflows/publish.yml`, with npm trusted publishing (OIDC) and a provenance attestation, once a maintainer has approved the run. Nobody publishes from a workstation, and no npm token exists for this package.

## Cutting a release

1. `[Unreleased]` in `CHANGELOG.md` lists what the release contains. The version follows from it: a patch for fixes only, including security fixes that change no behaviour; a minor release for additions, and, while the package is `0.x`, for breaking changes.
2. On `main`, commit `release: vX.Y.Z — <summary>`. That commit sets `version` in `package.json`, moves the `[Unreleased]` entries under a new `## X.Y.Z - YYYY-MM-DD` heading, and leaves `## [Unreleased]` empty above it.
3. Once CI is green on that commit, tag it and push the tag:

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

4. `publish` runs. Its `verify` job holds no credential and stops the release when any of these fails:
   - the tag is `v` + the `package.json` version;
   - the tagged commit is on `main`;
   - `CHANGELOG.md` has a `## X.Y.Z - ` section and nothing under `[Unreleased]`, which would otherwise ship unannounced;
   - the version is not on npm yet;
   - `pnpm install --frozen-lockfile`, `pnpm audit signatures` (registry signatures of every installed package) and `pnpm audit --prod --audit-level=moderate` pass;
   - `pnpm ci:quality` passes;
   - the tarball `pnpm pack` produces installs into a throwaway project and the installed server answers (`scripts/release-smoke.mjs`).
5. The `publish` job then waits in the `npm` environment. GitHub notifies the reviewer by e-mail and in GitHub Mobile, and **one approval publishes**: approve from the GitHub Mobile notification, or click "Review deployments", then "Approve and deploy", on the run page. The job checks the downloaded tarball against the SHA-256 that `verify` recorded, then publishes it with `pnpm publish --provenance`.
6. `latest` only moves forward. A version lower than the current `latest`, such as a fix for an older line, is published under `release-MAJOR.MINOR`.

A failed run is retried with "Re-run failed jobs", which keeps the same tag and commit. Moving a tag that has already been pushed is never the fix.

## One-time setup

These are maintainer settings, outside the repository.

- **npm**, package `code-dev-intel.ts`: add a trusted publisher. Choose GitHub Actions, repository `jordanvalnet/code-dev-intel.ts`, workflow `publish.yml`, environment `npm`. Every field must match exactly. Use the package settings page, or npm 11.15 or later, which asks for a second factor:

  ```bash
  npm trust github code-dev-intel.ts --repo jordanvalnet/code-dev-intel.ts --file publish.yml --env npm --allow-publish
  ```

  A new trusted publisher that has not published within two days expires. Once a release has gone through, set "Publishing access" to "Require two-factor authentication and disallow tokens", then revoke the publish tokens that are left.
- **GitHub**, environment `npm`: the maintainer is a required reviewer, the deployment policy allows tags matching `v*` only, and self-review is allowed, because the maintainer who pushes a tag is also the one who approves it.

## `pnpm security:patch`

The weekly `security-hardening` run notices a new advisory. This command fixes the advisories that need no judgement call, proves the repository still works, and records the change. It works on the current checkout and needs its dependencies installed.

### What it does

1. `pnpm audit --json`. If nothing is reported, it stops there.
2. `pnpm audit --fix update` re-resolves the lockfile within the declared ranges. pnpm also raises the range of each affected **direct** dependency to the version it picked. For a dependency a consumer installs, that raised floor is what stops a consumer from resolving the vulnerable version again.
3. If every advisory left is in a **transitive development** dependency, `pnpm audit --fix override` adds overrides to `pnpm-workspace.yaml`. An override only affects this repository's own install and does not travel with the package, so it is never used for anything a consumer installs or for a direct dependency. pnpm cannot apply overrides selectively, so a single advisory outside that case leaves all of them to a person.
4. Gates: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm build`. It stops at the first failure and records nothing.
5. Records, unless `--no-record` is passed:
   - It appends an entry to `docs/ai/memory/AGENT_MEMORY.md` under `T-025`, with the audit before and after and the gate results.
   - When a range a consumer installs from (`dependencies`, `optionalDependencies`, `peerDependencies`) changed and `[Unreleased]` is empty, it makes a patch release: the version is bumped in `package.json`, and a `## X.Y.Z - date` section lists each fixed advisory.
   - When `[Unreleased]` already holds changes, it does not choose their version. It adds the lines under `[Unreleased]` / `### Security` and reports that a person has to cut the release.
   - A change nothing consumes, such as the lockfile or a development range, does not appear in the changelog, which describes the package.
   - With `--pr-body=<file>`, it also writes a pull request description that satisfies `pr-memory-reference`.

pnpm's `minimumReleaseAge` (24 hours) applies: a patched version published less than a day ago is picked up by the next run, not this one.

### Options

| Option | Effect |
| --- | --- |
| `--check` | Audit only; change nothing |
| `--no-overrides` | Skip step 3 |
| `--no-record` | Fix and verify, but write no record |
| `--no-verify` | Skip the gates. Implies `--no-record`: nothing is recorded without evidence |
| `--pr-body=<file>` | Write the pull request description to `<file>` |
| `--task=T-0NN` | Task ID of the record (default `T-025`) |
| `--agent=<name>` | Author name of the record (default `security-patch`) |

### Report and exit code

stdout carries one JSON report and nothing else. It holds package names, versions, advisory identifiers and URLs, and repository-relative file names, so it can be posted as it is. The pull request description written by `--pr-body` and the memory entry hold the same kind of data, plus the operating system and Node version of the gates, and no local path either. Command output goes to stderr, which can contain local paths and must not be posted.

| `status` | Meaning |
| --- | --- |
| `clean` | `pnpm audit` reports nothing |
| `vulnerable` | `--check` found advisories |
| `patched` | Every advisory is fixed and the gates pass |
| `partial` | Some advisories are fixed and the gates pass; `advisoriesAfter` lists the rest |
| `unresolved` | Nothing could be fixed without a judgement call; nothing was written |
| `gates-failed` | A gate failed after the fix; nothing was recorded, and the files are left as the fix wrote them |

The other fields:
- `changedFiles` is what to commit.
- `commitMessage` and `prTitle` describe the change.
- `lockfileOnly` is true when, among `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml`, only the lockfile changed.
- `consumerImpact` is true when a shipped range changed.
- `release` is `{ needed, version, blockedBy }`.
- `needsHuman` is true when something is left for a person: advisories still open, a failed gate, or a release that `[Unreleased]` blocks.

The exit code is `0` when there is nothing left to do (`clean`, or `patched` with no person needed), `2` when the report needs attention, and `1` on an error, such as a registry that cannot be reached or output that cannot be read. `--check` therefore exits `0` on a clean audit and `2` when it finds an advisory (`vulnerable`), so it works on its own as a detection step.

### Running it unattended

A caller that runs it on a schedule follows these steps:

1. Work in a fresh clone of `main`, run `pnpm install --frozen-lockfile`, then run `pnpm security:patch --pr-body=<file>`.
2. Commit `changedFiles` with `commitMessage`, and open a pull request titled `prTitle` with that body. `lockfileOnly: true` is the only case where merging without review is considered safe: nothing a consumer installs changes.
3. When `release.version` is set, push the tag `v<version>` on the merged commit. A lightweight tag, such as one created through the GitHub API, is accepted like an annotated one: `verify` checks the commit the tag points to, not the tag object. `publish.yml` then waits for the maintainer's approval as described above.
4. Never post stderr, and never post a failure's command output anywhere public.
