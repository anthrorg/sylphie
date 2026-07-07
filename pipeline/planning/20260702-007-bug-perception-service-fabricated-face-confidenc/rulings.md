# Architect rulings — session C (perception + provenance/self-state)

Date: 2026-07-06. Scope: parked design forks of pipeline items **20260702-007**,
**20260702-006**, **20260702-009** (replan stage; intent Jim-approved; forks per each
item's `verify.md`). Writer discipline honored: no shared file touched; log entries
below are **ready-to-append** with placeholder ids `AD-C1..AD-C5` (coordinator
renumbers + appends serially). Precedents consulted: **DEC-32** (contract.yaml:7399 —
threshold-lowering on a fabricated confidence = Std-4 theater), **AD-0011** (provenance-
restoring migration of the 293 legacy rows), **AD-0047** (Std-4 reconcile-then-rewrite),
**AD-0048** (surfaced-check as the sole provenance gate).

**No fork here is new application direction — nothing escalates to Jim.** All three
items are Jim-filed with approved intent; every ruling below is design mechanics or
process decomposition. The one Jim-adjacent touchpoint is noted in R-006-2 (the
backfill's `--confirm` execution window is naturally his, per db-change-safety).

---

## Item 20260702-007 — perception fabricated face confidence

### R-007-1 (Q-face-confidence-signal) — Option (b)+(c) hybrid: a real geometry-derived QUALITY score + re-semantic'd consumer gate. Option (a) REJECTED. → AD-C1

**Decision.** Ticket -a replaces the fabricated constant
(`face_detector.py:256-258`, `confidence = self._config.confidence_threshold`) with a
deterministic, per-detection, per-frame-stateless **face quality score** in [0,1]
computed from real measurable geometry of that detection — candidate components: face
bbox area as a fraction of frame area, inter-ocular pixel distance, landmark-spread /
bbox-aspect sanity, blendshape availability. The exact formula is designed and
calibrated in a small POC (marr builds, luria conceptual-reviews) against a labeled
fixture set (clear-frontal / occluded / tiny-distant / extreme-angle) with a
monotonicity check against human-judged crop quality. It is documented **in code, on
both ends of the wire**, as a geometry-derived quality proxy — explicitly *not* a model
posterior probability.

The consumer half (the (c) component): `face-snapshot.service.ts:101`'s
`MIN_CONFIDENCE = 0.65` is re-semantic'd to a **crop-quality floor** (rename the
constant, e.g. `MIN_CROP_QUALITY`) and its **value re-derived from the measured
distribution of the new metric on the fixtures** — carrying 0.65 over blind against a
new metric would be an uncalibrated bar on a new signal, the mirror image of the
DEC-32-rejected shape. The in-file precedent for honest threshold provenance is the
`PROVISIONAL_ARCFACE` block at `face-snapshot.service.ts:106-130` — the new floor gets
the same treatment if the calibration set is small. The bail at `:316` gets its log
(already an AC).

**Wire field name:** keep `confidence` on the wire in v1 (`types.py:280` FaceDetection,
shared TS type, gateway mapping `perception.gateway.ts:183`, `face.encoder.ts:146`,
frontend) and truth-edit the docstrings/comments on both ends ("detection quality,
geometry-derived proxy — not a model probability"). A cross-package rename is churn
without a safety gain; honesty lives in the semantics, the docs, and the renamed
consumer constant. Optional follow-up rename, non-blocking.

**Option (a) rejected** (second FaceDetector task): the FaceLandmarker already runs an
internal BlazeFace detection stage whose score the Tasks API discards — option (a)
re-runs detection a second time per frame on exactly the hot path ticket -d is
de-loading; it adds a second model asset plus a **box-association step** (two models'
outputs matched by IoU — a mis-association assigns the wrong score to a face, a *new*
correctness hazard); and its score answers "is this a face?" not "is this crop
enrollment-grade?" — a tiny distant face can carry a high detection score and still be
a useless crop. Wrong signal at real cost. **Revisit trigger:** the POC cannot produce
a quality metric that separates the good/bad fixture classes — then (a) returns to the
table with the association and cost explicitly handled.

**Std-4 / DEC-32 check.** DEC-32 rejected making a still-fabricated signal reachable by
moving the bar. This ruling does the DEC-32 Option-A analog: replace the fabrication
with a genuinely computed measurement and calibrate the bar to it. Two things remain
forbidden by the same principle: (i) keeping the constant and lowering MIN_CONFIDENCE;
(ii) dressing a blendshape activation (an expression score, `face_detector.py:264-266`)
up as detection confidence — that substitutes one fabrication for a better-looking one.
The v1 metric must be per-frame stateless (no cross-frame state in the detector —
temporal logic belongs to the tracker), keeping `detect()` pure and unit-testable.

**Sub-question (MIN_CONFIDENCE vs Std-3 0.60 ceiling): confirmed no interaction.**
MIN_CONFIDENCE is a perceptual crop-quality gate, not a guardian-gated belief/identity
confidence. Verified: `saveSnapshot` (`face-snapshot.service.ts:526-591`) persists
angle + crop + embedding only — no confidence value ever enters OKG/TimescaleDB as a
belief. Add as a ticket non-goal: the quality value must not be persisted as a KG
belief confidence (that would newly engage Std-3).

**Consequences to flag in the restaged ticket:**
- `face.encoder.ts:146` (`features[5] = primary.confidence`) goes from a dead constant
  0.5 to a live varying signal — a sensory-tensor input-distribution change. Note it to
  the tensor input-manifest work (item 20260702-017) so the versioned manifest records
  the semantics change.
- Primary-face selection (`face-snapshot.service.ts:313`, `face.encoder.ts:129-131`
  reduce-by-confidence) becomes meaningful instead of first-face-wins — desirable, but
  the -a spec should assert it (multi-face fixture: highest-quality face selected).
- The ticket crosses the package boundary (marr owns the Python producer; forge owns
  `face-snapshot.service.ts`). Coordinator may build as one trio-staffed ticket or
  split -a1 (producer + metric POC) / -a2 (consumer gate re-semantic + calibration) —
  process call, either is fine; -a2 depends on -a1's calibrated distribution.

### R-007-2 (split) — APPROVED: advance -b/-c/-d now

Tickets -b (tracker LOST→CONFIRMED respects `min_confirm_frames` — confirmed at
`tracker.py:364-365` via plan verification), -c (thread `cfg.tracking`), -d
(throttle/vectorize color loop) are verified clean, single-surface, and independent of
-a. Advance them to refine/queue now. -a is **unblocked by R-007-1**: restage it
against this ruling and advance after the rewrite. Endorsed in passing: verify.md's
non-blocking notes (builder picks throttle-vs-vectorize in -d; -b keys off accumulated
`frames_seen`) are correct as written.

---

## Item 20260702-006 — learning/planning provenance + validation retry

### R-006-1 (verify.md fork, ticket -c2) — speaker SUBJECT node: a person-scoped `:Candidate` person node, merged by speakerId, never by label. → AD-C2

**Decision.** For `subjectHint === 'speaker'` triples, the subject is a minted
**`:Candidate` node with `node_type: 'Person'`**, NOT a live `:Entity` and NOT a new
node label:

- **(a) Label:** `:Candidate` (the existing `CANDIDATE_NODE_LABEL`), `node_type:
  'Person'`, provenance `CANDIDATE_PROVENANCE_TYPE`, confidence ≤
  `CANDIDATE_CONFIDENCE_CAP`. This inherits, with **zero read-path changes**, every
  Wave-3 grounding exclusion (`NOT n:Candidate` across the four WKG read paths per
  AD-0018) — the speaker node cannot ground for another speaker, exactly the §2.8
  invariant. A live `:Person`/`:Entity` would mint a groundable node from an unverified
  conversational identity — reopening the leak class Wave 3 closed.
- **(b) Merge key:** deterministic `node_id = 'person-candidate-' + speakerId`, MERGEd
  on `{grounding_person_id: speakerId, node_type: 'Person'}` (equivalently on the
  deterministic node_id) — **never on `{label}`**. `upsertValueEntity`'s label-keyed
  MERGE (`extract-typed-edges.service.ts:553`) is the wrong key for identity: labels
  collide across humans and a speaker may never state a name. The `label` property is
  cosmetic (display name if known, else the speakerId). `speakerId` is already threaded
  (`extractSpeakerId`, `:721-724`) and already scopes object candidates (`:460/:478`).
- **(c) Third-person reconciliation: disjoint by design in v1.** A third-person mention
  ("Alice likes tea") keeps resolving via `_subjectLabel` to a label-keyed node; the
  same human can therefore have a label-node and a speaker-node. **Auto-merging by
  name-match is forbidden** — name-equality identity resolution is precisely the
  "Maxford" leak class. Reconciliation is guardian-gated only (the C4
  `promoteCandidate` family is where a guardian asserts "this candidate IS that
  person"). Record as an explicit deferral in governance, not silent scope.
- **(d) Person-model relation: correlation by shared key, no cross-graph edge.**
  `speakerId` is the PostgreSQL User.id — the same id space as the OKG `Person.node_id`
  (`face-snapshot.service.ts:539`). The deterministic `person-candidate-<speakerId>`
  makes the WORLD node the auditable world-graph shadow of the OKG person without any
  cross-instance edge (three-graph isolation stands; the graphs live in separate Neo4j
  instances anyway).
- **`findSpeakerEntity` retirement + missing-speakerId behavior:** the positional
  heuristic (`:738-746`) is retired for speaker triples. When `extractSpeakerId`
  returns undefined, do **not** fall back to the arbitrary-entity pick — **skip the
  triple with a logged, counted drop** (vlog + counter). Attaching a personal fact to a
  wrong subject is worse than not learning it; an honest visible drop beats silent
  mis-attribution (Std-1). Edge provenance for these edges follows ticket -c1
  (CANDIDATE, ≤ cap), which composes cleanly: candidate subject + candidate object +
  candidate-provenance edge.

Also endorsed (mechanical, not a fork): verify.md's -d correction — `enqueue()`
(`opportunity-queue.service.ts:87-136`) returns a **discriminated rejection reason**
(duplicate | rate_limited | capacity_outranked) instead of a bare boolean; duplicates
stay marked `has_planned=true`, rate-limit/capacity rejects stay unmarked. -d's
files_in_scope must include `opportunity-queue.service.ts`.

### R-006-2 (OQ-1, backfill) — conversation edges: YES, additive re-stamp with in-place audit trail, discriminator-gated. ActionProcedure nodes: NO backfill (no ground truth exists). → AD-C3

**Conversation edges (the -c bug's residue): MIGRATE.** Precedent AD-0011 governs:
leaving GUARDIAN-stamped conversational edges in place is a *standing* Std-2 violation
that actively distorts the live system going forward — GUARDIAN provenance carries the
slowest decay (0.03 vs 0.05, `confidence-decay.service.ts:141-146`) and top trust, so
unverified chat claims keep outliving and outranking honest sensor data every day the
data stands. This is provenance-restoring, cheap, and compounds if deferred.

**How — additive re-stamp (chosen) over leave-with-annotation:**
- Correct the live values: `provenance_type` GUARDIAN → `CANDIDATE_PROVENANCE_TYPE`
  (matching the forward fix), confidence re-capped to the candidate cap.
- **In-place audit trail on each touched edge:** `prior_provenance_type`,
  `prior_confidence`, `restamped_at`, `restamp_reason: '<decision-id>'`. This is the
  additive re-stamp and the annotation in one — reversible by construction (REVERSE =
  restore from `prior_*`), and the history is honest rather than erased (AD-0047's
  reconcile-don't-delete spirit).
- **Discriminator precondition (hard gate):** the migration must *positively* identify
  conversation-origin edges — signature: `provenance_type='GUARDIAN' AND
  refined_from='STRUCTURED'` (set only by `writeTypedEdge` ON CREATE,
  `extract-typed-edges.service.ts:685-689`) — and the dry run must prove genuinely
  guardian-taught edges (GUARDIAN_CORRECTION/GUARDIAN_CONFIRMATION paths, a different
  writer) do NOT match the signature. **If any subset cannot be discriminated, that
  subset is annotated (`provenance_suspect=true`) and left un-restamped — never
  guessed** (a blind down-stamp of genuine guardian teaching would corrupt the one
  provenance class the system trusts most).
- Mis-attributed subjects (the `(Minecraft)-[LIKES]->(Minecraft)` class): the true
  speaker was never persisted on the edge (writeTypedEdge stores no speaker/session),
  so re-attachment is **not reconstructable** — do not attempt it. Conversation-origin
  **self-loop** edges are structurally identifiable; mark them `subject_suspect=true`
  in the same pass. Deleting them is destructive and stays out of this migration (a
  separate Jim-approvable step if ever wanted).
- Mechanics per house policy: idempotent, dry-run-by-default with counted candidates,
  `--confirm` to apply, backup + REVERSE documented, `infra/migrations/NNN-*.ts`, its
  own migration.md; owner **sentinel**, conceptual **ashby**. Ships as its own ticket
  **after** -c1/-c2 land (the forward fix defines the target values). The `--confirm`
  window is Jim's, per db-change-safety — that is the normal execution gate, not an
  escalation.

**ActionProcedure nodes (the -a bug's residue): NO backfill.** The refined proposal
that actually passed validation was never persisted anywhere — `ValidationResult`
carried no proposal (that IS the bug) and the PLAN_VALIDATED event does not record it —
so there is **no ground truth to restore**: re-stamp impossible, regeneration
impossible. A speculative rewrite would be fabricating history (Std-4). Rider for the
plan rewrite: **verify whether ActionProcedure reuse re-validates at execution time.**
If it does, historical procedures are safely re-checked on reuse and leave-as-is is
fully safe; if it does not, add a cheap annotation sweep
(`created_before_validation_fix=true` on pre-fix-date nodes) so reuse can be gated.
That verification belongs in ticket -a's AC set.

### R-006-3 (split_recommendation) — APPROVED: re-file the "Lower" 8 as their own item, with the Std-3 defect flagged P1 inside it

The 8 "Lower" defects have no acceptance criteria in the source and 8 independent root
causes — folding them into 006 blows its scope. Re-file as a new intake item sourced
from `docs/audits/repo-bug-audit-2026-07-02.md` §5, **with one priority order imposed**:
the re-grounding sweep pushing INFERENCE confidence past 0.60
(`confidence-decay.service.ts:239`, unclamped ratio) is a **live CANON Std-3
confidence-ceiling violation** and must be the new item's P1 lead finding (likely a
one-line clamp + regression test) — triaged, not lost, exactly as the verifier flagged.
The new item's source needs its own GWT criteria before planning. Tickets -a, -b, -c1,
-d advance once -d's enqueue contract is fixed per R-006-1; -c2 is unblocked by AD-C2.

---

## Item 20260702-009 — grounded self-state answers

### R-009-1 (Fork 1, control-flow locus) — Option B: pre-arbitration deterministic short-circuit; intent persisted as a NEW value `SELF_STATE`, not `QUESTION`. → AD-C4

**Decision.** Build the no-LLM self-state path as a **pre-arbitration early return in
`decision-making.service.ts`**, placed beside the existing pre-arbitration recall block
(`computeRecallRetrieval` at `:652` and the metric-gate intent derivation at
`:685-687`): run `selfStateKeyForQuestion(cycleInputText)` (ticket 009-a); on a hit,
render the answer from **the cycle's already-captured snapshot** (`:608` —
single-snapshot-per-cycle, see AD-C5) via the 009-b responder and return a complete
`CycleResponse` before the latent-space/arbitration section, bypassing arbitration and
all three `deliberate()` call sites for that cycle only.

**Option A (TYPE_1 procedure through graduation) rejected.** The graduation machinery
exists to admit *learned* procedures past a confidence/context floor; a hand-authored
deterministic readout gets in only by (i) seeding — which this log has already ruled
theater ("seeding a reflex just to satisfy it", AD-0033 area, log:1593) — or (ii) a
special-cased always-graduated procedure, which pollutes TYPE_1 metrics and the
attractor monitor with authored behavior presented as learned (Std-4-adjacent, and
against the spirit of Std-6: the learning-evaluation surface must measure learning).
Interoception is a reflex arc, not a learned procedure; pre-arbitration is where the
cycle's other deterministic pre-LLM classification already lives.

**Two invariants the ruling binds to 009-c:**

1. **Uniform exit path — the turn must be a real turn, not a ghost.** The short-circuit
   bypasses candidate retrieval, arbitration, and deliberation ONLY. It must exit
   through the same delivery/persistence path as any other CycleResponse: episodic
   record, RESPONSE_GENERATED event, communication delivery, drive ActionOutcome push
   (push-only, per the drive event standard). Otherwise working memory omits what she
   just said and the conversation record lies by omission.
2. **Metric handling (the verifier's rider) — persist `intent: 'SELF_STATE'` (new
   value), NOT `'QUESTION'` and NOT null.** The `knowledge_retrieval` capability gates
   its denominator on `payload.intent='QUESTION'` (`decision-making.service.ts:662-687`).
   Counting self-state turns as QUESTION would put an always-succeeding deterministic
   readout into a capability metric that measures graph-fact retrieval — free wins
   inflating a self-model capability score is exactly the Std-4-adjacent shape the
   metric-gate comment forbids ("never default to 'QUESTION'", `:681-684`). Persisting
   null recreates the inert-branch ambiguity that block was written to fix. A distinct
   `SELF_STATE` value is honest (the row carries its true classification), additive-safe
   (consumers gate on `='QUESTION'`), and auditable. AC to add: the knowledge_retrieval
   denominator is byte-identical before/after a self-state turn.
   
   Classifier precedence: 009-a's classifier and `recallKeyForQuestion` must be
   mutually exclusive on both corpora (already an AC); if both ever match, **fact-recall
   wins** (the established, provenance-carrying path) — documented deterministic
   tiebreak.

### R-009-2 (Fork 2, provenance typing) — Option A: widen `groundedBy` to `'OKG' | 'WKG' | 'DRIVE' | null`; typed, verifiable snapshot provenance; 009-b IS the feeling-verbalizer core. → AD-C5

**Decision.** Add `'DRIVE'` to the `groundedBy` union
(`communication.types.ts:178`, mirrored in `RecallSource` and the consumer sites). The
union's own contract says it exists "so a consumer can verify groundingProvenance
against the CORRECT live instance" — a DRIVE-grounded verdict with `groundedBy: null`
would file a **known** source under the "ambiguous" sentinel, making the provenance
unparseable for the UI/guardian-cockpit and un-typed for every downstream consumer.
Free-text-only provenance (Option B) is provenance-in-name-only — rejected against
Std-1/2. The blast radius (5+ consumer sites + specs) is real but bounded, and it is
the honest cost of a genuinely new grounding source.

- **Provenance string:** deterministic and verifiable —
  `drive:${sessionId}:tick-${tickNumber}` (both fields live on `DriveSnapshot`;
  `decision-making.service.ts:612`, `deliberation.service.ts:382`). Paired with the
  existing `preExecutionDriveSnapshot` on CycleResponse, the claim is auditable
  end-to-end: a test (and the cockpit) can check the delivered text against the actual
  pressure vector of the referenced snapshot.
- **Confidence:** a named constant (e.g. `SELF_STATE_CONFIDENCE = 0.9`) with an in-code
  rationale: a deterministic readout of measured internal state — above the 0.85
  GREETING/EMOTION heuristic (`deliberation.service.ts:484`) because nothing is
  guessed. Std-3's 0.60 ceiling does not bind: it governs guardian-unconfirmed
  *beliefs/knowledge*, and this value is a response-confidence never persisted as a KG
  belief (add as a 009-c non-goal, same as R-007-1's).
- **`degradedNoLlm` stays untouched** — confirmed it means LLM-*unavailable* fallback
  (`deliberation.service.ts:905-943`), the opposite of this success path. The no-LLM
  proof is the AC's LLM spy (`ILlmService.complete` called zero times), not a flag.
- **Std-4 in the verbalization:** the rendered text must be generated from the SAME
  snapshot the provenance references (the cycle's `:608` capture) — no re-read at
  render time that could diverge from the cited evidence. 009-b's flat-state AC (no
  named emotion absent from the snapshot) stands as written.

**Feeling-verbalizer convergence (binding on 009-b).** Jim's companion item
(`pipeline/inbox/feeling-verbalizer-disclosure.md`) mandates ONE drives→NL algorithm
serving both this grounded answer path and general prompt-context injection — "do not
build two separate drive→text renderings." Therefore **009-b is built as the verbalizer
core, not a throwaway**: (i) signature accepts `pressureVector` plus an *optional*
disclosure context (defaulting to "direct question, current speaker") and returns a
structured result the verbalizer item can extend to the `felt`/`shareable` split;
(ii) adopt the no-numerals rule NOW (output contains no numeric drive serializations —
retrofitting it later churns every template); (iii) leave a seeded phrase-variation
hook (or at least don't preclude one) so equal-state repeats don't collide with the
TK-104 content-dedup gate. **Out of 009's scope** (stays with the verbalizer item):
the disclosure model itself — trust bands, guardian ×2/×3 asymmetry, pressure-gated
depth, and replacing the raw `driveLines` prompt injections at
`deliberation.service.ts:347-350` and `action-handler-registry.service.ts:224-228`.
When the verbalizer item is planned, it should ATTACH to 009's epic (per its own
header), consuming 009-b.

**Split (verifier's suggestion): approved** — 009-a and 009-b are fork-independent and
may advance now (with 009-b restaged against the convergence constraints above); 009-c
is unblocked by AD-C4/AD-C5 and advances after rewrite; 009-d follows 009-c.

---

## Ready-to-append architect-log entries (coordinator renumbers AD-C1.. → next AD-NNNN and appends serially)

```yaml
  - id: AD-C1
    date: 2026-07-06
    title: Face confidence (item 007-a) — replace the fabricated constant with a calibrated geometry-derived QUALITY score + re-semantic'd crop gate; second FaceDetector model rejected
    status: accepted
    context: >
      Item 20260702-007 ticket -a. face_detector.py:256-258 reports every face at
      the constant config threshold (0.5); face-snapshot.service.ts:316 gates
      crops on MIN_CONFIDENCE=0.65, so enrollment silently collects zero crops.
      Verified fork: the FaceLandmarker Tasks API the code calls returns NO
      per-face detection confidence (result = landmarks/blendshapes/matrixes
      only; confidence_threshold is input-only, face_detector.py:159-165).
      Neither signal the source proposed exists. DEC-32 precedent: moving the
      bar on a still-fabricated confidence is Std-4 theater.
    decision: >
      Option (b)+(c) hybrid. Producer: a deterministic, per-frame-stateless face
      QUALITY score in [0,1] from real per-detection geometry (bbox area
      fraction, inter-ocular px distance, landmark-spread sanity, blendshape
      availability), formula designed+calibrated in a marr/luria POC on a
      labeled fixture set, documented on both wire ends as a geometry proxy,
      never a model posterior. Consumer: MIN_CONFIDENCE renamed to a
      crop-quality floor whose VALUE is re-derived from the measured metric
      distribution (0.65 must not be carried over blind); bail logged. Wire
      field keeps the name `confidence` in v1 with truth-edited docs (rename
      optional follow-up). Blendshape-as-confidence and threshold-lowering
      remain forbidden (DEC-32). Option (a) — a second FaceDetector task —
      REJECTED: re-runs the detection stage the Landmarker already runs
      internally, on the hot path ticket -d de-loads, adds a box-association
      hazard, and scores "is this a face" not "is this crop enrollment-grade".
      Split: -b/-c/-d advance now; -a restaged against this ruling.
    rationale: >
      DEC-32's Option-A analog: replace the fabrication with a genuinely
      computed measurement and calibrate the bar to it. The enrollment gate's
      real question is crop quality, which geometry measures directly; a
      detection posterior (option a) is the wrong semantics at real hot-path
      cost. Stateless-per-frame keeps detect() pure; temporal logic stays in
      the tracker.
    alternatives:
      - option: Add MediaPipe's separate FaceDetector task for a genuine category.score
        rejected_because: >
          Duplicate detection stage on the hot path -d is de-loading + IoU
          box-association mis-assignment hazard + answers the wrong question.
          Revisit only if the POC cannot produce a quality metric separating
          the good/bad fixture classes.
      - option: Gate purely on discrete checks (landmarks/angle), drop the float entirely
        rejected_because: >
          face.encoder.ts:146 feeds features[5] from this float into the
          sensory tensor — a continuous real signal revives a dead input dim;
          pure-discrete gating would orphan it and churn the wire type.
    consequences: >
      face.encoder features[5] goes dead-constant->live (flag the semantics
      change to the item-017 input manifest). Primary-face selection
      (reduce-by-confidence) becomes meaningful — assert in -a's spec. Ticket
      -a crosses marr/forge ownership; coordinator may split producer/consumer.
      Non-goal added: the quality value is never persisted as a KG belief
      confidence. Std-3 0.60 ceiling confirmed NOT binding (crop gate, not
      belief; saveSnapshot persists no confidence — verified :526-591).
    canon: "supports Std-4 per DEC-32 (real measurement replaces fabrication; bar calibrated to the real signal); Std-3 confirmed untouched"
    evidence:
      - packages/perception-service/cobeing/layer2_perception/face_detector.py:159
      - packages/perception-service/cobeing/layer2_perception/face_detector.py:256
      - apps/sylphie/src/services/face-snapshot.service.ts:101
      - apps/sylphie/src/services/face-snapshot.service.ts:316
      - apps/sylphie/src/services/face-snapshot.service.ts:526
      - packages/decision-making/src/inputs/encoders/face.encoder.ts:146
      - planning/contract.yaml:7399
    supersedes: null

  - id: AD-C2
    date: 2026-07-06
    title: Speaker-fact subject node (item 006-c2) — person-scoped :Candidate person node MERGEd by speakerId, never by label; findSpeakerEntity retired; no name-match reconciliation
    status: accepted
    context: >
      Item 20260702-006 ticket -c criterion 2. findSpeakerEntity
      (extract-typed-edges.service.ts:738-746) picks the first
      GUARDIAN/SENSOR/candidate entity as the "speaker", so "I love Minecraft"
      yields (Minecraft)-[LIKES]->(Minecraft). Post-Wave-3 no speaker node is
      minted at all; upsertValueEntity MERGEs :Candidate by {label} (:553) with
      grounding_person_id as a property only. The plan's claimed
      "MERGE-by-grounding_person_id pattern" does not exist — a per-speaker
      subject node must be designed.
    decision: >
      Mint the subject as a :Candidate node with node_type='Person',
      deterministic node_id 'person-candidate-'+speakerId, MERGEd on
      {grounding_person_id: speakerId, node_type:'Person'} — never on label
      (label property is cosmetic display). Provenance CANDIDATE, confidence <=
      CANDIDATE_CONFIDENCE_CAP; edges per -c1. Third-person mentions stay
      label-resolved and DISJOINT in v1 — auto-merge by name-match is forbidden
      (the Maxford leak class); reconciliation is guardian-gated only (C4
      promoteCandidate family) — record as an explicit deferral. Relation to
      the person-model is correlation by shared key (speakerId == Postgres
      User.id == OKG Person.node_id), no cross-graph edge. findSpeakerEntity is
      retired for speaker triples; when speakerId is absent the triple is
      SKIPPED with a logged, counted drop — never the arbitrary-entity
      fallback. Also endorsed: -d's enqueue() returns a discriminated rejection
      reason (duplicate|rate_limited|capacity_outranked); duplicates stay
      marked has_planned, rate-limit/cap rejects stay unmarked;
      opportunity-queue.service.ts enters -d's files_in_scope.
    rationale: >
      :Candidate inherits every Wave-3 grounding exclusion with zero read-path
      changes — the speaker node cannot ground for another speaker (Std-3
      isolation invariant). Identity keyed on the stable speakerId is the only
      non-colliding merge key; labels collide across humans. An honest visible
      drop beats silent mis-attribution when the speaker is unknown (Std-1).
    alternatives:
      - option: Mint a live :Person/:Entity node for the speaker
        rejected_because: >
          Creates a groundable node from unverified conversational identity —
          reopens the §2.8 leak class Wave 3 closed; promotion to live is the
          guardian's, not the pipeline's.
      - option: Auto-reconcile speaker-node with same-name label-nodes
        rejected_because: >
          Name-equality identity resolution is exactly the historical leak
          vector; reconciliation must stay guardian-gated. Revisit only via a
          designed, guardian-driven merge surface.
    consequences: >
      -c splits: -c1 (provenance, queue-ready) + -c2 (this design). Two-speaker
      test asserts distinct subject nodes keyed to distinct speakerIds and
      unchanged third-person resolution. A known v1 limitation is recorded:
      one human may own a speaker-node and a label-node until guardian
      reconciliation exists.
    canon: "supports Std-2 (honest provenance), Std-3 (person-scoped candidate isolation), Std-5 (reconciliation guardian-gated); no tension"
    evidence:
      - packages/learning/src/pipeline/extract-typed-edges.service.ts:407
      - packages/learning/src/pipeline/extract-typed-edges.service.ts:553
      - packages/learning/src/pipeline/extract-typed-edges.service.ts:721
      - packages/learning/src/pipeline/extract-typed-edges.service.ts:738
      - apps/sylphie/src/services/face-snapshot.service.ts:539
    supersedes: null

  - id: AD-C3
    date: 2026-07-06
    title: Historical mis-provenanced data (item 006 OQ-1) — MIGRATE conversation edges via discriminator-gated additive re-stamp with in-place audit trail; NO backfill of ActionProcedure nodes (no ground truth exists); Lower-8 re-filed as own item with the Std-3 clamp as its P1
    status: accepted
    context: >
      Item 20260702-006 OQ-1 + split_recommendation. Pre-fix writes left (a)
      conversation edges stamped GUARDIAN/0.60 (slowest decay,
      confidence-decay.service.ts:141-146) that should be CANDIDATE/capped, and
      (b) ActionProcedure nodes possibly created from an attempt-1 proposal
      that FAILED validation while a refined one passed. AD-0011 precedent:
      standing provenance violations get migrated, counted, reversibly.
    decision: >
      Conversation edges: MIGRATE — one-shot idempotent re-stamp (GUARDIAN ->
      CANDIDATE provenance, confidence re-capped) writing an in-place audit
      trail on every touched edge (prior_provenance_type, prior_confidence,
      restamped_at, restamp_reason=decision id). Hard gate: a POSITIVE
      discriminator (provenance_type='GUARDIAN' AND refined_from='STRUCTURED',
      set only by writeTypedEdge ON CREATE) proven by dry-run to exclude
      genuine guardian-teaching edges; any non-discriminable subset is
      annotated provenance_suspect=true and left un-restamped, never guessed.
      Conversation-origin self-loop edges get subject_suspect=true; no
      deletions in this pass (destructive = separate Jim-approvable step).
      Dry-run/--confirm/backup/REVERSE per db-change-safety; own ticket +
      migration.md, owner sentinel, conceptual ashby, sequenced AFTER -c1/-c2.
      ActionProcedure nodes: NO backfill — the passing refined proposal was
      never persisted (ValidationResult carried no proposal; PLAN_VALIDATED
      records none), so restoration would fabricate history (Std-4). Rider on
      ticket -a: verify whether procedure REUSE re-validates at execution time;
      if not, add a created_before_validation_fix annotation sweep so reuse can
      gate. Split: the 8 "Lower" defects re-file as their own intake item; the
      unclamped INFERENCE-confidence-past-0.60 defect
      (confidence-decay.service.ts:239) is that item's P1 lead (live Std-3
      violation), triaged not lost.
    rationale: >
      GUARDIAN mis-stamps are a STANDING Std-2 falsification that outlives and
      outranks honest data daily via the slowest decay tier — the
      compounds-if-deferred class AD-0011 already ruled on. Additive re-stamp
      with prior_* fields is annotation and correction in one, reversible by
      construction. The discriminator gate protects the one provenance class
      the system trusts most from a blind down-stamp. For procedures, no
      recorded ground truth exists — any rewrite would be invention.
    alternatives:
      - option: Leave-with-annotation only (no value correction)
        rejected_because: >
          Read paths and decay keep TREATING the edges as guardian-grade; the
          live distortion continues — annotation without correction fixes the
          record, not the behavior.
      - option: Backfill/regenerate pre-fix ActionProcedure nodes
        rejected_because: >
          The refined proposals were never persisted; regeneration would be
          fabricated history (Std-4). Revisit only if an event-payload audit
          finds the refined proposals recorded somewhere (none known).
    consequences: >
      A new sentinel-owned migration ticket lands after -c1/-c2. Tickets -a,
      -b, -c1, -d advance (with -d's enqueue contract per AD-C2); -c2 per
      AD-C2. A new intake item carries the Lower-8 with the Std-3 clamp first.
    canon: "restores Std-2 (provenance-required); protects Std-5 (guardian teaching never blind-down-stamped); refuses an Std-4 fabrication of procedure history; flags a live Std-3 violation for priority triage"
    evidence:
      - packages/learning/src/pipeline/extract-typed-edges.service.ts:487
      - packages/learning/src/pipeline/extract-typed-edges.service.ts:685
      - pipeline/replan/20260702-006-bug-learningplanningsupervisor-validation-retry-/migration.md
      - docs/decisions/architect-log.yaml:428
    supersedes: null

  - id: AD-C4
    date: 2026-07-06
    title: Self-state answer locus (item 009 Fork 1) — pre-arbitration deterministic short-circuit beside computeRecallRetrieval; NOT a TYPE_1 graduated procedure; persist intent='SELF_STATE' (new value), uniform exit path
    status: accepted
    context: >
      Item 20260702-009 ticket -c. "How are you?" runs the TYPE_2 LLM monologue
      and is stamped LLM_ASSISTED (deliberation.service.ts:431-433); no
      grounding source reads the DriveSnapshot though it is injected into the
      prompt (:347-368). Fork: TYPE_1 reflex via arbitration graduation vs a
      pre-arbitration early return. Verifier rider: branches skipping the
      monologue persist intent=NULL, and the knowledge_retrieval capability
      gates its denominator on intent='QUESTION'
      (decision-making.service.ts:662-687).
    decision: >
      Option B — a pre-arbitration early return in decision-making.service.ts
      beside the existing deterministic pre-LLM block (:652-687): on a
      selfStateKeyForQuestion hit, render from the cycle's already-captured
      snapshot (:608) via the 009-b responder and return a complete
      CycleResponse, bypassing candidate retrieval, arbitration, and all three
      deliberate() sites for that cycle ONLY. Two bound invariants: (1) uniform
      exit path — the turn flows through the normal delivery/persistence
      machinery (episodic record, RESPONSE_GENERATED, communication delivery,
      drive ActionOutcome push) so it is a real turn, not a ghost; (2) persist
      intent='SELF_STATE' — a NEW value, not 'QUESTION' (an always-succeeding
      deterministic readout must not inflate the knowledge_retrieval
      denominator/capability) and not null (recreates the inert-branch
      ambiguity). AC added: knowledge_retrieval denominator unchanged by
      self-state turns. Tiebreak: if both classifiers ever match, fact-recall
      wins. 009-a/009-b advance now; 009-c unblocked by this + AD-C5.
    rationale: >
      Graduation machinery admits LEARNED procedures; hand-authoring one in
      requires seeding (already ruled theater in this log) or a special-case
      that pollutes TYPE_1/attractor metrics with authored behavior presented
      as learned (Std-4-adjacent, against Std-6's measurement integrity).
      Interoception is a deterministic reflex arc; pre-arbitration is where the
      cycle's other deterministic pre-LLM classification already lives, and the
      metric-gate comment itself forbids defaulting to 'QUESTION'.
    alternatives:
      - option: TYPE_1 procedure through arbitration graduation (Fork 1 A)
        rejected_because: >
          Seeded/special-cased graduation is authored behavior in learning
          metrics — theater; larger blast radius (arbitration, registration,
          attractor monitor) for no honesty gain.
      - option: Persist intent='QUESTION' on self-state rows (verifier's literal rider)
        rejected_because: >
          Free-win inflation of the knowledge_retrieval capability (it measures
          graph-fact retrieval); a distinct SELF_STATE value keeps the row
          honest AND the metric clean.
    consequences: >
      A new cycle-level early-return shape exists, scoped to exactly one
      deterministic turn class with a documented tiebreak. RESPONSE_GENERATED
      gains an additive intent value 'SELF_STATE' (consumers gate on
      ='QUESTION', unaffected). 009-c ACs extend with the metric-unchanged
      assertion and the LLM-spy zero-calls proof.
    canon: "supports Std-4 (no authored behavior in learned-behavior metrics; no fabricated QUESTION intent) and Std-1 (answer read from the real captured snapshot); drive isolation preserved (read-only IDriveStateReader, push-only outcome)"
    evidence:
      - packages/decision-making/src/decision-making.service.ts:608
      - packages/decision-making/src/decision-making.service.ts:652
      - packages/decision-making/src/decision-making.service.ts:662
      - packages/decision-making/src/deliberation/deliberation.service.ts:431
      - packages/decision-making/src/deliberation/deliberation-helpers.ts:518
    supersedes: null

  - id: AD-C5
    date: 2026-07-06
    title: Self-state provenance typing (item 009 Fork 2) — widen groundedBy with 'DRIVE'; verifiable drive:session:tick provenance; named SELF_STATE_CONFIDENCE; 009-b is built as the feeling-verbalizer core
    status: accepted
    context: >
      Item 20260702-009 Fork 2. groundedBy is a closed 'OKG'|'WKG'|null union
      (communication.types.ts:178) whose contract is verifiable provenance;
      degradedNoLlm means LLM-unavailable (deliberation.service.ts:905-943) and
      cannot signal the no-LLM success path. Jim's companion inbox item
      (pipeline/inbox/feeling-verbalizer-disclosure.md) mandates ONE
      deterministic drives->NL algorithm serving both this grounded answer and
      general context injection, with a felt/shareable disclosure split.
    decision: >
      Widen groundedBy to 'OKG'|'WKG'|'DRIVE'|null (plus RecallSource mirror
      and consumer sites). groundingProvenance =
      'drive:${sessionId}:tick-${tickNumber}' — deterministic and auditable
      against the CycleResponse's preExecutionDriveSnapshot. Confidence = a
      named SELF_STATE_CONFIDENCE (0.9) constant with in-code rationale
      (deterministic readout of measured state; above the 0.85
      GREETING/EMOTION heuristic; NOT a KG belief, so Std-3's ceiling does not
      bind — and a 009-c non-goal forbids persisting it as one). The rendered
      text must derive from the SAME snapshot the provenance cites (the :608
      capture) — no render-time re-read. degradedNoLlm untouched; the no-LLM
      proof is the LLM-spy AC. Convergence binding on 009-b: build it as the
      feeling-verbalizer core — signature takes pressureVector + optional
      disclosure context, structured output extendable to felt/shareable;
      adopt the no-numerals output rule NOW; leave a seeded phrase-variation
      hook (TK-104 dedup). The disclosure model itself (trust bands, guardian
      x2/x3 asymmetry, pressure-gated depth, replacing the raw driveLines
      injections at deliberation.service.ts:347-350 and
      action-handler-registry.service.ts:224-228) stays with the verbalizer
      item, which ATTACHES to 009's epic and consumes 009-b.
    rationale: >
      A known source filed under the null="ambiguous" sentinel is
      provenance-in-name-only — untyped for the UI/cockpit and every consumer;
      the union's own doc contract says typed source enables verification
      against the correct live instance. The bounded 5-site blast radius is
      the honest cost of a genuinely new grounding source. Building 009-b
      throwaway would violate Jim's one-algorithm directive and churn every
      template when disclosure lands.
    alternatives:
      - option: groundedBy null + free-text groundingProvenance only (Fork 2 B)
        rejected_because: >
          Unparseable provenance; conflates a KNOWN source with the ambiguous
          sentinel — fails the field's own verification contract (Std-1/2 in
          spirit).
      - option: Reuse degradedNoLlm to signal the no-LLM path
        rejected_because: >
          Means the opposite (LLM-unavailable SHRUG fallback); conflating a
          success path with a degraded state is a theater hazard.
    consequences: >
      Shared-type widening touches decision-making/deliberation/helpers + specs
      (bounded, enumerated in the plan). The provenance is end-to-end auditable
      (text vs preExecutionDriveSnapshot). 009-b restaged with the verbalizer
      signature/no-numerals/variation-hook constraints; the verbalizer item
      later extends rather than replaces it.
    canon: "supports Std-1/Std-2 (typed, verifiable provenance for a real state readout; text from the cited snapshot only); Std-3 confirmed not binding on a non-persisted response confidence; theater prohibition served by the felt/shareable rule that disclosure gates AMOUNT, never truthfulness"
    evidence:
      - packages/shared/src/types/communication.types.ts:178
      - packages/decision-making/src/deliberation/deliberation.service.ts:347
      - packages/decision-making/src/deliberation/deliberation.service.ts:484
      - packages/decision-making/src/deliberation/deliberation.service.ts:905
      - pipeline/inbox/feeling-verbalizer-disclosure.md
    supersedes: null
```

---

## What I'd verify next (riders for the plan rewrites)

1. **007-a POC:** the quality metric actually separates the fixture classes (this is
   the revisit trigger for option (a)); assert multi-face primary selection.
2. **006 migration dry-run:** the `GUARDIAN + refined_from='STRUCTURED'` discriminator
   matches zero genuine guardian-teaching edges (positively verify what the
   GUARDIAN_CORRECTION path writes before trusting the signature).
3. **006-a rider:** does ActionProcedure reuse re-validate at execution time? Decides
   whether the annotation sweep is needed.
4. **009-c:** the knowledge_retrieval denominator is provably unchanged by SELF_STATE
   turns; the short-circuited turn appears in episodic memory/working-memory context.

## Handoffs

- Item 007: -b/-c/-d → refine/queue now; -a rewrite by the plan cog against AD-C1
  (marr + luria POC leg; forge on the consumer edge).
- Item 006: -a/-b/-c1/-d → queue after -d's enqueue-contract fix (AD-C2); -c2 rewrite
  against AD-C2; new sentinel migration ticket per AD-C3 sequenced after -c1/-c2;
  coordinator re-files the Lower-8 as a new intake item (Std-3 clamp as its P1).
- Item 009: -a/-b → queue now (-b restaged per AD-C5's verbalizer constraints); -c
  rewrite against AD-C4+AD-C5; -d follows -c. The feeling-verbalizer inbox item, when
  planned, attaches to 009's epic and consumes 009-b.
