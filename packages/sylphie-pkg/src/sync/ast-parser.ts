/**
 * ast-parser.ts -- TypeScript AST extraction using ts-morph.
 *
 * Parses TypeScript source files and extracts structured metadata about
 * functions, methods, types, interfaces, enums, classes, imports,
 * decorators, class hierarchy, constructor injection, call sites, and
 * type references.
 *
 * Used by the sync pipeline to detect what changed and what to write
 * to the codebase PKG.
 *
 * Parsing is best-effort: files that fail to parse are logged and skipped
 * rather than crashing the whole pipeline.
 */

import {
  Project,
  SourceFile,
  Node,
  type ArrowFunction,
  type FunctionExpression,
} from 'ts-morph';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface ParsedArgument {
  name: string;
  type: string;
}

export interface ParsedDecorator {
  name: string;
  args: string[];
}

export interface ParsedFunction {
  name: string;
  filePath: string;
  lineNumber: number;
  endLine: number;
  args: ParsedArgument[];
  returnType: string;
  jsDoc: string;
  bodyText: string;
  isExported: boolean;
  isAsync: boolean;
  decorators: ParsedDecorator[];
  /** HTTP method if this is a NestJS endpoint (GET, POST, etc.) */
  httpMethod?: string;
  /** Full route path if this is a NestJS endpoint */
  routePath?: string;
  /** Function names called within this function's body */
  callees: string[];
  /** Type names referenced in args + return type */
  typeRefs: string[];
  /** SHA-256 hash of the full source text — single comparison detects any change */
  contentHash: string;
}

export interface ParsedProperty {
  name: string;
  type: string;
}

export interface ParsedConstructorParam {
  name: string;
  type: string;
  injectToken?: string;
}

export interface ParsedType {
  name: string;
  filePath: string;
  lineNumber: number;
  kind: 'interface' | 'type' | 'enum' | 'class';
  properties: ParsedProperty[];
  bodyText: string;
  comment: string;
  decorators: ParsedDecorator[];
  /** Parent class name (for classes with extends) */
  extends?: string;
  /** Implemented interface names (for classes) */
  implements: string[];
  /** Constructor parameters with DI tokens (for classes) */
  constructorParams: ParsedConstructorParam[];
  /** SHA-256 hash of the full source text — single comparison detects any change */
  contentHash: string;
}

export interface ParsedImport {
  fromFile: string;
  importedNames: string[];
  moduleSpecifier: string;
}

export interface ParsedFile {
  filePath: string;
  functions: ParsedFunction[];
  types: ParsedType[];
  imports: ParsedImport[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute a truncated SHA-256 hash (first 16 hex chars = 64 bits).
 * Used for fast change detection: if the hash differs, something changed.
 */
function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

const REPO_ROOT = 'C:/Users/Jim/OneDrive/Desktop/Code/sylphie';

/**
 * Resolve the tsconfig to use for a given file path.
 */
function findTsConfig(filePath: string): string | undefined {
  const normalised = filePath.replace(/\\/g, '/');
  let dir = path.dirname(normalised);
  const root = REPO_ROOT.replace(/\\/g, '/');

  while (dir.startsWith(root) && dir !== root) {
    const candidate = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    dir = path.dirname(dir);
  }
  return undefined;
}

/**
 * Extract the first JSDoc comment attached to a node, if any.
 */
function extractJsDoc(node: Node): string {
  if (Node.isJSDocable(node)) {
    const docs = node.getJsDocs();
    if (docs.length > 0) {
      return docs.map(d => d.getDescription().trim()).filter(Boolean).join('\n');
    }
  }
  return '';
}

/**
 * Extract parameters from a function-like declaration node.
 */
function extractArgsFromNode(
  node: { getParameters(): Array<{ getName(): string; getTypeNode(): { getText(): string } | undefined }> }
): ParsedArgument[] {
  return node.getParameters().map(p => ({
    name: p.getName(),
    type: p.getTypeNode()?.getText() ?? 'unknown',
  }));
}

/**
 * Safely get the body text of a function-like node.
 */
function extractBodyText(
  node: { getBody?(): { getText(): string } | undefined }
): string {
  try {
    const body = node.getBody?.();
    return body ? body.getText().slice(0, 8000) : '';
  } catch {
    return '';
  }
}

/**
 * Extract decorators from a node that supports them.
 */
function extractDecorators(
  node: { getDecorators(): Array<{ getName(): string; getArguments(): Array<{ getText(): string }> }> }
): ParsedDecorator[] {
  try {
    return node.getDecorators().map(d => ({
      name: d.getName(),
      args: d.getArguments().map(a => a.getText().replace(/^['"]|['"]$/g, '')),
    }));
  } catch {
    return [];
  }
}

// NestJS HTTP method decorators → HTTP verb mapping
const HTTP_DECORATORS: Record<string, string> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  Head: 'HEAD',
  Options: 'OPTIONS',
  All: 'ALL',
};

/**
 * Extract HTTP endpoint info from method decorators + controller prefix.
 */
function extractEndpointInfo(
  decorators: ParsedDecorator[],
  controllerPrefix: string | undefined,
): { httpMethod?: string; routePath?: string } {
  for (const dec of decorators) {
    const verb = HTTP_DECORATORS[dec.name];
    if (verb) {
      const subPath = dec.args[0] ?? '';
      const prefix = controllerPrefix ?? '';
      // Build full route: /prefix/subPath
      const parts = [prefix, subPath].filter(Boolean);
      const routePath = '/' + parts.join('/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
      return { httpMethod: verb, routePath };
    }
  }
  return {};
}

/**
 * Extract call site names from a function body.
 *
 * Walks all CallExpression descendants and extracts the callee name.
 * Handles: foo(), this.foo(), Bar.foo(), this.service.method().
 * Returns deduplicated callee names.
 */
function extractCallees(
  node: { getBody?(): Node | undefined }
): string[] {
  const callees = new Set<string>();
  try {
    const body = node.getBody?.();
    if (!body) return [];

    body.forEachDescendant((child) => {
      if (!Node.isCallExpression(child)) return;
      const expr = child.getExpression();
      const text = expr.getText();

      // Skip very long expressions (chained calls, complex expressions)
      if (text.length > 80) return;

      // Extract meaningful callee name:
      // this.foo() → foo
      // this.service.method() → service.method
      // Bar.create() → Bar.create
      // foo() → foo
      let callee = text;
      if (callee.startsWith('this.')) {
        callee = callee.slice(5);
      }
      // Skip internal JS methods, constructors, and trivial calls
      if (callee.includes('(') || callee.includes('[')) return;
      if (['console.log', 'console.warn', 'console.error', 'console.debug',
           'Math.max', 'Math.min', 'Math.abs', 'Math.round', 'Math.floor',
           'Math.ceil', 'Math.random', 'Math.log', 'Math.sqrt', 'Math.pow',
           'JSON.stringify', 'JSON.parse',
           'Object.keys', 'Object.values', 'Object.entries', 'Object.assign',
           'Array.isArray', 'Array.from',
           'String', 'Number', 'Boolean', 'parseInt', 'parseFloat',
           'Date.now', 'Promise.all', 'Promise.resolve', 'Promise.reject',
           'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
          ].includes(callee)) return;

      callees.add(callee);
    });
  } catch {
    // Body traversal failure — return empty
  }
  return Array.from(callees);
}

/**
 * Extract type names referenced in function args and return type.
 */
function extractTypeRefs(args: ParsedArgument[], returnType: string): string[] {
  const refs = new Set<string>();
  const typePattern = /\b([A-Z][A-Za-z0-9]+)\b/g;

  for (const arg of args) {
    let match;
    while ((match = typePattern.exec(arg.type)) !== null) {
      const name = match[1]!;
      if (!BUILTIN_TYPES.has(name)) refs.add(name);
    }
  }

  // Also extract from return type
  let match;
  const rtPattern = /\b([A-Z][A-Za-z0-9]+)\b/g;
  while ((match = rtPattern.exec(returnType)) !== null) {
    const name = match[1]!;
    if (!BUILTIN_TYPES.has(name)) refs.add(name);
  }

  return Array.from(refs);
}

const BUILTIN_TYPES = new Set([
  'Array', 'Map', 'Set', 'Record', 'Promise', 'Partial', 'Required', 'Readonly',
  'Pick', 'Omit', 'Exclude', 'Extract', 'NonNullable', 'ReturnType', 'InstanceType',
  'Parameters', 'ConstructorParameters', 'Awaited', 'ReadonlyArray', 'ReadonlyMap',
  'ReadonlySet', 'WeakMap', 'WeakSet', 'Buffer', 'Date', 'RegExp', 'Error',
  'String', 'Number', 'Boolean', 'Object', 'Symbol', 'Function', 'Uint8Array',
  'Int8Array', 'Float32Array', 'Float64Array', 'ArrayBuffer', 'SharedArrayBuffer',
  'JSX', 'React', 'Element',
]);

// ---------------------------------------------------------------------------
// Extraction: functions
// ---------------------------------------------------------------------------

/**
 * Extract functions (declarations, exported arrow functions, class methods).
 */
function extractFunctions(sourceFile: SourceFile, filePath: string): ParsedFunction[] {
  const results: ParsedFunction[] = [];

  // Named function declarations
  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName();
    if (!name) continue;
    const decorators = extractDecorators(fn as any);
    const args = extractArgsFromNode(fn);
    const returnType = fn.getReturnTypeNode()?.getText() ?? fn.getReturnType().getText().slice(0, 120);
    results.push({
      name,
      filePath,
      lineNumber: fn.getStartLineNumber(),
      endLine: fn.getEndLineNumber(),
      args,
      returnType,
      jsDoc: extractJsDoc(fn),
      bodyText: extractBodyText(fn),
      isExported: fn.isExported(),
      isAsync: fn.isAsync(),
      decorators,
      callees: extractCallees(fn),
      typeRefs: extractTypeRefs(args, returnType),
      contentHash: sha256(fn.getText()),
    });
  }

  // Arrow functions and function expressions assigned to variables
  for (const varDecl of sourceFile.getVariableDeclarations()) {
    const initializer = varDecl.getInitializer();
    if (!initializer) continue;

    const isArrow = Node.isArrowFunction(initializer);
    const isFuncExpr = Node.isFunctionExpression(initializer);
    if (!isArrow && !isFuncExpr) continue;

    const fnNode = initializer as ArrowFunction | FunctionExpression;
    const name = varDecl.getName();
    const parentStatement = varDecl.getParent()?.getParent();
    const isExported =
      parentStatement && Node.isVariableStatement(parentStatement)
        ? parentStatement.isExported()
        : false;

    const args = extractArgsFromNode(fnNode);
    const returnType = fnNode.getReturnTypeNode()?.getText() ?? fnNode.getReturnType().getText().slice(0, 120);
    results.push({
      name,
      filePath,
      lineNumber: fnNode.getStartLineNumber(),
      endLine: fnNode.getEndLineNumber(),
      args,
      returnType,
      jsDoc: extractJsDoc(varDecl.getParent()?.getParent() ?? varDecl),
      bodyText: extractBodyText(fnNode),
      isExported,
      isAsync: fnNode.isAsync(),
      decorators: [],
      callees: extractCallees(fnNode),
      typeRefs: extractTypeRefs(args, returnType),
      contentHash: sha256(fnNode.getText()),
    });
  }

  // Methods inside classes
  for (const cls of sourceFile.getClasses()) {
    const className = cls.getName() ?? 'AnonymousClass';

    // Get @Controller('prefix') for route resolution
    const classDecorators = extractDecorators(cls as any);
    const controllerDec = classDecorators.find(d => d.name === 'Controller');
    const controllerPrefix = controllerDec?.args[0];

    for (const method of cls.getMethods()) {
      const name = method.getName();
      const decorators = extractDecorators(method as any);
      const args = extractArgsFromNode(method);
      const returnType = method.getReturnTypeNode()?.getText() ?? method.getReturnType().getText().slice(0, 120);

      const { httpMethod, routePath } = extractEndpointInfo(decorators, controllerPrefix);

      results.push({
        name: `${className}.${name}`,
        filePath,
        lineNumber: method.getStartLineNumber(),
        endLine: method.getEndLineNumber(),
        args,
        returnType,
        jsDoc: extractJsDoc(method),
        bodyText: extractBodyText(method),
        isExported: cls.isExported(),
        isAsync: method.isAsync(),
        decorators,
        httpMethod,
        routePath,
        callees: extractCallees(method),
        typeRefs: extractTypeRefs(args, returnType),
        contentHash: sha256(method.getText()),
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Extraction: types
// ---------------------------------------------------------------------------

/**
 * Extract type-level constructs: interfaces, type aliases, enums, classes.
 */
function extractTypes(sourceFile: SourceFile, filePath: string): ParsedType[] {
  const results: ParsedType[] = [];

  // Interfaces
  for (const iface of sourceFile.getInterfaces()) {
    const properties = iface.getProperties().map(p => ({
      name: p.getName(),
      type: p.getTypeNode()?.getText() ?? 'unknown',
    }));
    results.push({
      name: iface.getName(),
      filePath,
      lineNumber: iface.getStartLineNumber(),
      kind: 'interface',
      properties,
      bodyText: iface.getText().slice(0, 8000),
      comment: extractJsDoc(iface),
      decorators: [],
      implements: [],
      constructorParams: [],
      contentHash: sha256(iface.getText()),
    });
  }

  // Type aliases
  for (const typeAlias of sourceFile.getTypeAliases()) {
    results.push({
      name: typeAlias.getName(),
      filePath,
      lineNumber: typeAlias.getStartLineNumber(),
      kind: 'type',
      properties: [],
      bodyText: typeAlias.getText().slice(0, 8000),
      comment: extractJsDoc(typeAlias),
      decorators: [],
      implements: [],
      constructorParams: [],
      contentHash: sha256(typeAlias.getText()),
    });
  }

  // Enums
  for (const enumDecl of sourceFile.getEnums()) {
    const properties = enumDecl.getMembers().map(m => ({
      name: m.getName(),
      type: String(m.getValue() ?? ''),
    }));
    results.push({
      name: enumDecl.getName(),
      filePath,
      lineNumber: enumDecl.getStartLineNumber(),
      kind: 'enum',
      properties,
      bodyText: enumDecl.getText().slice(0, 8000),
      comment: extractJsDoc(enumDecl),
      decorators: [],
      implements: [],
      constructorParams: [],
      contentHash: sha256(enumDecl.getText()),
    });
  }

  // Classes — structural metadata + hierarchy + DI
  for (const cls of sourceFile.getClasses()) {
    const name = cls.getName();
    if (!name) continue;
    const properties = cls.getProperties().map(p => ({
      name: p.getName(),
      type: p.getTypeNode()?.getText() ?? 'unknown',
    }));

    // Class hierarchy
    const extendsClause = cls.getExtends();
    const extendsName = extendsClause?.getText()?.split('<')[0]?.trim();

    const implementsNames: string[] = [];
    for (const impl of cls.getImplements()) {
      const implName = impl.getText().split('<')[0]?.trim();
      if (implName) implementsNames.push(implName);
    }

    // Constructor DI parameters
    const constructorParams: ParsedConstructorParam[] = [];
    const ctors = cls.getConstructors();
    if (ctors.length > 0) {
      const ctor = ctors[0]!;
      for (const param of ctor.getParameters()) {
        const paramName = param.getName();
        const paramType = param.getTypeNode()?.getText() ?? 'unknown';

        // Check for @Inject() decorator token
        let injectToken: string | undefined;
        try {
          const paramDecorators = param.getDecorators();
          const injectDec = paramDecorators.find(d => d.getName() === 'Inject');
          if (injectDec) {
            const tokenArg = injectDec.getArguments()[0];
            injectToken = tokenArg?.getText();
          }
        } catch {
          // Decorator extraction failed — skip
        }

        constructorParams.push({ name: paramName, type: paramType, injectToken });
      }
    }

    const decorators = extractDecorators(cls as any);

    results.push({
      name,
      filePath,
      lineNumber: cls.getStartLineNumber(),
      kind: 'class',
      properties,
      bodyText: cls.getText().slice(0, 8000),
      comment: extractJsDoc(cls),
      decorators,
      extends: extendsName,
      implements: implementsNames,
      constructorParams,
      contentHash: sha256(cls.getText()),
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Extraction: imports
// ---------------------------------------------------------------------------

/**
 * Extract import statements from a source file.
 */
function extractImports(sourceFile: SourceFile, filePath: string): ParsedImport[] {
  const results: ParsedImport[] = [];
  for (const importDecl of sourceFile.getImportDeclarations()) {
    const moduleSpecifier = importDecl.getModuleSpecifierValue();
    const named = importDecl.getNamedImports().map(n => n.getName());
    const defaultImport = importDecl.getDefaultImport()?.getText();
    const namespaceImport = importDecl.getNamespaceImport()?.getText();

    const importedNames: string[] = [];
    if (defaultImport) importedNames.push(defaultImport);
    if (namespaceImport) importedNames.push(`* as ${namespaceImport}`);
    importedNames.push(...named);

    results.push({ fromFile: filePath, importedNames, moduleSpecifier });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Project cache — reuse ts-morph Project instances keyed by tsconfig path
// ---------------------------------------------------------------------------

const _projectCache = new Map<string, Project>();

function getProject(tsConfigPath: string | undefined): Project {
  const key = tsConfigPath ?? '__no_tsconfig__';
  if (!_projectCache.has(key)) {
    const project = tsConfigPath
      ? new Project({
          tsConfigFilePath: tsConfigPath,
          skipAddingFilesFromTsConfig: true,
          skipFileDependencyResolution: true,
        })
      : new Project({
          compilerOptions: { target: 99, module: 1, strict: true, esModuleInterop: true },
          skipFileDependencyResolution: true,
        });
    _projectCache.set(key, project);
  }
  return _projectCache.get(key)!;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse an array of TypeScript file paths and return structured AST data.
 *
 * Files that fail to parse are logged to stderr and skipped — the pipeline
 * continues with the remaining files.
 *
 * @param filePaths - Absolute paths to .ts or .tsx files.
 * @returns One ParsedFile per successfully parsed input file.
 */
export function parseFiles(filePaths: string[]): ParsedFile[] {
  const results: ParsedFile[] = [];

  for (const rawPath of filePaths) {
    const filePath = rawPath.replace(/\\/g, '/');
    try {
      const tsConfigPath = findTsConfig(filePath);
      const project = getProject(tsConfigPath);

      let sourceFile: SourceFile | undefined = project.getSourceFile(filePath);
      if (!sourceFile) {
        sourceFile = project.addSourceFileAtPath(filePath);
      }

      results.push({
        filePath,
        functions: extractFunctions(sourceFile, filePath),
        types: extractTypes(sourceFile, filePath),
        imports: extractImports(sourceFile, filePath),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[ast-parser] WARNING: skipping ${filePath} — ${msg}\n`);
    }
  }

  return results;
}

/**
 * Parse a single TypeScript file. Convenience wrapper around parseFiles.
 */
export function parseFile(filePath: string): ParsedFile | null {
  const results = parseFiles([filePath]);
  return results.length > 0 ? results[0] : null;
}

/**
 * Clear the internal ts-morph Project cache.
 * Call this between large batches if memory is a concern.
 */
export function clearProjectCache(): void {
  _projectCache.clear();
}
