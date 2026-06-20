/**
 * tk-43-healthcheck.e2e.ts
 *
 * TK-43 acceptance gate: static verification that the production Dockerfile
 * contains the correct HEALTHCHECK instruction.
 *
 * Acceptance criterion 1 (static — verifiable here):
 *   The production stage Dockerfile contains a HEALTHCHECK that calls
 *   /metrics/health on the correct PORT.
 *
 * Acceptance criterion 2 (runtime — requires docker build + run):
 *   After the start-period, docker inspect shows Health.Status=healthy when
 *   the app is responsive; Health.Status flips to unhealthy after --retries
 *   when the endpoint hangs past --timeout. Verify manually:
 *     docker build -t sylphie-test .
 *     docker run -d -e PORT=3000 --name sylphie-hc-test sylphie-test
 *     sleep 90  # wait for start-period + one pass
 *     docker inspect --format='{{.State.Health.Status}}' sylphie-hc-test
 *     # => "healthy"
 *
 * Run: npx tsx test/e2e/tk-43-healthcheck.e2e.ts
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CheckResult {
  check: string;
  status: 'PASS' | 'FAIL';
  detail: string;
}

const results: CheckResult[] = [];

function record(check: string, status: 'PASS' | 'FAIL', detail: string) {
  results.push({ check, status, detail });
  const icon = status === 'PASS' ? '[PASS]' : '[FAIL]';
  console.log(`  ${icon} ${check} — ${detail}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log('\nTK-43 — Dockerfile HEALTHCHECK static verification\n');

  const dockerfilePath = path.resolve(process.cwd(), 'Dockerfile');
  let content: string;
  try {
    content = fs.readFileSync(dockerfilePath, 'utf8');
  } catch (err) {
    record('Dockerfile readable', 'FAIL', `Cannot read ${dockerfilePath}: ${err}`);
    process.exit(1);
  }

  // AC1a: HEALTHCHECK instruction present in the production stage.
  // The production stage is "FROM node:20-alpine AS production"; everything
  // after it through end-of-file is the production stage.
  const productionStageIdx = content.indexOf('AS production');
  if (productionStageIdx === -1) {
    record('production stage present', 'FAIL', 'Could not locate "AS production" stage in Dockerfile');
    process.exit(1);
  }
  const productionStage = content.slice(productionStageIdx);

  const hasHealthcheck = /^HEALTHCHECK\b/m.test(productionStage);
  record(
    'HEALTHCHECK present in production stage',
    hasHealthcheck ? 'PASS' : 'FAIL',
    hasHealthcheck
      ? 'HEALTHCHECK instruction found after "AS production"'
      : 'No HEALTHCHECK instruction found in production stage',
  );

  // AC1b: /metrics/health endpoint is the target.
  const hitsHealthEndpoint = /\/metrics\/health\b/.test(productionStage);
  record(
    'HEALTHCHECK targets /metrics/health',
    hitsHealthEndpoint ? 'PASS' : 'FAIL',
    hitsHealthEndpoint
      ? 'HEALTHCHECK references /metrics/health'
      : 'HEALTHCHECK does not reference /metrics/health',
  );

  // AC1c: Uses PORT env var with fallback (mirrors app's PORT || APP_PORT || 3000).
  // The check must hit the same port the app binds. Railway sets PORT at
  // runtime, so the healthcheck uses ${PORT:-3000} for correct resolution.
  const usesPortEnv = /\$\{PORT:-\d+\}/.test(productionStage) || /\$PORT/.test(productionStage);
  record(
    'HEALTHCHECK uses PORT env var',
    usesPortEnv ? 'PASS' : 'FAIL',
    usesPortEnv
      ? 'HEALTHCHECK references $PORT (or ${PORT:-N}) for dynamic port resolution'
      : 'HEALTHCHECK does not reference $PORT — will miss Railway-assigned port',
  );

  // AC1d: Timing parameters are present and sane.
  // --start-period must exist so migration + boot time doesn't cause false unhealthy.
  const hasStartPeriod = /--start-period=\d/.test(productionStage);
  record(
    'HEALTHCHECK has --start-period',
    hasStartPeriod ? 'PASS' : 'FAIL',
    hasStartPeriod
      ? '--start-period present (prevents false unhealthy during Prisma migrations / boot)'
      : '--start-period missing — container will go unhealthy before the app finishes booting',
  );

  // AC1e: Uses wget (available in node:20-alpine via BusyBox; curl is not installed).
  const usesWget = /\bwget\b/.test(productionStage);
  record(
    'HEALTHCHECK uses wget (Alpine-compatible)',
    usesWget ? 'PASS' : 'FAIL',
    usesWget
      ? 'wget used — present in node:20-alpine via BusyBox without extra apk install'
      : 'wget not used — curl is not available in node:20-alpine without apk install',
  );

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`\n${passed} passed, ${failed} failed\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

main();
