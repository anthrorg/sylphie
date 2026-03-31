/**
 * backfill-changes.ts -- One-shot backfill of Change nodes from git log history.
 *
 * Reads the last 30 commits from the sylphie git repo, creates a Change node
 * for each commit, and wires CHANGED_IN edges from any Function or Type node
 * whose filePath matches files touched by that commit.
 *
 * Idempotent: skips commits whose Change node already exists (matched by hash).
 *
 * Entry point: `npx tsx src/ingestion/backfill-changes.ts`
 */

import { execSync } from 'child_process';
import neo4j, { Integer as Neo4jInteger, Session } from 'neo4j-driver';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REPO_ROOT = 'C:/Users/Jim/OneDrive/Desktop/Code/sylphie';
const NEO4J_URI = 'bolt://localhost:7691';
const NEO4J_USER = 'neo4j';
const NEO4J_PASSWORD = 'sylphie-pkg-local';
const COMMIT_LIMIT = 30;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CommitMeta {
  hash: string;
  shortHash: string;
  author: string;
  date: string;   // ISO 8601
  message: string;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Returns the last N commits from the repo at repoRoot.
 *
 * Format string uses unit separator (0x1F) to safely delimit fields that may
 * contain spaces (author names, commit messages).
 */
function getRecentCommits(repoRoot: string, limit: number): CommitMeta[] {
  // %H  = full hash
  // %h  = short hash
  // %an = author name
  // %aI = author date, strict ISO 8601
  // %s  = subject (first line of commit message)
  const format = '%H\x1F%h\x1F%an\x1F%aI\x1F%s';
  const raw = execSync(
    `git -C "${repoRoot}" log -${limit} --format="${format}"`,
    { encoding: 'utf8' }
  ).trim();

  if (!raw) return [];

  return raw.split('\n').map((line) => {
    const parts = line.split('\x1F');
    if (parts.length < 5) {
      throw new Error(`Unexpected git log line format: ${line}`);
    }
    return {
      hash: parts[0].trim(),
      shortHash: parts[1].trim(),
      author: parts[2].trim(),
      date: parts[3].trim(),
      message: parts[4].trim(),
    };
  });
}

/**
 * Returns the list of files changed in a given commit.
 *
 * For the first commit (no parent), `<hash>~1` does not exist.
 * Falls back to `git show --name-only` which handles root commits.
 * Returns an empty array on any unrecoverable error.
 */
function getChangedFiles(repoRoot: string, hash: string): string[] {
  try {
    const raw = execSync(
      `git -C "${repoRoot}" diff --name-only ${hash}~1 ${hash}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    return raw ? raw.split('\n').map((f) => f.trim()).filter(Boolean) : [];
  } catch {
    // Likely a root commit with no parent — fall back to git show
    try {
      const raw = execSync(
        `git -C "${repoRoot}" show --name-only --format="" ${hash}`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      return raw ? raw.split('\n').map((f) => f.trim()).filter(Boolean) : [];
    } catch {
      console.warn(`  [warn] Could not get changed files for ${hash} — skipping file edges`);
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Neo4j helpers
// ---------------------------------------------------------------------------

/**
 * Coerces a Neo4j query result value to a plain JS number.
 * neo4j-driver v5 returns integers as Neo4jInteger objects.
 */
function toNumber(value: unknown): number {
  if (value instanceof Neo4jInteger) return value.toNumber();
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return 0;
}

// ---------------------------------------------------------------------------
// Neo4j writes
// ---------------------------------------------------------------------------

/**
 * Ensures the uniqueness constraint on Change.hash exists.
 * Safe to call if the constraint already exists.
 */
async function ensureConstraint(session: Session): Promise<void> {
  await session.run(
    `CREATE CONSTRAINT change_hash_unique IF NOT EXISTS
     FOR (c:Change) REQUIRE c.hash IS UNIQUE`
  );
}

/**
 * Returns true if a Change node with the given hash already exists.
 */
async function changeExists(session: Session, hash: string): Promise<boolean> {
  const result = await session.run(
    `OPTIONAL MATCH (c:Change { hash: $hash }) RETURN c IS NOT NULL AS exists`,
    { hash }
  );
  const record = result.records[0];
  return record ? Boolean(record.get('exists')) : false;
}

/**
 * Creates a Change node for the given commit.
 * Caller must have already checked the node does not exist.
 */
async function createChangeNode(
  session: Session,
  commit: CommitMeta,
  fileCount: number,
  recordedAt: string
): Promise<void> {
  await session.run(
    `CREATE (c:Change {
       hash:       $hash,
       shortHash:  $shortHash,
       author:     $author,
       date:       $date,
       message:    $message,
       fileCount:  $fileCount,
       recordedAt: $recordedAt
     })`,
    {
      hash: commit.hash,
      shortHash: commit.shortHash,
      author: commit.author,
      date: commit.date,
      message: commit.message,
      fileCount,          // plain JS number — driver stores as integer
      recordedAt,
    }
  );
}

/**
 * Creates CHANGED_IN edges from Function and Type nodes whose filePath
 * ends with any of the given relative paths.
 *
 * filePaths from git are relative to the repo root (e.g. "packages/backend/src/foo.ts").
 * Node filePath properties may be absolute Windows paths, so we normalize
 * separators and match on suffix.
 *
 * Returns the number of edges created or matched.
 */
async function wireChangedInEdges(
  session: Session,
  commitHash: string,
  relativePaths: string[]
): Promise<number> {
  if (relativePaths.length === 0) return 0;

  // Normalize all paths to forward-slash for consistent suffix matching
  const normalized = relativePaths.map((p) => p.replace(/\\/g, '/'));

  const result = await session.run(
    `MATCH (n) WHERE (n:Function OR n:Type)
       AND n.filePath IS NOT NULL
       AND ANY(rp IN $paths WHERE replace(n.filePath, '\\\\', '/') ENDS WITH rp)
     WITH n
     MATCH (c:Change { hash: $hash })
     MERGE (n)-[:CHANGED_IN]->(c)
     RETURN count(n) AS wired`,
    { hash: commitHash, paths: normalized }
  );

  const record = result.records[0];
  return record ? toNumber(record.get('wired')) : 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== Codebase PKG — Change node backfill ===');
  console.log(`Repo:    ${REPO_ROOT}`);
  console.log(`Neo4j:   ${NEO4J_URI}`);
  console.log(`Commits: last ${COMMIT_LIMIT}`);
  console.log('');

  // -- 1. Read git log --
  console.log('Reading git log...');
  const commits = getRecentCommits(REPO_ROOT, COMMIT_LIMIT);
  console.log(`Found ${commits.length} commits.\n`);

  // -- 2. Connect to Neo4j --
  const driver = neo4j.driver(
    NEO4J_URI,
    neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
    {
      maxConnectionPoolSize: 5,
      logging: {
        level: 'warn',
        logger: (level, message) => {
          if (level === 'error' || level === 'warn') {
            process.stderr.write(`[neo4j] [${level}] ${message}\n`);
          }
        },
      },
    }
  );

  try {
    await driver.verifyConnectivity();
    console.log('Neo4j connection verified.\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to connect to Neo4j at ${NEO4J_URI}: ${msg}`);
    await driver.close();
    process.exit(1);
  }

  const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });

  try {
    // -- 3. Ensure constraint --
    console.log('Ensuring Change.hash uniqueness constraint...');
    await ensureConstraint(session);
    console.log('Constraint ready.\n');

    const recordedAt = new Date().toISOString();
    let created = 0;
    let skipped = 0;
    let totalEdges = 0;

    // -- 4. Process each commit --
    for (let i = 0; i < commits.length; i++) {
      const commit = commits[i];
      const prefix = `[${String(i + 1).padStart(2, '0')}/${commits.length}]`;

      // Check idempotency before doing any file I/O
      const exists = await changeExists(session, commit.hash);
      if (exists) {
        console.log(`${prefix} SKIP  ${commit.shortHash}  ${commit.message.slice(0, 60)}`);
        skipped++;
        continue;
      }

      // Get changed files (may involve a git subprocess)
      const changedFiles = getChangedFiles(REPO_ROOT, commit.hash);

      // Create Change node
      await createChangeNode(session, commit, changedFiles.length, recordedAt);

      // Wire CHANGED_IN edges
      let edgeCount = 0;
      if (changedFiles.length > 0) {
        edgeCount = await wireChangedInEdges(session, commit.hash, changedFiles);
        totalEdges += edgeCount;
      }

      console.log(
        `${prefix} CREATE ${commit.shortHash}  ${commit.message.slice(0, 55).padEnd(55)}  ` +
        `files=${String(changedFiles.length).padStart(3)}  edges=${String(edgeCount).padStart(3)}`
      );
      created++;
    }

    // -- 5. Summary --
    console.log('');
    console.log('=== Backfill complete ===');
    console.log(`  Change nodes created : ${created}`);
    console.log(`  Change nodes skipped : ${skipped} (already existed)`);
    console.log(`  CHANGED_IN edges     : ${totalEdges}`);
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
