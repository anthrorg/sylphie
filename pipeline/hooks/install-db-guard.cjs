#!/usr/bin/env node
/**
 * install-db-guard.cjs — register db-change-guard as a PreToolUse hook.
 *
 * Run once from the repo root:   node pipeline/hooks/install-db-guard.cjs
 *
 * Idempotent: adds a PreToolUse entry (matcher "Write|Edit|Bash") that runs
 * pipeline/hooks/db-change-guard.cjs, without touching your existing hooks or
 * permissions. Re-running is a no-op. Pass --uninstall to remove it.
 *
 * (This is a separate step because an agent session cannot write into .claude/.
 * You run it yourself, so it's an explicit opt-in to repo-wide enforcement.)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const repoRoot = process.cwd();
const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
const COMMAND = 'node "$CLAUDE_PROJECT_DIR"/pipeline/hooks/db-change-guard.cjs';
const MATCHER = 'Write|Edit|Bash';
const uninstall = process.argv.includes('--uninstall');

if (!fs.existsSync(settingsPath)) {
  console.error(`No .claude/settings.json at ${settingsPath} — run this from the repo root.`);
  process.exit(1);
}

const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
settings.hooks = settings.hooks || {};
const pre = (settings.hooks.PreToolUse = settings.hooks.PreToolUse || []);

const hasOurs = (entry) =>
  (entry.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes('db-change-guard.cjs'));

if (uninstall) {
  const before = pre.length;
  settings.hooks.PreToolUse = pre.filter((e) => !hasOurs(e));
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(before === settings.hooks.PreToolUse.length
    ? 'db-change-guard was not installed; nothing to remove.'
    : 'db-change-guard hook removed.');
  process.exit(0);
}

if (pre.some(hasOurs)) {
  console.log('db-change-guard already installed — no change.');
  process.exit(0);
}

pre.push({
  matcher: MATCHER,
  hooks: [{ type: 'command', command: COMMAND, timeout: 10 }],
});

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log('Installed db-change-guard as a PreToolUse hook (Write|Edit|Bash).');
console.log('Restart the Claude session (or reload settings) for it to take effect.');
