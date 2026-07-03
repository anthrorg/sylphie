# Duplication Audit — 5aa7821

## Summary
Confirmed clusters: 11   |  true-duplicate: 5  near-duplicate: 6
Estimated sites collapsible: ~40 function/type definitions across the 11 confirmed clusters
Dismissed: 1 cluster (legitimate-specialization) + several per-member dismissals folded into otherwise-confirmed clusters

Two cross-language families dominate the findings: a **vector-math family** (cosine
similarity in both TS and Python, plus pgvector literal parsing and embedding parsing)
and a **perception layer-3 bootstrap** copy-paste. The single highest-value cross-package
target is the TypeScript vector/coercion utilities, which want one `@sylphie/shared`
home; the highest-volume single-file copy is the perception-service procedure-bootstrap
pair (two byte-identical ~100-line functions).

CANON note: every recommended canonical home respects package layering and drive/process
isolation. No consolidation introduces a `drive-engine`→app import, and the TS/Python
strata are kept as **two parallel single-source helpers** (the perception sidecar runs as
a separate process/language — bridging it would violate isolation). Where the correct
shared home crosses a package boundary or needs workspace wiring (frontend), the call is
flagged for `architect`/`forge` rather than mechanically merged.

## Clusters (ranked by impact = sites × body size)

### procedure-bootstrap-helpers — true-duplicate — 4 dup sites (+1 specialization)
  Members:
    - `packages/perception-service/cobeing/layer3_knowledge/procedure_bootstrap.py:322` `_collect_procedure_nodes_and_edges`
    - `packages/perception-service/cobeing/layer3_knowledge/language_bootstrap.py:604` `_collect_procedure_nodes_and_edges`
    - `packages/perception-service/cobeing/layer3_knowledge/procedure_bootstrap.py:423` `_bootstrap_single_procedure`
    - `packages/perception-service/cobeing/layer3_knowledge/language_bootstrap.py:705` `_bootstrap_single_procedure`
    - `packages/perception-service/cobeing/layer3_knowledge/semantic_bootstrap.py` `_taught` (specialization — dismissed)
  Canonical home: `packages/perception-service/cobeing/layer3_knowledge/procedure_bootstrap.py`
  (the Phase-1.6 original; `language_bootstrap.py` is a self-admitted copy) — or a new
  `layer3_knowledge/_procedure_bootstrap_core.py`. (respects CANON: yes — same package/dir, no boundary crossed)
  Consolidation: Extract `_collect_procedure_nodes_and_edges` + `_bootstrap_single_procedure`
  into one shared helper and have `language_bootstrap` import it. The collector body is
  byte-identical, but its `_build_procedure_step`/`_build_procedure_template` deps DIVERGE
  (language adds `match_*` syntactic step-types + an optional `domain` template prop), so
  inject the step/template builders (or extend the shared step-builder). Leave `_taught`
  per-module (3-line factory differing only by an intentional `source_id` provenance literal).

### cosine-similarity-py — near-duplicate — 4 sites (+1 dismissed)
  Members:
    - `packages/perception-service/cobeing/layer3_knowledge/expectation_manager.py` `_cosine_similarity`
    - `packages/perception-service/cobeing/layer3_knowledge/in_memory_persistence.py` `_cosine_similarity`
    - `packages/perception-service/cobeing/layer3_knowledge/similarity_computer.py` `_cosine_similarity`
    - `packages/perception-service/cobeing/layer3_knowledge/verification.py` `_cosine_similarity`
  Canonical home: `packages/perception-service/cobeing/shared/vector_utils.py` (new module —
  `shared/` today holds `time_utils`/`text_utils`/`types` but no cosine).
  (respects CANON: yes — stays inside perception-service; the numpy cognition-service variant is NOT folded in)
  Consolidation: Extract one pure-Python `cosine_similarity` (dot=`sum(x*y for zip)`,
  norm=`math.sqrt(sum(x*x))`, zero-magnitude→`0.0`) into `cobeing/shared` and import in the
  4 layer3 sites. **Standardize on the `ValueError`-on-length-mismatch behavior** —
  `verification.py` currently omits that raise and relies on `zip` truncation (a real
  behavioral divergence to fix on consolidation). The
  `similarity_computer.py` "avoid coupling to test-double module" comment dissolves with a
  neutral shared helper. NOT folded: `cognition-service/models/convergence.py:cosine_similarity`
  (numpy-native, `1e-8` epsilon, separate package — see Dismissed).

### bbox-iou — true-duplicate — 4 sites (2 TS + 2 Python, un-bridgeable split)
  Members:
    - `apps/sylphie/src/gateways/perception.gateway.ts` `bboxIoU`
    - `apps/sylphie/src/services/visual-working-memory.service.ts` `bboxIoU`
    - `packages/perception-service/cobeing/layer2_perception/tracker.py` `_compute_iou`
    - `packages/perception-service/cobeing/layer2_perception/observation_builder.py` `_compute_iou_detection`
  Canonical home (TWO homes, hard language/process split):
    - TS → `packages/shared/src/geometry/bbox.ts` (exported `bboxIoU`)
    - Python → `packages/perception-service/cobeing/layer2_perception/geometry.py` (e.g. `compute_iou`)
  (respects CANON: yes — shared TS util is a leaf dep of apps/sylphie; Python stays in perception-service per process isolation)
  Consolidation: Extract ONE TS `bboxIoU` into `packages/shared` and import in both
  `perception.gateway.ts` and `visual-working-memory.service.ts`; extract ONE Python
  `_compute_iou` into a layer2 geometry module called from both `tracker.py` and
  `observation_builder.py`. Do NOT merge across the TS/Python boundary — real collapse is
  2 TS→1 and 2 Py→1. Intra-pair diffs are cosmetic only (`> 0` vs `> 0.0`, fn name).

### sidecar-circuit-breaker — near-duplicate — 2 class sites + identical enum (3rd copy foldable)
  Members:
    - `apps/sylphie/src/services/sidecar-circuit-breaker.ts` `SidecarCircuitBreaker`
    - `packages/supervisor/src/sidecar-circuit-breaker.ts` `SidecarCircuitBreaker`
    - `apps/sylphie/src/services/sidecar-circuit-breaker.ts` `SidecarBreakerState`
    - `packages/supervisor/src/sidecar-circuit-breaker.ts` `SidecarBreakerState`
  Canonical home: `packages/shared/src/circuit-breaker.ts` (generic `CircuitBreaker` +
  `BreakerState`). (respects CANON: yes — both apps/sylphie and packages/supervisor depend on shared; no drive crossing)
  Consolidation: Extract one generic `CircuitBreaker` class + `BreakerState` enum into
  `packages/shared`; both sidecar breakers re-export/alias it (keep `canAttempt`/`allowRequest`
  as thin aliases), supervisor re-declares its `SIDECAR_BREAKER_*` constants as defaults.
  Same three-state machine, identical threshold=5 / cooldown=30_000ms, identical
  success/failure/reset/trip semantics; `SidecarBreakerState` enum is byte-identical
  (true-duplicate type). Drift is cosmetic (`canAttempt` vs `allowRequest`, options-object
  vs positional ctor, a transient `consecutiveFailures` increment placement that is
  behaviorally inert). Both headers note they mirror drive-engine's
  `SelfEvaluationCircuitBreaker` — a **third copy** worth folding into the same shared home.

### as-number-coercion — true-duplicate — 6 sites
  Members:
    - `apps/sylphie/src/services/self-assessment.service.ts` `asNumber`
    - `packages/shared/src/types/wkg-diff.types.ts` `wkgDiffAsNumber`
    - `apps/sylphie/src/services/wkg-query.service.ts` `asNumber`
    - `packages/learning/src/pipeline/confidence-decay.service.ts` `toNumber`
    - `packages/learning/src/pipeline/cross-session-synthesis.service.ts` `toNumber`
    - `packages/learning/src/pipeline/conversation-reflection.service.ts` `toNumber`
  Canonical home: `packages/shared/src/types/wkg-diff.types.ts` (or a new
  `packages/shared/src/util/neo4j-coerce.ts`) — exported as one `asNumber(v, fallback = 0)`.
  (respects CANON: yes — none live in drive-engine/drive-server; all six already import @sylphie/shared)
  Consolidation: Export one `asNumber(v, fallback = 0)` from `@sylphie/shared` and replace
  all six private copies (the 1-arg `toNumber` callers default `fallback` to 0); remove the
  `wkgDiffAsNumber` alias. Same Neo4j-driver value→number coercion (null→fallback, number
  passthrough, `neo4j.Integer.toNumber()` unwrap, else `Number()`) reimplemented 6×. Three
  are the byte-identical 2-arg form; three are the 1-arg form (strict specialization).
  Sibling helpers `asString`/`asNullableString`/`asStringArray`/`asDate`/`toPlain` show the
  same pattern and are worth folding into the same shared coerce module.

### parse-vector-literal — true-duplicate — 4 sites (2 drifted contracts)
  Members:
    - `apps/sylphie/src/services/visual-working-memory.service.ts` `parseVectorLiteral`
    - `packages/decision-making/src/latent-space/person-scoped-face-index.ts` `parseVectorLiteral`
    - `apps/sylphie/src/services/face-snapshot.service.ts` `parseEmbedding`
    - `packages/decision-making/src/latent-space/vector-math.ts` `parseEmbedding`
  Canonical home: `packages/shared/src` (e.g. `shared/src/vector/pgvector.ts`), exported from
  `@sylphie/shared`. (respects CANON: yes — @sylphie/shared is the only home both app and
  decision-making can depend on without a layering violation; decision-making must NOT import app code)
  Consolidation: Export one `parseVectorLiteral(literal): number[] | null` from `@sylphie/shared`
  (the JSON.parse + non-empty + every-finite-number contract — the safer variant) and import
  at all four sites; delete the two local `parseVectorLiteral` copies and the two
  `parseEmbedding` copies (naive comma-split, no NaN guard, returns `[]` — the weaker variant
  that silently yields NaN), adapting the two `parseEmbedding` callers that want `[]` via `?? []`.
  `person-scoped-face-index`'s own comment admits the copy was kept local "to avoid a
  cross-package import from an app-layer service" — `@sylphie/shared` resolves that.
  Escalate precise shared-module placement to forge/architect if the barrel layering is a concern.

### cosine-similarity-ts — near-duplicate — 2 sites (+identical parseEmbedding)
  Members:
    - `packages/decision-making/src/latent-space/vector-math.ts` `cosineSimilarity`
    - `apps/sylphie/src/services/face-snapshot.service.ts` `cosineSimilarity`
  Canonical home: `packages/shared/src` (new vector-math util, e.g. `@sylphie/shared`) —
  shared is the correct cross-boundary home since one consumer is an app.
  (respects CANON: yes — all involved code is perception/decision read-side; no drive-engine import introduced)
  Consolidation: Promote the generic `cosineSimilarity` (and the identical `parseEmbedding`,
  which overlaps with the parse-vector-literal cluster) into `@sylphie/shared`; have both
  `latent-space/vector-math.ts` and `face-snapshot.service.ts` import the one copy; delete the
  file-local helpers in `face-snapshot.service.ts`. Byte-identical generic cosine over
  `number[]` (same `Math.min(len)` loop, same zero-denom→0 guard). DISMISSED 2 candidate
  members: `episodic-memory.service.ts:driveCosineSimilarity` (legitimate-specialization —
  operates on DriveSnapshot objects, clamps to [0,1] for the mood-blend) and
  `recall-retrieval.ts:bestCosine` (coincidental name — it is NOT a cosine impl; it already
  imports and CONSUMES the canonical `cosineSimilarity`, the exact kind of downstream caller
  the consolidation re-points at `@sylphie/shared`). Escalate exact home to architect if
  shared placement is contested.

### supervisor-types-frontend-dup — near-duplicate — 5 types × 2 (mixed per-member verdicts)
  Members:
    - `packages/supervisor/src/interfaces/supervisor.types.ts` / `frontend/src/store/supervisorSlice.ts` `VerdictRating` (true-duplicate, byte-identical)
    - `…` `SupervisorVerdict` (near-duplicate — frontend wire subset, `timestamp:string`)
    - `…` `SupervisorStatus` (near-duplicate — frontend wire subset)
    - `…` `SamplingPolicy` (near-duplicate — frontend 2-field optional stub vs backend 7-field policy; unused by frontend)
    - `…` `SupervisorIntervention` (coincidental/divergent — union members don't overlap; ad-hoc redefinition, dismissed)
  Canonical home: `packages/supervisor/src/interfaces/supervisor.types.ts` (authoritative);
  the shared wire-DTO subset belongs in `packages/shared` so the frontend consumes one source.
  (CANON/layering: frontend is a standalone Vite app with ZERO @sylphie/* deps — it cannot
  import packages/supervisor directly; escalate the workspace-wiring decision to architect)
  Consolidation: Define the wire-shaped DTOs once in `packages/shared` and import in both the
  supervisor backend and the frontend slice. This first requires wiring the frontend into the
  workspace (architect-level layering decision) — do NOT mechanically merge.

### ipc-ws-channel-handlers — true-duplicate — 3 types × 2 sites
  Members:
    - `packages/drive-engine/src/ipc-channel/ipc-channel.service.ts` / `ws-channel.service.ts` `MessageHandler`
    - `…` `MessageHandlers`
    - `…` `PendingMessage`
  Canonical home: `packages/drive-engine/src/ipc-channel/channel-message.types.ts`.
  (respects CANON: yes — drive-wire-protocol types bound to DriveIPCMessageType, stay inside
  drive-engine; does NOT cross into app code, drive-isolation respected)
  Consolidation: Extract the three byte-identical types (`MessageHandler`, `MessageHandlers`,
  `PendingMessage`) into a `channel-message.types.ts` in the same `ipc-channel/` dir and import
  into both services. `ws-channel.service.ts` is the live transport ("Replaces IpcChannelService",
  "Same API shape"); the fork-based `ipc-channel.service.ts` is the legacy path. Lower-impact
  (~14 LOC). A stronger fix may be deleting the superseded `ipc-channel.service.ts` if dead —
  that is an audit-dead-code determination, out of scope here.

### jaccard-similarity — near-duplicate — 3 sites
  Members:
    - `packages/decision-making/src/episodic-memory/episodic-memory.service.ts:786` `jaccardSimilarity`
    - `packages/decision-making/src/wkg/wkg-context.service.ts:1343` `jaccardSimilarity`
    - `packages/decision-making/src/working-memory/activation.ts:127` `jaccardSimilarity`
  Canonical home: `packages/decision-making/src/working-memory/activation.ts` (already
  `export`ed). (respects CANON: yes — pure stateless helper, same package, no drive isolation/layering concern)
  Consolidation: Export the one set-Jaccard helper and have `episodic-memory.service.ts` and
  `wkg-context.service.ts` import it, deleting their private copies. **Reconcile the empty-set
  guard first**: episodic+activation use `a.size===0 && b.size===0`; wkg uses `||`. Pick OR
  (`|A|==0||B|==0 → 0`), then gate-verify the threshold-sensitive call sites
  (`queryByFingerprint >0.70`, `writeActionProcedure` dedup `>0.70`) still behave. Each call
  site pairs Jaccard with its OWN tokenizer — those are a SEPARATE cluster (see text-tokenize),
  do NOT fold them in here.

### text-tokenize — near-duplicate — 2 sites (+2 dismissed)
  Members:
    - `packages/decision-making/src/wkg/wkg-context.service.ts:1338` `tokenize`
    - `packages/decision-making/src/working-memory/activation.ts:113` `tokenize`
  Canonical home: `packages/decision-making/src/working-memory/activation.ts` (exported
  `tokenize` + `jaccardSimilarity`). (respects CANON: yes — same package; no @sylphie/shared
  tokenize exists today, so keeping it in the package that owns the concept is correct, not over-hoisting)
  Consolidation: Have `wkg-context.service.ts` import the already-exported `tokenize`/
  `jaccardSimilarity` from `working-memory/activation.ts` (drop its two private copies). The two
  differ only in punctuation handling — `activation.ts` strips `[.,!?;:'"()[]{}]` (the more
  correct, Python-aligned variant); `wkg-context` does a bare whitespace split. DISMISSED two
  members: `theater-affect-scorer.ts:112:tokenize` (specialization — returns ordered `string[]`
  for positional negation lookup, deliberately KEEPS apostrophes so contractions survive into
  NEGATION_WORDS; merging breaks negation) and `template_matcher.py:_whitespace_tokenize`
  (coincidental — Python, isolated perception-service process, produces parse-token dicts, a
  different concept). Recommend doing this together with jaccard-similarity since both are
  duplicated across the exact same two files.

## Redundant types
- `SidecarBreakerState` — defined in 2 places (apps/sylphie + supervisor), byte-identical → unify in `packages/shared/src/circuit-breaker.ts` (see sidecar-circuit-breaker cluster).
- `MessageHandler`, `MessageHandlers`, `PendingMessage` — each defined in 2 places inside drive-engine, byte-identical → unify in `packages/drive-engine/src/ipc-channel/channel-message.types.ts` (see ipc-ws-channel-handlers cluster).
- `VerdictRating` — byte-identical in supervisor backend + frontend → unify in `packages/shared` (requires frontend workspace wiring; see supervisor-types-frontend-dup cluster).
- `SupervisorVerdict`, `SupervisorStatus`, `SamplingPolicy` — frontend wire subsets that have drifted from the supervisor backend types → define wire DTOs once in `packages/shared`.

## Dismissed candidates (coincidental / specialization + why)

- **graph-persistence-protocol-methods** (legitimate-specialization — whole cluster dismissed).
  `BehavioralStore` Protocol methods in `protocols.py` (`get_recent_proposal_outcomes`,
  `save_verification_result`, `get_gap_lifecycle_history`) vs their `InMemoryGraphPersistence`
  implementations. This is an abstract Protocol contract (`...`-stub bodies + docstrings) vs its
  concrete ports-and-adapters implementation — the shingle matched on names/signatures, which
  are MANDATED by Python `@runtime_checkable` structural subtyping. Merging is impossible/incorrect.
  Both module docstrings document the split ("Forge owns the contract, not the implementation").
  No CANON issue. Dismiss.

- **cognition-service `cosine_similarity`** (`packages/cognition-service/models/convergence.py`) —
  different implementation from the perception-service Python cosine family: numpy-native
  (`np.linalg.norm`, `np.dot`, `np.ndarray` inputs), `1e-8` epsilon guard rather than exact-zero,
  no length raise, in a separate package (cognition-service / supervisor stack, owner meridian)
  that already depends on numpy. Keeping it separate respects package layering. Dismiss.

- **`episodic-memory.service.ts:driveCosineSimilarity`** — legitimate-specialization over
  DriveSnapshot objects (DRIVE_INDEX_ORDER/pressureVector), clamps to [0,1] for the mood-blend;
  a shared base would not cleanly help given the clamp + drive-vector alignment. Dismiss.

- **`recall-retrieval.ts:bestCosine`** — coincidental name; NOT a cosine implementation. It
  already imports and CONSUMES the canonical `cosineSimilarity` from `vector-math.ts` to pick the
  max over candidate forms — a downstream caller, not a duplicate. Dismiss.

- **`theater-affect-scorer.ts:tokenize`** — coincidental/specialization; returns ordered
  `string[]` (not a Set) for positional negation lookup and deliberately keeps apostrophes.
  Merging would break negation handling. Dismiss.

- **`template_matcher.py:_whitespace_tokenize`** — coincidental; different language/process
  (isolated perception-service), produces syntactic parse-token dicts, not a word set. Dismiss.

- **`semantic_bootstrap.py:_taught`** (and the per-module `_taught` factories) —
  legitimate-specialization; a 3-line factory differing only by an intentional `source_id`
  provenance literal recording which bootstrap created the node. Collapsing is low-value and
  would require parameterizing by source_id. Dismiss (optional fold).

- **`SupervisorIntervention`** (supervisor backend vs frontend) — coincidental/divergent: the
  union members do not overlap (frontend `flag`|`rollback`|`freeze` vs backend
  reinforce|correct|freeze_model|unfreeze_model|rollback_checkpoint|boost_salience). An
  independent ad-hoc redefinition, not a subset. Dismiss (per-member, inside an otherwise-confirmed cluster).
