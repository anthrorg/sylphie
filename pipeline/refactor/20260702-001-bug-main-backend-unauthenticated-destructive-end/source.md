# Bug: Main backend — unauthenticated destructive endpoints, incomplete boot-hang fix, broken CANON metric, silent WS/STT death paths

**Severity:** blocker  ·  **Priority:** P0
**Area / component:** apps/sylphie (controllers, gateways, services, DI wiring)

## What's broken (required)
The request-path code is disciplined about honesty (no fake-200s, explicit 501s), but the deployment surface and resilience layer have serious holes:
- **Nearly every controller is unauthenticated.** Only `RulesController` and `AuthController.me` use `AuthGuard`. Anonymous-reachable routes include `POST /api/skills/reset` (wipes all three Neo4j graphs + truncates `events`, `learned_patterns`, `voice_patterns`, `sensory_ticks`, `proposed_drive_rules` + resets drive state — the only guard is `{confirm:true}` in the body), `reset-world`, several `/api/metrics/*-reset` + `c3-seed` + `decay-now`, `POST /api/llm/lesion` (disables the LLM), and `GET /api/graph/*` (full OKG person facts). In a public build (Railway + `ServeStaticModule`) a single anonymous `curl` destroys all accumulated memory.
- **TK-107 boot-hang fix is incomplete.** `PersonModelService.onModuleInit` and `FaceSnapshotService.onModuleInit` still `await session.run('CREATE CONSTRAINT … IF NOT EXISTS')` against Neo4j OTHER with **no deadline** — the exact schema-lock-prone op TK-107 fixed elsewhere. A cold/locked Neo4j still hangs `NestFactory.create()`.
- **TK-107's own pattern can crash the process.** `await Promise.race([bootstrap(), deadline])` leaves the losing `bootstrap()` promise with no rejection handler; a late rejection is an unhandled rejection → process exit. The boot-hang fix introduced a boot-then-crash.
- **A CANON metric has never worked.** `meanDriveResolutionTimes` self-joins `events` and selects/groups unqualified `payload->>'drive'` (both aliases have `payload`) → `column reference "payload" is ambiguous` on every call; the catch returns `{}`, so `/api/metrics/health` has never reported it.
- **Silent WS/STT death paths.** ConversationGateway's trigger-phrase chain has no `.catch` → a rejection silently drops the turn and leaves the client's thinking spinner stuck on. Abnormal Deepgram close neither reconnects nor notifies the client — the mic looks live while audio is discarded. A stale STT `close` handler can delete the *replacement* session's map entry and kill its keep-alive under reconnect churn.
- Lower: `handleCycleResponse` unhandled-rejection path; eviction leaks socket-map entries for half-dead sockets; `WebRTCGateway` is an unregistered empty stub; `SensoryLoggerService` interval never cleared; `DrivePublisher` broadcasts hardcoded `drive_entropy:0, state:'idle', transition_count:0, is_stale:false` as real-looking telemetry.

## Expected (required)
Destructive/system-mutating endpoints require authentication (or are gated to localhost/an env flag); all Neo4j `onModuleInit` schema ops run under a deadline with the losing promise's rejection handled (no boot hang, no orphan-crash); `meanDriveResolutionTimes` returns real numbers; a dropped turn or STT close surfaces to the client rather than silently stalling; and telemetry does not present hardcoded zeros as measurements.

## Steps to reproduce (required)
1. With the backend running, `curl -X POST localhost:3000/api/skills/reset -d '{"confirm":true}'` with no auth → all graphs wiped.
2. Start the backend against a cold/locked Neo4j OTHER → `NestFactory.create()` hangs on the person-model/face-snapshot constraint creation.
3. `GET /api/metrics/health` → `meanDriveResolutionTimes` is `{}` (check logs for the 42702 ambiguous-column error).
4. Trigger a "who am I?"-style phrase while `personModel.loadFacts()` rejects → turn dropped, spinner stuck.

**Reproducibility:** always for #1/#3; #2 on a locked Neo4j; #4 on the rejection path.

## Evidence
- Auth: `skills.controller.ts:10-53`, `metrics.controller.ts` (many), `llm.controller.ts:43-63`, `graph.controller.ts`; guard applied only in `app.module.ts:151-164` scope (rules + auth/me).
- TK-107 gaps: `person-model.service.ts:96-132`, `face-snapshot.service.ts:189-215`; orphan promise `wkg-bootstrap.service.ts:61-81`, `wkg-query.service.ts:149-182`.
- Metric SQL: `metrics.controller.ts:1759-1774`.
- WS/STT: `conversation.gateway.ts:394-422` (no catch), `audio.gateway.ts:162-173` + `stt.service.ts:177-191` (silent close), `stt.service.ts:157-173` (stale handler), `communication.service.ts:211-218`.
- Lower: `conversation.gateway.ts:263-273`; `webrtc.gateway.ts` unregistered (`app.module.ts:219-226`); `sensory-logger.service.ts:28-31`; `drive-publisher.service.ts:99-127`.
- Verified OK (do not re-file): `AuthGuard` fails closed without `JWT_SECRET`; voice endpoints return honest errors; DrivesController honestly 501s; PerceptionGateway resets `processing` in `finally`.

Full detail: `docs/audits/repo-bug-audit-2026-07-02.md` §4.

## Where it lives (scope hints)
Auth: apply `AuthGuard` (or a localhost/env gate) across `skills`, `metrics` (mutating routes), `llm`, `graph` controllers. Boot: wrap the two `onModuleInit` constraint ops in the TK-107 deadline helper and attach a `.catch` to the racing promise. Metric: qualify `e1.payload` in `metrics.controller.ts:1759-1774`. WS/STT: add `.catch` + client notification to the trigger chain and Deepgram close handler; guard the STT close handler on current-session identity.

## Database impact (required)
**Touches a database / schema / migration?** no schema/migration. The metric fix is a **read** query correction; the auth/boot/WS fixes are code only. (Note: the endpoints being *guarded* are themselves destructive to data, but the fix adds a guard — it does not itself change schema.)

## Acceptance — how we'll know it's fixed (required)
- Given no auth token, when any destructive/system-mutating endpoint (`skills/reset*`, `metrics/*-reset`, `llm/lesion`, `graph/*`) is called, then it is rejected (401/403) — proven by an e2e test hitting each unauthenticated.
- Given a cold Neo4j OTHER that never responds, when the backend boots, then `NestFactory.create()` returns within the deadline (degraded, logged) rather than hanging, and no unhandled rejection crashes the process (test with a stalled driver).
- Given event rows with a `drive` payload, when `GET /api/metrics/health` is called, then `meanDriveResolutionTimes` returns numeric values, not `{}`.
- Given the trigger-phrase handler rejects, when a turn is processed, then the client receives an error/spinner-clear rather than a silent stall.

## Environment
Local dev + any deploy; auth exposure is worst in public (Railway) builds. Source-trace at commit `228df73`.

## Notes / non-goals (optional)
- The reset/lesion endpoints are legitimate gate seams for dev — the fix is to gate them, not remove them.
- Non-goal: reworking the DrivePublisher telemetry contract into real entropy/state metrics (that's a feature; here just stop emitting fabricated zeros — emit null/omit).
- Coordinate the STT/WS reconnect notification with the frontend audio-hook reconnect item (shared UX contract).
