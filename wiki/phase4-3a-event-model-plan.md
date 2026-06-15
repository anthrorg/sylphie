# Phase 4 Wave 2 — Cluster 3a on the Event-Judge Model

**Standard (Jim, 2026-06-14):** the Drive Engine watches events and changes the drives. MAIN computes a value and **pushes an event; the drive judges it.** NO drive→main pull/RPC/query. The earlier `KG_QUERY` read-path design is **discarded**. Do not reintroduce it.

Two tickets, same shape: MAIN computes → pushes an inbound event → drive caches/judges. The only inbound write path today is `ActionOutcomeReporterService` → `OutcomeQueue` → `WsChannelService.send()` → `drive-engine.ts handleIPCMessage()`. Everything rides that path.

---

## Ticket 1 — `ipc-self-kg-reader-wiring` (real KG(Self) self-evaluation)

**New inbound event `SELF_ASSESSMENT`** (NOT reuse ACTION_OUTCOME — a self-assessment has no actionId, no theater check, no reinforcement; forcing it through `applyOutcome` would violate Std-2 or pollute the contingency path).

### shared/ipc.types.ts
- Add enum member `SELF_ASSESSMENT = 'SELF_ASSESSMENT'` (inbound section); update header inbound list.
- Add `SelfAssessmentPayload`: `assessedAt: Date`; `capabilities[]` `{id,name,successRate[0,1],confidence[0,1],sampleCount,lastExecuted}` (name MUST match `CAPABILITY_TO_DRIVE_MAP` keys: `social_interaction`,`knowledge_retrieval`,`prediction_accuracy`,`error_correction`); `drivePatterns[]` `{drive:DriveName,stimulus,responseStrength[0,1],examples[],lastObserved,confidence}`; `predictionAccuracy[]` `{domain,mae,sampleCount,confidence,lastUpdated}`; `provenance: 'GUARDIAN'|'GUARDIAN_APPROVED_INFERENCE'|'INFERENCE'|'SYSTEM_BOOTSTRAP'`.

### drive-engine validator (ipc-message-validator.ts — closed union, edit mandatory)
- Add `SelfAssessmentPayloadSchema` (zod, ranges as above, `z.coerce.date()`), add union arm to `InboundMessageSchema` for `SELF_ASSESSMENT`.

### drive-side (drive owns)
- `CachedSelfKgReader implements ISelfKgReader` in `database-clients.ts`: holds `latest: SelfAssessmentPayload|null`, `ingest(payload)`; `queryCapabilities/queryDrivePatterns/queryPredictionAccuracy` serve cached, mapped to `SelfCapability`/etc.; `isReady()` = `latest!==null` (before first push → empty → `assessResults` false → no adjustment = today's safe neutral).
- `drive-engine.ts handleIPCMessage()`: add `case SELF_ASSESSMENT:` → `getOrCreateSelfKgReader().ingest(payload)`. (Cache on receipt; self-eval reads on its 10-tick cadence — decoupled, non-blocking.)
- `getOrCreateSelfKgReader()` constructs `CachedSelfKgReader` (keep `FallbackSelfKgReader` for tests).
- `self-evaluation.ts` / `drive-baseline-adjustment.ts` UNCHANGED (consume via `ISelfKgReader`).

### Std-3 + provenance (drive owns)
- In `ingest()`/mapping: clamp capability `confidence` ≤ 0.60 unless `provenance==='GUARDIAN'`.
- Provenance gate: if `provenance` is `INFERENCE`/`SYSTEM_BOOTSTRAP`, **suppress baseline-reduction** (allow only recovery toward default) — an inferred "I'm bad at X" must not drive the Depressive Attractor. Minimal impl: optional `allowReduction` flag on the mapped `SelfCapability`, checked in the reduction branch (`drive-baseline-adjustment.ts:83`).

### Degradation
No push yet → neutral/no-adjustment (= today). Stale cache → `applyGeneralRecovery()` self-heals toward default. Never fabricate.

### MAIN contract (must build, NOT silent stub — apps/sylphie + atlas)
New push path parallel to the reporter: main computes from Grafeo/KG(Self), pushes `SELF_ASSESSMENT` every ~10s (or on KG-Self consolidation), coalesced ≤1/self-eval interval. Empty if KG-Self empty; never fabricate.

---

## Ticket 2 — `curiosity-information-gain-wkg-access` (§A.14)

**Finding: the IPC path already exists.** `ActionOutcomePayload.informationGainMetrics` (ipc.types.ts) → validator → `contingency-coordinator.ts:144 computeReliefFromMetrics`. Gaps: (a) reporter never threads it, (b) field unvalidated/untrusted, (c) no provenance tie.

### shared/ipc.types.ts
- Extend `informationGainMetrics` with `source: 'WKG_DIFF' | 'UNVERIFIED'`.

### validator
- Add a constrained schema for `informationGainMetrics` to `ActionOutcomePayloadSchema`: `{newNodes:int≥0, confidenceDeltas:≥0, resolvedErrors:int≥0, source:enum}` `.optional()` — closes the "arbitrary numbers" hole.

### drive-side honesty gate (drive owns)
- `curiosity-information-gain.ts computeReliefFromMetrics`: if `!metrics || metrics.source!=='WKG_DIFF'` → **return 0** (no defrauding curiosity; only atlas-computed real diffs earn relief). Else compute as today. Drive still never touches WKG.

### MAIN/atlas contract (must build)
- **atlas:** per WKG-touching action: before-snapshot node-set+confidences; after writes land, diff → `newNodes` (provenance-attributed to THIS action only), `confidenceDeltas` (sum of positive increases on pre-existing nodes), `resolvedErrors` (prediction-error markers flipped resolved). Tag `source:'WKG_DIFF'`. If unattributable (concurrency/no snapshot) → `'UNVERIFIED'` (or omit) → drive zero-relief. Never emit WKG_DIFF with guessed numbers.
- **reporter (apps side):** `ActionOutcomeReporterService.reportOutcome` accept + thread `informationGainMetrics` into the payload (today omitted — the stub). Until atlas supplies real diffs, curiosity relief stays 0 (honest-red), never fabricated.

### Degradation
No metrics / `UNVERIFIED` / missing source → relief 0 (honest). `WKG_DIFF` → proportional relief.

---

## Build sequence
1. shared/ipc.types.ts (enum + payloads + source) → build `@sylphie/shared`.
2. drive-engine validator (union arm + constrained metrics schema).
3. drive-side: CachedSelfKgReader; SELF_ASSESSMENT routing; Std-3/provenance gate; curiosity honesty gate → build drive-engine.
4. MAIN (flagged contracts): reporter threads metrics; SELF_ASSESSMENT push path; **atlas** WKG-diff + KG-Self assessment compute.

Honest-red is acceptable and correct: the drive-side honesty gate makes curiosity honest *immediately* (zero relief on unverified) — atlas/main then make the data real.
