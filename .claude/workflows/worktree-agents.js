export const meta = {
  name: 'worktree-agents',
  description: 'Sequential worktree agent loop: pick next todo ticket, build it in an isolated git worktree, open a PR, repeat up to N times. Orchestrator is the sole contract writer.',
  phases: [
    { title: 'Pick & Assign' },
    { title: 'Build' },
    { title: 'Close' },
  ]
}

// ─── Configuration ────────────────────────────────────────────────────────────
const REPO_ROOT   = 'C:/Users/Jim/OneDrive/desktop/Code/sylphie'
const WT_BASE     = 'C:/Users/Jim/OneDrive/desktop/Code/sylphie-worktrees'
const CONTRACT    = REPO_ROOT + '/planning/contract.yaml'
const MAX_TICKETS = (args && args.count) ? args.count : 5

// ─── Structured output schemas ────────────────────────────────────────────────

const TICKET_SCHEMA = {
  type: 'object',
  properties: {
    ticketId:            { type: ['string', 'null'] },
    ticketTitle:         { type: ['string', 'null'] },
    ticketSlug:          { type: ['string', 'null'],
                           description: 'Short 3-5 word kebab-case slug derived from the title' },
    description:         { type: ['string', 'null'] },
    acceptanceCriteria:  { type: 'array', items: { type: 'string' },
                           description: 'Each criterion as a single readable string' },
    engineeringLevel:    { type: ['string', 'null'] },
    filesInScope:        { type: 'array', items: { type: 'string' } },
    testRefs:            { type: 'array', items: { type: 'string' } },
    parentEpic:          { type: ['string', 'null'] },
  },
  required: ['ticketId']
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

// ─── Orchestrator loop ────────────────────────────────────────────────────────

let processed = 0

while (processed < MAX_TICKETS) {

  // ── 1. Pick the next todo ticket ──────────────────────────────────────────
  phase('Pick & Assign')

  const ticket = await agent(
    'Read the file ' + CONTRACT + ' using the Read tool (read the whole file). ' +
    'Find the next ticket to work on:\n' +
    '  - kind must be "ticket" (skip feature/epic nodes)\n' +
    '  - status must be "todo" (skip done, in_progress, pr_open, canceled)\n' +
    '  - Pick highest priority first: P1 > P2 > P3\n' +
    '  - Within same priority, pick the lowest ticket number (TK-19 before TK-20)\n\n' +
    'Return ticketId: null if no todo tickets remain.\n\n' +
    'For acceptanceCriteria: if entries have given/when/then sub-fields, flatten each to ' +
    '"Given <given>, when <when>, then <then>". If already plain strings, return as-is.\n' +
    'For ticketSlug: derive a 3-5 word lowercase kebab-case slug from the title (no special chars, numbers ok).\n' +
    'For filesInScope: extract from the files_in_scope field (array of strings).\n' +
    'For testRefs: extract from the test_refs field (array of strings).',
    { label: 'pick-ticket', phase: 'Pick & Assign', schema: TICKET_SCHEMA }
  )

  if (!ticket || !ticket.ticketId) {
    log('No todo tickets remaining — stopping.')
    break
  }

  const ticketId         = ticket.ticketId
  const ticketTitle      = ticket.ticketTitle || ''
  const description      = ticket.description || 'See acceptance criteria.'
  const acceptanceCriteria = ticket.acceptanceCriteria || []
  const engineeringLevel = ticket.engineeringLevel || 'mvp'
  const filesInScope     = ticket.filesInScope || []
  const testRefs         = ticket.testRefs || []

  const safeSlug   = (ticket.ticketSlug || 'work').replace(/[^a-z0-9-]/g, '-').slice(0, 40)
  const branchName = 'agent/' + ticketId.toLowerCase() + '-' + safeSlug
  const wtPath     = WT_BASE + '/' + ticketId.toLowerCase()

  log('→ ' + ticketId + ': ' + ticketTitle)

  // ── 2. Mark in_progress (orchestrator is sole contract writer) ─────────────
  await agent(
    'You are the orchestrator. Your only job is to update a single status field in the contract.\n\n' +
    '1. Read ' + CONTRACT + ' with the Read tool.\n' +
    '2. Find the node whose id is "' + ticketId + '".\n' +
    '3. Change its status value from "todo" to "in_progress".\n' +
    '   - If the node is inline YAML (one line), update the status field in that line.\n' +
    '   - If the node uses block YAML (status: on its own line), update that line.\n' +
    '4. Use the Edit tool to make ONLY that change. Touch nothing else in the file.',
    { label: 'assign-' + ticketId, phase: 'Pick & Assign' }
  )

  // ── 3. Build sub-agent works in an isolated worktree ──────────────────────
  phase('Build')

  const acLines    = acceptanceCriteria.map(function(c, i) { return '  ' + (i + 1) + '. ' + c }).join('\n')
  const fileHints  = filesInScope.length ? filesInScope.join('\n  ') : '(derive from exploration)'
  const testHints  = testRefs.length     ? testRefs.join('\n  ')     : '(derive from subsystem test patterns)'
  const acChecks   = acceptanceCriteria.map(function(c) { return '- [ ] ' + c }).join('\n')

  const buildResult = await agent(
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
    'Return the PR URL, branch name, and a one-sentence summary of what you built.',
    { label: 'build-' + ticketId, phase: 'Build', schema: BUILD_SCHEMA }
  )

  // ── 4. Mark pr_open (orchestrator writes) ─────────────────────────────────
  phase('Close')

  const prUrl      = (buildResult && buildResult.prUrl)      ? buildResult.prUrl      : 'unknown'
  const finalBranch = (buildResult && buildResult.branchName) ? buildResult.branchName : branchName

  await agent(
    'You are the orchestrator. Update the contract file at ' + CONTRACT + '.\n\n' +
    '1. Read the full file with the Read tool.\n' +
    '2. Find the node with id "' + ticketId + '".\n' +
    '3. Make these changes:\n' +
    '   - Set status to "pr_open"\n' +
    '   - Add field: pr_url: "' + prUrl + '"\n' +
    '   - Add field: branch: "' + finalBranch + '"\n' +
    '4. Use the Edit tool to make only those changes. Preserve everything else exactly.\n\n' +
    'If the node is inline YAML (one line), update in-line. If block YAML, update line by line.',
    { label: 'close-' + ticketId, phase: 'Close' }
  )

  log('✓ ' + ticketId + ' → ' + prUrl)
  processed++
}

log('Session complete. ' + processed + ' ticket(s) processed.')
return { processed }
