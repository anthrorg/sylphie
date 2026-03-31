/**
 * mutation-builder.ts -- Convert a graph diff changeset into executable Cypher.
 *
 * Takes the structured Changeset from graph-differ and produces an array of
 * {cypher, params} pairs that can be run inside a single Neo4j write transaction.
 *
 * Conventions:
 * - MERGE on (filePath, name) for Function and Type nodes — idempotent.
 * - DETACH DELETE for removals — cleans up dangling edges automatically.
 * - MERGE for IMPORTS edges keyed on (fromFile, moduleSpecifier).
 * - All property values are passed as params, never interpolated into the
 *   Cypher string, to prevent injection and enable query plan caching.
 */

import type { Changeset, NodeCreate, NodeUpdate, NodeDelete, EdgeAdd, EdgeRemove } from './graph-differ.js';
import type { ParsedFunction, ParsedType } from './ast-parser.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CypherStatement {
  cypher: string;
  params: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Function node mutations
// ---------------------------------------------------------------------------

function buildFunctionCreate(fn: ParsedFunction): CypherStatement[] {
  const stmts: CypherStatement[] = [];

  // 1. Function metadata node (lightweight — no bodyText)
  stmts.push({
    cypher: `
      MERGE (f:Function {filePath: $filePath, name: $name})
      SET f.lineNumber   = $lineNumber,
          f.endLine      = $endLine,
          f.returnType   = $returnType,
          f.jsDoc        = $jsDoc,
          f.isExported   = $isExported,
          f.isAsync      = $isAsync,
          f.domain       = coalesce(f.domain, 'unclassified'),
          f.args         = $args,
          f.decorators   = $decorators,
          f.httpMethod   = $httpMethod,
          f.routePath    = $routePath,
          f.contentHash  = $contentHash,
          f.updatedAt    = timestamp()
      WITH f
      MATCH (m:Module {filePath: $filePath})
      MERGE (m)-[:CONTAINS]->(f)
    `.trim(),
    params: {
      filePath: fn.filePath,
      name: fn.name,
      lineNumber: fn.lineNumber,
      endLine: fn.endLine,
      returnType: fn.returnType,
      jsDoc: fn.jsDoc,
      isExported: fn.isExported,
      isAsync: fn.isAsync,
      args: JSON.stringify(fn.args),
      decorators: fn.decorators.length > 0 ? JSON.stringify(fn.decorators) : null,
      httpMethod: fn.httpMethod ?? null,
      routePath: fn.routePath ?? null,
      contentHash: fn.contentHash,
    },
  });

  // 2. CodeBlock node with pure source code, connected via HAS_CODE
  if (fn.bodyText) {
    stmts.push({
      cypher: `
        MATCH (f:Function {filePath: $filePath, name: $name})
        MERGE (f)-[:HAS_CODE]->(cb:CodeBlock {filePath: $filePath, functionName: $name})
        SET cb.bodyText  = $bodyText,
            cb.updatedAt = timestamp()
      `.trim(),
      params: {
        filePath: fn.filePath,
        name: fn.name,
        bodyText: fn.bodyText.slice(0, 8000),
      },
    });
  }

  // 3. CALLS edges — link this function to functions it calls
  stmts.push(...buildCallsEdges(fn.filePath, fn.name, fn.callees));

  // 4. USES_TYPE edges — link this function to types it references
  stmts.push(...buildUsesTypeEdges(fn.filePath, fn.name, fn.typeRefs));

  return stmts;
}

/**
 * Full rebuild of a function node. Hash-based diffing means if we're here,
 * something changed — so we rewrite all properties and rebuild all edges.
 */
function buildFunctionUpdate(fn: ParsedFunction, _changedFields: string[]): CypherStatement[] {
  // Hash changed → full rebuild. Same statements as create (MERGE is idempotent).
  return buildFunctionCreate(fn);
}

// ---------------------------------------------------------------------------
// Type node mutations
// ---------------------------------------------------------------------------

function buildTypeCreate(ty: ParsedType): CypherStatement[] {
  const stmts: CypherStatement[] = [];

  stmts.push({
    cypher: `
      MERGE (t:Type {filePath: $filePath, name: $name})
      SET t.lineNumber       = $lineNumber,
          t.kind             = $kind,
          t.properties       = $properties,
          t.comment          = $comment,
          t.decorators       = $decorators,
          t.extendsType      = $extendsType,
          t.implementsTypes  = $implementsTypes,
          t.contentHash      = $contentHash,
          t.updatedAt        = timestamp()
      WITH t
      MATCH (m:Module {filePath: $filePath})
      MERGE (m)-[:CONTAINS]->(t)
    `.trim(),
    params: {
      filePath: ty.filePath,
      name: ty.name,
      lineNumber: ty.lineNumber,
      kind: ty.kind,
      properties: JSON.stringify(ty.properties),
      comment: ty.comment,
      decorators: ty.decorators.length > 0 ? JSON.stringify(ty.decorators) : null,
      extendsType: ty.extends ?? null,
      implementsTypes: ty.implements.length > 0 ? JSON.stringify(ty.implements) : null,
      contentHash: ty.contentHash,
    },
  });

  if (ty.bodyText) {
    stmts.push({
      cypher: `
        MATCH (t:Type {filePath: $filePath, name: $name})
        MERGE (t)-[:HAS_CODE]->(cb:CodeBlock {filePath: $filePath, functionName: $name})
        SET cb.bodyText  = $bodyText,
            cb.updatedAt = timestamp()
      `.trim(),
      params: {
        filePath: ty.filePath,
        name: ty.name,
        bodyText: ty.bodyText.slice(0, 8000),
      },
    });
  }

  // EXTENDS edge — class hierarchy
  if (ty.extends) {
    stmts.push({
      cypher: `
        MATCH (child:Type {filePath: $filePath, name: $childName})
        MATCH (parent:Type {name: $parentName})
        MERGE (child)-[:EXTENDS]->(parent)
      `.trim(),
      params: {
        filePath: ty.filePath,
        childName: ty.name,
        parentName: ty.extends,
      },
    });
  }

  // IMPLEMENTS edges — interface implementation
  for (const ifaceName of ty.implements) {
    stmts.push({
      cypher: `
        MATCH (cls:Type {filePath: $filePath, name: $className})
        MATCH (iface:Type {name: $ifaceName})
        MERGE (cls)-[:IMPLEMENTS]->(iface)
      `.trim(),
      params: {
        filePath: ty.filePath,
        className: ty.name,
        ifaceName,
      },
    });
  }

  // INJECTS edges — constructor DI parameters
  for (const param of ty.constructorParams) {
    const targetType = param.injectToken ?? param.type;
    if (targetType === 'unknown' || targetType.length > 80) continue;
    stmts.push({
      cypher: `
        MATCH (cls:Type {filePath: $filePath, name: $className})
        MATCH (dep:Type {name: $depName})
        MERGE (cls)-[r:INJECTS]->(dep)
        SET r.paramName = $paramName
      `.trim(),
      params: {
        filePath: ty.filePath,
        className: ty.name,
        depName: targetType,
        paramName: param.name,
      },
    });
  }

  return stmts;
}

/**
 * Full rebuild of a type node. Hash-based diffing means if we're here,
 * something changed — so we rewrite all properties and rebuild all edges.
 */
function buildTypeUpdate(ty: ParsedType, _changedFields: string[]): CypherStatement[] {
  return buildTypeCreate(ty);
}

// ---------------------------------------------------------------------------
// Relationship edge builders (CALLS, USES_TYPE)
// ---------------------------------------------------------------------------

/**
 * Build CALLS edges from a function to its callees.
 * Uses MERGE so re-seeding is idempotent. Only creates edges to functions
 * that exist in the graph (MATCH won't fail silently for missing targets).
 */
function buildCallsEdges(filePath: string, callerName: string, callees: string[]): CypherStatement[] {
  const stmts: CypherStatement[] = [];

  // First, clean up any existing CALLS edges from this function
  // (the callee set may have changed after code edits)
  stmts.push({
    cypher: `
      MATCH (caller:Function {filePath: $filePath, name: $name})-[r:CALLS]->()
      DELETE r
    `.trim(),
    params: { filePath, name: callerName },
  });

  for (const callee of callees) {
    // Try to match callee as an exact function name in the graph.
    // Callees may be: "foo", "service.method", "ClassName.method"
    stmts.push({
      cypher: `
        MATCH (caller:Function {filePath: $filePath, name: $callerName})
        MATCH (callee:Function)
        WHERE callee.name = $calleeName
           OR callee.name ENDS WITH $calleeSuffix
        WITH caller, callee LIMIT 1
        MERGE (caller)-[:CALLS]->(callee)
      `.trim(),
      params: {
        filePath,
        callerName,
        calleeName: callee,
        calleeSuffix: '.' + callee,
      },
    });
  }

  return stmts;
}

/**
 * Build USES_TYPE edges from a function to the types it references.
 */
function buildUsesTypeEdges(filePath: string, funcName: string, typeRefs: string[]): CypherStatement[] {
  const stmts: CypherStatement[] = [];

  // Clean up existing USES_TYPE edges
  stmts.push({
    cypher: `
      MATCH (f:Function {filePath: $filePath, name: $name})-[r:USES_TYPE]->()
      DELETE r
    `.trim(),
    params: { filePath, name: funcName },
  });

  for (const typeName of typeRefs) {
    stmts.push({
      cypher: `
        MATCH (f:Function {filePath: $filePath, name: $funcName})
        MATCH (t:Type {name: $typeName})
        WITH f, t LIMIT 1
        MERGE (f)-[:USES_TYPE]->(t)
      `.trim(),
      params: { filePath, funcName, typeName },
    });
  }

  return stmts;
}

// ---------------------------------------------------------------------------
// Delete mutations
// ---------------------------------------------------------------------------

function buildNodeDelete(del: NodeDelete): CypherStatement {
  const label = del.kind === 'function' ? 'Function' : 'Type';
  return {
    cypher: `
      MATCH (n:${label} {filePath: $filePath, name: $name})
      DETACH DELETE n
    `.trim(),
    params: { filePath: del.filePath, name: del.name },
  };
}

function buildDeletedFileNodes(filePath: string): CypherStatement[] {
  // Delete all Function, Type, CodeBlock, and Module nodes for a deleted file.
  // CodeBlock nodes are deleted first since DETACH DELETE on Function/Type
  // removes the HAS_CODE edge but leaves orphan CodeBlocks without it.
  return [
    {
      cypher: `
        MATCH (cb:CodeBlock {filePath: $filePath})
        DETACH DELETE cb
      `.trim(),
      params: { filePath },
    },
    {
      cypher: `
        MATCH (n:Function {filePath: $filePath})
        DETACH DELETE n
      `.trim(),
      params: { filePath },
    },
    {
      cypher: `
        MATCH (n:Type {filePath: $filePath})
        DETACH DELETE n
      `.trim(),
      params: { filePath },
    },
    {
      cypher: `
        MATCH (n:Module {filePath: $filePath})
        DETACH DELETE n
      `.trim(),
      params: { filePath },
    },
  ];
}

// ---------------------------------------------------------------------------
// Edge mutations
// ---------------------------------------------------------------------------

function buildEdgeAdd(edge: EdgeAdd): CypherStatement {
  if (edge.kind === 'IMPORTS') {
    return {
      cypher: `
        MERGE (m:Module {filePath: $fromFile})
        MERGE (m)-[e:IMPORTS {moduleSpecifier: $moduleSpecifier}]->(m)
        SET e.importedNames = $importedNames,
            e.updatedAt     = timestamp()
      `.trim(),
      // Note: IMPORTS edges point to an external module specifier, not necessarily
      // a Module node in our graph (could be an npm package). We model the edge
      // on the source Module and store the specifier as a property.
      params: {
        fromFile: edge.fromFile,
        moduleSpecifier: edge.moduleSpecifier ?? '',
        importedNames: edge.importedNames ?? [],
      },
    };
  }

  // BELONGS_TO and USES_TYPE edges are managed by the create mutations above.
  // Return a no-op if we somehow get an unexpected kind.
  return {
    cypher: 'RETURN 1',
    params: {},
  };
}

function buildEdgeRemove(edge: EdgeRemove): CypherStatement {
  return {
    cypher: `
      MATCH (m:Module {filePath: $fromFile})-[e:IMPORTS {moduleSpecifier: $moduleSpecifier}]->()
      DELETE e
    `.trim(),
    params: {
      fromFile: edge.fromFile,
      moduleSpecifier: edge.moduleSpecifier,
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a Changeset into an ordered array of Cypher statements.
 *
 * Execution order matters:
 * 1. Delete nodes for fully deleted files (cascades edges via DETACH DELETE).
 * 2. Delete individual removed nodes.
 * 3. Remove stale edges.
 * 4. Create/update nodes (MERGE is idempotent).
 * 5. Add new edges.
 *
 * The caller is responsible for running these inside a single write transaction.
 *
 * @param changeset - Output from graph-differ.computeChangeset().
 * @returns Ordered array of {cypher, params} pairs ready for execution.
 */
export function buildMutations(changeset: Changeset): CypherStatement[] {
  const statements: CypherStatement[] = [];

  // 1. Deleted files — wipe all nodes
  for (const filePath of changeset.deletedFiles) {
    statements.push(...buildDeletedFileNodes(filePath));
  }

  // 2. Individual node deletions (functions/types removed from still-existing files)
  for (const del of changeset.nodesToDelete) {
    statements.push(buildNodeDelete(del));
  }

  // 3. Stale edge removals
  for (const edge of changeset.edgesToRemove) {
    statements.push(buildEdgeRemove(edge));
  }

  // 4. Creates and updates
  for (const create of changeset.nodesToCreate) {
    if (create.kind === 'function') {
      statements.push(...buildFunctionCreate(create.data as ParsedFunction));
    } else {
      statements.push(...buildTypeCreate(create.data as ParsedType));
    }
  }

  for (const update of changeset.nodesToUpdate) {
    if (update.kind === 'function') {
      statements.push(...buildFunctionUpdate(update.data as ParsedFunction, update.changedFields));
    } else {
      statements.push(...buildTypeUpdate(update.data as ParsedType, update.changedFields));
    }
  }

  // 5. New edges
  for (const edge of changeset.edgesToAdd) {
    statements.push(buildEdgeAdd(edge));
  }

  return statements;
}

/**
 * Execute an array of Cypher statements inside a single write transaction.
 *
 * Requires direct driver access (not the read-only runQuery wrapper).
 * Returns the number of statements executed.
 *
 * @param statements - Output from buildMutations().
 * @param driver - Neo4j driver (obtained from getDriver()).
 * @returns Number of statements executed.
 */
export async function applyMutations(
  statements: CypherStatement[],
  driver: import('neo4j-driver').Driver
): Promise<number> {
  if (statements.length === 0) return 0;

  const session = driver.session({ defaultAccessMode: 'WRITE' });
  const tx = session.beginTransaction();

  try {
    for (const { cypher, params } of statements) {
      await tx.run(cypher, params);
    }
    await tx.commit();
    return statements.length;
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    await session.close();
  }
}
