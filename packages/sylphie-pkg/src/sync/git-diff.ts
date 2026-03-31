/**
 * git-diff.ts -- Detect changed TypeScript files since the last sync.
 *
 * Reads a .last-sync-commit file to find the last synced git commit, runs
 * git diff to identify changed files, and filters to only the TypeScript
 * sources we care about in this monorepo.
 *
 * On the first run (no .last-sync-commit), returns ALL matching files so
 * the initial seed can use this same interface.
 *
 * After a successful sync the caller is responsible for calling
 * writeLastSyncCommit() to advance the cursor forward.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = 'C:/Users/Jim/OneDrive/Desktop/Code/sylphie';
const LAST_SYNC_FILE = path.join(REPO_ROOT, 'packages', 'sylphie-pkg', '.last-sync-commit');

/**
 * Directories within the repo that contain TypeScript we want to index.
 * Python packages and firmware are excluded.
 */
const WATCHED_DIRECTORIES = [
  'src',
];

/**
 * Glob suffixes to exclude even if they pass the directory filter.
 */
const EXCLUDE_PATTERNS = [
  /node_modules/,
  /\/dist\//,
  /\.d\.ts$/,
  /\.spec\.ts$/,
  /\.test\.ts$/,
  /\.spec\.tsx$/,
  /\.test\.tsx$/,
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command and return stdout as a string.
 * Throws if the command exits non-zero.
 */
function git(args: string): string {
  return execSync(`git ${args}`, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Returns true if the file path is inside one of the watched directories
 * and does not match any exclusion pattern.
 */
function isWatchedFile(relativePath: string): boolean {
  const normalised = relativePath.replace(/\\/g, '/');

  const inWatchedDir = WATCHED_DIRECTORIES.some(dir =>
    normalised.startsWith(dir + '/')
  );
  if (!inWatchedDir) return false;

  const isTypeScript = normalised.endsWith('.ts') || normalised.endsWith('.tsx');
  if (!isTypeScript) return false;

  return !EXCLUDE_PATTERNS.some(rx => rx.test(normalised));
}

/**
 * Walk the entire repo and return all watched TypeScript files.
 * Used on the first run when there is no last-sync-commit.
 */
function getAllWatchedFiles(): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name).replace(/\\/g, '/');
      const relativePath = fullPath.replace(REPO_ROOT.replace(/\\/g, '/') + '/', '');

      if (entry.isDirectory()) {
        // Skip directories that are definitively excluded
        if (
          entry.name === 'node_modules' ||
          entry.name === 'dist' ||
          entry.name === '.git' ||
          entry.name === 'archives'
        ) {
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile() && isWatchedFile(relativePath)) {
        results.push(fullPath);
      }
    }
  }

  walk(REPO_ROOT);
  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DiffResult {
  /** Absolute paths to changed files that need re-parsing. */
  changedFiles: string[];
  /** The current HEAD commit hash. */
  currentCommit: string;
  /** True if no .last-sync-commit existed (first run). */
  isInitialRun: boolean;
}

/**
 * Determine which TypeScript files need to be re-indexed since the last sync.
 *
 * On first run (no .last-sync-commit), all watched TypeScript files are
 * returned so the initial seed pipeline can process them.
 *
 * @returns DiffResult with changed files and metadata.
 */
export function getChangedFiles(): DiffResult {
  const currentCommit = git('rev-parse HEAD');

  // First run: no cursor file exists
  if (!fs.existsSync(LAST_SYNC_FILE)) {
    console.log('[git-diff] No .last-sync-commit found — returning all watched files (initial run).');
    const changedFiles = getAllWatchedFiles();
    return { changedFiles, currentCommit, isInitialRun: true };
  }

  const lastCommit = fs.readFileSync(LAST_SYNC_FILE, 'utf-8').trim();

  if (lastCommit === currentCommit) {
    console.log('[git-diff] Already up to date — no changes since last sync.');
    return { changedFiles: [], currentCommit, isInitialRun: false };
  }

  // Verify the last commit is reachable (handles rebases / force pushes)
  let diffBase = lastCommit;
  try {
    git(`cat-file -t ${lastCommit}`);
  } catch {
    console.warn(
      `[git-diff] Last sync commit ${lastCommit} is no longer reachable. Falling back to all watched files.`
    );
    const changedFiles = getAllWatchedFiles();
    return { changedFiles, currentCommit, isInitialRun: true };
  }

  const diffOutput = git(`diff --name-only ${diffBase} HEAD`);
  if (!diffOutput) {
    return { changedFiles: [], currentCommit, isInitialRun: false };
  }

  const changedFiles = diffOutput
    .split('\n')
    .filter(line => line.trim().length > 0)
    .filter(relativePath => isWatchedFile(relativePath))
    .map(relativePath =>
      path.join(REPO_ROOT, relativePath).replace(/\\/g, '/')
    )
    // Only include files that still exist on disk (deletions are handled separately)
    .filter(absPath => fs.existsSync(absPath));

  console.log(`[git-diff] ${changedFiles.length} changed file(s) since ${lastCommit.slice(0, 8)}.`);
  return { changedFiles, currentCommit, isInitialRun: false };
}

/**
 * Write the current HEAD commit hash to .last-sync-commit.
 * Call this AFTER a successful sync to advance the cursor.
 *
 * @param commitHash - The commit hash to record (from DiffResult.currentCommit).
 */
export function writeLastSyncCommit(commitHash: string): void {
  fs.writeFileSync(LAST_SYNC_FILE, commitHash, 'utf-8');
  console.log(`[git-diff] Cursor advanced to ${commitHash.slice(0, 8)}.`);
}

/**
 * Returns the commit hash recorded in .last-sync-commit, or null if
 * the file does not exist (first run).
 */
export function readLastSyncCommit(): string | null {
  if (!fs.existsSync(LAST_SYNC_FILE)) return null;
  return fs.readFileSync(LAST_SYNC_FILE, 'utf-8').trim() || null;
}

/**
 * Get files deleted since the last sync commit.
 * Returns relative paths (from repo root) of files that were deleted.
 * Used by the graph-differ to remove stale nodes.
 */
export function getDeletedFiles(lastCommit: string, currentCommit: string): string[] {
  if (lastCommit === currentCommit) return [];

  try {
    const output = git(`diff --name-only --diff-filter=D ${lastCommit} ${currentCommit}`);
    if (!output) return [];
    return output
      .split('\n')
      .filter(line => line.trim().length > 0)
      .filter(relativePath => isWatchedFile(relativePath));
  } catch {
    return [];
  }
}
