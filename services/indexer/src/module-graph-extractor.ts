import { extname } from 'node:path';
import ts from 'typescript';
import type { UnresolvedDependency, UnresolvedReason } from '../../code-intel-mcp/src/contracts.ts';

/** One name a `export … from` statement republishes. */
export interface ReExportedName {
  /** Name in the TARGET module, or `*` when the whole module passes through. */
  source: string;
  /**
   * Name this module publishes it under. `*` means the target's own names are kept
   * (`export * from`), which is the only form where the set is not known statically.
   */
  exported: string;
}

/** One dependency edge candidate: a literal specifier plus the names it pulls in. */
export interface ModuleImportRef {
  /** Specifier text exactly as written in the source. */
  specifier: string;
  /**
   * Binding names as the TARGET module knows them (`{ original as alias }` records
   * `original`), or `*` when the whole module is depended upon.
   */
  importedSymbols: string[];
  /**
   * Present only when this edge is a re-export (`export … from`), and then it says
   * exactly which of the target's names travel onwards and under which name. An
   * impact walk needs that: a barrel that re-exports a changed symbol passes the
   * change to ITS importers, while a file that merely uses the symbol does not pass
   * that particular name on at all. Absent means "an ordinary import" — the importer
   * consumes the module in its own code.
   */
  reExports?: ReExportedName[];
}

export interface ModuleGraphFacts {
  imports: ModuleImportRef[];
  /**
   * Source text of `import()` / `require()` arguments that are not string literals
   * (a template with substitutions, a variable). These are dependencies no static
   * analysis can name, so they are reported rather than dropped.
   */
  dynamicSpecifiers: string[];
  /** Names this file exports, read off the parse tree. */
  exports: string[];
}

/** A non-literal specifier is quoted back to the caller; keep the quote compact. */
const MAX_DYNAMIC_SPECIFIER_LENGTH = 80;

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
    case '.mjs':
    case '.cjs':
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
function bindingSymbols(elements: readonly ts.ImportSpecifier[] | readonly ts.ExportSpecifier[]): string[] {
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
 * What a `export … from` statement republishes, target name by target name. The two
 * wildcard forms differ in a way an impact walk cares about: `export * from 'x'` lets
 * the target's names through unchanged, so a change to `Foo` arrives at the importers
 * as a change to `Foo`, while `export * as ns from 'x'` collapses the whole module into
 * one binding, so any change to it is a change to `ns`.
 */
function reExportedNames(clause: ts.NamedExportBindings | undefined): ReExportedName[] {
  if (!clause) {
    return [{ source: '*', exported: '*' }];
  }

  if (ts.isNamespaceExport(clause)) {
    return [{ source: '*', exported: clause.name.text }];
  }

  return clause.elements.map((element) => ({
    source: (element.propertyName ?? element.name).text,
    exported: element.name.text
  }));
}

/**
 * Any call to an identifier named `require`. Without a type-checker that is all a
 * module graph can know, and it is the same rule `ts.preProcessFile` applied — a
 * locally defined `require` would contribute an edge it does not really have.
 */
function isRequireCall(node: ts.CallExpression): boolean {
  return ts.isIdentifier(node.expression) && node.expression.text === 'require';
}

function isImportCall(node: ts.CallExpression): boolean {
  return node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

/**
 * The name an `import('./m').Outer.Inner` type reaches into the target for: the
 * LEFTMOST identifier, because `Inner` is a member of the export `Outer` rather than an
 * export of its own.
 */
function leftmostEntityName(name: ts.EntityName): string {
  let current: ts.EntityName = name;
  while (ts.isQualifiedName(current)) {
    current = current.left;
  }
  return current.text;
}

/**
 * JSDoc is the type system of a JavaScript file, so `@type {import('./m').T}` there is
 * a dependency `tsc` follows. In a `.ts` file the checker ignores JSDoc types, so
 * following one would invent an edge the compiler does not have.
 */
function parsesJsDocTypes(scriptKind: ts.ScriptKind): boolean {
  return scriptKind === ts.ScriptKind.JS || scriptKind === ts.ScriptKind.JSX;
}

/**
 * One compact line, capped: this text is quoted back in tool payloads. `getText` needs
 * the source file explicitly because the tree is parsed without parent pointers.
 */
function dynamicSpecifierText(sourceFile: ts.SourceFile, node: ts.Node): string {
  const raw = node.getText(sourceFile).replace(/\s+/g, ' ').trim();
  return raw.length > MAX_DYNAMIC_SPECIFIER_LENGTH ? `${raw.slice(0, MAX_DYNAMIC_SPECIFIER_LENGTH)}...` : raw;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

function isExported(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function isDefaultExported(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.DefaultKeyword);
}

/** Every name a binding pattern introduces: `const { a, b: c } = x` exports `a` and `c`. */
function bindingNames(name: ts.BindingName, into: string[]): void {
  if (ts.isIdentifier(name)) {
    into.push(name.text);
    return;
  }

  for (const element of name.elements) {
    if (ts.isBindingElement(element)) {
      bindingNames(element.name, into);
    }
  }
}

function collectDeclarationExports(statement: ts.Statement, into: string[]): void {
  if (!isExported(statement)) {
    return;
  }

  // `export default class Widget {}` is exported as `default`, never as `Widget`.
  if (isDefaultExported(statement)) {
    into.push('default');
    return;
  }

  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      bindingNames(declaration.name, into);
    }
    return;
  }

  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement) ||
    ts.isImportEqualsDeclaration(statement)
  ) {
    const name = statement.name;
    if (name !== undefined && ts.isIdentifier(name)) {
      into.push(name.text);
    }
  }
}

function collectExportStatement(statement: ts.Statement, into: string[]): void {
  if (ts.isExportAssignment(statement)) {
    // `export = handler` exports the entity itself; `export default x` exports `default`.
    if (statement.isExportEquals !== true) {
      into.push('default');
      return;
    }

    if (ts.isIdentifier(statement.expression)) {
      into.push(statement.expression.text);
    }
    return;
  }

  if (!ts.isExportDeclaration(statement)) {
    return;
  }

  const clause = statement.exportClause;
  if (!clause) {
    // `export * from 'x'` re-exports names only the target module knows.
    return;
  }

  if (ts.isNamespaceExport(clause)) {
    into.push(clause.name.text);
    return;
  }

  // Here the exported name is the ALIAS (`{ source as fromModule }` exports `fromModule`),
  // the mirror image of the import side, which records the target's own name.
  for (const element of clause.elements) {
    into.push(element.name.text);
  }
}

/**
 * Imports, re-exports and exports of one file, from a single parse.
 *
 * Both module-graph engines read this: `impactedFiles` needs the reverse edges and the
 * export names, `dependencyGraph` the forward edges — and when they disagreed (a regex
 * on one side, `ts.preProcessFile` on the other) the two tools answered differently
 * about the same repository. Imports are collected from the WHOLE tree, so a
 * `require()` in a nested closure or an import inside a `declare module` body counts;
 * exports are read from the top-level statements only, so a name exported from inside a
 * `namespace` body — which is not a module export — does not.
 */
export function extractModuleGraph(fileName: string, sourceText: string): ModuleGraphFacts {
  const scriptKind = scriptKindFor(fileName);
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    // Parent pointers cost time to set and nothing here walks upwards.
    false,
    scriptKind
  );
  const readJsDoc = parsesJsDocTypes(scriptKind);

  const imports: ModuleImportRef[] = [];
  const dynamicSpecifiers: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      imports.push({
        specifier: node.moduleSpecifier.text,
        importedSymbols: importClauseSymbols(node.importClause)
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      imports.push({
        specifier: node.moduleSpecifier.text,
        importedSymbols: exportClauseSymbols(node.exportClause),
        reExports: reExportedNames(node.exportClause)
      });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      imports.push({ specifier: node.moduleReference.expression.text, importedSymbols: ['*'] });
    } else if (ts.isCallExpression(node) && (isImportCall(node) || isRequireCall(node))) {
      const argument = node.arguments[0];
      if (argument !== undefined) {
        if (ts.isStringLiteralLike(argument)) {
          imports.push({ specifier: argument.text, importedSymbols: ['*'] });
        } else {
          dynamicSpecifiers.push(dynamicSpecifierText(sourceFile, argument));
        }
      }
    } else if (ts.isImportTypeNode(node)) {
      // `type X = import('./m').Y` and `typeof import('./m')`. A dependency named only
      // in a type position is still a dependency: it breaks when the target moves, and
      // it is what the file has to be re-checked against when the target changes.
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal)) {
        imports.push({
          specifier: argument.literal.text,
          importedSymbols: node.qualifier === undefined ? ['*'] : [leftmostEntityName(node.qualifier)]
        });
      } else {
        dynamicSpecifiers.push(dynamicSpecifierText(sourceFile, argument));
      }
    }

    // `forEachChild` does not descend into JSDoc, so the comments have to be visited
    // explicitly; from the JSDoc node itself the ordinary walk reaches the type nodes.
    if (readJsDoc) {
      const jsDoc = (node as { jsDoc?: ts.Node[] }).jsDoc;
      if (jsDoc !== undefined) {
        for (const comment of jsDoc) {
          comment.forEachChild(visit);
        }
      }
    }

    node.forEachChild(visit);
  }

  visit(sourceFile);

  const exported: string[] = [];
  for (const statement of sourceFile.statements) {
    collectDeclarationExports(statement, exported);
    collectExportStatement(statement, exported);
  }

  return { imports, dynamicSpecifiers, exports: [...new Set(exported)] };
}

export interface UnresolvedCollector {
  add(from: string, specifier: string, reason: UnresolvedReason): void;
  /** Distinct `(from, specifier, reason)` triples seen, sample or no sample. */
  readonly count: number;
  /** The first `limit` of them, in the order they were found. */
  readonly sample: UnresolvedDependency[];
}

/**
 * Collects what a module graph could not follow, counting everything and keeping only
 * the first `limit` entries: a result payload is read by an agent that pays for every
 * token, so the count carries the completeness signal and the sample carries the
 * evidence. Both graph engines report through this, so their answers use one vocabulary.
 */
export function createUnresolvedCollector(limit: number): UnresolvedCollector {
  const seen = new Set<string>();
  const sample: UnresolvedDependency[] = [];

  return {
    add(from: string, specifier: string, reason: UnresolvedReason): void {
      // A NUL separator keeps the key unambiguous: no path or specifier can contain one.
      const key = `${from}\u0000${specifier}\u0000${reason}`;
      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      if (sample.length < limit) {
        sample.push({ from, specifier, reason });
      }
    },
    get count(): number {
      return seen.size;
    },
    get sample(): UnresolvedDependency[] {
      return sample;
    }
  };
}
