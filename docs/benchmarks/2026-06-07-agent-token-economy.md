# Benchmark — spontaneous adoption & token economy (2026-06-07)

Does giving a coding agent `code-intel` actually change its behavior, and does it save tokens on real work? We measured it on a large production TypeScript repository (Next.js, hexagonal architecture, ~1,450 dependencies, hundreds of source files, individual files up to ~1,200 lines) with `code-dev-intel.ts` v0.3.0.

## TL;DR

- **Spontaneous adoption: 11 of 11 agents.** With `code-intel` available alongside Grep/Glob/Read and each agent free to choose, **all 11 fresh-context agents chose it on their own — with no instruction to use it** — across 7 real task types on a production codebase.
- **Fewer tokens, scaling with task difficulty.** Roughly parity on simple grep-friendly lookups; **13–34% fewer tokens (≈27% fewer on average) on debugging traces, large-file comprehension, and ambiguous-name searches** — the tasks that dominate real work.
- **Type-checked precision.** `findReferences`/`findImplementations` results are resolved by the type-checker, so they carry no grep false positives. On an ambiguous-name task the grep-only baseline had to *manually* enumerate and exclude false matches.

> **Update (v0.3.3):** the benchmark below ran on v0.3.0. In v0.3.3 the `findReferences`/`findDefinitions`/`findImplementations` output was made compact (grouped by file, `"line:col"` positions) — on a 43-reference symbol the payload dropped ~72% (5,793 → 1,634 chars) and is now ~60% smaller than `grep -n`. This directly improves the one area where semantic find-references was previously *more* verbose than grep.

## Method

- **Agents:** fresh-context AI agents, one task each, no memory of prior runs.
- **Arms:**
  - **Treatment** — full toolset (Grep, Glob, Read) **plus** `code-intel`, told to "use whatever you judge best" (no preference imposed). This measures *spontaneous* choice, not forced use.
  - **Control** — restricted to Grep, Glob, Read only.
- **Measurement:** each agent's total token consumption (input+output across all its turns, reported by the agent runtime) and a self-reported list of the tools it called.
- **Tasks:** two batches. Batch 1 = ordinary navigation with distinctive (grep-friendly) symbol names. Batch 2 = "hard" tasks designed to be read-heavy / grep-hostile (debugging traces, multi-large-file comprehension, ambiguous common-name search).

Token figures are end-to-end **agent** tokens, not per-tool output sizes. (The per-operation output of a semantic call is roughly 7–8× smaller than the equivalent grep+read output, but that ratio is not the same as end-to-end agent consumption — see Caveats.)

## Results — adoption

**All 11 of the 11 treatment agents chose `code-intel` on their own** (no instruction to use it), on real tasks against the production codebase. The tools they reached for, by task:

| Task type | Tools the agent chose |
|---|---|
| Cross-layer call chain | `getSymbolContent`, `findImplementations` |
| Port blast-radius | `findReferences`, `findImplementations`, `getFileOutline` |
| Single-symbol deep-dive | `findSymbol`, `getSymbolContent` |
| Large-file structure | `getFileOutline` |
| Debugging field-lifecycle trace | `findDefinitions`, `getSymbolContent`, `findImplementations` |
| Multi-large-file subsystem map | `getFileOutline`, `getSymbolContent`, `findCallers` |
| Ambiguous-type blast-radius | `findSymbol`, `findReferences`, `getSymbolContent` |

## Results — token economy

### Batch 1 — ordinary, grep-friendly navigation

| Task | code-intel (tokens) | Grep/Read (tokens) | code-intel result |
|---|--:|--:|--:|
| Trace a 3-layer call chain | 35,562 | 35,318 | ~parity (0.7% more) |
| Port implementers + consumers | 39,798 | 37,920 | ~parity (5% more) |
| Explain one use-case + its deps | 34,837 | 33,697 | ~parity (3% more) |
| List a 1,177-line class's structure | 30,657 | **46,221** | **34% fewer tokens** |

On simple lookups where the symbol name is distinctive, an efficient grep agent is already cheap, so code-intel is roughly at parity — **except** when the task forces reading a whole large file (the structure task), where outline-instead-of-read is a clear win.

### Batch 2 — hard: debugging / read-heavy / grep-hostile

| Task | code-intel (tokens) | Grep/Read (tokens) | code-intel result |
|---|--:|--:|--:|
| Debug: trace a field's full lifecycle | 63,579 | 95,657 | **34% fewer tokens** |
| Map a 3-file (~1,900-line) subsystem | 43,421 | 63,883 | **32% fewer tokens** |
| Blast radius of an ambiguous common type | 54,515 | 62,535 | **13% fewer tokens** |
| **Mean** | **53,838** | **74,025** | **27% fewer tokens** |

The harder the task, the more the grep baseline pays — it reads 12–14 files (the debugging task cost the control 95.7k tokens) where the semantic agent jumps to the relevant declarations.

## Quality (not visible in the token numbers)

- **No false positives.** On the ambiguous-type task, the grep-only control had to write out an explicit exclusion list ("Notable false matches I excluded: `RecordType`, `RecordStatus`, `RecordWithImage`, …") and read 14 files to disambiguate. The treatment agent got a type-checker-authoritative result from `findReferences` in one step.
- **Precise localization.** On the debugging task the semantic agent used `findDefinitions`/`getSymbolContent` to land directly on the generator and the unvalidated create-path; the control read 12 files to reconstruct the same picture.

## Caveats (so the numbers are honest)

- **End-to-end ≠ per-operation.** A single semantic call returns ~7–8× less than the equivalent grep+read, but agent token totals are dominated by reasoning and answer-writing, so the realized end-to-end saving is smaller and task-dependent.
- **Conservative against code-intel.** The control agents were competent (efficient grep, minimal reads), and the treatment agents stayed *hybrid* — they cross-checked code-intel output with grep on the ambiguous-type task, which inflated their cost. A more code-intel-trusting agent would save more.
- **Deferred-tool overhead.** In this harness the MCP tools are loaded on demand, so each treatment agent paid a one-time `ToolSearch` to load schemas. Eager-loaded tools would remove that.
- **First call cold-starts** the TypeScript program (a few seconds on a large repo); this is latency, not tokens, and is amortized across the session.

## Takeaway

Adoption is solved: with the server's own tool descriptions and `initialize.instructions`, agents reach for `code-intel` by default — **no consumer-side prompt forcing required**. Token savings are real and grow with task difficulty (debugging, big files, ambiguous names), on top of a consistent correctness/precision advantage.

## Reproduce

Run several fresh-context agents on identical real tasks in your repo, split into a treatment arm (code-intel available, free choice) and a control arm (Grep/Read only), and compare each agent's total token usage plus which tools it called. Favor tasks that mirror real work: debugging a value's lifecycle, understanding a large file or subsystem, and finding usages of a common/ambiguous name.
