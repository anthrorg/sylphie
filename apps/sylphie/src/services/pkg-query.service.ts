/**
 * PkgQueryService — Codebase intelligence queries against the PKG Neo4j instance.
 *
 * Replicates the functionality of the sylphie-pkg MCP tools as REST-queryable
 * endpoints for the frontend Codebase Explorer.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Neo4jService, Neo4jInstanceName } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Response DTOs
// ---------------------------------------------------------------------------

export interface SearchResult {
  name: string;
  type: 'Function' | 'Type' | string;
  filePath: string;
  lineNumber: number | null;
  endLine: number | null;
  returnType: string | null;
  isExported: boolean;
  isAsync: boolean;
  matchLines: string[];
}

export interface FunctionDetail {
  name: string;
  filePath: string;
  lineNumber: number | null;
  args: string | null;
  returnType: string | null;
  comment: string | null;
  body: string | null;
  isAsync: boolean;
  isExported: boolean;
  relatedTypes: Array<{ name: string; filePath: string; kind: string }>;
  recentChanges: Array<{ hash: string; message: string; date: string; author: string }>;
  callers: Array<{ name: string; filePath: string }>;
  callees: Array<{ name: string; filePath: string }>;
}

export interface DataFlowNode {
  name: string;
  filePath: string;
  type: string;
  hopDistance: number;
}

export interface DataFlowResult {
  startNode: { name: string; filePath: string; type: string };
  upstream: DataFlowNode[];
  downstream: DataFlowNode[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && 'toString' in v) return String(v);
  return String(v);
}

function asNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && v !== null && 'toNumber' in v) {
    return (v as { toNumber(): number }).toNumber();
  }
  const parsed = Number(v);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Escape special regex chars and wrap in case-insensitive pattern. */
function toRegex(input: string): string {
  const escaped = input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `(?i).*${escaped}.*`;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class PkgQueryService {
  private readonly logger = new Logger(PkgQueryService.name);

  constructor(private readonly neo4j: Neo4jService) {}

  private getSession(mode: 'READ' | 'WRITE' = 'READ') {
    return this.neo4j.getSession(Neo4jInstanceName.PKG, mode);
  }

  // -----------------------------------------------------------------------
  // Search
  // -----------------------------------------------------------------------

  async search(
    pattern: string,
    fileFilter?: string,
    limit = 20,
  ): Promise<SearchResult[]> {
    const session = this.getSession();
    const maxResults = Math.min(Math.max(1, limit), 50);
    const regex = toRegex(pattern);

    try {
      // Primary: search via CodeBlock bodyText
      const fileClause = fileFilter
        ? 'AND cb.filePath CONTAINS $fileFilter'
        : '';
      let result = await session.run(
        `MATCH (parent)-[:HAS_CODE]->(cb:CodeBlock)
         WHERE cb.bodyText =~ $pattern ${fileClause}
         RETURN parent.name AS name,
                labels(parent) AS labels,
                parent.filePath AS filePath,
                parent.lineNumber AS lineNumber,
                parent.endLine AS endLine,
                parent.returnType AS returnType,
                parent.isExported AS isExported,
                parent.isAsync AS isAsync,
                cb.bodyText AS bodyText
         ORDER BY parent.filePath, parent.lineNumber
         LIMIT $maxResults`,
        { pattern: regex, fileFilter: fileFilter ?? '', maxResults },
      );

      // Fallback: search function name + inline bodyText
      if (result.records.length === 0) {
        const fallbackFileClause = fileFilter
          ? 'AND f.filePath CONTAINS $fileFilter'
          : '';
        result = await session.run(
          `MATCH (f)
           WHERE (f:Function OR f:Type)
             AND (f.name =~ $pattern OR f.bodyText =~ $pattern)
             ${fallbackFileClause}
           RETURN f.name AS name,
                  labels(f) AS labels,
                  f.filePath AS filePath,
                  f.lineNumber AS lineNumber,
                  f.endLine AS endLine,
                  f.returnType AS returnType,
                  f.isExported AS isExported,
                  f.isAsync AS isAsync,
                  f.bodyText AS bodyText
           ORDER BY f.filePath, f.lineNumber
           LIMIT $maxResults`,
          { pattern: regex, fileFilter: fileFilter ?? '', maxResults },
        );
      }

      return result.records.map((rec) => {
        const bodyText = asString(rec.get('bodyText'));
        const labels: string[] = rec.get('labels') ?? [];
        const matchLines = bodyText
          .split('\n')
          .filter((line: string) =>
            line.toLowerCase().includes(pattern.toLowerCase()),
          )
          .slice(0, 5)
          .map((line: string) => line.trim());

        return {
          name: asString(rec.get('name')),
          type: labels.includes('Type') ? 'Type' : 'Function',
          filePath: asString(rec.get('filePath')),
          lineNumber: asNumber(rec.get('lineNumber')),
          endLine: asNumber(rec.get('endLine')),
          returnType: asString(rec.get('returnType')) || null,
          isExported: rec.get('isExported') === true,
          isAsync: rec.get('isAsync') === true,
          matchLines,
        };
      });
    } catch (err) {
      this.logger.warn(`PKG search failed: ${(err as Error).message}`);
      return [];
    } finally {
      await session.close();
    }
  }

  // -----------------------------------------------------------------------
  // Function detail
  // -----------------------------------------------------------------------

  async getFunctionDetail(
    name: string,
    filePath?: string,
  ): Promise<FunctionDetail | null> {
    const session = this.getSession();
    try {
      const fpClause = filePath ? 'AND f.filePath CONTAINS $filePath' : '';

      // Main function query
      const funcResult = await session.run(
        `MATCH (f:Function)
         WHERE f.name = $name ${fpClause}
         OPTIONAL MATCH (f)-[:HAS_CODE]->(cb:CodeBlock)
         RETURN f.name AS name,
                f.filePath AS filePath,
                f.lineNumber AS lineNumber,
                f.args AS arguments,
                f.returnType AS returnType,
                f.jsDoc AS comment,
                coalesce(cb.bodyText, f.bodyText) AS body,
                f.isAsync AS isAsync,
                f.isExported AS isExported
         ORDER BY f.filePath
         LIMIT 1`,
        { name, filePath: filePath ?? '' },
      );

      if (funcResult.records.length === 0) return null;
      const fn = funcResult.records[0];
      const fp = asString(fn.get('filePath'));

      // Related types
      const typesResult = await session.run(
        `MATCH (f:Function)-[:USES_TYPE]->(t:Type)
         WHERE f.name = $name AND ($fp = '' OR f.filePath = $fp)
         RETURN t.name AS name, t.filePath AS filePath, t.kind AS kind
         ORDER BY t.name LIMIT 20`,
        { name, fp },
      );

      // Callers (who calls this function)
      const callersResult = await session.run(
        `MATCH (caller:Function)-[:CALLS]->(f:Function)
         WHERE f.name = $name AND ($fp = '' OR f.filePath = $fp)
         RETURN caller.name AS name, caller.filePath AS filePath
         ORDER BY caller.name LIMIT 20`,
        { name, fp },
      );

      // Callees (what this function calls)
      const calleesResult = await session.run(
        `MATCH (f:Function)-[:CALLS]->(callee:Function)
         WHERE f.name = $name AND ($fp = '' OR f.filePath = $fp)
         RETURN callee.name AS name, callee.filePath AS filePath
         ORDER BY callee.name LIMIT 20`,
        { name, fp },
      );

      // Recent changes
      const changesResult = await session.run(
        `MATCH (f:Function)-[:CHANGED_IN]->(c:Change)
         WHERE f.name = $name AND ($fp = '' OR f.filePath = $fp)
         RETURN c.shortHash AS hash, c.message AS message,
                c.date AS date, c.author AS author
         ORDER BY c.date DESC LIMIT 10`,
        { name, fp },
      );

      return {
        name: asString(fn.get('name')),
        filePath: fp,
        lineNumber: asNumber(fn.get('lineNumber')),
        args: asString(fn.get('arguments')) || null,
        returnType: asString(fn.get('returnType')) || null,
        comment: asString(fn.get('comment')) || null,
        body: asString(fn.get('body')) || null,
        isAsync: fn.get('isAsync') === true,
        isExported: fn.get('isExported') === true,
        relatedTypes: typesResult.records.map((r) => ({
          name: asString(r.get('name')),
          filePath: asString(r.get('filePath')),
          kind: asString(r.get('kind')),
        })),
        callers: callersResult.records.map((r) => ({
          name: asString(r.get('name')),
          filePath: asString(r.get('filePath')),
        })),
        callees: calleesResult.records.map((r) => ({
          name: asString(r.get('name')),
          filePath: asString(r.get('filePath')),
        })),
        recentChanges: changesResult.records.map((r) => ({
          hash: asString(r.get('hash')),
          message: asString(r.get('message')),
          date: asString(r.get('date')),
          author: asString(r.get('author')),
        })),
      };
    } catch (err) {
      this.logger.warn(`PKG function detail failed: ${(err as Error).message}`);
      return null;
    } finally {
      await session.close();
    }
  }

  // -----------------------------------------------------------------------
  // Data flow
  // -----------------------------------------------------------------------

  async getDataFlow(
    name: string,
    direction: 'upstream' | 'downstream' | 'both' = 'both',
    depth = 3,
  ): Promise<DataFlowResult | null> {
    const maxDepth = Math.min(Math.max(1, depth), 6);
    const session = this.getSession();

    try {
      // Find the start node
      const startResult = await session.run(
        `MATCH (n)
         WHERE (n:Function OR n:Type) AND n.name = $name
         RETURN labels(n) AS labels, n.name AS name,
                n.filePath AS filePath
         LIMIT 1`,
        { name },
      );

      if (startResult.records.length === 0) return null;
      const startRec = startResult.records[0];
      const startLabels: string[] = startRec.get('labels') ?? [];
      const startNode = {
        name: asString(startRec.get('name')),
        filePath: asString(startRec.get('filePath')),
        type: startLabels.includes('Type') ? 'Type' : 'Function',
      };

      const upstream: DataFlowNode[] = [];
      const downstream: DataFlowNode[] = [];

      // Upstream: who calls/uses this node
      if (direction === 'upstream' || direction === 'both') {
        const upResult = await session.run(
          `MATCH path = (n)-[:CALLS|USES_TYPE|INJECTS|EXTENDS|IMPLEMENTS*1..${maxDepth}]->(target)
           WHERE (target:Function OR target:Type) AND target.name = $name
             AND (n:Function OR n:Type)
           RETURN n.name AS name, n.filePath AS filePath,
                  labels(n) AS labels, length(path) AS hopDistance
           ORDER BY hopDistance, n.name
           LIMIT 50`,
          { name },
        );
        for (const rec of upResult.records) {
          const labels: string[] = rec.get('labels') ?? [];
          upstream.push({
            name: asString(rec.get('name')),
            filePath: asString(rec.get('filePath')),
            type: labels.includes('Type') ? 'Type' : 'Function',
            hopDistance: asNumber(rec.get('hopDistance')) ?? 1,
          });
        }
      }

      // Downstream: what this node calls/uses
      if (direction === 'downstream' || direction === 'both') {
        const downResult = await session.run(
          `MATCH path = (start)-[:CALLS|USES_TYPE|INJECTS|EXTENDS|IMPLEMENTS*1..${maxDepth}]->(n)
           WHERE (start:Function OR start:Type) AND start.name = $name
             AND (n:Function OR n:Type)
           RETURN n.name AS name, n.filePath AS filePath,
                  labels(n) AS labels, length(path) AS hopDistance
           ORDER BY hopDistance, n.name
           LIMIT 50`,
          { name },
        );
        for (const rec of downResult.records) {
          const labels: string[] = rec.get('labels') ?? [];
          downstream.push({
            name: asString(rec.get('name')),
            filePath: asString(rec.get('filePath')),
            type: labels.includes('Type') ? 'Type' : 'Function',
            hopDistance: asNumber(rec.get('hopDistance')) ?? 1,
          });
        }
      }

      return { startNode, upstream, downstream };
    } catch (err) {
      this.logger.warn(`PKG data flow failed: ${(err as Error).message}`);
      return null;
    } finally {
      await session.close();
    }
  }
}
