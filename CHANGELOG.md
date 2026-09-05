# Changelog

All notable changes to this package are documented in this file.

## 0.5.0 - 2026-09-04

### Added

- **`dependencyGraph` and `impactedFiles` now resolve modules with TypeScript's own resolver, from the nearest project config.** Until 0.4.0 both engines followed relative specifiers only, so on a codebase that imports through `@/domain/ports/Port` — the norm in a Next.js-shaped app — every alias was reported as an external dependency and the two tools returned an almost empty graph. Resolution now goes through `ts.resolveModuleName` (with a `ts.createModuleResolutionCache` per project) using the options of the **nearest** `tsconfig.json`, else `jsconfig.json`, walking up from the importing file to the workspace root — not only the root config, which is what a monorepo with per-package projects actually needs.
  - **What that covers:** `compilerOptions.paths` and `baseUrl` with TypeScript's own precedence, `extends` chains, comments and trailing commas in the config, package `main` / `exports` and directory imports, index files, declaration-only modules (`foo.d.ts`, `index.d.ts`), the `.js` → `.ts` specifier mapping, the whole `.mts` / `.cts` / `.mjs` / `.cjs` family including `.d.mts` / `.d.cts` — and **workspace packages symlinked into `node_modules`**, which now come back as the real file inside the workspace instead of as an external package.
  - **Emit rules never hide a dependency.** `allowJs` and `allowImportingTsExtensions` are forced on, and `classic` resolution — a legacy mode that ignores `node_modules` entirely — is upgraded to `bundler`: this tool indexes files rather than emitting them, so a `.js` neighbour, a `./x.mts` specifier and a workspace package linked into `node_modules` are real dependencies whatever `tsc` would say about emitting them.
  - **Root-config fallback.** When a nested project redefines `paths` without re-declaring an alias the root config maps, the root config is tried before the specifier is given up on, so those edges survive instead of vanishing (160 of them on the synthetic workspace below; losing an edge in silence is the failure mode this release exists to end).
  - **Sandbox consistency.** A specifier that resolves to a file outside `workspaceRoot` is still never followed, and is now *reported* as `outside-workspace` instead of being quietly relabelled external.
  - **Caching.** Every config a workspace contains is parsed once and invalidated on the *content* of the config file **and** every file in its `extends` chain, so a long-lived server picks up an edit to a nested project as well as to the root one. Each resolution pass creates one resolver, whose module-resolution caches, workspace-boundary verdicts and per-question memo are a snapshot of the workspace for the duration of that pass. That memo — keyed by the importing file's directory and extension plus the specifier, which is everything resolution depends on — collapsed 27,420 specifier lookups into 7,699 distinct questions on the synthetic workspace below, for 20% off every resolution pass.
  - The extensions the workspace walkers, the symbol tools, `searchText`'s node engine, the duplicate scanner and the change detector consider source code all gained `.mts` / `.cts` / `.mjs` / `.cjs`.

- **One module-graph extractor, shared by both tools, over a single parse per file.** `impactedFiles` read imports off the parse tree and exports off a regex; `dependencyGraph` used `ts.preProcessFile`, which never sees `export * as ns from`. Two extractors meant the two tools could disagree about the same repository, and a test now pins that they cannot. `services/indexer/src/module-graph-extractor.ts` reads, from one `ts.createSourceFile` pass:
  - **Imports:** default / named / namespace / type-only clauses and inline `type` modifiers, side-effect `import 'x'`, `export … from`, `export * from`, `export * as ns from`, `import x = require('x')`, and `import()` / `require()` calls with a string-literal argument **anywhere in the file** — inside a closure, a class method or a `declare module` body — where before only top-level statements counted.
  - **`import()` in a type position** — `type X = import('./m').Y`, `typeof import('./m')`, a generic argument, a mapped type, a return type, a `declare module` or `declare global` member — and JSDoc `@type {import('./m').T}` in JavaScript files, where JSDoc *is* the type system. (In a `.ts` file the checker ignores JSDoc types, so neither does the extractor: following one would invent an edge `tsc` does not have.) A dependency named only in a type position still breaks when its target moves, and the file still has to be re-checked when the target changes. `impactedFiles` never saw these at all; `dependencyGraph` had seen them through `ts.preProcessFile` and lost them when the two tools were unified, and both now report the edge with the imported name (`import('./m').Outer.Inner` records `Outer`, the export it actually reaches into).
  - **Exports, from the AST instead of a regex:** declarations (including `export const { a, b } = …` destructuring), export lists with aliases, `export default`, `export =`, re-exports and `export type { }`. The regex counted a commented-out export, an export inside a string literal and a name exported from inside a `namespace` body as module exports, and missed `export async function` entirely — and those names fed `impactedFiles`' changed-symbol filter. On this repository it reported 283 exported names where the parse tree has 188: 104 it had invented (fixture strings and comments in the test suite, one of them the literal `...` out of the phrase "export { ... } from") and 9 real ones it had never seen. Differentially tested against `checker.getExportsOfModule` over all 70 module files of this repository: 0 names missed, 0 surplus.

- **Both tools now report what they could not resolve instead of dropping it.** A silently incomplete answer is a false answer: an agent cannot tell a file with no importers from a file whose importers the graph failed to follow. `dependencyGraph` results gained `unresolved` (up to 20 entries of `{ from, specifier, reason }`) and `unresolvedCount`; `impactedFiles` results gained `unresolvedCount` and `unresolvedSample` (up to 10, counted across the whole workspace, because any of them could have been a missing importer). The reasons:
  - `not-found` — a specifier that names a file and finds none. That covers relative, absolute, `#`-prefixed and alias-shaped specifiers, and also **`baseUrl`-shaped** ones: `billing/invoice` is spelled exactly like a package subpath, so the filesystem decides — when `billing/` exists under `baseUrl` it is a workspace file, and a deleted module there is a lost edge rather than an uninstalled package.
  - `unsupported-file-type` — the file is **there**, and this graph does not read that kind: `./Widget.vue`, `./Panel.svelte`, `./engine.wasm`. Calling those "not found" is a false statement, and on a component-per-file codebase it fills the report ahead of real breakage.
  - `outside-workspace` — the target exists but resolves outside `workspaceRoot`; it is never followed and never read.
  - `dynamic-specifier` — a non-literal `import()` / `require()` argument, e.g. ``import(`./locales/${lang}`)``, quoted back as source text (whitespace-collapsed, capped at 80 characters).

  Packages and `node:` builtins are external dependencies, never "unresolved", so `unresolvedCount: 0` means the graph is complete. `/tools/describe` and the MCP `tools/list` descriptions state the contract, since those are the strings a client puts in front of the model.

- **Imported non-code files are part of the graph** — new `includeAssets` option on both tools, **default `true`**. A component that imports `./Button.module.css`, `@shared/icons/logo.svg` or `./fixtures/regions.json` depends on those files, and changing one changes the component. Both tools now say so.
  - **Extensions:** `.css .scss .sass .less .json .svg .png .jpg .jpeg .gif .webp .avif .woff .woff2 .graphql .gql .md .txt .yaml .yml`, defined once and spelled out in the `/tools/describe` option description, since the answer is only predictable if the caller knows the list. Only the last extension counts, so `Button.module.css` is a `.css` asset.
  - **Resolved by exact filename, and nothing else.** No extension guessing, no directory index, no `node_modules` walk: `./button.css` resolves if and only if that file exists. `compilerOptions.paths` and `baseUrl` are substituted (TypeScript's own precedence — exact key first, then longest matching prefix) and a bundler query suffix is ignored (`./logo.svg?react` resolves `logo.svg`), but every candidate still has to be a file on disk, so the graph cannot invent an asset edge. One extension *is* appended: `.json`, the only one Node's own loader and every bundler add by themselves, so `./data/fixture` finds `fixture.json` — a real dependency that was otherwise reported as broken, while `./button` still never finds `button.css`.
  - **Always a leaf.** Assets are never read and never parsed, so they are never a source of edges and never appear in the workspace graph's file list. A `.md` file whose fenced examples contain `import` statements contributes nothing — and `dependencyGraph` rooted at an asset answers with an empty graph rather than parsing it as code.
  - **Why the default is on.** With assets off, `impactedFiles` for a changed stylesheet answers with the stylesheet and nothing else — a confidently *wrong* answer, not merely a short one. On the synthetic workspace below: a changed shared icon returns 3,915 impacted files instead of 1, a changed co-located stylesheet 89 instead of 1, a changed JSON fixture 3,916 instead of 1. Before this release the behaviour was silently inconsistent — `.json` happened to resolve under `bundler` module resolution while every other asset did not, so the tool followed JSON fixtures and dropped stylesheets without saying which.
  - **The noise argument runs the other way.** Asset imports used to be reported as `not-found`: on a workspace with ~3,600 of them, `unresolvedCount` was **3,265**, burying the one genuinely broken import. It is now **327** — the 326 deliberately broken asset imports the generator plants, plus that one — so the completeness signal means something again. Payload cost of the default: **+0.6%** on an `impactedFiles` response for a code change (the impacted list is unchanged; assets have no outgoing edges, so they never enter a code-change answer), and **+21%** on a `dependencyGraph` response for a file that actually imports assets — or **+4%** against what 0.4.0-era code returned for that file, in exchange for 5 real dependencies replacing 4 false `not-found` entries.
  - **CPU cost of the default: none.** Cold build of the same workspace, alternating runs on the same machine: 4,097 ms before, **3,490 ms** now (0.85×). Resolving an asset by exact filename is *cheaper* than handing it to TypeScript's module resolution, which probes a dozen candidate paths per specifier and fails. `includeAssets: true` and `false` build in the same time — assets are resolved either way and the option filters the answer, so one cache serves both.
  - With `includeAssets: false` asset imports leave the unresolved report as well as the graph: the caller asked for a code graph, so a stylesheet the graph did not follow is not a gap in what they asked for. With assets on, an asset import that names no file *is* reported as `not-found`, because it is genuinely broken.
  - An asset target is never filtered out by `options.changedSymbolsByFile`: an asset has no exports, so there is no symbol for that filter to decide on, and a stylesheet that changed changed for everyone importing it.

- **The workspace module graph is cached per workspace root, for the life of the process.** `impactedFiles` rebuilt the whole graph on every call — seconds on a few thousand files, paid again for every question about the same unchanged repository. Each call now re-walks the directory tree (cheap, and the only way to see a file appear, vanish or move) and reuses everything the walk proves is still valid.
  - **Two layers, invalidated by different things.** A file's *parse* depends only on that file, and is kept while its `(mtime, size)` holds. A *resolution* depends on the whole workspace — a new `b.ts` can shadow the `b.js` a specifier used to reach, a deleted file turns an edge into a hole, an alias edit moves every aliased edge at once — so anything that changes the set of files (assets included) or the content of any `tsconfig.json` / `jsconfig.json` / `package.json` redoes all of them, while the parses survive untouched.
  - **Renames reuse the parse.** A rename arrives as one removal plus one addition carrying the same `(mtime, size, extension)`; the parse moves across instead of the file being read again. Only an unambiguous match is reused, and never one whose timestamp is too fresh to distinguish a rename from a codegen run that deleted one file and wrote a different one of the same length in the same tick.
  - **A just-written file is always re-read.** Filesystem timestamps are quantized: measured on the NTFS volume this was developed on, 200 rewrites of one file produced 60 distinct mtimes (ticks of 0.5–18.7 ms) and **358 of 500** same-length rewrites were indistinguishable from the previous content by `(mtime, size)` alone. An agent's normal loop — edit a file, immediately ask what it impacts — lands inside exactly that window, so any file whose recorded mtime is within 2 s of when it was cached is read again rather than trusted. That costs one re-parse per recently-touched file and never a wrong answer.
  - **Config fingerprints are content digests, not mtimes,** for the same reason: an alias edit that keeps a `tsconfig.json` the same length and lands in one tick would otherwise leave every aliased edge pointing at the old target. Configs are few and small, so hashing them costs nothing next to the resolution it guards.
  - **`dependencyGraph` shares the per-file parse cache** (same workspace root, same entries), so the two tools never parse the same file twice and still cannot disagree about it. Its BFS, its depth semantics and its results are unchanged.
  - **Bounded:** at most 50,000 tracked files across at most 16 workspace roots, least-recently-used roots evicted first, and a single workspace too large for the cap is not retained at all rather than kept as the sole resident.
  - **Measured** on the 4,000-file / 1,148-asset workspace (medians of three runs): cold **4,067 ms**; unchanged **180 ms** (22×); one file edited **221 ms** (18×); a file added 2,900 ms, deleted 2,817 ms, renamed 2,851 ms, an alias changed 2,802 ms, an asset added 2,847 ms (~1.4×, all of it the full re-resolution). On this repository: **273 ms cold, 7 ms warm**, against 119–129 ms for every call before. The directory walk is ~97% of a warm call (13 ms of `readdir` plus ~90 ms of 3,986 `stat` calls); assembling the file list, edge list, exports map, unresolved report and reverse index costs **2.5 ms**, of which the reverse index is **2.1 ms** for 17,954 edges — which is why it is rebuilt in full rather than maintained incrementally, a choice that could save at most 1% of a warm call in exchange for per-file bookkeeping that can go wrong.
  - **`dependencyGraph` got faster too:** 18–24 ms per call on this repository against 48–49 ms, for byte-identical results — most of the per-call cost 0.5.0 had added back over 0.4.0 is gone.

- **`impactedFiles`' changed-symbol filter now sees through a barrel, and is declared in the MCP input schema.** `options.changedSymbolsByFile` kept only the *direct* importers of a listed file: nothing carried the changed symbol past a re-export, so on any codebase with an `index.ts` the answer was silently truncated at the first hop while `unresolvedCount` still read 0. The filter now propagates.
  - **A re-export carries the change onwards by name.** `export * from './impl'` passes `foo` through as `foo`; `export { foo as publicFoo } from './impl'` passes it on as `publicFoo`; `export * as ns from './impl'` collapses the module into `ns`, so any change to it is a change to `ns`. A re-export that republishes a *different* symbol still keeps its consumers out of the answer, which is what makes the option worth using.
  - **Any other importer is opaque.** A file that uses a changed symbol in its own code may have changed in any way that static analysis here cannot narrow down, so from there on all of its exports count as changed. The unsound assumption — that an importer publishes nothing new — is exactly what truncated the set.
  - **A file listed in `changedFiles` with no entry counts as changed in full.** No list means the caller did not narrow it down, not that nothing in it changed.
  - **Modules whose exports cannot be read are never filtered out.** The filter used to require the changed symbol to appear in the target's parsed export list, so a CommonJS module (whose `module.exports` is not on the parse tree) dropped every importer, and *deleting* an export — the case where a blast radius matters most — matched nothing. Missing knowledge is not evidence that nothing matches.
  - `changedSymbolsByFile` is now declared in `/tools/describe` and in the MCP `tools/list` input schema. The schema is generated with `additionalProperties: false`, so an option a description tells the model to send but the schema omits is rejected by any client that validates arguments; a test now pins that every `options.X` a tool description mentions is a property that tool actually declares.

- **Measured on a 4,000-file synthetic workspace** (~23,500 specifiers; `paths` aliases with a more-specific pattern, a `baseUrl`, an `extends` chain, a nested project, `.mts`/`.cts` modules, directory imports through package `main`/`exports`, a workspace package symlinked into `node_modules`, declaration-only modules, and every import/export form above):
  - Edges found: **491 in 0.4.0 → 14,700**, exported names **7,457 → 7,950**, with **no edge and no export lost** against either earlier engine. That workspace is alias-heavy by construction, so read the ratio as an illustration of what alias-only and workspace-package codebases were losing, not as a general figure.
  - Cold `buildWorkspaceGraph`: **1.9 s in 0.4.0 → 3.2 s** (1.7×). Most of that increase is the parse per file that replaced the regex scan (~1.1 s); resolving through `ts.resolveModuleName`, walking the whole tree for `import()` / `require()` and collecting the unresolved report add ~0.25 s on top of it, and buy the 980 workspace-package and package-`main` edges an alias-only resolver cannot see.
  - `dependencyGraph` on this repository (which has no aliases and no workspace packages) returns exactly the same internal and external dependencies as 0.4.0. Resolving like the compiler instead of guessing cost ~50 ms per call against ~16 ms; the shared parse cache described below brings that back to 18–24 ms.

### Changed

- **`dependencyGraph` and `impactedFiles` are now one engine behind two questions.** They share a single module-graph extractor (one `ts.createSourceFile` parse per file, through one per-workspace parse cache), a single import resolver, one unresolved-report collector and one asset definition. Before this release `impactedFiles` read imports off the parse tree and exports off a regex while `dependencyGraph` used `ts.preProcessFile`, so the two tools could — and on `export * as ns from`, on multi-line statements and on anything the regex invented, did — answer differently about the same repository. They cannot any more, and a test asserts it directly: the internal edges `dependencyGraph` reports from a set of entry points are compared, edge for edge, against `buildWorkspaceGraph`'s edge set for the same files. Neither tool's request shape, defaults or result fields were removed; everything above is additive.
- **Canonical paths now carry the filesystem's own casing** (`fs.realpathSync.native`, falling back to the JavaScript implementation). This is what makes a mis-cased import join the graph rather than dangle — see *Fixed* below — and it applies to every path the workspace-boundary check canonicalizes.

### Fixed

- **A mis-cased import no longer erases its importer from every impact set.** On Windows and macOS `import './notifications/sender'` compiles and runs against `Sender.ts`, and the resolver used to answer with the *specifier's* spelling while the directory walk recorded the *file's* — two different strings for one file, so the edge pointed at a node no walk had ever produced. The importer then simply did not appear in `impactedFiles` for that file, with `unresolvedCount: 0` insisting the answer was complete. Targets are now canonicalized to their real on-disk name, and a test asserts the invariant that no internal edge points outside the walked file list.
- **A broken `baseUrl` import is no longer filed as an installed package.** In the classic "absolute imports from `src`" setup — `baseUrl` with no `paths` — a specifier like `billing/deleted` is spelled exactly like a package subpath, and anything TypeScript failed to resolve was classified `external` and left out of the report entirely. A workspace with three such imports reported `unresolvedCount: 1`. The first segment is now checked against `baseUrl`: `billing/` exists, so `billing/deleted` is a workspace file that is missing and is reported as `not-found`, while `some-lib` (nothing of that name under `baseUrl`) stays external.
- **A file that exists is no longer reported as missing.** `./Widget.vue`, `./Page.mdx`, `./engine.wasm` — files this graph does not read — came back as `not-found`, which is factually wrong and, on a component-per-file codebase, fills the 10- and 20-entry samples ahead of real breakage. They are now `unsupported-file-type`, so the count still signals a hole in the graph and the caller can tell which kind.
- **The CLI integration test no longer fails on its own timeout.** It spawns three `node --experimental-strip-types` processes, each of which type-strips the whole server graph before doing anything; on Windows that exceeded the suite's 15 s default about two runs in three (at `main` as well — it was not introduced here), so the release gate could not certify anything. The test now carries its own generous deadline, which exists to stop a hung process rather than to measure startup.

- **`impactedFiles` no longer ignored multi-line, type-only and re-export statements.** The module-graph extractor was a regex whose clause class excluded newlines, so every statement Prettier had wrapped across lines — the normal shape of an `import type { … }` list — produced no edge at all. On a formatted production codebase that is most of the graph: on a ~4,200-file Next.js-shaped codebase it found 13,440 edges where the parse tree has 15,294, and `impactedFiles` for a changed port answered *without* the adapters that implement it — the whole purpose of the tool. Imports and re-exports are now read off TypeScript's own parse tree, so all of these produce the right edge with the right symbols: multi-line and `import type { … }` lists, inline type modifiers (`{ type A, B }` → `A`, `B`), default-plus-named clauses (`D, { A }` → `default`, `A`), namespace imports and side-effect `import 'x'` (→ `*`), `export { a, b as c } from 'x'` (multi-line included, recorded under the *source* name), and `export * from 'x'` / `export * as ns from 'x'` (→ `*`).
  - **The regex's false positives are gone too.** `from '…'` inside a comment or a string literal no longer fabricates an edge; the parser cannot see into either. On that same repository three such edges existed — two JSDoc usage examples that made a file import *itself*, and one string fixture inside an architecture test that pointed at the real database module. Old-vs-new on it: **+1,857 real edges gained, 3 phantom edges dropped, 0 real edges lost.**
- **A `tsconfig.json` / `jsconfig.json` with a JSON syntax error no longer fails the tool call on Windows.** Building the config path with `path.join` produced backslashes, which TypeScript's diagnostic machinery asserts against its own forward-slash normalization — so `dependencyGraph`, `impactedFiles` and `calculateWorkspaceImpactedFiles` threw `Debug Failure` (surfacing as an MCP internal error) for any workspace whose config had an unclosed brace or a missing comma. The path is now normalized the way `ts.findConfigFile` returns it, and the parse is additionally wrapped so an unusable config degrades to the default resolution options while relative imports keep resolving.

### Docs

- README: the `dependencyGraph` and `impactedFiles` entries now list every import form that is followed (type-position `import()` and JSDoc `import()` types included), state that resolution is TypeScript's own from the nearest project config, and document the `unresolved` / `unresolvedCount` / `unresolvedSample` completeness report and its four reasons; `impactedFiles` also documents `options.changedSymbolsByFile` — which had shipped undocumented — and exactly how a change travels through a re-export. New Tool Guide sections cover assets as leaves and the workspace graph cache with their measured numbers. Added the missing Tool Guide sections for `findSymbol` and `findCallers` / `findCallees` (shipped in 0.3.0, never documented there). Noted that `CODE_INTEL_SPAWN_TIMEOUT` (ms, default 15000) bounds the ripgrep run and that a timeout degrades to the node engine with `engineFallbackReason`. Added `pnpm audit --audit-level=high` to Package Validation.
- The `/tools/describe` and MCP `tools/list` descriptions for `dependencyGraph` and `impactedFiles` now say which import forms are covered, that resolution follows the nearest `tsconfig`/`jsconfig` (aliases included), and that anything unfollowed is reported — these are the strings an MCP client puts in front of the model, and the old wording steered agents away from both tools on exactly the codebases this release fixes.

## 0.4.0 - 2026-09-04

### Changed

- **Dependency refresh — every dependency bumped to its latest compatible version.**
  - Runtime: `typescript` 5.9.3 → **6.0.3** (the last JavaScript-based TypeScript; 7.x is the native Go compiler and ships no `createLanguageService` JS API, so it cannot back the symbol tools), `@ast-grep/cli` 0.40.5 → **0.45.3** (all seven platform binaries pinned to match), `zod` 4.3.6 → 4.5.4, `picomatch` 4.0.4 → 4.0.7.
  - Dev/test toolchain: `eslint` 9 → **10.10**, `@eslint/js` 10, `typescript-eslint` 8.69, `globals` 17, `vitest` / `@vitest/coverage-v8` 4 → **5**, `vite` 7 → **8**, `@types/node` 24 → 26, `@types/picomatch` 4.0.3.
  - Tooling: `packageManager` pnpm 10.28.2 → 10.34.5 (also in every workflow); GitHub Actions `actions/checkout`, `actions/setup-node`, `actions/upload-artifact` → v7 and `pnpm/action-setup` → v6 across all four workflows; Docker base images `node:24.20.0-alpine` and `alpine:3.23`.
- Build: `tsconfig.build.json` now sets `rootDir: ./services` explicitly — TypeScript 6 refuses to infer it (TS5011). The published `dist/` layout, `bin` and `exports` paths are unchanged.

### Security

- **Light security review — four pre-existing issues fixed** (found by a 4-lens review with adversarial verification; none were introduced by the dependency bumps):
  - **Arbitrary file read via `filePath` (high).** `findDefinitions` / `findReferences` / `findImplementations` / `findCallers` / `findCallees` / `getFileOutline` / `getSymbolContent` / `dependencyGraph` resolved `filePath` with `path.resolve()` and no boundary check, so an absolute path or `../` escaped the workspace and returned the outline or source of any readable file. `filePath` now goes through the same `assertWithinWorkspace` realpath + prefix check that `searchText` and `findDuplicates` already used, and answers `path outside workspace root`.
  - **ripgrep flag injection via `searchText.query` (high).** The query was appended to the `rg` argv as a bare positional, so a query such as `--pre=./evil.sh` was parsed as an option — and `--pre` executes a program per searched file. The pattern is now passed with `-e` and options are terminated with `--` before the search paths.
  - **git option injection via `findDuplicates.sinceGitRef` (medium).** A ref starting with `-` (e.g. `--output=<path>`) was passed straight to `git diff`, letting a caller write a file anywhere. The request schema now rejects values starting with `-`, and the service re-checks before spawning git.
  - **No `Origin` validation on `POST /tools/*` and `POST /mcp` (medium).** Any web page in the developer's browser could issue a preflight-free JSON POST to the (by default unauthenticated) localhost server. Requests carrying an `Origin` header are now accepted only from the server's own origin or from `CODE_INTEL_ALLOWED_ORIGINS` (new env var, `*` to disable); clients that send no `Origin` (IDEs, agents, curl, Node) are unaffected.
- **`pnpm audit` is fully clean** (was 13 high / 3 moderate, all in the dev toolchain: `brace-expansion`, `js-yaml`, `nanoid`, `postcss`, `@humanfs/node`). Overrides refreshed to the patched floors (`brace-expansion` ≥1.1.18 / ≥2.1.4, `postcss` ≥8.5.23, `js-yaml` ≥4.3.1, `nanoid` ≥3.3.18, `@humanfs/node` ≥0.16.8); the obsolete `picomatch` override was dropped because it broke `fdir`'s peer range now that the direct dependency is 4.0.7.

### Fixed

- **`impactedFiles` and `findDuplicates` no longer freeze the server on real repositories.** Their workspace walkers now skip hidden directories, nested git checkouts (a directory containing `.git`, e.g. worktrees under `.claude/worktrees/` or `.worktrees/`), `coverage/` and `.next/` — the same defaults ripgrep gives `searchText`. On a production Next.js repo the walk covered 66,563 files (a dozen nested worktrees plus ~110 MB of `.next/` bundles) and blocked the single-threaded server for over nine minutes per call; it now sees the ~4,000 real sources. Note: both engines still resolve relative imports only — `@/…` tsconfig path aliases are reported as external, so on alias-heavy codebases `dependencyGraph`/`impactedFiles` stay shallow.
- **`searchText` silently used the Node fallback engine instead of ripgrep under pnpm.** The bundled binary lives in `@vscode/ripgrep-<platform>-<arch>`, an optional dependency of `@vscode/ripgrep` that pnpm's isolated layout only exposes to `@vscode/ripgrep` itself; resolving it from this package failed and the service degraded (correct results, but the slow regex walker). The binary is now resolved from `@vscode/ripgrep`'s own location (the way its `rgPath` does), with the legacy postinstall path as a last resort. A real-binary integration test now guards the engine choice.
- `searchText` answered HTTP 500 `internal error` when ripgrep exceeded the spawn timeout (5 s by default; the first ripgrep launch from a fresh server takes ~5 s on Windows even though later searches take 0.2 s). The ripgrep default is now 15 s (ast-grep already used 30 s) and a timeout degrades to the Node engine with `engineFallbackReason: "ripgrep timed out…"`, the way `searchStruct` already reports an ast-grep timeout, and points at `CODE_INTEL_SPAWN_TIMEOUT`.
- Tests: the ast-grep fallback-chain tests assumed `node_modules/@ast-grep/cli/ast-grep.exe` exists, but that file is only created by `@ast-grep/cli`'s postinstall, which pnpm 10 blocks by default — a fresh Windows install failed them. The local-binary lookup is now injectable in tests (`setLocalAstGrepExecutableForTests`), mirroring the bundled-binary seam, so the chain is asserted deterministically on every platform.
- Lint under ESLint 10 / typescript-eslint 8.69: removed nine unnecessary type assertions, a dead initializer in the self-test, and two unused type imports. No behavior change.

## 0.3.7 - 2026-06-14

### Security

- **Dependency security update — `pnpm audit` is clean again (was 1 critical, 9 high, 6 moderate, 1 low).** The CI `pnpm audit --audit-level=high` gate is green. Changes, all in the dev/test toolchain except `picomatch`:
  - `vitest` / `@vitest/coverage-v8` upgraded 3.x → 4.x — clears the **critical** Vitest UI arbitrary-file-read advisory (GHSA-5xrq-8626-4rwp) and brings a patched Vite 7.3.x toolchain. Full test suite (153 tests) and v8 coverage verified green under Vitest 4.
  - `picomatch` (the only shipped runtime dependency touched) bumped 4.0.3 → 4.0.4 for the extglob ReDoS fix — a patch, no API change.
  - `vite` pinned to `^7.3.5` as an explicit devDependency. The vulnerable Vite (>=7.0.0 <=7.3.1) was an auto-installed peer of Vitest, which `pnpm.overrides` cannot reach; declaring it directly forces the patched version (GHSA-p9ff-h696-f583 and the dev-server file-read advisories).
  - Added scoped `pnpm.overrides` for the remaining transitive advisories: `esbuild` ≥0.28.1, `minimatch` ≥3.1.5 / ≥9.0.9, `flatted` ≥3.4.2, `brace-expansion` ≥1.1.15, `picomatch` ≥4.0.4, `postcss` ≥8.5.10.

## 0.3.6 - 2026-06-13

### Added

- **Explicit workspace-root allowlist for sibling worktrees.** A request `workspaceRoot` outside the configured default `--workspaceRoot` is still rejected by default, but operators can now authorize specific paths via repeatable `--allowed-workspace-root=<glob>` CLI args or the `CODE_INTEL_ALLOWED_WORKSPACE_ROOTS` env var (comma/semicolon-separated globs). Patterns are matched against the canonical (realpath-resolved) path, so `..`/symlink traversal stays blocked, and the strict default-boundary behavior is unchanged when no patterns are configured. This lets the MCP run against a git worktree that is a sibling of the main checkout (instead of falling back to grep).

## 0.3.5 - 2026-06-08

### Docs

- Clarified the benchmark wording so the gains read unambiguously: token results are now "X% fewer tokens" / "~parity" (no more "+X%" that read like an *increase*), and adoption is stated as "11 of 11 fresh-context agents chose it on their own, on real production-codebase tasks".
- README now links to the benchmark write-up via a full GitHub URL — relative repo paths don't resolve on the npm page (npm renders only the README).

## 0.3.4 - 2026-06-08

### Docs

- README benchmark section now also shows the compact-output result (`findReferences` ~72% smaller than the old format, ~60% smaller than `grep -n`), so every measured gain — adoption, token savings, type-checked precision, and compact output — is visible on the npm page.

## 0.3.3 - 2026-06-08

### Changed

- **Compact output for `findReferences` / `findDefinitions` / `findImplementations`** (breaking shape change). These three tools now return matches grouped by file instead of a flat `locations` array:
  `{ symbol, sourceFilePath, count, byFile: { "<path>": ["line:col", ...] } }`.
  The path is written once per file (not once per occurrence) and each position is the universal 1-based `"line:col"` string. On a 43-reference symbol the payload dropped **~72%** (5,793 → 1,634 chars) and is now **~60% smaller than the equivalent `grep -n`** — flipping find-references from a token loss to a clear win. The column is always present, so single-line / minified files stay unambiguous. Only consumers that read the old `.locations` array are affected; `findSymbol` / `findCallers` / `findCallees` are unchanged.

## 0.3.2 - 2026-06-08

### Docs

- Added an agent adoption / token-economy benchmark (`docs/benchmarks/2026-06-07-agent-token-economy.md`): **100% spontaneous adoption** (11/11 fresh-context agents chose code-intel unprompted), token savings that scale with task difficulty (**+13% to +34%** on debugging traces, large-file comprehension, and ambiguous-name searches; near-parity on simple grep-friendly lookups), and type-checked precision (no grep false positives).
- Refreshed the README: full 13-tool list, benchmark highlights, a self-describing-server note (the MCP `initialize.instructions` mean no consumer-side prompt forcing is needed), and configuration notes (`workspaceRoot`, deferred tools, cold-start, reconnect).

## 0.3.1 - 2026-06-07

### Fixed

- `findSymbol`: prefer exact-name matches. `getNavigateToItems` is fuzzy (substring/camelCase/prefix), so a query like `findSymbol("UserRepository")` previously returned ~100 unrelated same-prefix symbols (`userRepository`, `userSessionRepository`, …). It now returns only exact-name declarations, falling back to fuzzy matches only when there is no exact hit — so "go to symbol by name" is precise by default.

## 0.3.0 - 2026-06-07

### Added

- **Adoption redesign**: tool descriptions rewritten to state, for each tool, *when* to use it, *instead of which* built-in (Grep/Read), and the token/precision benefit — so an agent has a concrete reason to prefer code-intel over reflexive Grep/Glob/Read. The persuasion now ships *with the server*; consumers need no `AGENTS.md` forcing.
- **MCP `initialize.instructions`**: the server now returns a usage guide routing symbol-level intents to the right tool. Clients that surface it inject it into the model's context automatically.
- `findCallers` / `findCallees`: real incoming/outgoing **call hierarchy** via the TS language service (were mock).
- `findSymbol`: **workspace symbol search by name alone** (no `filePath` needed) via `getNavigateToItems` — removes the "must know the file first" friction (was mock).
- `impactedFiles`: real transitive **blast-radius** analysis wired to the indexer engine (was mock).

### Fixed

- `searchStruct`: resolves the bundled `ast-grep` binary directly from `optionalDependencies` (or `CODE_INTEL_ASTGREP_PATH`), and degrades to an empty result with `engineFallbackReason` instead of throwing when the binary is unavailable. Previously it required `pnpm`/network at runtime and hard-failed in many consumer installs.
- The server now advertises **only tools that work** — the four formerly-mock endpoints are real, so an agent no longer loses trust in the whole server after one mock response.

## 0.2.0 - 2026-05-09

### Fixed

- `findReferences`, `findDefinitions`, `findImplementations`, `getSymbolContent`: the resolver no longer anchors on the first textual occurrence of the symbol (`indexOf`). It now walks the AST to find the actual *declaration* node, then falls back to identifier-only matches before the legacy text fallback. This fixes false positives where the symbol first appeared in a comment or in a module-specifier string (e.g. `import styles from './Widget.module.css'` was resolving to the Next.js `*.module.css` ambient declaration, returning a single result inside `node_modules/next/types/global.d.ts`).
- `findReferences` / `findDefinitions` / `findImplementations` now exclude `node_modules/**` and `*.d.ts` results by default. Use `includeNodeModules: true` and/or `includeDeclarationFiles: true` to opt back in.
- `searchText` ripgrep parser now handles Windows drive letters (e.g. `E:\path\file.ts:1:17:content`); previously the path was split on the drive-letter colon, returning zero matches.
- `searchText` now resolves the ripgrep binary from the bundled `@vscode/ripgrep` dependency (or `CODE_INTEL_RIPGREP_PATH` env var). Previously the spawn could fail silently on Windows because Node's `spawnSync(..., { shell: false })` does not honor `PATHEXT`, so `rg.cmd` and `rg.ps1` shims were never resolved.

### Added

- `getFileOutline` accepts `summaryOnly: true` to omit the `signature` field. On large schema files this typically cuts the payload by 60–80 % and avoids hitting the 25 000-token tool-result ceiling.
- `getSymbolContent` accepts `maxLines` to truncate the returned content. The result includes `truncated: boolean` and (when truncated) `truncatedAtLine: number`.
- `searchText` result includes `engineFallbackReason: string` when the call falls back to the Node implementation, so clients can debug why ripgrep was not used.
- New runtime dependency: `@vscode/ripgrep` (MIT). The `rg` binary is bundled with the package so `searchText` works out of the box on Windows, macOS, and Linux without requiring `rg` on `PATH`.

## 0.1.9 - 2026-04-30

### Fixed

- Surface the underlying error message when an MCP tool throws (e.g. `file not found: <path>` for `getFileOutline`, `getSymbolContent`, etc.) instead of the opaque `Internal error`.
- Log tool execution failures to stderr with tool name, message and stack trace so MCP clients can debug invalid input or workspace issues.

## 0.1.8 - 2026-04-18

### Fixed

- Fixed `searchStruct` in consumer projects by resolving the `ast-grep` binary from the package root instead of the consuming workspace root.
- Fixed the `pnpm dlx` fallback for `@ast-grep/cli` by selecting the `ast-grep` binary explicitly, avoiding the multiple-binaries failure.
- Added `@ast-grep/cli` as a runtime dependency so structural search works in installed package usage, not only in the package repository.

### Changed

- Extended the release smoke test to execute a real `searchStruct` call against a temporary consumer project before considering a release valid.

## 0.1.7 - 2026-04-18

### Fixed

- Fixed MCP `tools/list` schema generation for `getFileOutline` so `symbolKinds` is emitted as a valid JSON Schema array instead of the invalid `string[]` pseudo-type.
- Restored compatibility with VS Code MCP clients that reject invalid input schemas during tool discovery.

### Changed

- Reworked the main README so it documents the npm package itself rather than internal project delivery notes.
- Added package-oriented guidance for installation, usage, MCP client integration, prompt recommendations, and IDE setup.