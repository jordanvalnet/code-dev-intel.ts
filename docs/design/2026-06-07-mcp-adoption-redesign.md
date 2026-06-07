# code-intel MCP — adoption & token-savings redesign

**Date:** 2026-06-07
**Goal:** make an AI agent reach for `code-intel` *by default* for code navigation — over reflexive Grep/Glob/Read — **without** requiring forcing instructions in the consumer's `AGENTS.md`/`CLAUDE.md`. Success = measurable token savings on a real project.

## Diagnosis — why agents under-use the server today

1. **Descriptions paraphrase the implementation instead of selling the tool.** At tool-selection time the `description` is the *only* signal the model has. Current text like `"Find symbol references from filePath + symbol."` gives no reason to prefer it over Grep, and `searchText` literally describes itself as *"Plain text search via ripgrep"* — i.e. a worse grep.
2. **Trust poison: 5 of 13 advertised tools are dead or unreliable.** `findSymbol`/`findCallers`/`findCallees`/`impactedFiles` returned a mock payload (`tool-handler.ts` fall-through), and `searchStruct` hard-throws when the ast-grep binary is missing. The first time an agent hits one, it learns the whole server is unreliable and falls back to Grep for everything.
3. **Discovery friction.** In harnesses that defer MCP tools behind a search step, code-intel must be *retrieved* before it can be called, while Grep/Glob are always present. Descriptions must be keyword-dense to win that retrieval, and the value prop strong enough to be worth the detour.
4. **Usability friction.** `findReferences`/`findDefinitions` require `filePath` **and** `symbol` — the agent must already know where the symbol lives. (Addressed by the new `findSymbol` = name-only workspace search, repaired in parallel.)

## Strategy

> Position code-intel as the **semantic layer that has no native equivalent** — not as a better grep. Move all persuasion **into the server** (tool descriptions + the MCP `initialize.instructions` field), which ship automatically with the server, so consumers need zero `AGENTS.md` changes. And **advertise only what works.**

### Description formula (every tool)
`[what it returns] · [use-when trigger] · [instead of which built-in] · [token/precision benefit]`, keyword-dense for retrieval.

### Server-level `instructions`
The MCP `initialize` result now returns an `instructions` string routing symbol-level intents to the right tool. Clients that surface it inject it into context for free — the "forcing" without an AGENTS.md.

## Tool disposition

| Tool | Action this pass |
|---|---|
| findDefinitions, findReferences, findImplementations, getSymbolContent, getFileOutline, dependencyGraph | **Keep** — rewrite descriptions (semantic-layer framing) |
| **impactedFiles** | **Repaired & kept** — wire the already-tested `calculateWorkspaceImpactedFiles` engine; real description |
| findDuplicates, searchText | **Keep** — rewrite descriptions; `searchText` de-emphasized toward non-symbol text only |
| findSymbol, findCallers, findCallees, searchStruct | **Hidden** from `tools/list` now (removed from the describe payload only — `TOOL_NAMES`/handlers untouched, so re-wiring is trivial). Implemented properly on branch `fix/repair-hidden-tools` (parallel), then re-advertised + re-tested in a follow-up. |

## Deferred (finishing touches, pre-publish — to avoid breaking the build mid-measurement)
- Tool rename `searchText → searchCode` (ripples into tests/README/service internals).
- Package rename `code-dev-intel.ts → code-intel-mcp` + `bin` → `code-intel`.
- Reducing `workspaceRoot` from advertised required input fields (injected at startup).

## Measurement plan (light A/B, ~4 tasks)
- **💰 Efficiency (hard number, reproducible):** for ~4 real navigation tasks on the consumer repo, head-to-head token cost of the Grep+Read path vs the code-intel path. Independent of model whim — the savings ceiling, measured exactly.
- **🧲 Adoption (softer signal):** fresh-context agents on un-forced tasks — do they spontaneously pick code-intel with the new descriptions?

## Publish
Local build + repoint the consumer `.mcp.json` at `dist/` for validation (no bump). On green: bump, `npm publish`, squash the branch for clean public history.
