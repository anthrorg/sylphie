/**
 * TK-44 — Subpath exports verification
 *
 * Acceptance criteria:
 *   AC1: The Dockerfile no longer contains the cp workaround that mirrored
 *        dist/ contents to package roots to work around missing exports fields.
 *   AC2: drive-engine/package.json has an exports field covering both
 *        ./drive-process/* and ./ipc-channel/* — the subpaths used by
 *        apps/drive-server at runtime.
 *
 * Run: npx tsx test/e2e/tk-44-subpath-exports.spec.ts
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const root = process.cwd();

function pass(msg: string): void { console.log(`[PASS] ${msg}`); }
function fail(msg: string): void { console.error(`[FAIL] ${msg}`); process.exitCode = 1; }

// ---------------------------------------------------------------------------
// AC1: Dockerfile must not contain the cp workaround
// ---------------------------------------------------------------------------

const dockerfilePath = resolve(root, 'Dockerfile');
const dockerfile = readFileSync(dockerfilePath, 'utf8');

// The workaround mirrored dist/ contents to package roots. Its signature was
// "cp -r /app/packages/drive-engine/dist/." — match that exact pattern.
if (dockerfile.includes('cp -r /app/packages/drive-engine/dist/.')) {
  fail('AC1: Dockerfile still contains the cp workaround for drive-engine');
} else {
  pass('AC1: Dockerfile does not contain the redundant cp workaround');
}

// Ensure no cp of any package dist to its root remains (belt-and-suspenders)
const cpHackPattern = /cp -r \/app\/packages\/\w[\w-]*\/dist\//;
if (cpHackPattern.test(dockerfile)) {
  fail('AC1: Dockerfile still contains a package dist cp hack');
} else {
  pass('AC1: No package dist cp hack present in Dockerfile');
}

// ---------------------------------------------------------------------------
// AC2: drive-engine/package.json exports field covers subpath consumers
// ---------------------------------------------------------------------------

const drivePkgPath = resolve(root, 'packages/drive-engine/package.json');
const drivePkg = JSON.parse(readFileSync(drivePkgPath, 'utf8'));

if (!drivePkg.exports) {
  fail('AC2: drive-engine/package.json has no exports field');
} else {
  pass('AC2: drive-engine/package.json has an exports field');

  // Must cover ./drive-process/* (used by apps/drive-server main.ts)
  if (drivePkg.exports['./drive-process/*']) {
    const entry = drivePkg.exports['./drive-process/*'];
    const defaultMap: string = entry['default'] ?? entry;
    if (defaultMap.startsWith('./dist/drive-process/')) {
      pass('AC2: ./drive-process/* export maps to dist/drive-process/');
    } else {
      fail(`AC2: ./drive-process/* export default "${defaultMap}" does not point into dist/`);
    }
  } else {
    fail('AC2: drive-engine/package.json exports missing ./drive-process/* entry');
  }

  // Must cover ./ipc-channel/* (used by apps/drive-server ws-transport.ts)
  if (drivePkg.exports['./ipc-channel/*']) {
    const entry = drivePkg.exports['./ipc-channel/*'];
    const defaultMap: string = entry['default'] ?? entry;
    if (defaultMap.startsWith('./dist/ipc-channel/')) {
      pass('AC2: ./ipc-channel/* export maps to dist/ipc-channel/');
    } else {
      fail(`AC2: ./ipc-channel/* export default "${defaultMap}" does not point into dist/`);
    }
  } else {
    fail('AC2: drive-engine/package.json exports missing ./ipc-channel/* entry');
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

if (!process.exitCode) {
  console.log('\nAll TK-44 acceptance criteria satisfied.');
} else {
  console.error('\nOne or more TK-44 acceptance criteria FAILED.');
}
