<!--
HOW TO USE
  1. Copy this file into pipeline/inbox/ named  bug-<short-slug>.md
  2. Fill every section. The first heading becomes the item title, so make it specific.
  3. Delete the angle-bracket hints as you go. Keep it concrete — vague reports get
     parked in `replan` waiting on you; concrete ones flow to a plan.
  Sections marked (required) are what keep an item from stalling.
-->

# Bug: <one-line symptom, specific — e.g. "Login loops after session expiry">

**Severity:** <blocker | high | medium | low>  ·  **Priority:** <P0 | P1 | P2>
**Area / component:** <subsystem or feature, e.g. auth, perception, drive-engine>

## What's broken (required)
<What actually happens. Observed behavior, in plain terms. One short paragraph.>

## Expected (required)
<What should happen instead. This seeds the "done" check — be precise.>

## Steps to reproduce (required)
1. <step>
2. <step>
3. <what you see vs. what you expected>

**Reproducibility:** <always | intermittent (~X%) | once>

## Evidence
<Error text, stack trace, log lines, screenshots, request/response. Paste the actual
message, not a paraphrase. Note the log file + timestamp if relevant.>

## Where it lives (scope hints)
<Suspected file(s), function, endpoint, or service — anything that points discovery at
the right place. "Unknown" is fine; a good guess speeds planning. e.g.
`packages/.../foo.service.ts` / `GET /api/bar` / the websocket gateway.>

## Database impact (required)
**Touches a database / schema / migration?** <no | yes | unknown>
<If yes or unknown: which store (Postgres / Timescale / Neo4j), and whether existing data
is affected. This trips the DB-change-safety gate so a migration plan gets written. If
purely code, say "no".>

## Acceptance — how we'll know it's fixed (required)
<One or two testable checks, ideally Given/When/Then. e.g.
"Given an expired session, when I hit a protected route, then I get one redirect to
/login with a 'session expired' notice — no loop.">

## Environment
<Where seen: prod / staging / local · URL · build/commit if known · OS/browser if UI.>

## Notes / non-goals (optional)
<Theories, related issues, anything explicitly NOT part of this fix (scope guard).>

<!-- ─────────────────────────── EXAMPLE (delete in real reports) ───────────────────────────
# Bug: Verbose log file grows unbounded

**Severity:** medium · **Priority:** P2
**Area / component:** shared logging

## What's broken
With VERBOSE=1, logs/verbose.log is never rotated; over a long session it grows to
hundreds of MB, slowing startup (the log reader scans the whole file) and filling disk.

## Expected
The verbose log stays size-bounded — rolls over past a threshold and keeps only the last
few segments, so disk use and read time stay flat.

## Steps to reproduce
1. Run with VERBOSE=1 for a few hours.
2. Watch logs/verbose.log size climb without bound.

**Reproducibility:** always

## Where it lives (scope hints)
packages/shared/src/verbose.ts (the append-stream sink). Call sites use verboseFor().

## Database impact
no — only the verbose/debug log path.

## Acceptance — how we'll know it's fixed
Given VERBOSE=1 and a log past the size threshold, when a line is written, then it rolls
to a new file and only the last N segments remain.
─────────────────────────────────────────────────────────────────────────────────────── -->
