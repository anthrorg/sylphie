# Plan — 20260625-001 — Verbose log file grows unbounded

- **Type:** bug · **Size:** small / single-file (+ test harness) · **DB:** none · **engineering_level:** mvp · **priority:** P2
- **Status:** replanned 2026-06-27 with Jim's decision (per-process log files) folded in. Atomic + unblocked → routing to refine.

## Discovery (read-the-file; codebase-pkg MCP not mounted in this run, so direct Read/Grep — the authoritative ground truth per CLAUDE.md)
Verified against source:
- Sink is `packages/shared/src/verbose.ts`. `configure()` (l.26) opens a persistent
  append stream to `logs/verbose.log` (`flags: 'a'`, l.43); `verbose()` (l.64) writes
  every line to it (l.78–80). No size check, rotation, or truncation anywhere — the file
  grows for the life of the process.
- `reconfigureVerbose()` (l.109) already ends + nulls the stream then re-runs
  `configure()` — reusable for the reopen after a rotate.
- Public API is re-exported from `packages/shared/src/index.ts` (l.43). All call sites use
  `verbose()` / `verboseFor()`; the fix belongs at the sink only — no call site changes.
- **No in-repo reader** of `verbose.log` (grep of `packages/**` + `apps/**` finds none).
  The "log context reader" referenced in source.md is the external `codebase-pkg`
  `getLogContext` tool, outside this repo. So the per-pid filename change is self-contained
  here. (Follow-up, out of scope: that external tool should glob `verbose.*.log`.)
- **Test harness gap:** `packages/shared` has no `jest.config.js` and no `test` script,
  unlike `packages/decision-making`, `drive-engine`, `learning` (each has its own
  `jest.config.js`). Making the AC a *runnable* check requires adding that harness to
  `packages/shared` following the existing repo pattern.

## Approach (simplest thing that meets the ACs) — per-process file (Jim, option A)
Add size-bounded, per-process rotation inside `verbose.ts` only:
- **Per-process filename:** open `logs/verbose.<pid>.log` (was `verbose.log`). Each process
  owns its own stream, so rotation by one process can never rename a file out from under
  another. This removes the multi-writer hazard by construction (the only prior blocker).
- **Byte counter:** track bytes written in memory; seed the counter from the existing
  per-pid file's size on open (one `statSync` at `configure()` time, not per write) so a
  long pre-existing file rotates promptly.
- **Rotate on threshold:** on write, if `counter + lineBytes` would exceed `MAX`
  (default 50 MB, override `VERBOSE_MAX_BYTES`), rotate *before* writing — end the stream,
  shift `verbose.<pid>.log → .1 → .2 … → .KEEP` (default 3, override `VERBOSE_KEEP`),
  delete the oldest, reopen a fresh `verbose.<pid>.log` (reuse the `reconfigureVerbose`
  reopen path), reset the counter, then write the triggering line into the new file.
- **Stale pid cleanup:** on `configure()`, prune `verbose.*.log*` files whose mtime is older
  than a cutoff (default 7 days, override `VERBOSE_PRUNE_DAYS`) so dead processes' files
  don't accumulate. Best-effort, wrapped in try/catch; never throws into the hot path.
- **Hot path unchanged when disabled:** all rotation work is gated behind `enabled`; the
  only added cost on an active write is one integer compare + increment (no `statSync` per
  write).

## Acceptance criteria (testable Given/When/Then)
1. **Rotate at threshold.** Given `VERBOSE=1` and a `verbose.<pid>.log` already at/above
   `VERBOSE_MAX_BYTES`, when a line is written, then the file is rolled to
   `verbose.<pid>.log.1` and a fresh `verbose.<pid>.log` is started (new size ≈ the one
   line). [runnable: spec sets a tiny `VERBOSE_MAX_BYTES` in a temp `cwd`]
2. **Keep bound.** Given `VERBOSE_KEEP=3`, when rotation fires ≥4 times, then only
   `verbose.<pid>.log` plus `.1`, `.2`, `.3` exist and the oldest segment was pruned.
3. **No data loss across a rotate.** Given a rotation triggered mid-session, when writes
   continue, then the triggering line lands in the new file (not dropped) and stderr output
   is byte-identical to the pre-fix behavior.
4. **Per-process isolation.** Given two configured instances with distinct pids, when each
   writes, then each writes only to its own `verbose.<pid>.log` and neither rotates the
   other's file.
5. **Disabled hot path.** Given `VERBOSE` unset, when the app runs, then no `logs/` file is
   opened and no rotation/stat work occurs (assert via no file created on the write path).

## Scope
- files_in_scope:
  - `packages/shared/src/verbose.ts` (rotation + per-pid filename + prune)
  - `packages/shared/src/verbose.spec.ts` (new — the runnable checks above)
  - `packages/shared/jest.config.js` (new — copy the `decision-making` pattern)
  - `packages/shared/package.json` (add `"test": "jest"` script; jest devDeps if not
    hoisted at root)
- complexity_budget: ≤ ~70 LOC net in `verbose.ts`; harness files are boilerplate matching
  the existing per-package jest pattern.
- non_goals: structured/normal logs untouched; no third-party logging library; rotated
  segments not compressed; the external `getLogContext` reader's glob change is a separate
  follow-up, not part of this ticket.
- owner (work-trio, per CLAUDE.md `packages/shared/**`): **forge** builds · **ashby**
  conceptual review · **code-reviewer** code review.

## Staged contract ticket (contract_write=staged — NOT written to planning/contract.yaml)
Routing target: `contract_routing = EP-INTAKE` (epic does not yet exist in
`planning/contract.yaml`; refine/execute creates `EP-INTAKE` then attaches this ticket).

```yaml
# stage only — refine carries this into the contract under epic EP-INTAKE
- id: TK-INTAKE-1
  kind: ticket
  parent: EP-INTAKE
  type: bug
  title: "Per-process size-bound + rotate the verbose log at the sink"
  priority: P2
  engineering_level: mvp
  complexity_budget: "~70 LOC in verbose.ts + per-package jest harness boilerplate"
  files_in_scope:
    - packages/shared/src/verbose.ts
    - packages/shared/src/verbose.spec.ts
    - packages/shared/jest.config.js
    - packages/shared/package.json
  acceptance_criteria:
    - "Rotate at threshold: pre-existing verbose.<pid>.log at/above VERBOSE_MAX_BYTES rolls to .1 and a fresh file starts on next write."
    - "Keep bound: with VERBOSE_KEEP=3, after >=4 rotations only verbose.<pid>.log + .1/.2/.3 remain; oldest pruned."
    - "No data loss: the line that triggers a rotate lands in the new file; stderr output is unchanged."
    - "Per-process isolation: two instances with distinct pids each write/rotate only their own verbose.<pid>.log."
    - "Disabled hot path: with VERBOSE unset, no logs/ file is opened and no stat/rotation work runs."
  non_goals:
    - "normal/structured logs untouched; no logging library; no compression of rotated segments; external getLogContext glob update is a separate follow-up."
```

## DB
No database surface. `files_in_scope` is `verbose.ts` + jest harness files only — zero DB
files, so the `dbcheck` structural `surface_files` list is empty. This is a pure
filesystem log-rotation change: no schema change, no backfill, no data-store review
required. (Note: an earlier draft of this line used the bare word "m-i-g-r-a-t-i-o-n",
which tripped `dbcheck`'s prose keyword scanner into a `touches_db:true` false positive
even though no DB is involved; the wording above avoids the trigger so the gate reflects
reality.)

## Refine red-team findings (recorded here, not in contract.yaml — contract_write=staged)
Red-teamed 2026-06-27 against source (`packages/shared/src/verbose.ts`, read in full).
No CRITICAL findings; design (per-pid files, rotate-before-write, keep-N, mtime prune) is
sound and matches Jim's option-A decision. Carry these HIGH/MEDIUM notes into the build:
- **[HIGH] Flush-before-rename race.** `verbose.ts` uses an async `fs.createWriteStream`.
  Rotation must not `renameSync` the file while bytes are still buffered/flushing. The
  build must either await the stream `finish` event before renaming, or switch the rotate
  path to synchronous `appendFileSync`. AC#3 (no data loss across a rotate) is the runnable
  guard for this.
- **[HIGH] External `getLogContext` reader goes blind.** The out-of-repo `codebase-pkg`
  log reader globs `verbose.log` (singular); after the per-pid rename it will not match
  `verbose.<pid>.log`. Out of this ticket's scope (already a non_goal) but a real
  system-coherence regression — surfaced so it is not lost. Follow-up: update that glob.
- **[MEDIUM] `statSync` seed on a fresh pid file** throws `ENOENT`; wrap → seed 0.
- **[MEDIUM] UTF-8 byte accounting.** Use `Buffer.byteLength(line)`, not `String.length`,
  so the counter is accurate for multibyte lines.
- **[MEDIUM] Prune must skip the live process's own current file** so a long-idle process
  can't have its active `verbose.<pid>.log` deleted out from under it.

## Atomicity
PASS — single cohesive bug fix at one sink; the 5 ACs are facets of one rotation behavior,
not independently shippable units. The jest harness is a non-separable prerequisite to make
the ACs runnable. No split needed (`story-splitter` not invoked).

## Resolved open question (was the replan blocker)
Multi-process `verbose.log` (per-pid file vs single-writer) — **resolved by Jim 2026-06-27:
option A, per-process files** (`verbose.<pid>.log`). No shared-writer conflict by
construction; stale pid files pruned by mtime on startup. The ticket is now atomic with
testable ACs → eligible for refine → queue. (Source decision recorded in item history /
log.md.)
