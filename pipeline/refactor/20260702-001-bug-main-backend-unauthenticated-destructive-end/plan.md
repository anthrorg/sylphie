# Plan — 20260702-001 — Backend hardening: auth, boot, metric, WS/STT resilience

- **Type:** bug (ingest hint correct; title kept) · **Route:** EPIC (multi-ticket) · **DB:** no (code-only; metric fix is a read-query correction) · **size_hint:** large
- **Replan status:** DEC-29 (accepted) resolved the plan-reviewer CRITICALs against the first staging pass. This is the re-staged version. No new design — DEC-29 adopts the red-team's own prescribed approach.

## Classification (plan cog)
One audit source, four separable defects in `apps/sylphie`. Not atomic as one ticket —
route = epic decomposition. All findings are execution-level bugs with clear expected
behavior; no design reconciliation needed → refine, not replan (confirmed again by DEC-29:
both CRITICALs it resolved were execution-approach corrections, not a design/CANON fork).

## Discovery (verified against source @ 228df73, 2026-07-02; haiku reader sweep, full-file reads)
codebase-pkg MCP unavailable in this scheduled session → fell back to direct reads of every cited file.
- **AUTH — CONFIRMED, RE-VERIFIED post-DEC-29.** `AuthGuard` only on `rules.controller.ts:26` (class) and
  `auth.controller.ts:71` (`me`). No global guard in `main.ts`/`app.module.ts`. `metrics.controller.ts` has
  **15 `@Post` routes**, confirmed by direct grep: `reset` (:204), `latent-reset` (:236),
  `latent-seed-overgeneral` (:267), `person-facts-reset` (:324), `all-persons-facts-reset` (:350, TRUNCATEs
  all persons), `episodic-reset` (:380), `perception-reset` (:418), `scene-predictor-reset` (:449),
  `visual-presence-habituation-reset` (:524), `prompt-capture-reset` (:577), `c3-seed` (:794),
  `c3-reinforce` (:883), `decay-now` (:937), `learn-now` (:962), `c3-cleanup` (:1101) — i.e. the original
  staging's ~5-route hand-list under-scoped this controller alone by ~3x, exactly the plan-reviewer's C1
  finding. Also anonymous: `skills.controller.ts:10-53` (`reset`, `reset-world`; only `{confirm:true}` body),
  `llm.controller.ts:43-63` (`lesion`, `heal`), `graph.controller.ts:12-76` (all 8 GETs incl. OKG person facts).
- **No e2e/HTTP harness exists today (C2, CONFIRMED).** No `test/e2e/**`, no `supertest` dependency, no
  `test:e2e` script in `apps/sylphie/package.json` — only unit `jest`. Standing up AppModule + supertest is
  real, net-new scope, not a detail inside an existing harness.
- **BOOT — CONFIRMED (deadline gap + duplication).** `person-model.service.ts:96-132` (`onModuleInit` →
  two `CREATE CONSTRAINT … IF NOT EXISTS` calls at :106/:110, plus an **unbounded** `SET p.label = p.username`
  backfill at :116-120 with no deadline at all) and `face-snapshot.service.ts:189-215` (`onModuleInit` →
  `CREATE CONSTRAINT face_snapshot_id_unique` at :195, then unconditionally calls `this.ensureSchema()` and,
  if `schemaReady`, `this.hydrate()` — neither wrapped in any deadline) all run against Neo4j OTHER / Timescale
  with no timeout. The TK-107 deadline helper pattern is **duplicated**, not shared: `wkg-bootstrap.service.ts:61-81`
  builds its own `Promise.race([this.bootstrap(), deadline])` and `wkg-query.service.ts:151-182` repeats the
  same shape independently.
- **METRIC — CONFIRMED.** `metrics.controller.ts:1759-1774`: `SELECT payload->>'drive' AS drive, ...` and
  `GROUP BY payload->>'drive'` are unqualified against `FROM events e1 JOIN events e2` (both aliases expose a
  `payload` column) → Postgres 42702 ambiguous-column on every call; the `catch` at :1792 logs and returns `{}`.
- **WS/STT — CONFIRMED (3/3).** `conversation.gateway.ts:394` `void this.communication.handleTriggerPhrase(...).then(...)`
  with no `.catch`; `audio.gateway.ts:162-173` abnormal Deepgram close returns silently (no reconnect, no client
  notify); `stt.service.ts:~150-173` close handler deletes `sessions`/`keepAliveTimers` by clientId without
  checking the entry is still *this* session (reconnect-churn clobber).
- Lower-cluster findings (`handleCycleResponse` unhandled-rejection, `webrtc.gateway.ts` unregistered stub,
  `sensory-logger.service.ts` interval leak, `drive-publisher.service.ts` fabricated telemetry) are **unaffected
  by DEC-29** and remain staged as **TK-BEH-5** (P2) below, carried over unchanged from the prior pass — DEC-29
  only re-scoped TK-BEH-1..4.
- Line numbers verified current (no drift since 228df73). Full audit: `docs/audits/repo-bug-audit-2026-07-02.md` §4.

## Replan resolution (DEC-29 — authoritative, no new design)
Plan-reviewer parked the first staging on two CRITICALs against TK-BEH-1..4 (`redteam.md`): **C1** — the
hand-listed auth AC covered ~5 routes but `metrics.controller.ts` alone has 15 `@Post` routes, missing several
anonymous-reachable destructive ones (`all-persons-facts-reset`, `episodic-reset`, `perception-reset`,
`scene-predictor-reset`, `visual-presence-habituation-reset`, `prompt-capture-reset`, `latent-seed-overgeneral`).
**C2** — the AC mandated an e2e test but no e2e/HTTP harness exists, so the AC was not runnable as staged.
Both are execution-approach corrections the red-team itself prescribed — architect/replan made no design call.
DEC-29's resolution (`planning/contract.yaml` decisions, id `DEC-29`) is adopted verbatim below:

1. **TK-BEH-1 gates the state-mutating route CLASS BY RULE, not a hand-list** — apply the auth/localhost-env
   guard to all mutating controller routes; the AC's e2e test enumerates routes dynamically from the Nest
   router and asserts every non-GET/mutating + `*-reset` route is guarded (fails if any anonymous destructive
   route is reachable).
2. **Explicit e2e/supertest harness is real scope**, declared in `files_in_scope` — bootstrap `AppModule` +
   `supertest`; TK-BEH-1's AC is restated as a supertest assertion against the bootstrapped app.
3. **TK-BEH-2 widens + de-duplicates**: extract the TK-107 `Promise.race` deadline into a single shared helper
   (today duplicated in `wkg-bootstrap.service.ts:59-81` and `wkg-query.service.ts:151-182`) instead of copying
   it a third/fourth time; apply it to person-model's unbounded `SET p.label` backfill (~:117-120) and to
   face-snapshot's `ensureSchema()`/`hydrate()`. It also corrects `migration.md`'s claim that "nothing writes
   any store" — person-model boot **does** mutate Neo4j at runtime (constraint DDL + label backfill), even
   though no schema/migration *file* changes (see DB gate below; `migration.md` itself is not edited by this
   plan.md pass — flagged for the next writer that touches that file).
4. **TK-BEH-3** stands as previously scoped (qualify `e1.payload`, surface errors instead of `{}`).
5. **TK-BEH-4**'s client-notification event contract must be **pinned jointly with frontend item
   `20260702-005`** — cross-linked explicitly in the ticket below, not decided unilaterally here.

## Proposed contract structure (STAGED — NOT written to contract.yaml; contract_write=staged)
Epic (at contract-write time): **EP-21** — "apps/sylphie backend hardening (2026-07-02 audit §4)"
(parent: FEAT-3, rolling intake). Working ids `TK-BEH-1..5` below are reference labels only —
each becomes a numeric `TK-<n>` when written, per the planning-worx schema.

Sequencing: TK-BEH-1 **+ TK-BEH-1b together** first (P0, public-build exposure — the only P0s;
TK-BEH-1b is a hard co-dependency of TK-BEH-1's supervisor-gating slice and MUST land in the same
change — see TK-BEH-1b below), then TK-BEH-2/3/4a/4b independent of each other and of TK-BEH-1
(see the harness-coupling note under TK-BEH-1's ACs for the one soft build-order awareness item),
then TK-BEH-6 (soft-depends on TK-BEH-4b's event contract landing first), TK-BEH-5a/5b/5c last
(P2, unaffected by DEC-29). Record ids on approval: `pipeline.py set 20260702-001 --add-node <ids>`.

## Refine — Jim-ruled decisions (2026-07-02, third pass)

Jim ruled on the two items this plan.md flagged for Jim/architect after the second red-team
pass. Both are applied below (staged only, not written to `contract.yaml`):

1. **Supervisor gating → "gate + wire frontend token together," no breakage window.** Rejects
   the "accept temporary breakage" option this plan.md previously left open. TK-BEH-1's
   supervisor-gating slice now has a hard, paired co-dependency: **TK-BEH-1b** (new,
   `frontend/src`, owner forge) wires a Bearer token into `SupervisorPanel.tsx`'s POST calls.
   TK-BEH-1 gains a new AC proving the guardian UI still works, authenticated, after gating.
   Neither ticket is done/mergeable without the other landing in the same change — see the
   "hard co-dependency" note under TK-BEH-1b.
2. **mic_dead/error:true consumption → new frontend ticket, do NOT amend item 005.** **TK-BEH-6**
   (new, `frontend/src`, owner forge) consumes TK-BEH-4b's `mic_dead`/`error:true` fields and
   surfaces them in the UI. It is a soft dependency on TK-BEH-4b's contract landing first (not a
   hard co-ship requirement like TK-BEH-1/1b — TK-BEH-4b's backend honesty stands on its own even
   before a UI reacts to it), and it stays entirely inside this epic (EP-21), not item 005.

## Refine — second red-team pass (2026-07-02, AC-level/coordination findings, no design fork)

A second red-team pass against the DEC-29 re-staged TK-BEH-1..5 found 6 further holes, all
AC-level or coordination gaps (no CANON conflict, no design reconciliation needed — confirmed
against source @ 228df73 by direct read/grep, same commit the rest of this plan verified
against). Resolutions below are folded into the ticket bodies; this section is the changelog:

1. **[CRITICAL] TK-BEH-1 had no public-route AC.** A naive default-deny global guard 401s
   `GET /api/health` (the Railway healthcheck TK-106 built specifically to avoid deploy-deadlock
   — see `health.controller.ts`'s own docstring), `POST /api/auth/login`+`register`,
   `GET /api/metrics/health` + the 6 `GET /api/metrics/observatory/*` routes (confirmed anonymous
   today — `useObservatoryData.ts`/`useObservatoryAlerts.ts` send no `Authorization` header),
   static assets, and the WS handshake. Fixed: TK-BEH-1 now carries an explicit public-route
   allowlist AC and a concrete mechanism (default-deny + `@Public()` reflector allowlist, with an
   auth-OR-localhost/env-gate branch for mutating routes) that cannot brick public routes even if
   `JWT_SECRET` is unset on Railway.
2. **[HIGH] `supervisor.controller.ts` was uncovered.** Confirmed 4 anonymous mutating `@Post`
   routes (`policy`, `intervene`, `enable`, `disable` — the controller's own docstring: "the
   guardian's control surface") plus 2 `@Get` (`status`, `verdicts`). Added to TK-BEH-1's
   files_in_scope and ACs. **RESOLVED (Jim-ruled, see "Refine — Jim-ruled decisions" below):** the
   live `SupervisorPanel.tsx` calls these 4 POST routes today with **no** `Authorization` header,
   so gating without a paired fix would functionally break the guardian UI. Jim ruled "gate + wire
   frontend token together, no breakage window" — **TK-BEH-1b** now does that wiring as a hard
   co-dependency of this ticket's supervisor-gating slice.
3. **[HIGH] supertest harness would hang.** Bootstrapping `AppModule` fires
   `PersonModelService`/`FaceSnapshotService`/`WkgBootstrapService`/`WkgQueryService`
   `onModuleInit` hooks against real Neo4j OTHER and TimescaleDB. Fixed: TK-BEH-1 now specifies a
   `TestingModule` provider-override strategy (mock `Neo4jService`, `TimescaleService`) in
   files_in_scope, and the `complexity_budget` is raised. **Correction to this finding's literal
   wording:** direct read of `stt.service.ts:44-49` and `tts.service.ts:22-35` confirms neither
   service's `onModuleInit` makes a Deepgram/ElevenLabs network call at boot — both are pure
   `ConfigService` reads; Deepgram connections are opened lazily per-session via
   `createSession()`. No Deepgram mock is required for the harness to complete; only Neo4j/Timescale
   are real boot-time I/O hazards. Also confirmed: TK-BEH-1's harness is **not** fully independent
   of TK-BEH-2 (both touch the same services' `onModuleInit` internals) — see the sequencing note
   under TK-BEH-1's ACs.
4. **[HIGH] TK-BEH-3 AC1 was non-binary.** `metrics.controller.ts:1782` drops any drive with
   `sampleCount < 5` from the result — so `meanDriveResolutionTimes` returns `{}` both **before**
   the SQL fix (ambiguous-column error → catch → `{}`) and **after** it (correct query, but
   insufficient seeded samples → CANON-omission `{}`). Fixed: AC1 now requires seeding >=5
   `DRIVE_PRESSURE_ELEVATED`/`DRIVE_PRESSURE_RESOLVED` pairs for at least one drive, with a
   companion control AC proving the same seed run against the unfixed query still throws 42702 —
   so the AC actually discriminates on the bug, not on sample volume.
5. **[HIGH] TK-BEH-4's event contract was floating.** DEC-29 assumed joint-pinning with frontend
   item `20260702-005`; confirmed by direct read that **005 has already advanced to `queue`**
   (`pipeline/queue/20260702-005-.../plan.md`) with **no** ticket, AC, or note defining a
   mic-dead/spinner-clear server→client event — the joint-pinning conversation DEC-29 deferred to
   can no longer happen before either side builds. Fixed: the event contract is now **defined
   directly in TK-BEH-4b** (event name/type, payload shape, fire condition for both the
   trigger-phrase-rejection case and the Deepgram-abnormal-close case) as an additive, non-breaking
   wire change. Frontend *consumption* of these fields (spinner/mic-dead UI) stays out of this
   backend-only ticket's scope. **RESOLVED (Jim-ruled, see "Refine — Jim-ruled decisions" below):**
   Jim ruled a new ticket, NOT an amendment to item 005 — **TK-BEH-6** now owns that consumption
   work, staged inside this epic (EP-21).
6. **Splits, per the coordinator's brief:** TK-BEH-4 → **TK-BEH-4a** (stt.service.ts
   session-identity close guard, buildable now, independent of the event-contract question —
   also now covers `pendingBuffers` at `:163`, which the prior staging missed alongside
   `sessions`/`keepAliveTimers`) and **TK-BEH-4b** (client-notify event contract, defined above).
   TK-BEH-5 → **5a** (gateway rejection + full socket-map purge — corrected locus below: the
   unhandled-rejection call site is `communication.service.ts:213`, not
   `conversation.gateway.ts:263-273` as originally staged; the socket-map-purge gap is separately
   confirmed in `conversation.gateway.ts`'s `routeDelivery`) / **5b** (interval clear) / **5c**
   (telemetry honesty, full fabricated-field enumeration, reconciled with 005's `action:null`
   mention). TK-BEH-1 and TK-BEH-2 stay whole (widened, not split). TK-BEH-2 also now states
   per-site deadline values explicitly (`wkg-bootstrap.service.ts` 15s and `wkg-query.service.ts`
   20s stay as-is; the two **new** call sites — `person-model.service.ts` and
   `face-snapshot.service.ts` — get their own stated values, not a copy of either existing one).

---

### TK-BEH-1 — Default-deny rule-based auth gate (public allowlist + auth-or-localhost-gate for mutations) + dynamic-route e2e harness
- **priority:** P0
- **engineering_level:** production
- **complexity_budget:** "<=450 LOC net (guard/decorator + wiring + supertest harness +
  Neo4j/Timescale test-double providers); no new auth mechanism beyond the existing
  `AuthGuard`/JWT — this is a coverage + mechanism-completeness fix, not a new auth scheme; do
  not touch `graph.controller.ts` GET response shapes, only gating. Raised from the prior pass's
  350 LOC because the harness now requires explicit provider overrides (finding #3), not just a
  route-auth spec."
- **owner (work-trio):** forge / ashby / code-reviewer
- **mechanism (fixed, not left to an unstated forge choice — resolves finding #1):** a global
  `APP_GUARD` (`RouteAuthGuard`) implementing default-deny, with two escape hatches, neither of
  which is a new auth scheme:
  1. **`@Public()` reflector-metadata decorator** on the enumerated known-public routes/handlers
     below. The guard's `canActivate` returns `true` immediately if the handler (or its
     controller) carries the `@Public()` metadata.
  2. For everything else (all mutating routes not marked `@Public()`): pass if EITHER (a) a
     valid Bearer JWT verifies via the existing `AuthGuard`/`jwt.verify` path (reused as-is,
     `apps/sylphie/src/guards/auth.guard.ts`), OR (b) the request originates from loopback
     (`127.0.0.1`/`::1`) AND an env flag (e.g. `ALLOW_LOCALHOST_MUTATIONS`, default `true` when
     `NODE_ENV !== 'production'`, must be unset/false on Railway) is enabled — this is the
     "auth OR localhost/env-gate" mechanism source.md asks for, and it is what keeps local dev
     and the CI/e2e harness working without minting a JWT for every request.
  3. **Non-HTTP execution contexts (WS/RPC) short-circuit to `true`** — `context.getType()` is
     checked first and the guard is a no-op for gateway `@SubscribeMessage` handlers. Nest guards
     never intercept the raw WS handshake/`handleConnection` at all (confirmed: it's a lifecycle
     hook, not a guarded call), so this is a correctness note, not new gateway-auth work — WS auth
     stays exactly as it is today (JWT-in-query-param, `conversation.gateway.ts`'s
     `extractUserFromConnection`), out of this ticket's scope.
  4. **`JWT_SECRET`-unset assumption (explicit, per finding #1):** Railway's `JWT_SECRET`
     provisioning is not confirmed by this ticket. If unset, `AuthGuard`'s `jwt.verify(token,
     undefined)` simply throws → caught → 401 (confirmed: `auth.guard.ts:29-36` never crashes the
     process on a bad/missing secret) — so branch (a) silently and permanently fails shut, but
     branch (b) and the `@Public()` allowlist are unaffected. This is why the mechanism picks
     localhost/env-gate as a REQUIRED second branch rather than JWT-only: it is the one that
     cannot deadlock regardless of Railway's `JWT_SECRET` state.
- **files_in_scope:**
  - `apps/sylphie/src/guards/auth.guard.ts` (existing — reused as-is, unmodified)
  - NEW: `apps/sylphie/src/guards/route-auth.guard.ts` (the `RouteAuthGuard` described above)
  - NEW: `apps/sylphie/src/decorators/public.decorator.ts` (`@Public()` — sets reflector metadata)
  - `apps/sylphie/src/app.module.ts` (wire `RouteAuthGuard` as `APP_GUARD`)
  - `apps/sylphie/src/controllers/health.controller.ts` — mark `GET /api/health` `@Public()`
    (Railway/Docker healthcheck; TK-106's own docstring explains why this must never require auth)
  - `apps/sylphie/src/controllers/auth.controller.ts` — mark `POST /register` and `POST /login`
    `@Public()` (a login-required gate on the login route is a deadlock; `GET /me` keeps its
    existing `AuthGuard`, unchanged)
  - `apps/sylphie/src/controllers/metrics.controller.ts` — mark `GET health` (:148) and the 6
    `GET observatory/*` routes (`vocabulary-growth` :1185, `drive-evolution` :1216,
    `action-diversity` :1254, `developmental-stage` :1297, `session-comparison` :1364,
    `comprehension-accuracy` :1405, `phrase-recognition` :1467 — 7 total, corrected count from
    discovery) `@Public()` (confirmed anonymous-consumed today by
    `useObservatoryData.ts`/`useObservatoryAlerts.ts`, no `Authorization` header sent). All 15
    `@Post` routes stay under the default-deny gate (auth-or-localhost-gate), unchanged from the
    prior pass: `reset` (:204), `latent-reset` (:236), `latent-seed-overgeneral` (:267),
    `person-facts-reset` (:324), `all-persons-facts-reset` (:350), `episodic-reset` (:380),
    `perception-reset` (:418), `scene-predictor-reset` (:449),
    `visual-presence-habituation-reset` (:524), `prompt-capture-reset` (:577), `c3-seed` (:794),
    `c3-reinforce` (:883), `decay-now` (:937), `learn-now` (:962), `c3-cleanup` (:1101). The
    remaining debug/introspection GETs (`scene-prediction-state`, `last-scene-outcome`,
    `visual-presence-habituation-state`, `last-deliberation-prompt`, `perception-status`,
    `episodic-recent`, `episodic-recall`, `rumination-state`, `candidate-exists`, `c3-inspect`,
    `node-exists`) are **not** on the public allowlist (confirmed: grepped, none are called by
    `frontend/src` today) — they fall under the default-deny gate like the POSTs, which is a
    behavior change (previously fully open) but not a regression against any live consumer.
  - `apps/sylphie/src/controllers/skills.controller.ts` (`reset`, `reset-world`, :10-53) — gated,
    unchanged
  - `apps/sylphie/src/controllers/llm.controller.ts` (`lesion`, `heal`, :43-63) — gated, unchanged
  - `apps/sylphie/src/controllers/graph.controller.ts` (all 8 `@Get` routes, :12-76 — OKG
    person-facts exposure) — gated, unchanged from the prior pass (this is a deliberate
    behavior change vs. today; not on the public allowlist)
  - NEW: `apps/sylphie/src/controllers/supervisor.controller.ts` (finding #2 — confirmed via
    direct read: `@Get('status')` :27, `@Get('verdicts')` :36 → mark `@Public()`, matching the
    live `SupervisorPanel.tsx` anonymous read pattern; `@Post('policy')` :47, `@Post('intervene')`
    :57, `@Post('enable')` :64, `@Post('disable')` :71 → default-deny gate, same as the other
    mutating controllers)
  - NEW: `apps/sylphie/test/e2e/route-auth.e2e-spec.ts` (AppModule bootstrap + `supertest`)
  - NEW: `apps/sylphie/test/e2e/support/mock-neo4j.provider.ts`,
    `apps/sylphie/test/e2e/support/mock-timescale.provider.ts` (finding #3 — `Neo4jService`
    and `TimescaleService` test doubles, overridden via
    `Test.createTestingModule({...}).overrideProvider(Neo4jService).useValue(...)` /
    `.overrideProvider(TimescaleService).useValue(...)`, so `PersonModelService`,
    `FaceSnapshotService`, `WkgBootstrapService`, and `WkgQueryService`'s real `onModuleInit`
    hooks resolve immediately against the stub instead of hitting live Neo4j OTHER/TimescaleDB)
  - `apps/sylphie/package.json` (add `supertest` devDependency + `test:e2e` script — no e2e
    harness exists today, confirmed by discovery above)
- **acceptance_criteria:**
  - `{ given: "the AppModule bootstrapped via supertest (with Neo4jService/TimescaleService
    overridden by test doubles per files_in_scope) with no Authorization header, and every route
    enumerated dynamically from the Nest HTTP adapter's underlying router/routing table (not a
    hand-maintained list)", when: "each enumerated route whose HTTP method is non-GET, or whose
    path matches a *-reset / reset / reset-world / lesion / heal pattern, is called", then: "every
    such route returns 401 or 403 and no state changes — the test FAILS if any anonymous
    destructive/mutating route in the live router is reachable, including ones not named
    explicitly in this ticket" }`
  - `{ given: "the same dynamic route enumeration", when: "the enumerated set from
    metrics.controller.ts alone is counted", then: "the count of mutating (`@Post`) routes
    discovered is >=15 — a regression guard so a future hand-list narrowing cannot silently
    shrink coverage back down" }`
  - `{ given: "a valid Bearer token signed with the test JWT_SECRET", when: "the same enumerated
    mutating routes are called", then: "none return 401/403 (the guard passes authenticated
    requests through to the handler)" }`
  - `{ given: "GET /api/graph/* (OKG person-facts read routes)", when: "called with no
    Authorization header", then: "401/403 — covered structurally by the same rule-based gate,
    not a special case" }`
  - **NEW — public-route allowlist (resolves finding #1, CRITICAL):** `{ given: "the AppModule
    bootstrapped via supertest with no Authorization header and JWT_SECRET explicitly UNSET in
    the test config (simulating the unknown-Railway-provisioning case)", when: "GET /api/health,
    POST /api/auth/register, POST /api/auth/login, GET /api/metrics/health, and each of the 7
    GET /api/metrics/observatory/* routes are called", then: "every one returns non-401/403 (200
    or its normal non-auth status) — this AC FAILS if wiring the default-deny guard as a naive
    APP_GUARD-with-no-allowlist would have 401'd any of them, and it must pass even though
    JWT_SECRET is unset" }`
  - **NEW — supervisor coverage (resolves finding #2, HIGH):** `{ given: "no Authorization
    header", when: "POST /api/supervisor/policy, /intervene, /enable, /disable are each called",
    then: "401/403 and no state change (supervisor policy/enabled-state/verdict-buffer
    unaffected)" } { given: "no Authorization header", when: "GET /api/supervisor/status and
    /verdicts are called", then: "non-401 — matches the live SupervisorPanel.tsx anonymous read
    today" }`
  - **NEW — guardian UI keeps working, authenticated (Jim-ruled, resolves the supervisor
    breakage-window trade-off — proves TK-BEH-1 + TK-BEH-1b together, no gap):** `{ given: "a
    valid guardian Bearer token, wired into SupervisorPanel.tsx's fetch calls per TK-BEH-1b, is
    attached to POST /api/supervisor/policy, /intervene, /enable, and /disable", when: "each is
    called (simulating the post-TK-BEH-1b guardian UI)", then: "each succeeds (2xx, no 401/403)
    and produces the same state change it does today — this AC FAILS if TK-BEH-1's gate ships
    without TK-BEH-1b's token wiring, which is why the two tickets are a hard co-dependency, not
    independently schedulable" }`
  - **NEW — WS handshake unaffected (resolves finding #1's WS clause):** `{ given: "a raw WS
    client connects to the ConversationGateway/AudioGateway paths with no auth query param",
    when: "the connection is attempted", then: "the handshake succeeds (connection opens) —
    proving RouteAuthGuard's non-http short-circuit does not interfere with gateway connection
    lifecycle; per-message authorization inside gateways, if any, is unchanged and out of this
    ticket's scope" }`
  - **NEW — static assets inherently exempt:** `{ given: "NODE_ENV=production with
    ServeStaticModule active", when: "a static asset path (e.g. /index.html) is requested with no
    Authorization header", then: "it is served — ServeStaticModule's `exclude: ['/api/*splat',
    '/ws/*splat']` middleware sits outside Nest's controller/guard pipeline entirely, so this is
    verified as structurally already-true, not a code change" }`
- **test_refs:** `apps/sylphie/test/e2e/route-auth.e2e-spec.ts` (new)
- **sequencing note (harness/TK-BEH-2 coupling, per finding #3):** this ticket's harness mocks
  `Neo4jService`/`TimescaleService` at the provider level, so it is written against the current,
  stable constructor signatures of `PersonModelService`/`FaceSnapshotService`/
  `WkgBootstrapService`/`WkgQueryService` — it does not depend on TK-BEH-2's internal
  deadline-helper refactor to build. If TK-BEH-2 lands first, re-run this ticket's harness as a
  regression check (constructor signatures are the only thing that could break it); this is a
  build-order awareness item, not a hard blocking dependency, and does not change either
  ticket's independence for scheduling purposes.
- **RESOLVED (Jim-ruled — "gate + wire frontend token together," no breakage window):** gating
  `supervisor.controller.ts`'s 4 POST routes is architecturally correct (CANON guardian
  asymmetry — this is explicitly "the guardian's control surface" per the controller's own
  docstring), and the live `SupervisorPanel.tsx` sends these requests with **no** `Authorization`
  header today. Jim rejected the "accept temporary breakage" option this plan.md previously left
  open. **TK-BEH-1b (immediately below) is a hard co-dependency of this ticket's
  supervisor-gating slice** — it wires a guardian Bearer token into `SupervisorPanel.tsx`'s
  policy/enable/disable calls (and covers `intervene`'s call site, though it has no live UI
  caller today — see TK-BEH-1b). TK-BEH-1's gate and TK-BEH-1b's token wiring must land in the
  same change/PR; neither is considered done in isolation. The new AC above (guardian UI keeps
  working, authenticated) is the runnable proof of this.

---

### TK-BEH-1b — Wire a guardian Bearer token into SupervisorPanel.tsx's mutating calls (hard co-dependency of TK-BEH-1's supervisor gating)
- **priority:** P0 (same as TK-BEH-1 — this is a paired slice of the same P0 fix, not an
  independently-schedulable P1/P2)
- **engineering_level:** production
- **complexity_budget:** "<=100 LOC net; attach an `Authorization: Bearer <token>` header to
  SupervisorPanel.tsx's existing fetch calls, reusing the app's existing auth-token store
  (`useAppStore`'s `authToken`, already used by `App.tsx`'s `/api/auth/me` call) — no new auth
  flow, no new token storage mechanism, no redesign of the login flow"
- **owner (work-trio):** forge / ashby / code-reviewer
- **hard co-dependency (Jim-ruled, not a soft/independent ticket):** this ticket and TK-BEH-1's
  supervisor-gating slice (the `@Post('policy')`/`intervene`/`enable`/`disable` gating in
  `supervisor.controller.ts`) MUST land together in the same change. TK-BEH-1's gate must not be
  merged/deployed ahead of this ticket's token wiring (that reopens the breakage window Jim
  explicitly ruled against), and this ticket's token wiring landing ahead of TK-BEH-1's gate is
  harmless but pointless on its own (nothing to authenticate against yet) — so in practice build
  them as one PR or two PRs merged atomically.
- **files_in_scope:**
  - `frontend/src/components/Supervisor/SupervisorPanel.tsx:190-229`
    (`postAndRefresh` — the shared POST helper used by `handleToggleEnabled` (:216-219,
    `/api/supervisor/enable`/`disable`) and `handleApplyPolicy`/`handleBurstToggle` (:221-229,
    `/api/supervisor/policy`) — confirmed by direct read: `postAndRefresh` currently sends no
    `Authorization` header at all (:195-199). Add
    `Authorization: Bearer ${authToken}` to its `headers`, reading `authToken` from
    `useAppStore` (`frontend/src/store/index.ts:205`, the same store `App.tsx` already reads for
    `/api/auth/me`). Also attach the header to the standalone status-refresh fetches at :202 and
    :394 (`GET /api/supervisor/status` — harmless to send the header on a public GET, keeps the
    fetch pattern consistent).)
  - **`intervene` note (confirmed by grep):** no live caller of `POST /api/supervisor/intervene`
    exists in `frontend/src` today — only `policy`/`enable`/`disable` have UI call sites in
    `SupervisorPanel.tsx`. This ticket does not invent a UI for `intervene`; it is covered by
    TK-BEH-1's gate regardless (no live consumer to break), and if/when a UI caller is added it
    must go through the same `authToken`-bearing pattern this ticket establishes.
- **acceptance_criteria:**
  - `{ given: "a signed-in guardian (authToken set in useAppStore) opens SupervisorPanel and
    clicks Enable/Disable or Apply Policy", when: "the resulting POST fires", then: "the request
    carries Authorization: Bearer <authToken> and succeeds against the TK-BEH-1-gated backend
    (2xx, no 401)" }`
  - `{ given: "no authToken (anonymous/guest session)", when: "the same SupervisorPanel controls
    are used", then: "the request is sent without a valid Bearer token and the backend correctly
    401s (proving this ticket did not weaken TK-BEH-1's gate — the panel's own UX for this case,
    e.g. a disabled-state/error message, is a reasonable minimal addition but not the ticket's
    main contract)" }`
  - `{ given: "TK-BEH-1's gate is live", when: "SupervisorPanel's status poll (GET
    /api/supervisor/status) runs", then: "it continues to succeed (status is on the public
    allowlist per TK-BEH-1) whether or not a token is attached — confirms this ticket didn't
    accidentally start requiring auth on a route TK-BEH-1 left public" }`
- **test_refs:** `frontend/src/components/Supervisor/SupervisorPanel.spec.tsx` (new, or extend
  existing component tests if present)

---

### TK-BEH-2 — Shared boot-deadline helper; widen to person-model backfill + face-snapshot schema/hydrate; correct migration.md
- **priority:** P1
- **engineering_level:** production
- **complexity_budget:** "<=250 LOC net (one shared helper + 4 call-site conversions); no
  behavior change to already-passing boots — only bounds previously-unbounded ops; the shared
  helper takes an explicit `ms` parameter per call site — see stated per-site values below, do
  NOT unify to one constant"
- **owner (work-trio):** forge (shared helper, face-snapshot.service.ts, wkg-bootstrap.service.ts,
  wkg-query.service.ts) + vox (person-model.service.ts) / ashby (forge side) + skinner (vox side) / code-reviewer
- **per-site deadline values (explicit, resolves the "do NOT unify" instruction):**
  - `wkg-bootstrap.service.ts` — **15s** (unchanged; existing TK-107 constant, single Neo4j
    MERGE-style write sequence)
  - `wkg-query.service.ts` — **20s** (unchanged; existing TK-107 constant, 3-way parallel
    `Promise.all` index creation across WORLD/SELF/OTHER)
  - `person-model.service.ts` (**NEW** call site) — **15s**, matching `wkg-bootstrap.service.ts`'s
    precedent: the critical section is the same class of operation (Neo4j OTHER constraint DDL +
    a bounded label backfill `MATCH`/`SET`, single-instance, not parallelized)
  - `face-snapshot.service.ts` (**NEW** call site) — **20s**, matching `wkg-query.service.ts`'s
    precedent: the critical section is a compound op spanning Neo4j OTHER (constraint) AND
    TimescaleDB (`ensureSchema()` + `hydrate()`), the heavier of the two existing deadline
    classes
  - The shared helper must NOT apply a default `ms` silently across call sites — each call site
    passes its own value explicitly (verified by an AC below asserting two different `ms` values
    used in the same test run don't share timer state)
- **files_in_scope:**
  - NEW: `apps/sylphie/src/utils/boot-deadline.ts` (or `services/boot-deadline.service.ts`) — the
    single shared `withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T | undefined>`
    (or equivalent) helper, including a rejection handler on the losing promise so a late rejection
    cannot become an unhandled rejection (the TK-107 orphan-promise gap this item's source.md flags)
  - `apps/sylphie/src/services/wkg-bootstrap.service.ts:59-81` (replace inline `Promise.race` with the
    shared helper, `ms=15_000`)
  - `apps/sylphie/src/services/wkg-query.service.ts:151-182` (replace inline `Promise.race` with the
    shared helper, `ms=20_000`)
  - `apps/sylphie/src/services/person-model.service.ts:96-132` (`onModuleInit` — wrap both
    `CREATE CONSTRAINT` calls at :106/:110 AND the unbounded `SET p.label = p.username` backfill at
    :113-124 in the shared deadline helper, `ms=15_000`)
  - `apps/sylphie/src/services/face-snapshot.service.ts:189-215` (`onModuleInit` — wrap the
    `CREATE CONSTRAINT face_snapshot_id_unique` call at :189-206, `this.ensureSchema()` at :209, and
    `this.hydrate()` at :212-214 in the shared deadline helper, `ms=20_000`)
- **acceptance_criteria:**
  - `{ given: "a Neo4j OTHER driver stubbed to never resolve (stalled-driver test double)", when:
    "PersonModelService.onModuleInit runs", then: "onModuleInit returns within the shared deadline with a
    degraded-mode log line, and the app does not hang" }`
  - `{ given: "the same stalled-driver stub", when: "FaceSnapshotService.onModuleInit runs", then:
    "onModuleInit returns within the shared deadline (covering the constraint call AND
    ensureSchema()/hydrate()), no hang" }`
  - `{ given: "the shared deadline helper's losing (deadline-exceeded) branch", when: "the racing work
    promise rejects LATE, after the deadline has already fired", then: "no `unhandledRejection` is
    observed — asserted via a `process.on('unhandledRejection')` probe registered for the test" }`
  - `{ given: "wkg-bootstrap.service.ts and wkg-query.service.ts after refactor", when: "grepped for
    `Promise.race`", then: "zero inline duplicates remain outside the shared helper module" }`
  - `{ given: "the shared helper invoked twice in the same test run — once with ms=15_000
    (person-model style) and once with ms=20_000 (face-snapshot style), both against stalled-work
    promises", when: "both calls are in flight concurrently", then: "each resolves/times out
    according to its OWN ms value, proving the helper has no shared/global timeout state that
    would silently unify the two call sites' deadlines" }`
  - `{ given: "this ticket lands", when: "the item's migration.md is next revisited", then: "its §1
    claim 'nothing writes any store' is corrected to note person-model boot performs a runtime Neo4j
    DDL + label-backfill write (no schema/migration FILE changes, so the DB-schema-surface classification
    stays 'no' — see DB gate below); this plan.md pass does not itself edit migration.md" }`
- **test_refs:** `apps/sylphie/src/services/person-model.service.spec.ts`,
  `apps/sylphie/src/services/face-snapshot.service.spec.ts`,
  `apps/sylphie/src/utils/boot-deadline.spec.ts` (new)

---

### TK-BEH-3 — Qualify `e1.payload` in meanDriveResolutionTimes; surface query errors
- **priority:** P1
- **engineering_level:** mvp
- **complexity_budget:** "<=40 LOC net; SQL qualification + error propagation only — no
  schema change, no new endpoint, no change to the 5-sample-minimum CANON omission rule at :1782"
- **owner (work-trio):** forge / ashby / code-reviewer
- **files_in_scope:**
  - `apps/sylphie/src/controllers/metrics.controller.ts:1750-1795` (`computeMeanDriveResolutionTimes`
    — qualify `payload->>'drive'` to `e1.payload->>'drive'` in the `SELECT` at :1760 and the `GROUP BY`
    at :1774; the `catch` at :1792 currently swallows the error and returns `{}` — surface it instead,
    e.g. rethrow as a typed exception or include an explicit error marker in the metrics response rather
    than a silently-empty object)
- **acceptance_criteria:**
  - **REWRITTEN (resolves finding #4, HIGH — the prior AC1 was non-binary):**
    `{ given: ">=5 seeded DRIVE_PRESSURE_ELEVATED/DRIVE_PRESSURE_RESOLVED pairs for at least one
    drive (same session_id, matching payload->>'drive', resolution within the 5-minute window
    the query requires)", when: "GET /api/metrics/health is called against the FIXED
    (qualified) query", then: "meanDriveResolutionTimes contains a numeric mean_ms/sample_count
    entry for that drive with sample_count >= 5 — not {}" }`
  - **NEW control (makes AC1 binary — without this, {} before AND after the fix both pass a
    naive AC):** `{ given: "the SAME >=5-pair seed data", when: "run against the UNFIXED
    (ambiguous-column, unqualified payload->>'drive') query", then: "the query throws a 42702
    ambiguous-column error and computeMeanDriveResolutionTimes returns {} — proving AC1's pass
    is discriminating on the SQL qualification fix itself, not on incidentally-insufficient
    sample volume" }`
  - `{ given: "the same query", when: "run directly against Postgres", then: "no 42702
    ambiguous-column error appears in logs or the query plan" }`
  - `{ given: "the underlying Timescale query throws for a reason OTHER than the ambiguous-column bug
    (e.g. a stubbed connection failure)", when: "computeMeanDriveResolutionTimes runs", then: "the error
    is surfaced (logged with context and/or reflected in the response) rather than silently returning {}" }`
- **test_refs:** `apps/sylphie/src/controllers/metrics.controller.spec.ts`

---

### TK-BEH-4a — STT session-identity-guarded close handler (pendingBuffers + sessions + keepAliveTimers)
- **priority:** P1
- **engineering_level:** production
- **complexity_budget:** "<=80 LOC net; a generation/token guard on one close handler — do not
  redesign the STT session lifecycle or reconnect policy"
- **owner (work-trio):** vox / skinner / code-reviewer
- **split rationale:** buildable now, independent of TK-BEH-4b's event-contract question (no
  client-visible wire change here at all — purely an internal map-integrity fix).
- **files_in_scope:**
  - `apps/sylphie/src/services/stt.service.ts:157-173` (the `ws.on('close', ...)` handler —
    guard the `pendingBuffers.delete(clientId)` call at **:163** (missed by the prior staging,
    which only named `sessions`/`keepAliveTimers`) AND the `keepAliveTimers`/`sessions` deletes
    at :164-169, all three keyed by `clientId`, on the entry still belonging to *this*
    session/generation before deleting — e.g. a per-clientId generation counter incremented in
    `createSession()` (~:59-70), captured by the close handler's closure at creation time and
    compared against the current counter value before any of the three `.delete()` calls fire)
- **acceptance_criteria:**
  - `{ given: "a new STT session is created for a client (new generation) before the OLD
    session's close event fires (reconnect churn)", when: "the stale close handler runs", then:
    "it does NOT delete the replacement session's `sessions`, `keepAliveTimers`, OR
    `pendingBuffers` entries — asserted by generation/session-identity check before any of the
    three deletes" }`
  - `{ given: "a session's own (non-superseded) close event fires normally", when: "the close
    handler runs", then: "all three maps (`sessions`, `keepAliveTimers`, `pendingBuffers`) ARE
    cleaned up for that clientId — the guard must not leak entries for legitimately-closed
    sessions" }`
- **test_refs:** `apps/sylphie/src/services/stt.service.spec.ts`

---

### TK-BEH-4b — WS/STT client-notify: trigger-phrase rejection + Deepgram abnormal-close event contract (defined here, not deferred)
- **priority:** P1
- **engineering_level:** production
- **complexity_budget:** "<=120 LOC net across the 2 sites; additive wire changes only (new/reused
  message-type fields), no new reconnect/backoff policy design"
- **owner (work-trio):** forge (`conversation.gateway.ts`, `audio.gateway.ts`) / ashby / code-reviewer
- **event contract (resolves finding #5, HIGH — defined NOW, not jointly-pinned with item 005,
  because 005 has already advanced to `queue` with no ticket referencing this contract at all —
  confirmed by direct read of its `plan.md`):**
  1. **Trigger-phrase rejection** — reuse the EXISTING `thinking_indicator` message type the
     client already listens to for spinner-clear (`conversation.gateway.ts:116`/`:378`,
     `{ type: 'thinking_indicator', is_thinking: boolean }`), extended with one additive field:
     `{ type: 'thinking_indicator', is_thinking: false, error: true }`. Fires from a `.catch`
     added to the existing chain at `conversation.gateway.ts:394-400`
     (`void this.communication.handleTriggerPhrase(...).then(...)`), sent to the originating
     `client` only (not broadcast — matches the existing scoped-send pattern at :370/:378).
  2. **Deepgram abnormal close** — ONE new minimal message type:
     `{ type: 'mic_dead', code: number }` (`code` = the raw non-1000 Deepgram close code). Fires
     from `audio.gateway.ts:162-173`'s `handleDeepgramClose`, in the existing `code !== 1000`
     branch (currently logs and silently `return`s at :172), sent via `state.ws.send(...)`
     instead of the silent return. Deliberately distinct from the existing `restart_audio` type
     (:182), which implies "we already reconnected for you" — that would be false here (the
     `code !== 1000` branch explicitly does NOT auto-reconnect, per the existing comment at
     :166-167).
  3. Both are **additive, non-breaking wire changes** — no existing message shape changes, so
     this ticket does not require the frontend to change for its own ACs to be true and honest
     (the server now reports the failure instead of staying silent, regardless of whether any
     client currently reads the new fields).
- **files_in_scope:**
  - `apps/sylphie/src/gateways/conversation.gateway.ts:394-400` (add `.catch` emitting
    `{ type: 'thinking_indicator', is_thinking: false, error: true }` to the originating client)
  - `apps/sylphie/src/gateways/audio.gateway.ts:162-173` (`handleDeepgramClose`'s `code !== 1000`
    branch — emit `{ type: 'mic_dead', code }` to `state.ws` before returning)
- **acceptance_criteria:**
  - `{ given: "handleTriggerPhrase rejects (e.g. personModel.loadFacts() throws)", when: "a
    trigger-phrase turn is processed", then: "the originating client receives
    { type: 'thinking_indicator', is_thinking: false, error: true } rather than a silent stall
    with the spinner left at is_thinking:true" }`
  - `{ given: "Deepgram closes with a non-1000 code", when: "the audio gateway's close handler
    runs", then: "the client receives { type: 'mic_dead', code } and no reconnect is silently
    attempted (matches existing code!=1000 no-auto-reconnect behavior, now paired with a
    notification instead of a silent drop)" }`
- **test_refs:** `apps/sylphie/src/gateways/conversation.gateway.spec.ts`,
  `apps/sylphie/src/gateways/audio.gateway.spec.ts`
- **RESOLVED (Jim-ruled — new ticket, not an amendment to item 005):** the frontend does not yet
  *consume* `error:true`/`mic_dead` (no code in `frontend/src` reads either field today). Jim
  ruled this gets its own ticket rather than amending item 005 — see **TK-BEH-6** below, staged
  inside this epic (EP-21), soft-dependent on this ticket's event contract.

---

### TK-BEH-5a — Unhandled cycle-response rejection + full socket-map purge on delivery to a dead socket
- **priority:** P2
- **engineering_level:** mvp
- **complexity_budget:** "<=70 LOC net across 2 sites"
- **owner (work-trio):** forge / ashby / code-reviewer
- **corrected locus (verified by direct read — the prior staging's file/line was wrong):**
  `handleCycleResponse` is a **private method on `communication.service.ts:820`**, not on
  `conversation.gateway.ts`. The actual unhandled-rejection call site is
  `communication.service.ts:213` (`void this.handleCycleResponse(response);` inside
  `onModuleInit`'s `this.decisionMaking.response$.subscribe({ next: ... })`) — `conversation.gateway.ts:263-273`
  does not contain this code today.
- **files_in_scope:**
  - `apps/sylphie/src/services/communication.service.ts:208-218` (`onModuleInit`'s
    `response$.subscribe` — wrap the `void this.handleCycleResponse(response)` call with
    `.catch((err) => this.logger.error(...))` so a rejection is caught and logged with context,
    not left as an unhandled rejection)
  - `apps/sylphie/src/gateways/conversation.gateway.ts:194-241` (`routeDelivery` — confirmed by
    direct read: when a targeted (`socketIdToClient`) or fallback (`userIdToClient`) lookup finds
    a socket whose `readyState !== OPEN`, the code currently falls through to a log-and-drop with
    NO map cleanup, leaking `clients`/`clientUsers`/`clientSocketIds`/`socketIdToClient`/
    `userIdToClient` entries for that half-dead socket indefinitely (until/unless
    `handleDisconnect` separately fires). Fix: purge the stale socket from ALL five maps at the
    point of discovery, not just at `handleDisconnect`.)
- **acceptance_criteria:**
  - `{ given: "handleCycleResponse rejects", when: "a cycle response is processed", then: "the
    rejection is caught and logged with context, not left unhandled (asserted via a
    process.on('unhandledRejection') probe)" }`
  - `{ given: "routeDelivery finds a socket via socketIdToClient or userIdToClient whose
    readyState is NOT OPEN (half-dead, e.g. CLOSING)", when: "the delivery attempt runs", then:
    "that socket's entries are purged from clients, clientUsers, clientSocketIds,
    socketIdToClient, AND userIdToClient — not just logged and left in place" }`
- **test_refs:** `apps/sylphie/src/services/communication.service.spec.ts`,
  `apps/sylphie/src/gateways/conversation.gateway.spec.ts`

---

### TK-BEH-5b — SensoryLoggerService interval leak on shutdown
- **priority:** P2
- **engineering_level:** mvp
- **complexity_budget:** "<=20 LOC net; add OnModuleDestroy, clear the one interval"
- **owner (work-trio):** forge / ashby / code-reviewer
- **files_in_scope:**
  - `apps/sylphie/src/services/sensory-logger.service.ts:19-31` (confirmed: implements
    `OnModuleInit` only; `this.interval` set at :29 via `setInterval`, never cleared anywhere —
    add `OnModuleDestroy` + `clearInterval(this.interval)`)
- **acceptance_criteria:**
  - `{ given: "app shutdown (OnModuleDestroy)", when: "SensoryLoggerService is destroyed", then:
    "its interval is cleared and the process can exit cleanly (no lingering timer keeping the
    event loop alive)" }`
- **test_refs:** `apps/sylphie/src/services/sensory-logger.service.spec.ts`

---

### TK-BEH-5c — DrivePublisher telemetry honesty: stop emitting the FULL fabricated-field set
- **priority:** P2
- **engineering_level:** mvp
- **complexity_budget:** "<=60 LOC net; per source.md non-goals, do NOT rework the telemetry
  contract into real entropy/state metrics — only stop emitting fabricated constants; emit
  null/omit when unmeasured"
- **owner (work-trio):** forge (+ drive as conceptual consult — the telemetry contract is
  drive-adjacent) / ashby / code-reviewer
- **files_in_scope:**
  - `apps/sylphie/src/services/drive-publisher.service.ts:99-127` — **full fabricated-field
    enumeration (resolves the MEDIUM finding that the prior staging's list was incomplete;
    confirmed by direct read of the current broadcast payload):**
    `pressure_metadata.is_stale: false` (:110, nested), `drive_entropy: 0` (:113),
    `category: null` (:115), `action: null` (:116), `action_confidence: null` (:117),
    `state: 'idle'` (:118), `transition_count: 0` (:119), `speech_refractory: 0` (:122),
    `dynamic_threshold: 0` (:126) — 9 fields total, all hardcoded constants regardless of
    actual measurement.
- **reconciliation with item 20260702-005 (avoids a double-fix, per the coordinator's brief):**
  item 005's `TK-FE-5` mentions fixing `drive-publisher` `action:null` as part of its
  frontend-telemetry-contract-drift scope. **This ticket (TK-BEH-5c) is the single source of
  truth for the BACKEND emission at `drive-publisher.service.ts`** — item 005/TK-FE-5's
  `action:null` mention should be understood as covering the FRONTEND's handling/display of that
  field (e.g. MetricsPanel wiring), not a second edit to this backend file. Cross-reference both
  tickets once numeric ids exist so a future build doesn't land two independent PRs touching the
  same backend line.
- **acceptance_criteria:**
  - `{ given: "a DrivePublisher broadcast where drive_entropy, state, transition_count,
    pressure_metadata.is_stale, category, action, action_confidence, speech_refractory, and
    dynamic_threshold are NOT actually measured", when: "the broadcast is emitted", then: "all 9
    fields are absent or null in the payload, never the fabricated constants
    0/'idle'/0/false/null-as-if-measured" }`
- **test_refs:** `apps/sylphie/src/services/drive-publisher.service.spec.ts`

---

### TK-BEH-6 — Frontend: consume mic_dead + thinking_indicator.error:true (mic-dead indicator, spinner-error clear)
- **priority:** P1
- **engineering_level:** production
- **complexity_budget:** "<=90 LOC net across 2 hooks; reuse existing state (useAudioStream's
  `error` state, useWebSocket's `setThinking`) rather than inventing new state containers — no
  new reconnect/backoff UI, no redesign of the mic/spinner components"
- **owner (work-trio):** forge / ashby / code-reviewer
- **depends on (soft — event contract must exist, not a hard co-ship requirement):** TK-BEH-4b's
  `{ type: 'thinking_indicator', is_thinking: false, error: true }` and
  `{ type: 'mic_dead', code: number }` message contract. TK-BEH-4b's backend fix is truthful on
  its own even before this ticket lands (it stops staying silent); this ticket is what makes the
  guardian/user actually SEE that something went wrong, per Jim's ruling that this stays a
  separate, new ticket rather than folding into item 005.
- **files_in_scope:**
  - `frontend/src/hooks/useWebSocket.ts:267-276` (the existing `message.type === 'thinking_indicator'`
    branch — confirmed by direct read: currently only reads `message.is_thinking`. Extend to read
    `message.error` and, when `true`, surface a distinct "turn failed" signal alongside the
    spinner clear — e.g. a `turnError` state set alongside `setThinking(false)`, consumed by
    `ConversationPanel.tsx` to show a brief inline error instead of silently returning to idle)
  - `frontend/src/hooks/useAudioStream.ts:115-138` (the existing `ws.onmessage` handler that
    already handles `transcription`/`utterance_complete`/`restart_audio` — add a
    `msg.type === 'mic_dead'` branch that calls the hook's EXISTING `setError(...)` (already
    returned from the hook at `:189`, already consumed for the `error` field) with a
    user-facing message, and sets `isStreaming` to `false` so `AudioPanel.tsx`'s existing
    mic-status UI (whatever it renders off `isStreaming`/`error` today) reflects the dead session
    instead of continuing to look live)
  - `frontend/src/components/Audio/AudioPanel.tsx` (verify/adjust its existing render of
    `useAudioStream`'s `error`/`isStreaming` fields actually surfaces the new mic-dead case
    distinctly enough to be useful — minimal change if the existing error UI already renders
    any non-null `error` string)
- **acceptance_criteria:**
  - `{ given: "the WS client receives { type: 'thinking_indicator', is_thinking: false,
    error: true }", when: "useWebSocket processes the message", then: "the thinking spinner
    clears (is_thinking → false, as today) AND a turn-failed signal is set that
    ConversationPanel can render (distinct from a normal successful turn completion)" }`
  - `{ given: "the audio WS client receives { type: 'mic_dead', code }", when: "useAudioStream
    processes the message", then: "isStreaming becomes false and error is set to a user-facing
    message referencing the mic session ending — AudioPanel's existing error/status rendering
    surfaces it, rather than the mic UI continuing to look live" }`
  - `{ given: "a normal thinking_indicator (is_thinking:false, no error field) or a normal
    restart_audio message", when: "the same handlers run", then: "existing behavior is
    unchanged — no regression to the non-error paths" }`
- **test_refs:** `frontend/src/hooks/useWebSocket.spec.ts`, `frontend/src/hooks/useAudioStream.spec.ts`
  (new or extended, per whatever test scaffolding exists for these hooks)

---

### (Excluded — dedupe, unchanged from the prior pass)
- `apps/sylphie/src/gateways/webrtc.gateway.ts` + `apps/sylphie/src/app.module.ts:219-226`
  (unregistered empty stub) — already staged as `TK-AUDIT-7` in item `20260625-002` (EP-AUDIT);
  excluded from this epic, do not re-file.

## DB gate
Source states no schema/migration; fixes are code + a read-query correction. Per this task's
classification rule (migration files / `*.sql` / prisma only — **runtime Neo4j writes do NOT
count**): this item does **not** touch a DB schema surface. TK-BEH-2's discovery does confirm that
`person-model.service.ts` boot performs a **runtime** Neo4j write (constraint DDL + `SET p.label`
label backfill) — `migration.md`'s current §1 claim "nothing writes any store" is therefore
factually imprecise at the runtime-behavior level and should be corrected (per DEC-29) the next
time that file is touched; this plan.md pass does not edit `migration.md` (out of this pass's
scope per the task boundary — plan.md only). `supervisor.controller.ts` (added to TK-BEH-1 by the
second refine pass) is gating-only, no schema surface. TK-BEH-1b (`frontend/src`, token wiring)
and TK-BEH-6 (`frontend/src`, event consumption) are client-code-only, no schema surface either.
No `*.sql`/prisma/`infra/*/init/**` file changes are introduced by any TK-BEH-1/1b/2/3/4a/4b/
5a/5b/5c/6 ticket. `dbcheck`'s keyword scan may still false-positive on prose ("wipes Neo4j
graphs", "truncates events", "CREATE CONSTRAINT") — this is the known gotcha recorded in
`pipeline.rules.md`.

## Notes for refine
- TK-BEH-1's gating mechanism is now fully specified (default-deny `APP_GUARD` + `@Public()`
  reflector allowlist + auth-or-localhost/env-gate for mutations, non-http short-circuit) —
  the second refine pass closed the "implementation choice for forge" gap the first pass left
  open, since finding #1 showed an unspecified mechanism risks bricking public routes.
- TK-BEH-2 contains a CONFIRM sub-step inherited from the prior pass (orphan-rejection repro) —
  keep it inside the ticket (repro test first via the shared helper's design), do not split into a
  separate investigation item.
- **TK-BEH-4's client-notification event contract is NO LONGER a cross-item dependency on
  `20260702-005`.** The first pass's DEC-29 assumed joint-pinning with 005, but 005 has already
  advanced to `queue` with no ticket referencing this contract (confirmed by direct read). This
  second pass resolved it by defining the contract directly in **TK-BEH-4b** (see above) as an
  additive wire change that needs no frontend cooperation to be true. **TK-BEH-6 (Jim-ruled, third
  pass) now owns the frontend consumption of `error:true`/`mic_dead`, staged inside this epic —
  not folded into item 005.**
- TK-BEH-5 is untouched by DEC-29 and is now split into **5a/5b/5c** (independent, may ship in
  any order or be deferred independently without blocking TK-BEH-1/1b/2/3/4a/4b/6) — flag to
  architect only if refine wants to re-litigate its P2/mvp classification.
- **RESOLVED, third pass (Jim-ruled) — both prior open questions are now closed:**
  1. Supervisor gating ships paired with its frontend fix: **TK-BEH-1 + TK-BEH-1b are a hard
     co-dependency** (must land in the same change; TK-BEH-1's new "guardian UI keeps working,
     authenticated" AC is the runnable proof) — no breakage window, per Jim's ruling.
  2. mic_dead/error:true consumption is **TK-BEH-6**, a new ticket inside EP-21 (soft-dependent
     on TK-BEH-4b's contract) — NOT an amendment to item `20260702-005`, per Jim's ruling.
  No open Jim/architect decisions remain in this plan.md as of this third pass.
