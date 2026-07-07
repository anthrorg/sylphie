# Bug: Drive engine/server resilience & isolation layer is façade (no reconnect, RLS unenforced, self-monitoring fake)

**Severity:** blocker  ·  **Priority:** P0
**Area / component:** drive-engine (packages/drive-engine) + drive-server (apps/drive-server)

## What's broken (required)
The drive dynamics core is real, but the subsystem's reliability and integrity layers — the two CANON pillars it is named for (drive isolation, theater prohibition) plus reconnect/health/event persistence — are largely code that is never wired in or does not do what its docs claim:
- **No reconnect, ever.** `RecoveryMechanism.attemptRecovery()` has zero production callers; the WS `close` handler just nulls the socket; the send queue is unbounded with no TTL. The startup catch logs *"Drive Engine not available on startup — recovery will reconnect"* — false. One drive-server restart or network blip permanently severs the motivational system for the life of the main process, plus a slow memory leak. (Even if wired, `attemptRecovery` declares success before the `open` event.)
- **RLS drive-isolation unenforced and unverified.** `RlsVerificationService` is registered in no NestJS module, so its `OnModuleInit` never runs; and `infra/postgres/init/001-runtime-user.sql` grants full DML to `sylphie_app` with no REVOKE/policy on `drive_rules`. The archived case study claims "startup ABORTS on failure." Isolation is currently transport-only.
- **Theater post-flight check trusts the defendant.** `detectTheater(theaterCheck, currentDriveState)` never reads `currentDriveState`; the verdict is computed solely from the main-process-supplied `driveValueAtExpression`. The isolated judge trusts the caller's testimony.
- **SESSION_START lets any WS client overwrite the entire drive state** (validator only range-checks), a direct main→drive mutation path that also discards the Timescale-restored checkpoint.
- **One >5 s snapshot gap permanently poisons the reader.** The staleness anchor only advances on acceptance, so after a single stall every subsequent snapshot is rejected forever (throws swallowed) — the main app runs on frozen drive state with only log noise.
- **Event persistence is dead code with wrong columns.** `TimescaleWriter` INSERTs columns that don't exist in `002-events.sql`; unreachable only because `EventEmitter` is never instantiated. Headers claim events are persisted.
- **HEALTH_STATUS is fake end-to-end.** Engine never sends it; the main app registers a handler that can't fire; `lastPingAt` is fabricated at report time; `childMemoryBytes` is hardcoded null → the <10 MB memory criterion is unenforced.
- **Baseline self-adjustment (E4-T008) is a no-op subsystem** — computed and logged (`adjusted=N`) but no consumer; tick rates come only from static constants.
- Lower: tick "drift compensation" math forces `delay = INTERVAL` every tick (cumulative slowdown under the warn ratio); NaN via partial pressure vectors; legacy fork entry races checkpoint save vs `process.exit`; `POSTGRES_DB` default mismatch (`'sylphie'` vs `'sylphie_system'`); `reloadRules()` swallows errors so "Rule engine initialized" logs with 0 rules; cross-modulation coefficients 3× documented strength.

## Expected (required)
A dropped drive-server connection is detected and reconnected (with the send queue bounded and drained on reconnect, and success declared only after `open`); the runtime DB user is denied UPDATE/DELETE on `drive_rules` and startup aborts if the RLS verifier (registered and running) finds otherwise; the theater check reads actual isolated drive state; SESSION_START cannot arbitrarily overwrite drive state; a single delivery stall does not permanently lock out the snapshot reader; and health/event-persistence either work or are removed rather than logging fake success.

## Steps to reproduce (required)
1. Start backend + drive-server; confirm `/api/drives` shows connected, live snapshots.
2. Restart drive-server (or drop the socket).
3. Observed: the main app never reconnects; `/api/drives` reads disconnected/frozen forever; `sendQueue` grows. Expected: reconnect within backoff, snapshots resume.
4. Separately: after any >5 s snapshot gap, observe every later snapshot rejected by the staleness guard.

**Reproducibility:** always (reconnect, RLS, theater, staleness are unconditional)

## Evidence
- Reconnect dead: `packages/drive-engine/src/ipc-channel/recovery.ts:118` (only caller is `recovery.spec.ts`); `ws-channel.service.ts:106-112,132-141`; false log `drive-process-manager.service.ts:96-99`.
- RLS: `packages/drive-engine/src/postgres-verification/verify-rls.ts` (registered nowhere); grants `infra/postgres/init/001-runtime-user.sql:9-10`.
- Theater: `theater-prohibition.ts:59-67` (`currentDriveState` param unused).
- SESSION_START: `drive-engine.ts:400-406`; validator `ipc-message-validator.ts:164-182`.
- Snapshot lockout: `drive-state-snapshot.ts:99-118`; anchor `drive-reader.service.ts:196-207`; swallow `drive-process-manager.service.ts:170-177`.
- Timescale columns: `timescale-writer.ts:212-225` vs `infra/timescaledb/init/002-events.sql:7-17`; emitter null `drive-engine.ts:155`.
- HEALTH_STATUS: `drive-engine.ts:958,172`; handler `drive-process-manager.service.ts:227-234`; `health-monitor.ts:123,134`.
- Baseline no-op: `self-evaluation.ts:113-193`; static rates `accumulation.ts:27-37`.
- Drift math `drive-engine.ts:427-437`; NaN `drive-state.ts:198-204`; fork `drive-process/main.ts:50-55`; DB default `apps/drive-server/src/main.ts:59` vs `drive-engine.module.ts:44`; reloadRules `rule-engine.ts:274-281`; coefficients `cross-modulation.ts:113`.

Full detail: `docs/audits/repo-bug-audit-2026-07-02.md` §3.

## Where it lives (scope hints)
`packages/drive-engine/src/ipc-channel/` (recovery + ws-channel), `drive-process/drive-process-manager.service.ts`, `postgres-verification/verify-rls.ts` + its module registration, `drive-engine.ts` (SESSION_START, tick, health), `apps/drive-server/src/{main.ts,ws-transport.ts}`, and `infra/postgres/init/001-runtime-user.sql` (REVOKE + policy — see DB impact).

## Database impact (required)
**Touches a database / schema / migration?** yes — Postgres. The RLS fix edits `infra/postgres/init/001-runtime-user.sql` (a REVOKE UPDATE/DELETE on `drive_rules` + an RLS policy), which trips the `db-change-guard` gate and requires a migration plan. No existing-data mutation (grants/policy only), no destructive change. The Timescale event-persistence fix targets `002-events.sql`'s existing schema (fix the INSERT column list to match, or delete the dead writer). Note: the `drive_rules` REVOKE is already Jim-approved as `TK-AUDIT-1` (pipeline decision 002) — the plan cog should reconcile rather than clone.

## Acceptance — how we'll know it's fixed (required)
- Given a live connection, when the drive-server socket drops, then the client reconnects within the backoff window and resumes snapshots, and the send queue is bounded and drained (integration test on the ws-channel).
- Given the runtime user `sylphie_app`, when it attempts UPDATE/DELETE on `drive_rules`, then Postgres denies it; and when RLS is misconfigured, startup aborts via the (now-registered) verifier.
- Given a response whose reported `driveValueAtExpression` disagrees with the engine's actual state, when `detectTheater` runs, then it reads the isolated state and can return theatrical (unit test).
- Given a single >5 s snapshot gap, when the next valid snapshot arrives, then it is accepted and the reader resumes (unit test on the staleness anchor).

## Environment
Local dev + any deploy (esp. Railway, where drive-server restarts are routine). Source-trace at commit `228df73`.

## Notes / non-goals (optional)
- The reconnect fix and the frontend/perception reconnect + apps/sylphie drive-client reconnect are the same class — coordinate so the "wait for open + bounded queue" pattern is shared.
- Non-goal in this item: redesigning drive baseline self-adjustment into a live path (that's a capability decision under Std-6, not a bug fix) — either wire it as recovery-only per the ratified Std-6 clarification or remove the dead logging.
