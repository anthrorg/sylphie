# Plan — 20260702-005 — Frontend zombie sockets, browser-exposed API key, dead UI; shared DB nits

- **Type:** bug (ingest guessed `unclassified`) · **Route:** EPIC (multi-ticket) · **DB:** no · **size_hint:** large · **Priority:** P1 (key-exposure sub-item is effectively P0)
- **Owner:** `forge` (frontend/** + packages/shared) · **conceptual reviewer:** `ashby` · **code reviewer:** `code-reviewer`

## Classification (plan cog)
Ingest guessed `unclassified`; this is a **bug epic** — one systemic reconnect defect plus
several independent silent-failure / dead-UI / security issues, each with its own fix
surface and runnable check. Route = epic decomposition, staged here (contract_write=staged;
this scheduled run is contract-write-prohibited).

## Discovery (verified against live source @ HEAD 228df73 — not planned from a guess)
Files confirmed present at every cited path. Spot-checked the two headline claims:
- **API key in the browser:** `feAgent.ts:34-44` — `getClient()` reads
  `import.meta.env.VITE_ANTHROPIC_API_KEY` (Vite inlines it into the built bundle) and
  constructs `new Anthropic({ apiKey, dangerouslyAllowBrowser: true })`. The file docstring
  even asserts "trusted environment, not public-facing" — contradicted by the public
  login/register page. Confirmed exposure.
- **Zombie-socket surface:** the four cited WS hooks all exist
  (`useWebSocket.ts`, `useSupervisorWebSocket.ts`, `usePerception.ts`, `useWebRTC.ts`).
The remaining claims (word-rating envelope/no-handler, telemetry drift, lower cluster) were
not re-read line-by-line this run, but the audit is source-traced at the current HEAD and
both spot-checks matched exactly — treat as reliable; refine/execute confirm at the fix site.

## Proposed contract structure (STAGED — NOT written to contract.yaml)
Route target: `contract_routing = EP-21` (rolling intake epic, parent FEAT-3). Epic:
a new numeric `EP-<n>` (next free id assigned at contract-write; working name
"Frontend reconnect correctness, secret hygiene, and no-void affordances") — ids must
be numeric per the planning-worx schema, NOT a semantic name like EP-FE-RESILIENCE.

| Ticket | Defect | Priority | eng_level |
|---|---|---|---|
| TK-FE-1 | Unmount-reconnect zombie sockets — one shared teardown pattern across all 4 WS hooks (add `unmounted`/`closedByUnmount` flag, null `wsRef`, short-circuit `scheduleReconnect`) | P0 | production |
| TK-FE-2 | Anthropic API key out of the browser bundle — proxy FE-agent calls through a backend endpoint; key never inlined | P0 (security) | production |
| TK-FE-3 | Word-rating reaches a real backend handler (proper `{event,data}` envelope + gateway handler) **or** the affordance is removed | P1 | mvp |
| TK-FE-4 | Perception WS reconnect (folds into TK-FE-1's shared pattern; `usePerception` must reconnect + resume detections) | P1 | production |
| TK-FE-5 | Telemetry contract drift → dead panels: wire the dead handlers to real events **or** remove them; fix `drive-publisher` `action:null`; fix the ms-vs-seconds timestamp mismatch | P2 | mvp |
| TK-FE-6 | Lower cluster (refine will atomicity-split): WebRTC `RTCPeerConnection` leak + staleness guard; transient `/api/auth/me` failure deleting the token; full-store Zustand re-renders; `usePressureStatus` competing writers; shared: Prisma DSN URL-escape + `env!` assertions, `withTransaction` ROLLBACK masking the original error, `useAutoScroll` ignoring `behavior` | P2 | mvp |

**Non-goal (explicit, from source):** building *real* telemetry for the dead MetricsPanel
branches — that is a feature. Here the rule is wire-to-existing-events **or** remove, so the
UI stops implying data exists.

## Acceptance criteria (testable; ≥1 Given/When/Then)
- **TK-FE-1** — Given a mounted WS panel, When its component unmounts, Then no orphan
  socket remains and the async `onclose` does NOT call `scheduleReconnect` (unit test with a
  mock socket asserting no reconnect after unmount); returning to the tab shows single
  delivery and correct turn counts.
- **TK-FE-2** — Given a production build of the frontend, When the bundle is searched for
  the Anthropic key prefix, Then it is absent, and the FE agent's requests go to a backend
  proxy route (build-grep test + proxy integration test).
- **TK-FE-3** — Given a submitted word rating, When it is sent, Then a backend gateway
  handler receives it (gateway log / unit test) — or, if removal chosen: the drawer
  affordance is gone (component test / grep).
- **TK-FE-4** — Given a backend restart with the perception panel open, When the socket
  drops, Then perception reconnects and detections resume (integration test).

## DB step
`dbcheck` run (see log). Source declares **no DB impact** — the shared-package items are
client-code fixes (DSN escaping, error handling, transaction rollback), no schema/migration.
No `migration.md` required. If `dbcheck` flags on the `packages/shared` DB-client keywords,
the finding is client-code-only; record and proceed.

## Routing decision → refine
ACs are testable; fix surfaces are known; the one cross-cutting concern (shared reconnect
pattern) is a coordination note, not a design hole. No genuine multi-perspective
reconciliation is blocking. **Move to `refine`** for atomicity-splitting (esp. TK-FE-6) and
a `plan-reviewer` red-team.

## Notes for refine / coordination
- **Shared reconnect pattern:** TK-FE-1/TK-FE-4 are the *same class* as item 20260702-004's
  TK-DR-1 (drive-server) and the apps-sylphie drive-client. Coordinate so all three share one
  "wait for `open` + bounded queue + guard against unmount/close → short-circuit reconnect"
  implementation rather than three divergent fixes.
- TK-FE-3 and TK-FE-5 each carry a fix-or-remove decision — flag for `ashby` (removing a
  guardian-facing affordance / a "data exists" implication is a UX/design call, not a pure
  code fix).
- TK-FE-2 is security-sensitive (public login page) — treat as the top-priority split even
  though the epic's nominal severity is P1.

---

## Refine cog — 2026-07-02T17:08Z (atomicity gate + red-team; contract_write=staged, item-local only)

**Atomicity gate.** TK-FE-2, TK-FE-3, TK-FE-4, TK-FE-5 are atomic. **TK-FE-6 is NOT atomic** (bundles ~7 independent defects); story-split into:
- **TK-FE-6a** — WebRTC `RTCPeerConnection` leak + staleness guard (test: unmount/close closes the peer connection; stale track guarded).
- **TK-FE-6b** — transient `/api/auth/me` failure must NOT delete the token (test: 5xx/timeout on `me` leaves token intact; only 401 clears it).
- **TK-FE-6c** — full-store Zustand re-renders → selector-scoped subscriptions (test: unrelated store write does not re-render the panel).
- **TK-FE-6d** — `usePressureStatus` competing writers reconciled to a single source (test: no write-thrash / last-writer-wins race).
- **TK-FE-6e** — shared: Prisma DSN URL-escape + drop `env!` non-null assertions (test: special-char password DSN connects; missing env fails loud, not `!`-masked).
- **TK-FE-6f** — shared: `withTransaction` ROLLBACK must propagate the ORIGINAL error, not the rollback error (unit test on `withTransaction`).
- **TK-FE-6g** — `useAutoScroll` honors the `behavior` argument (test: `behavior:'auto'` vs `'smooth'` observed).

Owners: 6a–6d `forge`/`ashby`; 6e–6f `forge` (packages/shared) / `ashby`; 6g `forge`. All `mvp`, no-DB. Splitting revealed **no design hole**.

**Atomicity note (MEDIUM):** TK-FE-1 ("all 4 WS hooks") overlaps TK-FE-4 (perception WS). Clarify the seam: **TK-FE-1** = build the one shared teardown util (`unmounted`/`closedByUnmount` flag, null `wsRef`, short-circuit `scheduleReconnect`) and apply to `useWebSocket`, `useSupervisorWebSocket`, `useWebRTC`; **TK-FE-4** = apply the same util to `usePerception` **and** resume detections on reconnect. Not a blocker.

**Red-team (plan-reviewer role, applied by coordinator — no separate agent file in repo).**
- **HIGH (security, effectively-P0):** TK-FE-2 — Anthropic API key inlined into the browser bundle on a public login page (`feAgent.ts:34-44`, `dangerouslyAllowBrowser:true`). Fix direction is unambiguous (key must leave the bundle; route FE-agent calls through a backend proxy). Open at build: **which backend service hosts the proxy route, and does moving the agent server-side preserve streaming/tool-use parity** — confirm with `forge`/`ashby` at design/build. Bounded, standard pattern → not a replan-forcing hole, but the highest-priority split.
- **HIGH (cross-item coordination):** TK-FE-1/TK-FE-4 reconnect is the same class as item 004 TK-DR-1 and the apps-sylphie drive-client — one shared "wait-for-`open` + bounded queue + guard-against-unmount/close" implementation.
- **MEDIUM (fix-or-remove design calls):** TK-FE-3 (word-rating handler) and TK-FE-5 (dead telemetry panels) accept fix **or** remove. Removing a guardian-facing affordance / a "data exists" implication is an `ashby` UX call at the trio, not a planning-blocking hole; both branches have runnable ACs.
- **No CRITICAL findings. No CANON conflict.**

**DB gate.** `pipeline.py dbcheck 20260702-005` → `touches_db:true` (keyword false-positive: `prisma`/`timescale`/`migration` in prose), `has_migration_plan:true, ok:true`. `migration.md` is a **deliberate, complete `n/a`**: no schema surface (client-code only — DSN escaping, ROLLBACK error propagation), backfill assessed (none), REVERSE present (git revert), no init-script edit. Passes the DB gate. **`sentinel` to confirm no schema surface** before build.

**Verdict: atomic + red-teamed clean → `queue`.** Tickets remain staged in this plan.md; contract-write awaits Jim's per-item staged-write approval gate (contract_write=staged).
