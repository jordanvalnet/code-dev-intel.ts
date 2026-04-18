# Changelog

All notable changes to this package are documented in this file.

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