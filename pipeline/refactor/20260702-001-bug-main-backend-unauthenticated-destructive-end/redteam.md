# Red-team findings — 20260702-001 (refine cog, 2026-07-02, plan-reviewer)

Verdict: **REPLAN** — 2 CRITICAL + 4 HIGH unresolved; 3 of 5 tickets fail atomicity gate.
Diagnoses in plan.md are correct and re-verified against source @ 228df73; this is a
ticketing/scoping problem, not a wrong-diagnosis problem.

## CRITICAL
1. **TK-BEH-1 route enumeration under-scoped ~3x.** metrics.controller.ts has 15 @Post
   routes; plan lists ~5. Omitted destructive anonymous routes include
   `all-persons-facts-reset` (:350, TRUNCATEs all persons), `episodic-reset` (:380),
   `perception-reset` (:418), `scene-predictor-reset` (:449),
   `visual-presence-habituation-reset` (:524), `prompt-capture-reset` (:577),
   `latent-seed-overgeneral` (:267). A hand-list AC passes while worse endpoints stay
   open. Fix: gate by rule ("all non-GET on skills/metrics/llm + all graph GETs"); e2e
   test discovers routes from the Nest router, not a hand list.
2. **TK-BEH-1 AC mandates an e2e test but no e2e/HTTP harness exists** (jest unit specs
   only; no supertest/app-bootstrap harness). Hidden scope; AC not runnable as staged.
   Fix: add harness scope explicitly (raises size) or restate AC as supertest against
   bootstrapped AppModule, harness file in files_in_scope.

## HIGH
3. **TK-BEH-2 "TK-107 deadline helper" does not exist as a helper** — inline
   Promise.race duplicated in wkg-bootstrap.service.ts:59-81 / wkg-query.service.ts:151-182.
   Extract-vs-copy is an unmade decision the ticket silently inherits.
4. **TK-BEH-2 scope too narrow:** person-model onModuleInit also runs an unbounded
   backfill write (`SET p.label`, ~:117-120); face-snapshot also awaits `ensureSchema()`
   (TimescaleDB) + `hydrate()` — all un-deadlined, all reproduce the boot hang. Scope
   must be the whole onModuleInit critical section of both services.
5. **migration.md factually wrong:** claims "nothing writes any store"; person-model
   boot runs a `SET p.label` mutation (pre-existing). Impact-class none still defensible,
   but record must be corrected so TK-BEH-2 review doesn't under-check the backfill.
6. **TK-BEH-4 client-notification event contract unpinned** — shared with frontend item
   20260702-005; ACs not binary until event name+payload fixed. Blocker before build.

## MEDIUM/LOW (carry into replan)
- TK-BEH-5 fabricated-field list incomplete (`dynamic_threshold:0`, `speech_refractory:0`,
  nested `pressure_metadata.is_stale`, `category/action:null`).
- TK-BEH-5 bundles 3 unrelated defects → split 5a (gateway rejection + FULL socket-map
  purge incl. clientSocketIds/reverse maps), 5b (interval clear), 5c (telemetry honesty).
- TK-BEH-3 AC must seed ≥5 resolved pairs per drive (query filters sampleCount < 5).
- TK-BEH-1's e2e harness is a shared artifact TK-BEH-4 should reuse.

## Atomicity verdicts
TK-BEH-1 SPLIT (harness+non-GET gating / graph-read gating; resolve AuthGuard-vs-env
gate first). TK-BEH-2 SPLIT or re-scope (two services, two owners vox/forge).
TK-BEH-3 PASS. TK-BEH-4 PASS with contract blocker. TK-BEH-5 SPLIT into 5a/5b/5c.
