import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import type {
  DependencyEdge,
  DependencyGraphResult,
  FileOutlineItem,
  FileOutlineResult,
  SymbolContentResult,
  SymbolLocation,
  SymbolQueryResult
} from './contracts.ts';

const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  checkJs: false,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  strict: false,
  skipLibCheck: true
};

type ProjectContext = {
  projectFiles: string[];
  compilerOptions: ts.CompilerOptions;
};

type CollectedOutlineItem = {
  kind: string;
  symbol: FileOutlineItem;
};

function collectCodeFiles(rootPath: string): string[] {
  const result: string[] = [];

  function walk(currentPath: string): void {
    const entries = readdirSync(currentPath);

    for (const entry of entries) {
      const fullPath = join(currentPath, entry);
      const stats = statSync(fullPath);

      if (stats.isDirectory()) {
        if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'coverage') {
          continue;
        }
        walk(fullPath);
        continue;
      }

      const extension = extname(fullPath).toLowerCase();
      if (SUPPORTED_EXTENSIONS.has(extension)) {
        result.push(fullPath);
      }
    }
  }

  walk(rootPath);
  return result;
}

function toSymbolLocation(sourceFile: ts.SourceFile, textSpan: ts.TextSpan): SymbolLocation {
  const start = sourceFile.getLineAndCharacterOfPosition(textSpan.start);
  const end = sourceFile.getLineAndCharacterOfPosition(textSpan.start + textSpan.length);

  return {
    filePath: sourceFile.fileName,
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1
  };
}

function resolveTargetFilePath(workspaceRoot: string, filePath: string): string {
  const absoluteFilePath = resolve(workspaceRoot, filePath);
  if (!existsSync(absoluteFilePath)) {
    throw new Error(`file not found: ${absoluteFilePath}`);
  }
  return absoluteFilePath;
}

function findSymbolOffset(fileContent: string, symbol: string): number {
  const offset = fileContent.indexOf(symbol);
  if (offset < 0) {
    throw new Error(`symbol not found in source file: ${symbol}`);
  }
  return offset;
}

function resolveProjectContext(workspaceRoot: string): ProjectContext {
  const tsconfigPath = ts.findConfigFile(workspaceRoot, (fileName) => ts.sys.fileExists(fileName), 'tsconfig.json');

  if (!tsconfigPath) {
    return {
      projectFiles: collectCodeFiles(workspaceRoot),
      compilerOptions: DEFAULT_COMPILER_OPTIONS
    };
  }

  const configFile = ts.readConfigFile(tsconfigPath, (fileName) => ts.sys.readFile(fileName));
  if (configFile.error) {
    throw new Error(ts.formatDiagnostic(configFile.error, createMinimalHost()));
  }

  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    dirname(tsconfigPath),
    undefined,
    tsconfigPath
  );

  return {
    projectFiles: parsedConfig.fileNames,
    compilerOptions: {
      ...DEFAULT_COMPILER_OPTIONS,
      ...parsedConfig.options
    }
  };
}

function createLanguageService(workspaceRoot: string, targetFilePath: string): ts.LanguageService {
  const context = resolveProjectContext(workspaceRoot);
  const projectFiles = [...context.projectFiles];

  if (!projectFiles.includes(targetFilePath)) {
    projectFiles.push(targetFilePath);
  }

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => projectFiles,
    getScriptVersion: () => '1',
    getScriptSnapshot: (fileName) => {
      if (!existsSync(fileName)) {
        return undefined;
      }
      return ts.ScriptSnapshot.fromString(readFileSync(fileName, 'utf8'));
    },
    getCurrentDirectory: () => workspaceRoot,
    getCompilationSettings: () => context.compilerOptions,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (fileName) => ts.sys.fileExists(fileName),
    readFile: (fileName) => ts.sys.readFile(fileName),
    readDirectory: (rootDir, extensions, excludes, includes, depth) =>
      ts.sys.readDirectory(rootDir, extensions, excludes, includes, depth),
    directoryExists: (directoryPath) => ts.sys.directoryExists(directoryPath),
    getDirectories: (directoryPath) => ts.sys.getDirectories(directoryPath)
  };

  return ts.createLanguageService(host, ts.createDocumentRegistry());
}

function createMinimalHost(): ts.FormatDiagnosticsHost {
  return {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n'
  };
}

function normalizeOutputLocation(workspaceRoot: string, location: SymbolLocation): SymbolLocation {
  return {
    ...location,
    filePath: relative(workspaceRoot, location.filePath).replaceAll('\\', '/')
  };
}

function toLineColumn(sourceFile: ts.SourceFile, position: number): { line: number; column: number } {
  const loc = sourceFile.getLineAndCharacterOfPosition(position);
  return {
    line: loc.line + 1,
    column: loc.character + 1
  };
}

function getTypeText(checker: ts.TypeChecker, node: ts.Node, explicitTypeNode?: ts.TypeNode): string {
  if (explicitTypeNode) {
    return explicitTypeNode.getText();
  }

  try {
    return checker.typeToString(checker.getTypeAtLocation(node));
  } catch {
    return 'unknown';
  }
}

function buildParametersSignature(node: ts.SignatureDeclaration, checker: ts.TypeChecker): string {
  return node.parameters
    .map((parameter) => {
      const name = parameter.name.getText();
      const type = getTypeText(checker, parameter, parameter.type);
      const optionalToken = parameter.questionToken ? '?' : '';
      const restToken = parameter.dotDotDotToken ? '...' : '';
      return `${restToken}${name}${optionalToken}: ${type}`;
    })
    .join(', ');
}

function resolveReturnTypeForSignatureNode(node: ts.SignatureDeclaration, checker: ts.TypeChecker): string {
  if (node.type) {
    return node.type.getText();
  }

  const declarationSignature = checker.getSignatureFromDeclaration(node);
  if (!declarationSignature) {
    return 'unknown';
  }

  return checker.typeToString(checker.getReturnTypeOfSignature(declarationSignature));
}

function buildOutlineSignature(node: ts.Node | undefined, checker: ts.TypeChecker, declarationKind: string): string | undefined {
  if (!node) {
    return undefined;
  }

  if (ts.isFunctionDeclaration(node)) {
    const name = node.name?.getText() ?? 'anonymous';
    const parameters = buildParametersSignature(node, checker);
    const returnType = resolveReturnTypeForSignatureNode(node, checker);
    return `function ${name}(${parameters}): ${returnType}`;
  }

  if (ts.isMethodDeclaration(node)) {
    const name = node.name.getText();
    const parameters = buildParametersSignature(node, checker);
    const returnType = resolveReturnTypeForSignatureNode(node, checker);
    return `method ${name}(${parameters}): ${returnType}`;
  }

  if (ts.isConstructorDeclaration(node)) {
    const parameters = buildParametersSignature(node, checker);
    return `constructor(${parameters})`;
  }

  if (ts.isClassDeclaration(node)) {
    const className = node.name?.getText() ?? 'anonymous';
    return `class ${className}`;
  }

  if (ts.isInterfaceDeclaration(node)) {
    return `interface ${node.name.getText()}`;
  }

  if (ts.isTypeAliasDeclaration(node)) {
    return `type ${node.name.getText()} = ${node.type.getText()}`;
  }

  if (ts.isEnumDeclaration(node)) {
    return `enum ${node.name.getText()}`;
  }

  if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isParameter(node)) {
    const prefix = declarationKind === 'property' ? 'property' : declarationKind;
    return `${prefix} ${node.name.getText()}: ${getTypeText(checker, node, node.type)}`;
  }

  return `${declarationKind} ${node.getText()}`;
}

function cleanSignatureText(signature?: string): string | undefined {
  if (!signature) {
    return signature;
  }

  return signature.replaceAll(String.raw`\u003c`, '<').replaceAll(String.raw`\u003e`, '>');
}

function normalizeSymbolKindFilters(options?: { symbolKinds?: string[] }): Set<string> | null {
  const rawKinds = options?.symbolKinds;
  if (!rawKinds || rawKinds.length === 0) {
    return null;
  }

  const normalizedKinds = rawKinds.map((kind) => kind.trim().toLowerCase()).filter((kind) => kind.length > 0);
  if (normalizedKinds.length === 0) {
    return null;
  }

  return new Set(normalizedKinds);
}

function filterOutlineItems(items: CollectedOutlineItem[], allowedKinds: Set<string> | null): CollectedOutlineItem[] {
  if (!allowedKinds) {
    return items;
  }

  return items.filter((item) => allowedKinds.has(item.kind.toLowerCase()));
}

function toFileOutlineItem(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  item: ts.NavigationTree
): CollectedOutlineItem | null {
  if (!item.nameSpan || item.nameSpan.start < 0 || item.nameSpan.length <= 0) {
    return null;
  }

  const startPosition = item.spans[0]?.start ?? item.nameSpan.start;
  const endPosition = (item.spans[0]?.start ?? item.nameSpan.start) + (item.spans[0]?.length ?? item.nameSpan.length);

  const start = toLineColumn(sourceFile, startPosition);
  const end = toLineColumn(sourceFile, endPosition);
  const declarationNode = findBestDeclarationNode(sourceFile, item.nameSpan.start);

  return {
    kind: item.kind,
    symbol: {
      name: item.text,
      startLine: start.line,
      startColumn: start.column,
      endLine: end.line,
      endColumn: end.column,
      signature: cleanSignatureText(buildOutlineSignature(declarationNode, checker, item.kind))
    }
  };
}

function resolveImplementationEntries(
  languageService: ts.LanguageService,
  sourceFilePath: string,
  offset: number
): readonly ts.ImplementationLocation[] {
  const directImplementations = languageService.getImplementationAtPosition(sourceFilePath, offset) ?? [];
  if (directImplementations.length > 0) {
    return directImplementations;
  }

  const definitions = languageService.getDefinitionAtPosition(sourceFilePath, offset) ?? [];
  const aggregated = new Map<string, ts.ImplementationLocation>();

  for (const definition of definitions) {
    const fromDefinition = languageService.getImplementationAtPosition(definition.fileName, definition.textSpan.start) ?? [];
    for (const implementation of fromDefinition) {
      const key = `${implementation.fileName}:${implementation.textSpan.start}:${implementation.textSpan.length}`;
      aggregated.set(key, implementation);
    }
  }

  return [...aggregated.values()];
}

function isDeclarationNode(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function findBestDeclarationNode(sourceFile: ts.SourceFile, position: number): ts.Node | undefined {
  let candidate: ts.Node | undefined;

  function visit(node: ts.Node): void {
    if (position < node.getFullStart() || position > node.getEnd()) {
      return;
    }

    if (isDeclarationNode(node)) {
      candidate = node;
    }

    node.forEachChild(visit);
  }

  visit(sourceFile);
  return candidate;
}

function resolveRelativeImportTarget(sourceFileAbsolute: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) {
    return null;
  }

  const basePath = resolve(dirname(sourceFileAbsolute), specifier);
  const extensionIndex = basePath.lastIndexOf('.');
  const hasKnownRuntimeExtension = ['.js', '.jsx', '.mjs', '.cjs'].some((extension) =>
    basePath.endsWith(extension)
  );
  const basePathWithoutExtension = hasKnownRuntimeExtension && extensionIndex > -1 ? basePath.slice(0, extensionIndex) : null;
  const candidates = [
    basePath,
    ...(basePathWithoutExtension
      ? [`${basePathWithoutExtension}.ts`, `${basePathWithoutExtension}.tsx`, `${basePathWithoutExtension}.d.ts`]
      : []),
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
    if (!existsSync(candidate)) {
      continue;
    }

    const stats = statSync(candidate);
    if (stats.isFile()) {
      return candidate;
    }
  }

  return null;
}

function extractImportSpecifiers(fileContent: string): string[] {
  const info = ts.preProcessFile(fileContent, true, true);
  return info.importedFiles.map((item) => item.fileName);
}

function resolveDependencyGraphOptions(options?: {
  maxDepth?: number;
  includeExternal?: boolean;
}): { maxDepth: number; includeExternal: boolean } {
  const maxDepth =
    typeof options?.maxDepth === 'number' && Number.isFinite(options.maxDepth)
      ? Math.max(1, Math.floor(options.maxDepth))
      : 5;

  return {
    maxDepth,
    includeExternal: options?.includeExternal === true
  };
}

function addEdge(
  edgeSet: Set<string>,
  edges: DependencyEdge[],
  from: string,
  to: string,
  kind: 'internal' | 'external'
): void {
  const edgeId = `${from}->${to}::${kind}`;
  if (edgeSet.has(edgeId)) {
    return;
  }

  edgeSet.add(edgeId);
  edges.push({ from, to, kind });
}

function handleInternalDependency(params: {
  workspaceRoot: string;
  currentRelativePath: string;
  internalTarget: string;
  dependencies: Set<string>;
  visited: Set<string>;
  queue: Array<{ absolutePath: string; depth: number }>;
  nextDepth: number;
  edgeSet: Set<string>;
  edges: DependencyEdge[];
}): void {
  const targetRelativePath = relative(params.workspaceRoot, params.internalTarget).replaceAll('\\', '/');
  params.dependencies.add(targetRelativePath);
  addEdge(params.edgeSet, params.edges, params.currentRelativePath, targetRelativePath, 'internal');

  if (params.visited.has(params.internalTarget)) {
    return;
  }

  params.visited.add(params.internalTarget);
  params.queue.push({ absolutePath: params.internalTarget, depth: params.nextDepth });
}

function handleExternalDependency(params: {
  includeExternal: boolean;
  specifier: string;
  currentRelativePath: string;
  externalDependencies: Set<string>;
  edgeSet: Set<string>;
  edges: DependencyEdge[];
}): void {
  if (!params.includeExternal) {
    return;
  }

  params.externalDependencies.add(params.specifier);
  addEdge(params.edgeSet, params.edges, params.currentRelativePath, params.specifier, 'external');
}

export function findDefinitionsBySymbol(
  workspaceRoot: string,
  filePath: string,
  symbol: string
): SymbolQueryResult {
  const resolvedFilePath = resolveTargetFilePath(workspaceRoot, filePath);
  const languageService = createLanguageService(workspaceRoot, resolvedFilePath);
  const sourceContent = readFileSync(resolvedFilePath, 'utf8');
  const offset = findSymbolOffset(sourceContent, symbol);

  const definitions = languageService.getDefinitionAtPosition(resolvedFilePath, offset) ?? [];

  const locations = definitions
    .map((definition) => {
      const sourceFile = languageService.getProgram()?.getSourceFile(definition.fileName);
      if (!sourceFile) {
        return undefined;
      }
      return toSymbolLocation(sourceFile, definition.textSpan);
    })
    .filter((value): value is SymbolLocation => Boolean(value))
    .map((location) => normalizeOutputLocation(workspaceRoot, location));

  return {
    symbol,
    sourceFilePath: relative(workspaceRoot, resolvedFilePath).replaceAll('\\', '/'),
    locations
  };
}

export function findReferencesBySymbol(
  workspaceRoot: string,
  filePath: string,
  symbol: string
): SymbolQueryResult {
  const resolvedFilePath = resolveTargetFilePath(workspaceRoot, filePath);
  const languageService = createLanguageService(workspaceRoot, resolvedFilePath);
  const sourceContent = readFileSync(resolvedFilePath, 'utf8');
  const offset = findSymbolOffset(sourceContent, symbol);

  const references = languageService.getReferencesAtPosition(resolvedFilePath, offset) ?? [];

  const locations = references
    .map((reference) => {
      const sourceFile = languageService.getProgram()?.getSourceFile(reference.fileName);
      if (!sourceFile) {
        return undefined;
      }
      return toSymbolLocation(sourceFile, reference.textSpan);
    })
    .filter((value): value is SymbolLocation => Boolean(value))
    .map((location) => normalizeOutputLocation(workspaceRoot, location));

  return {
    symbol,
    sourceFilePath: relative(workspaceRoot, resolvedFilePath).replaceAll('\\', '/'),
    locations
  };
}

export function findImplementationsBySymbol(
  workspaceRoot: string,
  filePath: string,
  symbol: string
): SymbolQueryResult {
  const resolvedFilePath = resolveTargetFilePath(workspaceRoot, filePath);
  const languageService = createLanguageService(workspaceRoot, resolvedFilePath);
  const sourceContent = readFileSync(resolvedFilePath, 'utf8');
  const offset = findSymbolOffset(sourceContent, symbol);

  const implementations = resolveImplementationEntries(languageService, resolvedFilePath, offset);

  const locations = implementations
    .map((implementation) => {
      const sourceFile = languageService.getProgram()?.getSourceFile(implementation.fileName);
      if (!sourceFile) {
        return undefined;
      }

      return toSymbolLocation(sourceFile, implementation.textSpan);
    })
    .filter((value): value is SymbolLocation => Boolean(value))
    .map((location) => normalizeOutputLocation(workspaceRoot, location));

  return {
    symbol,
    sourceFilePath: relative(workspaceRoot, resolvedFilePath).replaceAll('\\', '/'),
    locations
  };
}

export function getFileOutline(
  workspaceRoot: string,
  filePath: string,
  options?: { symbolKinds?: string[] }
): FileOutlineResult {
  const resolvedFilePath = resolveTargetFilePath(workspaceRoot, filePath);
  const languageService = createLanguageService(workspaceRoot, resolvedFilePath);
  const navTree = languageService.getNavigationTree(resolvedFilePath);
  const program = languageService.getProgram();
  const sourceFile = program?.getSourceFile(resolvedFilePath);
  const checker = program?.getTypeChecker();

  if (!sourceFile || !checker) {
    throw new Error(`unable to read source file: ${resolvedFilePath}`);
  }

  const allowedKinds = normalizeSymbolKindFilters(options);

  const allSymbols = (navTree.childItems ?? [])
    .map((item) => toFileOutlineItem(sourceFile, checker, item))
    .filter((item): item is CollectedOutlineItem => Boolean(item));
  const symbols = filterOutlineItems(allSymbols, allowedKinds);
  const symbolsByKind: Record<string, FileOutlineItem[]> = {};

  for (const item of symbols) {
    const kindBucket = symbolsByKind[item.kind] ?? [];
    kindBucket.push(item.symbol);
    symbolsByKind[item.kind] = kindBucket;
  }

  return {
    filePath: relative(workspaceRoot, resolvedFilePath).replaceAll('\\', '/'),
    appliedKinds: allowedKinds ? [...allowedKinds] : [],
    symbolsByKind
  };
}

export function getSymbolContent(
  workspaceRoot: string,
  filePath: string,
  symbol: string
): SymbolContentResult {
  const resolvedFilePath = resolveTargetFilePath(workspaceRoot, filePath);
  const languageService = createLanguageService(workspaceRoot, resolvedFilePath);
  const sourceContent = readFileSync(resolvedFilePath, 'utf8');
  const offset = findSymbolOffset(sourceContent, symbol);

  const definitions = languageService.getDefinitionAtPosition(resolvedFilePath, offset) ?? [];
  const targetDefinition = definitions[0];

  if (!targetDefinition) {
    throw new Error(`no definition found for symbol: ${symbol}`);
  }

  const sourceFile = languageService.getProgram()?.getSourceFile(targetDefinition.fileName);
  if (!sourceFile) {
    throw new Error(`unable to resolve definition file: ${targetDefinition.fileName}`);
  }

  const declarationNode = findBestDeclarationNode(sourceFile, targetDefinition.textSpan.start);
  const node = declarationNode ?? sourceFile;

  const start = toLineColumn(sourceFile, node.getStart(sourceFile));
  const end = toLineColumn(sourceFile, node.getEnd());

  return {
    symbol,
    sourceFilePath: relative(workspaceRoot, resolvedFilePath).replaceAll('\\', '/'),
    declarationFilePath: relative(workspaceRoot, sourceFile.fileName).replaceAll('\\', '/'),
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
    content: node.getText(sourceFile)
  };
}

export function getDependencyGraph(
  workspaceRoot: string,
  filePath: string,
  options?: { maxDepth?: number; includeExternal?: boolean }
): DependencyGraphResult {
  const resolvedFilePath = resolveTargetFilePath(workspaceRoot, filePath);
  const normalizedRootFilePath = relative(workspaceRoot, resolvedFilePath).replaceAll('\\', '/');

  const { maxDepth, includeExternal } = resolveDependencyGraphOptions(options);

  const queue: Array<{ absolutePath: string; depth: number }> = [{ absolutePath: resolvedFilePath, depth: 0 }];
  const visited = new Set<string>([resolvedFilePath]);
  const dependencies = new Set<string>();
  const externalDependencies = new Set<string>();
  const edgeSet = new Set<string>();
  const edges: DependencyEdge[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    if (current.depth >= maxDepth) {
      continue;
    }

    const currentContent = readFileSync(current.absolutePath, 'utf8');
    const currentImportSpecifiers = extractImportSpecifiers(currentContent);
    const currentRelativePath = relative(workspaceRoot, current.absolutePath).replaceAll('\\', '/');
    const nextDepth = current.depth + 1;

    for (const specifier of currentImportSpecifiers) {
      const internalTarget = resolveRelativeImportTarget(current.absolutePath, specifier);
      if (!internalTarget) {
        handleExternalDependency({
          includeExternal,
          specifier,
          currentRelativePath,
          externalDependencies,
          edgeSet,
          edges
        });
        continue;
      }

      handleInternalDependency({
        workspaceRoot,
        currentRelativePath,
        internalTarget,
        dependencies,
        visited,
        queue,
        nextDepth,
        edgeSet,
        edges
      });
    }
  }

  dependencies.delete(normalizedRootFilePath);

  return {
    rootFilePath: normalizedRootFilePath,
    maxDepth,
    dependencies: [...dependencies].sort((left, right) => left.localeCompare(right)),
    externalDependencies: [...externalDependencies].sort((left, right) => left.localeCompare(right)),
    edges
  };
}
