import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, normalize, relative } from 'node:path';
import ts from 'typescript';
import { createImportResolver } from './import-resolver.ts';

export interface ImportEdge {
  sourceFile: string;
  targetFile: string;
  importedSymbols: string[];
}

export interface WorkspaceGraph {
  files: string[];
  imports: ImportEdge[];
  exportsByFile: Record<string, string[]>;
}

export interface ImpactedFilesOptions {
  graph: WorkspaceGraph;
  changedFiles: string[];
  changedSymbolsByFile?: Record<string, string[]>;
}

const DEFAULT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
// Same build/output directories searchText ignores: walking a Next.js `.next/` or a
// coverage report (megabytes of minified JS) made impactedFiles block the server for minutes.
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'coverage', '.next']);

/**
 * Directories the workspace walk must not enter. Mirrors ripgrep's defaults (which
 * `searchText` already inherits): hidden directories are skipped, and so is any nested
 * git checkout — e.g. worktrees kept under `.claude/worktrees/` or `.worktrees/`, which
 * otherwise multiply the graph by the number of worktrees (66k files on one real repo).
 */
export function shouldSkipDirectory(name: string, absolutePath: string): boolean {
  if (SKIPPED_DIRECTORIES.has(name) || name.startsWith('.')) {
    return true;
  }

  return existsSync(join(absolutePath, '.git'));
}

function toPosixPath(value: string): string {
  return normalize(value).replaceAll('\\', '/');
}

function toRelativePosixPath(workspaceRoot: string, absolutePath: string): string {
  return toPosixPath(relative(workspaceRoot, absolutePath));
}

function listSourceFiles(workspaceRoot: string): string[] {
  const result: string[] = [];

  function walk(currentDir: string): void {
    const entries = readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(entry.name, absolutePath)) {
          walk(absolutePath);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (!DEFAULT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        continue;
      }

      result.push(toPosixPath(absolutePath));
    }
  }

  walk(workspaceRoot);
  return result;
}

interface FileImport {
  importPath: string;
  importedSymbols: string[];
}

/**
 * `.tsx` and `.jsx` must be parsed as JSX, otherwise `<T>` is read as a type assertion
 * and the parser resynchronizes past the statements this collects.
 */
function scriptKindFor(fileName: string): ts.ScriptKind {
  switch (extname(fileName).toLowerCase()) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

/**
 * Binding names as the TARGET module knows them: `{ original as alias }` contributes
 * `original`, because that is the name `exportsByFile` records and the one
 * `changedSymbolsByFile` is expressed in. An inline `type` modifier is not part of the
 * name, so `{ type A }` contributes `A` — the parser has already separated the two.
 */
function bindingSymbols(
  elements: readonly ts.ImportSpecifier[] | readonly ts.ExportSpecifier[]
): string[] {
  return elements.map((element) => (element.propertyName ?? element.name).text);
}

function importClauseSymbols(clause: ts.ImportClause | undefined): string[] {
  // `import './side-effect'` binds nothing, so it depends on the module as a whole.
  if (!clause) {
    return ['*'];
  }

  const symbols: string[] = [];
  if (clause.name) {
    symbols.push('default');
  }

  const bindings = clause.namedBindings;
  if (bindings) {
    if (ts.isNamespaceImport(bindings)) {
      symbols.push('*');
    } else {
      symbols.push(...bindingSymbols(bindings.elements));
    }
  }

  return symbols.length > 0 ? symbols : ['*'];
}

function exportClauseSymbols(clause: ts.NamedExportBindings | undefined): string[] {
  // `export * from 'x'` and `export * as ns from 'x'` both re-export everything.
  if (!clause || ts.isNamespaceExport(clause)) {
    return ['*'];
  }

  const symbols = bindingSymbols(clause.elements);
  return symbols.length > 0 ? symbols : ['*'];
}

/**
 * The file's import and re-export edges, read off TypeScript's own parse tree.
 *
 * This used to be a regex whose clause class excluded newlines, so every statement
 * Prettier had wrapped — the normal shape of an `import type { … }` list — was
 * invisible: on a formatted codebase the graph lost most of its edges and
 * `impactedFiles` answered without the adapters that implement a changed port. The same
 * regex also matched `from '…'` inside comments and string literals, inventing edges
 * that were never there. Parsing is exact on both counts and hands over binding names,
 * `default`, namespace bindings and inline `type` modifiers already separated — there is
 * no clause string left to re-split.
 */
function extractImports(fileContent: string, fileName: string): FileImport[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    fileContent,
    ts.ScriptTarget.Latest,
    // Parent pointers cost time to set and nothing here walks upwards.
    false,
    scriptKindFor(fileName)
  );
  const imports: FileImport[] = [];

  function collect(statements: readonly ts.Statement[]): void {
    for (const statement of statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        imports.push({
          importPath: statement.moduleSpecifier.text,
          importedSymbols: importClauseSymbols(statement.importClause)
        });
        continue;
      }

      if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier !== undefined &&
        ts.isStringLiteralLike(statement.moduleSpecifier)
      ) {
        imports.push({
          importPath: statement.moduleSpecifier.text,
          importedSymbols: exportClauseSymbols(statement.exportClause)
        });
        continue;
      }

      // `declare module 'x' { import … }`: the old text scan saw these too.
      if (ts.isModuleDeclaration(statement) && statement.body && ts.isModuleBlock(statement.body)) {
        collect(statement.body.statements);
      }
    }
  }

  collect(sourceFile.statements);
  return imports;
}

function extractExports(fileContent: string): string[] {
  const symbols = new Set<string>();

  const declarationRegex = /export\s+(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  let declarationMatch = declarationRegex.exec(fileContent);
  while (declarationMatch) {
    if (declarationMatch[1]) {
      symbols.add(declarationMatch[1]);
    }
    declarationMatch = declarationRegex.exec(fileContent);
  }

  const listRegex = /export\s+\{([^}]*)\}/g;
  let listMatch = listRegex.exec(fileContent);
  while (listMatch) {
    const rawEntries = (listMatch[1] ?? '').split(',').map((part) => part.trim()).filter(Boolean);
    for (const entry of rawEntries) {
      const aliasParts = entry.split(/\s+as\s+/i).map((part) => part.trim()).filter(Boolean);
      const exportedName = aliasParts.length > 1 ? aliasParts[1] : aliasParts[0];
      if (exportedName) {
        symbols.add(exportedName);
      }
    }
    listMatch = listRegex.exec(fileContent);
  }

  if (/export\s+default\s+/m.test(fileContent)) {
    symbols.add('default');
  }

  return [...symbols];
}

export function buildWorkspaceGraph(workspaceRoot: string): WorkspaceGraph {
  const absoluteFiles = listSourceFiles(workspaceRoot);
  // Relative imports plus tsconfig/jsconfig `paths` and `baseUrl` aliases (e.g. `@/domain/x`).
  const importResolver = createImportResolver(workspaceRoot);
  const files = absoluteFiles.map((file) => toRelativePosixPath(workspaceRoot, file));
  const imports: ImportEdge[] = [];
  const exportsByFile: Record<string, string[]> = {};

  for (const absolutePath of absoluteFiles) {
    const filePath = toRelativePosixPath(workspaceRoot, absolutePath);
    const content = readFileSync(absolutePath, 'utf8');

    exportsByFile[filePath] = extractExports(content);

    const fileImports = extractImports(content, absolutePath);
    for (const fileImport of fileImports) {
      const resolvedTarget = importResolver.resolve(absolutePath, fileImport.importPath);
      if (!resolvedTarget) {
        continue;
      }

      imports.push({
        sourceFile: filePath,
        targetFile: toRelativePosixPath(workspaceRoot, resolvedTarget),
        importedSymbols: fileImport.importedSymbols
      });
    }
  }

  return {
    files,
    imports,
    exportsByFile
  };
}

function shouldMarkBySymbol(
  edge: ImportEdge,
  changedSymbolsByFile: Record<string, string[]> | undefined,
  exportsByFile: Record<string, string[]>
): boolean {
  if (!changedSymbolsByFile) {
    return true;
  }

  const changedSymbols = changedSymbolsByFile[edge.targetFile] ?? [];
  if (changedSymbols.length === 0) {
    return false;
  }

  if (edge.importedSymbols.includes('*')) {
    return true;
  }

  const availableExports = new Set(exportsByFile[edge.targetFile] ?? []);
  for (const symbol of changedSymbols) {
    if (!availableExports.has(symbol)) {
      continue;
    }

    if (edge.importedSymbols.includes(symbol)) {
      return true;
    }

    if (symbol === 'default' && edge.importedSymbols.includes('default')) {
      return true;
    }
  }

  return false;
}

export function calculateImpactedFiles(options: ImpactedFilesOptions): string[] {
  const reverseEdges = new Map<string, ImportEdge[]>();

  for (const edge of options.graph.imports) {
    const existing = reverseEdges.get(edge.targetFile) ?? [];
    existing.push(edge);
    reverseEdges.set(edge.targetFile, existing);
  }

  const impacted = new Set(options.changedFiles.map((file) => toPosixPath(file)));
  const queue = [...impacted];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const importers = reverseEdges.get(current) ?? [];
    for (const importerEdge of importers) {
      if (
        !shouldMarkBySymbol(importerEdge, options.changedSymbolsByFile, options.graph.exportsByFile)
      ) {
        continue;
      }

      if (impacted.has(importerEdge.sourceFile)) {
        continue;
      }

      impacted.add(importerEdge.sourceFile);
      queue.push(importerEdge.sourceFile);
    }
  }

  return [...impacted].sort((left, right) => left.localeCompare(right));
}

export interface WorkspaceImpactRequest {
  workspaceRoot: string;
  changedFiles: string[];
  changedSymbolsByFile?: Record<string, string[]>;
}

export function calculateWorkspaceImpactedFiles(request: WorkspaceImpactRequest): string[] {
  const graph = buildWorkspaceGraph(request.workspaceRoot);

  return calculateImpactedFiles({
    graph,
    changedFiles: request.changedFiles.map((filePath) => toPosixPath(filePath)),
    changedSymbolsByFile: request.changedSymbolsByFile
  });
}
