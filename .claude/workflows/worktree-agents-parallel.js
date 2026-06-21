export const meta = {
  name: 'worktree-agents-parallel',
  description: 'Parallel worktree agent loop: pick a wave of dependency-independent todo tickets, build up to 10 at once in isolated git worktrees, open PRs, repeat. Orchestrator is the sole contract writer; builds are parallel, contract writes are not.',
  phases: [
    { title: 'Pick & Assign' },
    { title: 'Build' },
    { title: 'Close' },
  ]
}

// ─── Configuration ────────────────────────────────────────────────────────────
const REPO_ROOT    = 'C:/Users/Jim/OneDrive/desktop/Code/sylphie'
const WT_BASE      = 'C:/Users/Jim/OneDrive/desktop/Code/sylphie-worktrees'
const CONTRACT     = REPO_ROOT + '/planning/contract.yaml'
const ORCH_MODEL   = 'opus'                                     // orchestration agents (pick/assign/close)
const BUILD_MODEL  = 'sonnet'                                   // build workers
const MAX_PARALLEL = 10                                         // up to 10 build agents at once
// Total tickets to process across all waves (safety cap; override with args.count).
const MAX_TICKETS  = (args && args.count) ? args.count : 50

// ─── Structured output schemas ────────────────────────────────────────────────

// One ready ticket as emitted by pick_ready.py. dependsOn is kept for the wave-dedup guard.
const TICKET_FIELDS = {
  ticketId:            { type: ['string', 'null'] },
  ticketTitle:         { type: ['string', 'null'] },
  ticketSlug:          { type: ['string', 'null'],
                         description: 'Short 3-5 word kebab-case slug derived from the title' },
  priority:            { type: ['string', 'null'], description: 'P1 | P2 | P3' },
  description:         { type: ['string', 'null'] },
  acceptanceCriteria:  { type: 'array', items: { type: 'string' },
                         description: 'Each criterion as a single readable string' },
  engineeringLevel:    { type: ['string', 'null'] },
  filesInScope:        { type: 'array', items: { type: 'string' } },
  testRefs:            { type: 'array', items: { type: 'string' } },
  parentEpic:          { type: ['string', 'null'] },
  dependsOn:           { type: 'array', items: { type: 'string' },
                         description: 'The ids in this ticket\'s depends_on field (empty array if none)' },
}

// The pick step runs the deterministic pick_ready.py (canonical planning-worx readiness)
// and just relays its JSON — no LLM parses the contract. Already filtered + sorted + limited.
const READY_BATCH_SCHEMA = {
  type: 'object',
  properties: {
    tickets: {
      type: 'array',
      description: 'The ready tickets emitted by pick_ready.py, verbatim.',
      items: { type: 'object', properties: TICKET_FIELDS, required: ['ticketId'] }
    }
  },
  required: ['tickets']
}

const BUILD_SCHEMA = {
  type: 'object',
  properties: {
    prUrl:       { type: 'string' },
    branchName:  { type: 'string' },
    summary:     { type: 'string', description: 'One sentence: what was built and why' },
  },
  required: ['prUrl', 'branchName']
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugFor(t) {
  return (t.ticketSlug || 'work').replace(/[^a-z0-9-]/g, '-').slice(0, 40)
}
function branchFor(t) {
  return 'agent/' + t.ticketId.toLowerCase() + '-' + slugFor(t)
}
function wtPathFor(t) {
  return WT_BASE + '/' + t.ticketId.toLowerCase()
}

// The full senior-engineer build prompt for a single ticket, scoped to its own worktree.
function buildPrompt(t) {
  const ticketId         = t.ticketId
  const ticketTitle      = t.ticketTitle || ''
  const description      = t.description || 'See acceptance criteria.'
  const acceptanceCriteria = t.acceptanceCriteria || []
  const engineeringLevel = t.engineeringLevel || 'mvp'
  const filesInScope     = t.filesInScope || []
  const testRefs         = t.testRefs || []
  const wtPath           = wtPathFor(t)
  const branchName       = branchFor(t)

  const acLines   = acceptanceCriteria.map(function (c, i) { return '  ' + (i + 1) + '. ' + c }).join('\n')
  const fileHints = filesInScope.length ? filesInScope.join('\n  ') : '(derive from exploration)'
  const testHints = testRefs.length     ? testRefs.join('\n  ')     : '(derive from subsystem test patterns)'
  const acChecks  = acceptanceCriteria.map(function (c) { return '- [ ] ' + c }).join('\n')

  return (
    'You are a senior engineer on the Sylphie project. Your mission: implement ticket ' + ticketId + ' end-to-end in an isolated git worktree, then open a PR.\n\n' +

    '━━━ TICKET ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
    'ID:                ' + ticketId + '\n' +
    'Title:             ' + ticketTitle + '\n' +
    'Engineering level: ' + engineeringLevel + '\n' +
    'Description:       ' + description + '\n' +
    'Acceptance criteria:\n' + acLines + '\n' +
    'Files in scope (hint — confirm via exploration):\n  ' + fileHints + '\n' +
    'Test refs (hint):\n  ' + testHints + '\n\n' +

    '━━━ STEP 1 — CREATE WORKTREE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
    'Run these Bash commands in order:\n' +
    '  mkdir -p "' + WT_BASE + '"\n' +
    '  git -C "' + REPO_ROOT + '" worktree add "' + wtPath + '" -b "' + branchName + '"\n\n' +
    'If that fails because the branch already exists, add the --force flag.\n' +
    'Confirm the directory exists before continuing.\n\n' +

    '━━━ STEP 2 — EXPLORE (do NOT skip or rush this) ━━━━━━━━━━━━━━━━━━━━━━━━\n' +
    'You must feel VERY confident before writing a single line of code.\n\n' +
    '1. Use codebase-pkg MCP tools in order:\n' +
    '   a. getModuleContext — for the concept/feature you are implementing\n' +
    '   b. searchContent   — for the key symbols/functions mentioned in the ticket\n' +
    '   c. getFunctionDetail — full body for any specific function you will change\n' +
    '   d. getConstraints  — architectural invariants for the area you are modifying\n' +
    '2. Then Read every relevant file IN FULL with the Read tool.\n' +
    '   The codebase-pkg is for discovery only — never make an edit based on a snippet.\n' +
    '3. Understand: existing types, conventions, patterns, test structure.\n\n' +
    'Stop exploring when you can answer: "Exactly which lines change, and why?"\n\n' +

    '━━━ STEP 3 — IMPLEMENT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
    'IMPORTANT: All file edits MUST use absolute paths inside the worktree:\n' +
    '  ' + wtPath + '/packages/...\n' +
    '  ' + wtPath + '/apps/...\n' +
    '  etc.\n\n' +
    'The main checkout at ' + REPO_ROOT + ' is READ-ONLY for discovery.\n' +
    'ALL writes (Edit, Write tool calls) go into the worktree path above.\n\n' +
    'Rules:\n' +
    '- Do the simplest thing that satisfies every acceptance criterion. No extra scope.\n' +
    '- Follow project conventions: yarn scripts not bare tsc; process.cwd() not __dirname.\n' +
    '- Match the code style and naming of surrounding files exactly.\n' +
    '- No speculative abstractions or features no acceptance criterion asked for.\n\n' +

    '━━━ STEP 4 — SENIOR SELF-REVIEW ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
    'Put on your senior engineer hat. Re-read every file you changed as if reviewing a colleague PR:\n' +
    '- Is the logic correct? Any edge cases not handled?\n' +
    '- Will the next engineer understand this without you explaining it?\n' +
    '- Any subtle bugs: null dereference, async race, wrong type, off-by-one?\n' +
    '- Any obvious performance issues?\n' +
    '- Add comments ONLY where the WHY is non-obvious (hidden constraint, subtle invariant, workaround).\n' +
    '  One line max. Never describe what the code does — just why.\n' +
    'Fix everything you find before moving to Step 5.\n\n' +

    '━━━ STEP 5 — TESTS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
    'Look at existing test files in this subsystem to understand the test framework and patterns.\n' +
    'Write tests that directly verify each acceptance criterion. Use the hint paths above if provided.\n' +
    'Run from the worktree — find the right command in package.json, typically:\n' +
    '  cd "' + wtPath + '" && yarn test\n' +
    'All tests must pass. Fix any failures before continuing.\n\n' +

    '━━━ STEP 6 — COMMIT AND PUSH ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
    'From inside the worktree:\n' +
    '  cd "' + wtPath + '"\n' +
    '  git add <list specific changed files — NEVER git add -A or git add .>\n' +
    '  git commit -m "feat(' + ticketId.toLowerCase() + '): <concise what and why>"\n' +
    '  git push -u origin ' + branchName + '\n\n' +

    '━━━ STEP 7 — OPEN PR ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
    'Open a PR using gh pr create with:\n' +
    '  --title "' + ticketId + ': ' + ticketTitle + '"\n' +
    '  --base main\n' +
    '  --head ' + branchName + '\n' +
    'The PR body must include:\n' +
    '  - The ticket ID and title\n' +
    '  - Acceptance criteria as a checklist:\n' + acChecks + '\n' +
    '  - A brief summary of what changed and why\n\n' +
    'Return the PR URL, branch name, and a one-sentence summary of what you built.'
  )
}

// ─── Orchestrator loop ────────────────────────────────────────────────────────

let processed = 0

while (processed < MAX_TICKETS) {

  // ── 1. Pick the next wave — deterministic canonical readiness (pick_ready.py) ─
  // No LLM parses the 5k-line contract: a cheap agent just runs the script, which applies the
  // same readiness rule as /plan-status (todo|backlog + every depends_on done), sorted+limited.
  phase('Pick & Assign')

  const limit = Math.min(MAX_PARALLEL, MAX_TICKETS - processed)

  const picked = await agent(
    'Run this EXACT command with the Bash tool, then return its output — nothing else:\n\n' +
    '  cd "' + REPO_ROOT + '" && python .claude/workflows/pick_ready.py --limit ' + limit + '\n\n' +
    'It prints ONE JSON line: {"tickets":[...]} — the ready tickets (status todo/backlog whose every\n' +
    'depends_on is already done), already sorted by priority and limited to ' + limit + '. Return that\n' +
    'object verbatim as your structured output. Do NOT read or reason about the contract yourself.',
    { label: 'pick-ready', phase: 'Pick & Assign', model: ORCH_MODEL, schema: READY_BATCH_SCHEMA }
  )

  const ready = (picked && picked.tickets ? picked.tickets : []).filter(function (t) { return t && t.ticketId })

  if (ready.length === 0) {
    log('No ready tickets (all done, blocked, or in-flight) — stopping.')
    break
  }

  // Belt-and-suspenders: never put two tickets in the same wave where one depends on the other.
  // (pick_ready already guarantees this — an unbuilt blocker is not done — but keep the guard.)
  const wave = []
  const waveIds = new Set()
  for (const t of ready) {
    if ((t.dependsOn || []).some(function (d) { return waveIds.has(d) })) continue
    wave.push(t)
    waveIds.add(t.ticketId)
  }

  log('Wave: ' + wave.map(function (t) { return t.ticketId }).join(', '))

  // ── 3. Mark the whole wave in_progress — ONE writer, one pass (no race) ─────
  await agent(
    'You are the orchestrator and the SOLE writer of the contract. Update status fields only.\n\n' +
    '1. Read ' + CONTRACT + ' with the Read tool (whole file).\n' +
    '2. For EACH of these ticket ids, change its status value from "todo" to "in_progress":\n' +
    '     ' + wave.map(function (t) { return t.ticketId }).join(', ') + '\n' +
    '   - Inline YAML node (one line): update the status field in that line.\n' +
    '   - Block YAML node (status: on its own line): update that line.\n' +
    '3. Use the Edit tool. Change ONLY those status values. Touch nothing else.\n' +
    '4. After editing, confirm each listed ticket now reads status: in_progress.',
    { label: 'assign-wave', phase: 'Pick & Assign', model: ORCH_MODEL }
  )

  // ── 4. Build the wave IN PARALLEL — each in its own worktree (no contract writes) ─
  phase('Build')

  const results = await parallel(wave.map(function (t) {
    return function () {
      return agent(buildPrompt(t), {
        label: 'build-' + t.ticketId,
        phase: 'Build',
        model: BUILD_MODEL,
        schema: BUILD_SCHEMA,
      }).then(function (r) {
        return {
          ticketId: t.ticketId,
          prUrl: (r && r.prUrl) ? r.prUrl : 'unknown',
          branch: (r && r.branchName) ? r.branchName : branchFor(t),
          ok: !!(r && r.prUrl),
        }
      })
    }
  }))

  // parallel() maps a thrown/failed build to null — keep those rows so we don't silently
  // lose a ticket; a failed build stays in_progress (not pr_open) for manual follow-up.
  const built = []
  for (let i = 0; i < wave.length; i++) {
    const r = results[i]
    if (r && r.ok) built.push(r)
    else log('⚠ ' + wave[i].ticketId + ' build did not open a PR — leaving it in_progress for follow-up.')
  }

  // ── 5. Close: record PR metadata — ONE writer, one pass ────────────────────
  // The schema status enum is [backlog, todo, in_progress, blocked, done, canceled] — there is
  // NO "pr_open". A ticket with an open but UNMERGED PR is not done, so status stays in_progress;
  // we only stamp pr_url/branch. A human flips it to done after merging.
  phase('Close')

  if (built.length > 0) {
    const closeLines = built.map(function (r) {
      return '  - ' + r.ticketId + ': pr_url="' + r.prUrl + '", branch="' + r.branch + '"'
    }).join('\n')

    await agent(
      'You are the orchestrator and the SOLE writer of the contract. Update the file at ' + CONTRACT + '.\n\n' +
      '1. Read the whole file with the Read tool.\n' +
      '2. For EACH ticket below, find its node by id and ADD two fields: pr_url and branch:\n' +
      closeLines + '\n\n' +
      '   DO NOT change the status field — it must stay "in_progress". The PR is open but unmerged,\n' +
      '   and the schema has no "pr_open" status (valid: backlog/todo/in_progress/blocked/done/canceled).\n' +
      '   - Inline YAML node (one line): add pr_url and branch as fields inside the {…}.\n' +
      '   - Block YAML node: add pr_url and branch lines at the same indent as the other fields.\n' +
      '   - If the node already has a pr_url/branch, overwrite it with the value above.\n' +
      '3. Use the Edit tool. Change ONLY those nodes. Preserve everything else exactly.',
      { label: 'close-wave', phase: 'Close', model: ORCH_MODEL }
    )

    for (const r of built) log('✓ ' + r.ticketId + ' → ' + r.prUrl + ' (in_progress, awaiting merge)')
  }

  processed += wave.length
}

log('Session complete. ' + processed + ' ticket(s) assigned across waves.')
return { processed }
