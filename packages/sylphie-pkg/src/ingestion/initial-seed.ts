/**
 * initial-seed.ts -- One-time full codebase parse and PKG bootstrap.
 *
 * Walks the entire monorepo, extracts all TypeScript functions/types/imports,
 * creates the full node and edge set in the codebase PKG, then runs domain
 * classification and integrity checks.
 *
 * This is a one-time operation (or re-run after a hard reset). For ongoing
 * sync use sync-pipeline.ts instead.
 *
 * Entry point: `npm run seed-pkg`
 *
 * Progress output is printed to stdout. Errors for individual files are
 * captured and reported at the end without aborting the run.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { parseFiles, clearProjectCache } from '../sync/ast-parser.js';
import { runIntegrityChecks } from '../sync/integrity-checker.js';
import { writeLastSyncCommit } from '../sync/git-diff.js';
import { getDriver, closeDriver } from '../mcp-server/neo4j-client.js';
import type { ParsedFile, ParsedImport } from '../sync/ast-parser.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = 'C:/Users/Jim/OneDrive/Desktop/Code/sylphie';

const WATCHED_PACKAGES: Array<{ name: string; dir: string }> = [
  { name: 'app-root', dir: 'src' },             // main.ts, app.module.ts
  { name: 'communication', dir: 'src/communication' },
  { name: 'database', dir: 'src/database' },
  { name: 'db', dir: 'src/db' },
  { name: 'decision-making', dir: 'src/decision-making' },
  { name: 'drive-engine', dir: 'src/drive-engine' },
  { name: 'events', dir: 'src/events' },
  { name: 'knowledge', dir: 'src/knowledge' },
  { name: 'learning', dir: 'src/learning' },
  { name: 'metrics', dir: 'src/metrics' },
  { name: 'planning', dir: 'src/planning' },
  { name: 'shared', dir: 'src/shared' },
  { name: 'testing', dir: 'src/testing' },
  { name: 'web', dir: 'src/web' },
];

const EXCLUDE_PATTERNS = [
  /node_modules/,
  /\/dist\//,
  /\.d\.ts$/,
  /\.spec\.ts$/,
  /\.test\.ts$/,
  /\.spec\.tsx$/,
  /\.test\.tsx$/,
];

const BATCH_SIZE = 50;

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/**
 * Recursively collect all .ts and .tsx files under a directory, applying
 * the standard exclusion filters.
 */
function collectTsFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(currentDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name).replace(/\\/g, '/');
      const relativePath = fullPath.replace(REPO_ROOT.replace(/\\/g, '/') + '/', '');

      if (entry.isDirectory()) {
        if (
          entry.name === 'node_modules' ||
          entry.name === 'dist' ||
          entry.name === '.git' ||
          entry.name === '.cache'
        ) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        const isTs = entry.name.endsWith('.ts') || entry.name.endsWith('.tsx');
        if (!isTs) continue;
        if (EXCLUDE_PATTERNS.some(rx => rx.test(relativePath))) continue;
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// Import resolution
// ---------------------------------------------------------------------------

/**
 * Map from @sylphie/* package names to their source directories.
 */
const PACKAGE_SOURCE_DIRS: Record<string, string> = {
  '@sylphie/shared': 'src/shared',
  '@sylphie/decision-making': 'src/decision-making',
  '@sylphie/communication': 'src/communication',
  '@sylphie/learning': 'src/learning',
  '@sylphie/drive-engine': 'src/drive-engine',
  '@sylphie/planning': 'src/planning',
  '@sylphie/knowledge': 'src/knowledge',
  '@sylphie/events': 'src/events',
  '@sylphie/database': 'src/database',
  '@sylphie/db': 'src/db',
  '@sylphie/metrics': 'src/metrics',
  '@sylphie/testing': 'src/testing',
  '@sylphie/web': 'src/web',
};

/**
 * Resolve a moduleSpecifier to a target Module filePath in the graph.
 *
 * - @sylphie/shared        → packages/shared/src
 * - @sylphie/shared/foo    → packages/shared/src/foo (if it exists as a dir)
 * - ./services/foo         → resolved relative to sourceDir
 * - ../shared/types        → resolved relative to sourceDir
 * - @nestjs/common (etc.)  → returns null (external, skip)
 *
 * @param sourceDir - The directory of the file doing the importing.
 * @param moduleSpecifier - The import path string.
 * @returns Absolute directory path matching a Module node, or null if external.
 */
function resolveImportTarget(sourceDir: string, moduleSpecifier: string): string | null {
  const repoRoot = REPO_ROOT.replace(/\\/g, '/');

  // Handle @sylphie/* workspace imports
  if (moduleSpecifier.startsWith('@sylphie/')) {
    // Find the longest matching package prefix
    const sortedKeys = Object.keys(PACKAGE_SOURCE_DIRS).sort((a, b) => b.length - a.length);
    for (const pkg of sortedKeys) {
      if (moduleSpecifier === pkg || moduleSpecifier.startsWith(pkg + '/')) {
        const basePath = `${repoRoot}/${PACKAGE_SOURCE_DIRS[pkg]}`;
        const subPath = moduleSpecifier.slice(pkg.length + 1); // e.g., "foo/bar"
        if (subPath) {
          const fullPath = `${basePath}/${subPath}`;
          // Check if this resolves to a directory that exists
          if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
            return fullPath;
          }
          // Otherwise use the parent directory
          const parentDir = path.dirname(`${basePath}/${subPath}`).replace(/\\/g, '/');
          if (fs.existsSync(parentDir)) return parentDir;
        }
        return basePath;
      }
    }
    return null; // unknown @sylphie package
  }

  // Handle relative imports
  if (moduleSpecifier.startsWith('.')) {
    const resolved = path.resolve(sourceDir, moduleSpecifier).replace(/\\/g, '/');
    // Check if it's a directory
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return resolved;
    }
    // Otherwise it's a file import — use the target file's directory
    const targetDir = path.dirname(resolved).replace(/\\/g, '/');
    if (targetDir !== sourceDir && fs.existsSync(targetDir)) {
      return targetDir;
    }
    // Same directory — skip (would be a self-loop)
    return null;
  }

  // External package (@nestjs/*, neo4j-driver, etc.) — skip
  return null;
}

// ---------------------------------------------------------------------------
// Graph schema setup
// ---------------------------------------------------------------------------

/**
 * Create Neo4j indexes and constraints for the PKG schema.
 * Idempotent — safe to run multiple times.
 */
async function createSchemaIndexes(driver: import('neo4j-driver').Driver): Promise<void> {
  console.log('[seed] Creating schema indexes and constraints...');

  const session = driver.session({ defaultAccessMode: 'WRITE' });

  const statements = [
    // Unique constraints (single-property — Community Edition compatible)
    'CREATE CONSTRAINT service_name_unique IF NOT EXISTS FOR (s:Service) REQUIRE s.name IS UNIQUE',
    'CREATE CONSTRAINT module_filepath_unique IF NOT EXISTS FOR (m:Module) REQUIRE m.filePath IS UNIQUE',
    'CREATE CONSTRAINT change_hash_unique IF NOT EXISTS FOR (c:Change) REQUIRE c.hash IS UNIQUE',

    // Composite indexes for (filePath, name) lookups on Function and Type.
    // NODE KEY constraints require Enterprise — composite indexes give us the
    // same query performance. MERGE on (filePath, name) handles dedup.
    'CREATE INDEX function_filepath_name IF NOT EXISTS FOR (f:Function) ON (f.filePath, f.name)',
    'CREATE INDEX type_filepath_name IF NOT EXISTS FOR (t:Type) ON (t.filePath, t.name)',

    // Additional indexes for common query patterns
    'CREATE INDEX function_domain IF NOT EXISTS FOR (f:Function) ON (f.domain)',
    'CREATE INDEX function_name IF NOT EXISTS FOR (f:Function) ON (f.name)',
    'CREATE INDEX type_name IF NOT EXISTS FOR (t:Type) ON (t.name)',
    'CREATE INDEX type_kind IF NOT EXISTS FOR (t:Type) ON (t.kind)',
    'CREATE INDEX module_package IF NOT EXISTS FOR (m:Module) ON (m.packageName)',
    'CREATE INDEX function_hash IF NOT EXISTS FOR (f:Function) ON (f.contentHash)',
    'CREATE INDEX type_hash IF NOT EXISTS FOR (t:Type) ON (t.contentHash)',
  ];

  for (const stmt of statements) {
    try {
      await session.run(stmt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Constraint already exists — not an error
      if (!msg.includes('already exists') && !msg.includes('An equivalent')) {
        process.stderr.write(`[seed] WARNING: schema stmt failed — ${msg}\n`);
      }
    }
  }

  await session.close();
  console.log('[seed] Schema indexes ready.');
}

// ---------------------------------------------------------------------------
// Node creation helpers
// ---------------------------------------------------------------------------

/**
 * Create Service nodes for each watched package.
 */
async function createServiceNodes(driver: import('neo4j-driver').Driver): Promise<void> {
  console.log('[seed] Creating Service nodes...');
  const session = driver.session({ defaultAccessMode: 'WRITE' });
  const tx = session.beginTransaction();

  try {
    for (const pkg of WATCHED_PACKAGES) {
      await tx.run(
        `
        MERGE (s:Service {name: $name})
        SET s.directory = $directory,
            s.updatedAt = timestamp()
        `,
        { name: pkg.name, directory: pkg.dir }
      );
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    await session.close();
  }

  console.log(`[seed] Created ${WATCHED_PACKAGES.length} Service nodes.`);
}

/**
 * Create Module nodes for each directory that contains TypeScript files,
 * and link them to their parent Service via BELONGS_TO.
 */
async function createModuleNodes(
  allFiles: string[],
  driver: import('neo4j-driver').Driver
): Promise<void> {
  console.log('[seed] Creating Module nodes...');

  // Collect unique directories from the file list
  const dirSet = new Set<string>();
  for (const f of allFiles) {
    dirSet.add(path.dirname(f).replace(/\\/g, '/'));
  }

  const session = driver.session({ defaultAccessMode: 'WRITE' });
  let created = 0;

  for (const dir of dirSet) {
    const relativePath = dir.replace(REPO_ROOT.replace(/\\/g, '/') + '/', '');
    const dirName = path.basename(dir);

    // Determine which package this directory belongs to
    const pkg = WATCHED_PACKAGES.find(p =>
      relativePath.startsWith(p.dir + '/') || relativePath === p.dir
    );
    const packageName = pkg?.name ?? 'unknown';

    const tx = session.beginTransaction();
    try {
      await tx.run(
        `
        MERGE (m:Module {filePath: $filePath})
        SET m.name        = $name,
            m.packageName = $packageName,
            m.updatedAt   = timestamp()
        `,
        { filePath: dir, name: dirName, packageName }
      );

      if (pkg) {
        await tx.run(
          `
          MATCH (m:Module {filePath: $filePath})
          MATCH (s:Service {name: $packageName})
          MERGE (m)-[:BELONGS_TO]->(s)
          `,
          { filePath: dir, packageName }
        );
      }

      await tx.commit();
      created++;
    } catch (err) {
      await tx.rollback();
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[seed] WARNING: Module node failed for ${dir} — ${msg}\n`);
    }
  }

  await session.close();
  console.log(`[seed] Created ${created} Module nodes.`);
}

/**
 * Write a batch of parsed files to Neo4j.
 * Creates Function, Type nodes and CONTAINS/IMPORTS edges.
 */
async function writeParsedBatch(
  batch: ParsedFile[],
  driver: import('neo4j-driver').Driver
): Promise<{ functions: number; types: number; errors: number }> {
  let functions = 0;
  let types = 0;
  let errors = 0;

  const session = driver.session({ defaultAccessMode: 'WRITE' });

  for (const parsedFile of batch) {
    const dirPath = path.dirname(parsedFile.filePath).replace(/\\/g, '/');
    const tx = session.beginTransaction();

    try {
      // Ensure Module node exists for this file's directory
      await tx.run(
        `MERGE (m:Module {filePath: $filePath}) SET m.updatedAt = timestamp()`,
        { filePath: dirPath }
      );

      // Create Function metadata + CodeBlock + CALLS + USES_TYPE
      for (const fn of parsedFile.functions) {
        await tx.run(
          `
          MERGE (f:Function {filePath: $filePath, name: $name})
          SET f.lineNumber  = $lineNumber,
              f.endLine     = $endLine,
              f.returnType  = $returnType,
              f.jsDoc       = $jsDoc,
              f.isExported  = $isExported,
              f.isAsync     = $isAsync,
              f.args        = $args,
              f.decorators  = $decorators,
              f.httpMethod  = $httpMethod,
              f.routePath    = $routePath,
              f.contentHash  = $contentHash,
              f.domain       = coalesce(f.domain, 'unclassified'),
              f.updatedAt    = timestamp()
          WITH f
          MATCH (m:Module {filePath: $dirPath})
          MERGE (m)-[:CONTAINS]->(f)
          `,
          {
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
            dirPath,
          }
        );

        if (fn.bodyText) {
          await tx.run(
            `
            MATCH (f:Function {filePath: $filePath, name: $name})
            MERGE (f)-[:HAS_CODE]->(cb:CodeBlock {filePath: $filePath, functionName: $name})
            SET cb.bodyText  = $bodyText,
                cb.updatedAt = timestamp()
            `,
            { filePath: fn.filePath, name: fn.name, bodyText: fn.bodyText.slice(0, 8000) }
          );
        }

        // CALLS edges are deferred to a second pass (all functions must exist first)
        // USES_TYPE edges are also deferred
        functions++;
      }

      // Create Type metadata + CodeBlock + hierarchy
      for (const ty of parsedFile.types) {
        await tx.run(
          `
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
          MATCH (m:Module {filePath: $dirPath})
          MERGE (m)-[:CONTAINS]->(t)
          `,
          {
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
            dirPath,
          }
        );

        if (ty.bodyText) {
          await tx.run(
            `
            MATCH (t:Type {filePath: $filePath, name: $name})
            MERGE (t)-[:HAS_CODE]->(cb:CodeBlock {filePath: $filePath, functionName: $name})
            SET cb.bodyText  = $bodyText,
                cb.updatedAt = timestamp()
            `,
            { filePath: ty.filePath, name: ty.name, bodyText: ty.bodyText.slice(0, 8000) }
          );
        }
        types++;
      }

      // Create IMPORTS edges — resolve moduleSpecifier to target Module
      for (const imp of parsedFile.imports) {
        const targetPath = resolveImportTarget(dirPath, imp.moduleSpecifier);
        if (!targetPath) continue; // external package — skip

        await tx.run(
          `
          MATCH (source:Module {filePath: $dirPath})
          MATCH (target:Module {filePath: $targetPath})
          MERGE (source)-[e:IMPORTS {moduleSpecifier: $moduleSpecifier}]->(target)
          SET e.importedNames = $importedNames,
              e.fromFile      = $fromFile,
              e.updatedAt     = timestamp()
          `,
          {
            dirPath,
            targetPath,
            moduleSpecifier: imp.moduleSpecifier,
            importedNames: imp.importedNames,
            fromFile: parsedFile.filePath,
          }
        );
      }

      await tx.commit();
    } catch (err) {
      await tx.rollback();
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[seed] WARNING: batch write failed for ${parsedFile.filePath} — ${msg}\n`);
      errors++;
    }
  }

  await session.close();
  return { functions, types, errors };
}

// ---------------------------------------------------------------------------
// Main seed
// ---------------------------------------------------------------------------

async function runSeed(): Promise<void> {
  const startTime = Date.now();
  const driver = getDriver();

  console.log('='.repeat(60));
  console.log('[seed] Codebase PKG initial seed starting');
  console.log('='.repeat(60));

  // Step 1: Schema
  await createSchemaIndexes(driver);

  // Step 2: Discover files
  console.log('\n[seed] Step 2/8: Discovering TypeScript files...');
  const allFiles: string[] = [];
  for (const pkg of WATCHED_PACKAGES) {
    const pkgDir = path.join(REPO_ROOT, pkg.dir).replace(/\\/g, '/');
    if (!fs.existsSync(pkgDir)) {
      console.warn(`[seed] Package directory not found, skipping: ${pkgDir}`);
      continue;
    }
    const files = collectTsFiles(pkgDir);
    console.log(`       ${pkg.name.padEnd(25)} ${files.length} files`);
    allFiles.push(...files);
  }
  console.log(`\n       Total files: ${allFiles.length}`);

  // Step 3: Service + Module nodes
  console.log('\n[seed] Step 3/8: Creating structural nodes (Service, Module)...');
  await createServiceNodes(driver);
  await createModuleNodes(allFiles, driver);

  // Step 4: Parse all files in batches
  console.log('\n[seed] Step 4/8: Parsing TypeScript files...');
  const parseStart = Date.now();
  let totalFunctions = 0;
  let totalTypes = 0;
  let totalErrors = 0;
  let filesProcessed = 0;

  for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
    const batch = allFiles.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(allFiles.length / BATCH_SIZE);
    const pct = Math.round((i / allFiles.length) * 100);

    process.stdout.write(
      `\r       Batch ${batchNum}/${totalBatches} (${pct}%) — ${filesProcessed} files done...`
    );

    // Parse
    const parsedFiles = parseFiles(batch);

    // Write to graph
    const writeResult = await writeParsedBatch(parsedFiles, driver);
    totalFunctions += writeResult.functions;
    totalTypes += writeResult.types;
    totalErrors += writeResult.errors;
    filesProcessed += batch.length;

    // Release ts-morph memory periodically
    if (batchNum % 5 === 0) clearProjectCache();
  }

  clearProjectCache();
  process.stdout.write('\n');

  console.log(`       Files parsed:        ${allFiles.length}`);
  console.log(`       Functions created:   ${totalFunctions}`);
  console.log(`       Types created:       ${totalTypes}`);
  console.log(`       File errors:         ${totalErrors}`);
  console.log(`       Parse time:          ${((Date.now() - parseStart) / 1000).toFixed(1)}s`);

  // Step 5: Second pass — relationship edges (CALLS, USES_TYPE, EXTENDS, IMPLEMENTS, INJECTS)
  // All nodes must exist before we can create cross-references.
  console.log('\n[seed] Step 5/8: Creating relationship edges (CALLS, USES_TYPE, EXTENDS, IMPLEMENTS, INJECTS)...');
  const relStart = Date.now();
  let callsCreated = 0;
  let usesTypeCreated = 0;
  let hierarchyCreated = 0;
  let injectsCreated = 0;

  for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
    const batch = allFiles.slice(i, i + BATCH_SIZE);
    const parsedFiles = parseFiles(batch);

    for (const parsedFile of parsedFiles) {
      const session2 = driver.session({ defaultAccessMode: 'WRITE' });
      const tx2 = session2.beginTransaction();
      try {
        // CALLS + USES_TYPE from functions
        for (const fn of parsedFile.functions) {
          for (const callee of fn.callees) {
            try {
              const res = await tx2.run(
                `MATCH (caller:Function {filePath: $filePath, name: $callerName})
                 MATCH (callee:Function)
                 WHERE callee.name = $calleeName OR callee.name ENDS WITH $calleeSuffix
                 WITH caller, callee LIMIT 1
                 MERGE (caller)-[:CALLS]->(callee)
                 RETURN count(*) AS c`,
                { filePath: fn.filePath, callerName: fn.name, calleeName: callee, calleeSuffix: '.' + callee }
              );
              callsCreated += res.records[0]?.get('c')?.toNumber?.() ?? 0;
            } catch { /* skip unresolvable */ }
          }
          for (const typeName of fn.typeRefs) {
            try {
              const res = await tx2.run(
                `MATCH (f:Function {filePath: $filePath, name: $funcName})
                 MATCH (t:Type {name: $typeName})
                 WITH f, t LIMIT 1
                 MERGE (f)-[:USES_TYPE]->(t)
                 RETURN count(*) AS c`,
                { filePath: fn.filePath, funcName: fn.name, typeName }
              );
              usesTypeCreated += res.records[0]?.get('c')?.toNumber?.() ?? 0;
            } catch { /* skip */ }
          }
        }

        // EXTENDS, IMPLEMENTS, INJECTS from types
        for (const ty of parsedFile.types) {
          if (ty.extends) {
            try {
              const res = await tx2.run(
                `MATCH (child:Type {filePath: $filePath, name: $childName})
                 MATCH (parent:Type {name: $parentName})
                 WITH child, parent LIMIT 1
                 MERGE (child)-[:EXTENDS]->(parent)
                 RETURN count(*) AS c`,
                { filePath: ty.filePath, childName: ty.name, parentName: ty.extends }
              );
              hierarchyCreated += res.records[0]?.get('c')?.toNumber?.() ?? 0;
            } catch { /* skip */ }
          }
          for (const ifaceName of ty.implements) {
            try {
              const res = await tx2.run(
                `MATCH (cls:Type {filePath: $filePath, name: $className})
                 MATCH (iface:Type {name: $ifaceName})
                 WITH cls, iface LIMIT 1
                 MERGE (cls)-[:IMPLEMENTS]->(iface)
                 RETURN count(*) AS c`,
                { filePath: ty.filePath, className: ty.name, ifaceName }
              );
              hierarchyCreated += res.records[0]?.get('c')?.toNumber?.() ?? 0;
            } catch { /* skip */ }
          }
          for (const param of ty.constructorParams) {
            const targetType = param.injectToken ?? param.type;
            if (targetType === 'unknown' || targetType.length > 80) continue;
            try {
              const res = await tx2.run(
                `MATCH (cls:Type {filePath: $filePath, name: $className})
                 MATCH (dep:Type {name: $depName})
                 WITH cls, dep LIMIT 1
                 MERGE (cls)-[r:INJECTS]->(dep)
                 SET r.paramName = $paramName
                 RETURN count(*) AS c`,
                { filePath: ty.filePath, className: ty.name, depName: targetType, paramName: param.name }
              );
              injectsCreated += res.records[0]?.get('c')?.toNumber?.() ?? 0;
            } catch { /* skip */ }
          }
        }

        await tx2.commit();
      } catch (err) {
        await tx2.rollback();
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[seed] WARNING: relationship pass failed for ${parsedFile.filePath} — ${msg}\n`);
      }
      await session2.close();
    }

    clearProjectCache();
  }

  console.log(`       CALLS edges:         ${callsCreated}`);
  console.log(`       USES_TYPE edges:     ${usesTypeCreated}`);
  console.log(`       Hierarchy edges:     ${hierarchyCreated}`);
  console.log(`       INJECTS edges:       ${injectsCreated}`);
  console.log(`       Relationship time:   ${((Date.now() - relStart) / 1000).toFixed(1)}s`);

  // Step 6: Integrity check
  console.log('\n[seed] Step 6/8: Running integrity checks...');
  const integrityResult = await runIntegrityChecks();

  // Step 7: Write .last-sync-commit
  console.log('\n[seed] Step 7/8: Recording sync cursor...');
  const currentCommit = execSync('git rev-parse HEAD', {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  }).trim();
  writeLastSyncCommit(currentCommit);

  // Summary
  const totalTime = (Date.now() - startTime) / 1000;
  console.log('\n' + '='.repeat(60));
  console.log('[seed] Initial seed complete');
  console.log('='.repeat(60));
  console.log(`       Commit:              ${currentCommit.slice(0, 8)}`);
  console.log(`       Total functions:     ${totalFunctions}`);
  console.log(`       Total types:         ${totalTypes}`);
  console.log(`       Parse errors:        ${totalErrors}`);
  console.log(`       Integrity passed:    ${integrityResult.passed}`);
  console.log(`       Total time:          ${totalTime.toFixed(1)}s`);

  if (!integrityResult.passed) {
    console.error('\n[seed] WARNING: integrity checks did not fully pass. See above for details.');
  }

  await closeDriver();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSeed().catch(err => {
    console.error('[seed] Fatal error:', err instanceof Error ? err.message : String(err));
    closeDriver().finally(() => process.exit(1));
  });
}

export { runSeed };
