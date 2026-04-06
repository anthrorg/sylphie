/**
 * git-diff.ts -- Detect changed TypeScript files since the last sync.
 *
 * Reads a .last-sync-commit file to find the last synced git commit, runs
 * git diff to identify changed files, and filters to only the TypeScript
 * sources we care about in this monorepo.
 *
 * On the first run (no .last-sync-commit), returns ALL matching files so
 * the initial seed can use this same interface.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = process.cwd();
const LAST_SYNC_FILE = path.join(REPO_ROOT, 'packages', 'sylphie-pkg', '.last-sync-commit');

/**
 * Directories within the repo that contain TypeScript we want to index.
 * Adjusted for the new monorepo structure:
 *   apps/sylphie/src  — NestJS backend
 *   packages/*        — domain packages (excluding sylphie-pkg itself and perception-service)
 */
const WATCHED_DIRECTORIES = [
  'apps/sylphie/src',
  'packages/shared/src',
  'packages/decision-making/src',
  'packages/drive-engine/src',
  'frontend/src',
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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function git(args: string): string {
  return execSync(`git ${args}`, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

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
  changedFiles: string[];
  currentCommit: string;
  isInitialRun: boolean;
}

export function getChangedFiles(): DiffResult {
  const currentCommit = git('rev-parse HEAD');

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

  // Verify the last commit is reachable
  try {
    git(`cat-file -t ${lastCommit}`);
  } catch {
    console.warn(
      `[git-diff] Last sync commit ${lastCommit} is no longer reachable. Falling back to all watched files.`
    );
    const changedFiles = getAllWatchedFiles();
    return { changedFiles, currentCommit, isInitialRun: true };
  }

  const diffOutput = git(`diff --name-only ${lastCommit} HEAD`);
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
    .filter(absPath => fs.existsSync(absPath));

  console.log(`[git-diff] ${changedFiles.length} changed file(s) since ${lastCommit.slice(0, 8)}.`);
  return { changedFiles, currentCommit, isInitialRun: false };
}

export function writeLastSyncCommit(commitHash: string): void {
  fs.writeFileSync(LAST_SYNC_FILE, commitHash, 'utf-8');
  console.log(`[git-diff] Cursor advanced to ${commitHash.slice(0, 8)}.`);
}

export function readLastSyncCommit(): string | null {
  if (!fs.existsSync(LAST_SYNC_FILE)) return null;
  return fs.readFileSync(LAST_SYNC_FILE, 'utf-8').trim() || null;
}

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
