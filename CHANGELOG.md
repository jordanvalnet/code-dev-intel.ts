# Changelog

All notable changes to this package are documented in this file.

## 0.2.0 - 2026-05-09

### Fixed

- `findReferences`, `findDefinitions`, `findImplementations`, `getSymbolContent`: the resolver no longer anchors on the first textual occurrence of the symbol (`indexOf`). It now walks the AST to find the actual *declaration* node, then falls back to identifier-only matches before the legacy text fallback. This fixes false positives where the symbol first appeared in a comment or in a module-specifier string (e.g. `import styles from './UserMenuCard.module.css'` was resolving to the Next.js `*.module.css` ambient declaration, returning a single result inside `node_modules/next/types/global.d.ts`).
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