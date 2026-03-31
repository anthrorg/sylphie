/**
 * graph-differ.ts -- Compare AST output against current graph state.
 *
 * Queries the codebase PKG for existing Function and Type nodes in the
 * changed files, then diffs them against the freshly parsed AST output
 * to produce a changeset: what to create, update, and delete.
 *
 * Change detection uses SHA-256 content hashes: the parser hashes each
 * function/type's full source text, and we compare that single string
 * against the stored hash in Neo4j. If it differs, we do a full update
 * (all properties + all edges). If it matches, we skip entirely.
 *
 * Rename detection is intentionally simple: if a function disappears from
 * one file and a similarly-named one appears in another, we delete the old
 * and create the new. No clever rename tracking.
 */

import { runQuery } from '../mcp-server/neo4j-client.js';
import type { ParsedFile, ParsedFunction, ParsedType, ParsedImport } from './ast-parser.js';

// ---------------------------------------------------------------------------
// Graph state types (what we read from Neo4j)
// ---------------------------------------------------------------------------

interface GraphNode {
  name: string;
  filePath: string;
  contentHash: string | null;
}

interface GraphImportEdge {
  fromFile: string;
  moduleSpecifier: string;
  importedNames: string[];
}

// ---------------------------------------------------------------------------
// Changeset types
// ---------------------------------------------------------------------------

export interface NodeCreate {
  kind: 'function' | 'type';
  data: ParsedFunction | ParsedType;
}

export interface NodeUpdate {
  kind: 'function' | 'type';
  data: ParsedFunction | ParsedType;
  /**
   * 'full' means the contentHash changed — rebuild everything (properties + edges).
   * Individual field names are kept for backward compat but the mutation builder
   * should treat any non-empty changedFields as a full rebuild.
   */
  changedFields: string[];
}

export interface NodeDelete {
  kind: 'function' | 'type';
  name: string;
  filePath: string;
}

export interface EdgeAdd {
  kind: 'IMPORTS' | 'USES_TYPE' | 'BELONGS_TO';
  fromFile: string;
  toFile?: string;
  moduleSpecifier?: string;
  importedNames?: string[];
  functionName?: string;
  modulePath?: string;
}

export interface EdgeRemove {
  kind: 'IMPORTS';
  fromFile: string;
  moduleSpecifier: string;
}

export interface Changeset {
  nodesToCreate: NodeCreate[];
  nodesToUpdate: NodeUpdate[];
  nodesToDelete: NodeDelete[];
  edgesToAdd: EdgeAdd[];
  edgesToRemove: EdgeRemove[];
  /** Files that were deleted from the repo (all their nodes should be removed). */
  deletedFiles: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Fetch all Function nodes for the given file paths — only name, filePath,
 * and contentHash. That's all we need for diff.
 */
async function fetchGraphFunctions(
  filePaths: string[]
): Promise<Map<string, GraphNode>> {
  if (filePaths.length === 0) return new Map();

  const records = await runQuery(
    `MATCH (f:Function)
     WHERE f.filePath IN $filePaths
     RETURN f.name AS name, f.filePath AS filePath, f.contentHash AS contentHash`,
    { filePaths }
  );

  const map = new Map<string, GraphNode>();
  for (const r of records) {
    const node: GraphNode = {
      name: r.get('name') as string,
      filePath: r.get('filePath') as string,
      contentHash: (r.get('contentHash') as string) ?? null,
    };
    map.set(`${node.filePath}::${node.name}`, node);
  }
  return map;
}

/**
 * Fetch all Type nodes for the given file paths — only name, filePath,
 * and contentHash.
 */
async function fetchGraphTypes(
  filePaths: string[]
): Promise<Map<string, GraphNode>> {
  if (filePaths.length === 0) return new Map();

  const records = await runQuery(
    `MATCH (t:Type)
     WHERE t.filePath IN $filePaths
     RETURN t.name AS name, t.filePath AS filePath, t.contentHash AS contentHash`,
    { filePaths }
  );

  const map = new Map<string, GraphNode>();
  for (const r of records) {
    const node: GraphNode = {
      name: r.get('name') as string,
      filePath: r.get('filePath') as string,
      contentHash: (r.get('contentHash') as string) ?? null,
    };
    map.set(`${node.filePath}::${node.name}`, node);
  }
  return map;
}

/**
 * Fetch IMPORTS edges for changed files so we can diff them.
 */
async function fetchGraphImports(
  filePaths: string[]
): Promise<Map<string, GraphImportEdge>> {
  if (filePaths.length === 0) return new Map();

  const records = await runQuery(
    `MATCH (m:Module)-[e:IMPORTS]->(target)
     WHERE m.filePath IN $filePaths
     RETURN m.filePath AS fromFile, e.moduleSpecifier AS moduleSpecifier,
            e.importedNames AS importedNames`,
    { filePaths }
  );

  const map = new Map<string, GraphImportEdge>();
  for (const r of records) {
    const edge: GraphImportEdge = {
      fromFile: r.get('fromFile') as string,
      moduleSpecifier: r.get('moduleSpecifier') as string,
      importedNames: (r.get('importedNames') as string[]) ?? [],
    };
    map.set(`${edge.fromFile}::${edge.moduleSpecifier}`, edge);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the full changeset between freshly parsed AST output and the
 * current state of the codebase PKG.
 *
 * Uses SHA-256 content hashes for change detection:
 * - Hash match → skip (no update needed)
 * - Hash mismatch or null (legacy node without hash) → full update
 * - Not in graph → create
 * - In graph but not in AST → delete
 *
 * @param parsedFiles - Output from ast-parser for the changed files.
 * @param deletedFiles - Files that were removed from the repo entirely.
 * @returns Changeset describing all required graph mutations.
 */
export async function computeChangeset(
  parsedFiles: ParsedFile[],
  deletedFiles: string[] = []
): Promise<Changeset> {
  const changeset: Changeset = {
    nodesToCreate: [],
    nodesToUpdate: [],
    nodesToDelete: [],
    edgesToAdd: [],
    edgesToRemove: [],
    deletedFiles,
  };

  const allFilePaths = [
    ...parsedFiles.map(f => f.filePath),
    ...deletedFiles,
  ];

  // Fetch current graph state for all affected files in parallel
  const [graphFunctions, graphTypes, graphImports] = await Promise.all([
    fetchGraphFunctions(allFilePaths),
    fetchGraphTypes(allFilePaths),
    fetchGraphImports(allFilePaths),
  ]);

  // Handle deleted files: mark all their nodes for deletion
  for (const filePath of deletedFiles) {
    for (const [key, fn] of graphFunctions.entries()) {
      if (fn.filePath === filePath) {
        changeset.nodesToDelete.push({ kind: 'function', name: fn.name, filePath });
        graphFunctions.delete(key);
      }
    }
    for (const [key, ty] of graphTypes.entries()) {
      if (ty.filePath === filePath) {
        changeset.nodesToDelete.push({ kind: 'type', name: ty.name, filePath });
        graphTypes.delete(key);
      }
    }
  }

  // Diff each parsed file against graph state
  for (const parsedFile of parsedFiles) {
    const { filePath, functions, types, imports } = parsedFile;

    // --- Functions ---
    const parsedFunctionKeys = new Set<string>();

    for (const fn of functions) {
      const key = `${filePath}::${fn.name}`;
      parsedFunctionKeys.add(key);

      const existing = graphFunctions.get(key);
      if (!existing) {
        changeset.nodesToCreate.push({ kind: 'function', data: fn });
      } else if (existing.contentHash !== fn.contentHash) {
        // Hash mismatch (or legacy node with null hash) → full update
        changeset.nodesToUpdate.push({ kind: 'function', data: fn, changedFields: ['full'] });
      }
      // else: hash matches — no update needed
    }

    // Functions in graph but not in AST → delete
    for (const [key, fn] of graphFunctions.entries()) {
      if (fn.filePath === filePath && !parsedFunctionKeys.has(key)) {
        changeset.nodesToDelete.push({ kind: 'function', name: fn.name, filePath: fn.filePath });
      }
    }

    // --- Types ---
    const parsedTypeKeys = new Set<string>();

    for (const ty of types) {
      const key = `${filePath}::${ty.name}`;
      parsedTypeKeys.add(key);

      const existing = graphTypes.get(key);
      if (!existing) {
        changeset.nodesToCreate.push({ kind: 'type', data: ty });
      } else if (existing.contentHash !== ty.contentHash) {
        // Hash mismatch → full update
        changeset.nodesToUpdate.push({ kind: 'type', data: ty, changedFields: ['full'] });
      }
      // else: hash matches — no update needed
    }

    // Types in graph but not in AST → delete
    for (const [key, ty] of graphTypes.entries()) {
      if (ty.filePath === filePath && !parsedTypeKeys.has(key)) {
        changeset.nodesToDelete.push({ kind: 'type', name: ty.name, filePath: ty.filePath });
      }
    }

    // --- Imports ---
    const parsedImportKeys = new Set<string>();

    for (const imp of imports) {
      const key = `${filePath}::${imp.moduleSpecifier}`;
      parsedImportKeys.add(key);

      if (!graphImports.has(key)) {
        changeset.edgesToAdd.push({
          kind: 'IMPORTS',
          fromFile: filePath,
          moduleSpecifier: imp.moduleSpecifier,
          importedNames: imp.importedNames,
        });
      }
    }

    // Import edges in graph but not in AST → remove
    for (const [key, edge] of graphImports.entries()) {
      if (edge.fromFile === filePath && !parsedImportKeys.has(key)) {
        changeset.edgesToRemove.push({
          kind: 'IMPORTS',
          fromFile: edge.fromFile,
          moduleSpecifier: edge.moduleSpecifier,
        });
      }
    }
  }

  return changeset;
}
