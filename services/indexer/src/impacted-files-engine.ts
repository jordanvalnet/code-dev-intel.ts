import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';

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
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') {
        continue;
      }

      const absolutePath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
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

function parseImportedSymbols(specifier: string): string[] {
  const trimmed = specifier.trim();
  if (!trimmed) {
    return ['*'];
  }

  const namedImportsMatch = trimmed.match(/\{([^}]*)\}/);
  if (namedImportsMatch) {
    const namedImportsRaw = namedImportsMatch[1] ?? '';
    const values = namedImportsRaw
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const aliasParts = part.split(/\s+as\s+/i);
        return (aliasParts[0] ?? '').trim();
      });

    if (values.length > 0) {
      return values;
    }
  }

  if (trimmed.startsWith('*')) {
    return ['*'];
  }

  if (trimmed.includes(',')) {
    return ['default', ...parseImportedSymbols(trimmed.split(',').slice(1).join(','))];
  }

  return ['default'];
}

function extractImports(fileContent: string): Array<{ importPath: string; importedSymbols: string[] }> {
  const imports: Array<{ importPath: string; importedSymbols: string[] }> = [];
  const importRegex = /(?:import|export)\s+([^;\n]*?)\s+from\s+['"]([^'"]+)['"]/g;

  let match = importRegex.exec(fileContent);
  while (match) {
    const specifier = match[1] ?? '';
    const importPath = match[2] ?? '';
    imports.push({
      importPath,
      importedSymbols: parseImportedSymbols(specifier)
    });
    match = importRegex.exec(fileContent);
  }

  const sideEffectRegex = /import\s+['"]([^'"]+)['"]/g;
  let sideEffectMatch = sideEffectRegex.exec(fileContent);
  while (sideEffectMatch) {
    const importPath = sideEffectMatch[1] ?? '';
    imports.push({ importPath, importedSymbols: ['*'] });
    sideEffectMatch = sideEffectRegex.exec(fileContent);
  }

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

function tryResolveImport(workspaceRoot: string, sourceFileAbsolute: string, importPath: string): string | null {
  if (!importPath.startsWith('.')) {
    return null;
  }

  const basePath = resolve(dirname(sourceFileAbsolute), importPath);
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    join(basePath, 'index.ts'),
    join(basePath, 'index.tsx'),
    join(basePath, 'index.js'),
    join(basePath, 'index.jsx')
  ];

  for (const candidate of candidates) {
    try {
      const info = statSync(candidate);
      if (info.isFile()) {
        return toRelativePosixPath(workspaceRoot, candidate);
      }
    } catch {
      continue;
    }
  }

  return null;
}

export function buildWorkspaceGraph(workspaceRoot: string): WorkspaceGraph {
  const absoluteFiles = listSourceFiles(workspaceRoot);
  const files = absoluteFiles.map((file) => toRelativePosixPath(workspaceRoot, file));
  const imports: ImportEdge[] = [];
  const exportsByFile: Record<string, string[]> = {};

  for (const absolutePath of absoluteFiles) {
    const filePath = toRelativePosixPath(workspaceRoot, absolutePath);
    const content = readFileSync(absolutePath, 'utf8');

    exportsByFile[filePath] = extractExports(content);

    const fileImports = extractImports(content);
    for (const fileImport of fileImports) {
      const resolvedTarget = tryResolveImport(workspaceRoot, absolutePath, fileImport.importPath);
      if (!resolvedTarget) {
        continue;
      }

      imports.push({
        sourceFile: filePath,
        targetFile: resolvedTarget,
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
