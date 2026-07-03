#!/usr/bin/env node
/**
 * install-skills.cjs — copy staged pipeline skills into .claude/skills/.
 *
 * Run once from the repo root:   node pipeline/skills/install-skills.cjs
 *
 * Copies every skill folder under pipeline/skills/ (each containing a SKILL.md)
 * into .claude/skills/<name>/ so it's invocable as /<name>. Idempotent — it
 * overwrites the installed copy with the staged one, so re-running updates them.
 * Pass --list to see what would be installed without copying.
 *
 * (Separate step because an agent session cannot write into .claude/. You run it,
 * so installing a new skill is an explicit, auditable opt-in.)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const repoRoot = process.cwd();
const stageDir = path.join(repoRoot, 'pipeline', 'skills');
const destRoot = path.join(repoRoot, '.claude', 'skills');
const listOnly = process.argv.includes('--list');

if (!fs.existsSync(path.join(repoRoot, '.claude'))) {
  console.error('No .claude/ at the repo root — run this from the repo root.');
  process.exit(1);
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

const skills = fs.readdirSync(stageDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(stageDir, e.name, 'SKILL.md')))
  .map((e) => e.name);

if (skills.length === 0) {
  console.log('No staged skills found under pipeline/skills/.');
  process.exit(0);
}

for (const name of skills) {
  if (listOnly) {
    console.log(`would install: ${name} -> .claude/skills/${name}/`);
    continue;
  }
  copyDir(path.join(stageDir, name), path.join(destRoot, name));
  console.log(`installed: /${name}`);
}

if (!listOnly) {
  console.log('Restart the Claude session (or reload) for new skills to register.');
}
