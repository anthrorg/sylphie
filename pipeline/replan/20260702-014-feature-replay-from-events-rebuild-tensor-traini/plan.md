# Plan — 20260702-014: Replay-from-events (rebuild tensor training data from the event log)

## Verification against the actual codebase

| Source claim | Verdict | Evidence |
|---|---|---|
| "TimescaleDB event log is the ground truth of everything Sylphie did" — a queryable `events` table with situation/action/outcome records exists | **Confirmed, with a caveat** | `infra/timescaledb/init/002-events.sql`: hypertable `events(id, type, timestamp, subsystem, session_id, drive_snapshot JSONB, payload JSONB, correlation_id, schema_version)`, indexed by `(session_id, type, timestamp)` and `(correlation_id, timestamp)`. `packages/decision-making/src/logging/decision-event-logger.service.ts` writes it. `event.types.ts` defines `ACTION_EXECUTED`, `ARBITRATION_COMPLETE`, `PREDICTION_EVALUATED`, etc., correlated by `correlationId` — a situation→action→outcome chain is reconstructable *by event type + correlation join*. |
| Replay can "regenerate labeled training samples for the executor tensor" that match the current sample contract | **Not confirmed — likely false as literally stated** | `packages/cognition-service/schemas.py:112` `TrainingSample` requires `fused_embedding` (768-dim), `episodic_context` (768-dim), `modality_embeddings` (dict), `response_embedding`, plus scalar labels. Grepped `packages/shared/src/types/event.types.ts` for "embedding" — **zero matches**. `ActionExecutedEvent`'s actual payload (event.types.ts:567-576) carries only `actionId`, `actionType`, `arbitrationType` — no vectors. **The event log as currently captured does not persist the embeddings a `TrainingSample` needs.** See open question OQ-1 below — this is a real gap, not a nitpick, and it bears directly on acceptance criteria 1 and 3. |
| A distinct "replay" capability needs to be built | **Confirmed — and a naming collision was found** | `packages/cognition-service/training/replay.py` + `training/data_buffer.py` already exist, but they are the **EWC / experience-replay in-memory ring buffer** for continual learning (Online EWC Fisher calibration across bootstrap/audit/partial/full phase boundaries) — a completely different concern from "rebuild training data from the TimescaleDB event log." The new tool must not be named/placed so it collides with or is confused for the existing module. |
| Dependency: **feature-tensor-contract** exists as a plannable unit | **Confirmed, but unplanned** | Sibling pipeline item `pipeline/planning/20260702-017-feature-tensor-contract-versioned-inputarch-mani/` — still sitting in `planning/`, not yet staged into `contract.yaml`. No `EP-`/`TK-` id exists for it yet. |
| Dependency: **feature-snapshot-restore** exists as a plannable unit | **Confirmed, but unplanned** | Sibling pipeline item `pipeline/planning/20260702-016-feature-coordinated-sylphie-snapshot-tested-rest/` — same situation, still in `planning/`, no contract id. |
| Acceptance #4 hook: compare against manifest's `verified_training_samples` history | **Confirmed as forward-looking, not yet real** | `verified_training_samples` only appears in this item's own `source.md` and in `docs/future/sylphie-observability-spec.md` (a `docs/future/` design doc, not shipped code) — the metrics-block manifest it would live in is itself part of unplanned item 016. |
| Existing bootstrap ladder / graduation machinery to re-enter at shadow stage | **Confirmed** | `packages/cognition-service/inference/bootstrap.py` has `check_graduations()`, a demotion threshold, and `_graduated_categories` per-category state (also touched by existing contract tickets around TK-37/TK-39 EWC work at `planning/contract.yaml:2985-3003`). The retrain-from-experience path can plug into this real, live mechanism. |

## Existing contract overlap

**None.** Grepped `planning/contract.yaml` for `tensor_manifest`, `fusion-slot`,
`Sylphie Snapshot`, `snapshot-restore`, `persistence-migration`, `EWC Fisher`,
`bootstrap ladder`, `retrain-from-experience`, `verified_training_samples` —
no epic or ticket covers replay-from-events, the tensor manifest/contract, or
snapshot/restore. This is genuinely new scope. (The contract does have live
EWC/Fisher-order tickets around TK-37/TK-39 in the cognition-service files
this work will also touch — sequencing note, not overlap: same files,
different concern.) Current max ids in the contract: `EP-27`, `TK-155` — a new
epic would be `EP-28+` at staging time (whatever `refine`/actual write time
assigns).

## Open questions (route to architect — do not guess)

**OQ-1 (blocking AC1 and AC3 as literally written): Can the embeddings a
`TrainingSample` requires be deterministically recomputed from data already
durable elsewhere, or does full-fidelity replay require an event-schema field
the source declares out of scope?**
`fused_embedding`, `episodic_context`, and `modality_embeddings` are not
persisted in any event payload today (verified above). Three possible
resolutions, each with different ticket shapes:
  (a) They ARE deterministically recomputable offline — e.g. from the raw
      sensory/text inputs plus the drive state at that timestamp, re-run
      through the *same, versioned* fusion code path (this is exactly what
      the tensor-contract's input-contract versioning is for) — in which case
      replay is a real byte-identical reconstruction and AC1/AC2/AC3 hold as
      written.
  (b) They are NOT recomputable (raw inputs aren't retained at the needed
      granularity, or the fusion path isn't cheaply re-runnable offline), in
      which case the honest scope is a **narrower tool**: replay reconstructs
      the *labels* (arbitration_type, action_category, outcome, drive_effects,
      category distribution/counts) reliably, but cannot regenerate the exact
      input vectors — meaning "retrain-from-experience" would retrain against
      re-derived-but-not-identical inputs, which changes what AC2 (determinism)
      and AC3 (reaches audit-stage agreement) can honestly promise.
  (c) Add the missing fields to the event payload (schema-additive, no
      backfill for old rows) — but the source's non-goals explicitly forbid
      absorbing "changes to what events are captured" into this feature; that
      would need to be its own item, sequenced ahead of this one.
This is exactly the kind of fork the source's own non-goals section
anticipated ("if the event schema is missing a needed field, that's a finding
to surface, not scope to absorb") — surfacing it rather than guessing.

**OQ-2 (sequencing, not a design fork — informational for whoever queues this):**
Both hard dependencies (tensor-contract = item 20260702-017, snapshot-restore
= item 20260702-016) are themselves still unplanned siblings in
`pipeline/planning/`, not contract nodes. This item's tickets below use
`depends_on` refs to those *pipeline item ids* (not contract TK- ids, which
don't exist yet) — whoever later stages 016/017 into the contract should
backfill the real `TK-` ids into this epic's `depends_on`.

## Split recommendation

None. This is one coherent feature (build the replay tool, wire the
retrain-from-experience path, prove it end-to-end) and the source's own
non-goals already fence off the two things that would otherwise bloat it
(event-schema changes, online/continuous replay, graduation-threshold
changes). No sub-concern here belongs in a different pipeline item.

## Proposed epic

**EP-(new) — Replay-from-events: rebuild tensor training data from the event log**
Owner: `learning` (build) / `meridian` (cognition-service touch-points).
Conceptual reviewers: `piaget` (learning idea) / `ashby` (cognition-service
system properties). Code reviewer: `code-reviewer`.
Depends on: pipeline items 20260702-017 (feature-tensor-contract) and
20260702-016 (feature-snapshot-restore) landing in the contract first — this
epic should not leave `refine` until at least 017's input-contract versioning
ticket has a real `TK-` id, since 20260702-014-b's sample format is defined by
that contract.

### Ticket 20260702-014-a — Audit: can replay reconstruct `TrainingSample` inputs from the event log?

- **Priority:** P2 (a blocking investigation for a P2 feature, not itself a
  data-loss/security issue).
- **Engineering level:** prototype (throwaway investigation script + a written
  finding, not shipped product code).
- **depends_on:** none.
- **Given** the current `events` table and event-type payloads (as they exist
  in `packages/shared/src/types/event.types.ts` and are written by
  `decision-event-logger.service.ts`),
  **when** a spike script queries a real (or synthetic) session's event range
  and attempts to reassemble one `TrainingSample` per `ACTION_EXECUTED` event,
  **then** it must report, per required `TrainingSample` field
  (`fused_embedding`, `episodic_context`, `modality_embeddings`,
  `response_embedding`, `drive_vector`, `drive_deltas`, `arbitration_type`,
  `action_category`, `outcome`, `drive_effects`), whether the field is (i)
  directly present in event payload/`drive_snapshot`, (ii) deterministically
  derivable from other persisted data + versioned code, or (iii) unavailable —
  and this report resolves OQ-1.
  - **Runnable check:** the spike script (e.g.
    `packages/learning/scripts/audit-replay-feasibility.ts` or `.py`, exact
    location TBD by the owning expert) runs against a real dev-DB session and
    prints the per-field table above; a human/architect reads the printed
    table and rules on OQ-1's (a)/(b)/(c) branch. `yarn workspace @sylphie/learning run <script-name>` (or the cognition-service equivalent via its venv) exits 0 and produces the table.
- **Given** the spike's finding, **when** it is written up, **then** it is
  recorded as the resolution to OQ-1 in `planning/contract.yaml`'s governance
  (`open_question` → `decision`), not left as a comment in code.
  - **Runnable check:** `grep -c "OQ-1" planning/contract.yaml` (or the
    decision's actual id) returns a match after the ticket closes.
- **Non-goals:** no production replay code yet; no changes to the event
  schema; no retrain run.

### Ticket 20260702-014-b — Build the event-log replay tool (scope set by 014-a's finding)

- **Priority:** P2.
- **Engineering level:** production.
- **depends_on:** 20260702-014-a (OQ-1 resolved); pipeline item 20260702-017
  (tensor-contract — samples must target its versioned input contract) —
  real `TK-` id TBD once 017 is staged.
- **Given** an event-log time range and a session/correlation scope, **when**
  the replay tool runs, **then** it emits a labeled training set (shape/fields
  per whichever branch of OQ-1 was ruled — full `TrainingSample` if (a),
  label-only/reduced schema if (b)) whose **sample count matches an
  independently-run `SELECT count(*)` over the qualifying `ACTION_EXECUTED`
  events for that range** (this part of AC1 is unconditionally checkable
  regardless of OQ-1's outcome).
  - **Runnable check:** a test seeds N synthetic `ACTION_EXECUTED` +
    correlated `ARBITRATION_COMPLETE`/outcome events into a test TimescaleDB
    range, runs the replay tool over that range, and asserts
    `len(replay_output) == N` (or the documented qualifying subset count).
- **Given** the same event range replayed twice, **when** both runs complete,
  **then** the two outputs are byte-identical (or, if OQ-1 resolved to branch
  (b)/stochastic augmentation is documented, identical modulo the documented
  stochastic seed).
  - **Runnable check:** a determinism test runs the tool twice over the same
    fixture range and asserts `hash(output_1) == hash(output_2)`.
- **Given** a long replay range, **when** it runs, **then** progress is
  checkpointed so an interrupted replay resumes rather than restarting from
  the beginning.
  - **Runnable check:** a test kills the process mid-replay (e.g. after
    checkpoint N), restarts it, and asserts the resumed run does not
    reprocess events already checkpointed (verified via a call-count spy or
    checkpoint-file inspection).
- **Given** a completed replay, **when** it finishes, **then** it reports
  sample counts and category distributions to stdout/a report file.
  - **Runnable check:** the tool's exit output contains a `category_counts`
    (or equivalent) structure; a test asserts its keys match the known
    `action_category` values in the fixture data and counts sum to the total.
- **Non-goals:** no event-schema changes (per source); no online/continuous
  replay — offline tool only; no graduation-threshold changes; must not be
  named/placed so as to collide with the existing
  `packages/cognition-service/training/replay.py` EWC replay-buffer module
  (different concern — confirmed during verification).

### Ticket 20260702-014-c — Retrain-from-experience end-to-end: prove learning is reconstructible from events alone

- **Priority:** P2.
- **Engineering level:** production.
- **depends_on:** 20260702-014-b; existing bootstrap-ladder machinery in
  `packages/cognition-service/inference/bootstrap.py` (already live, no new
  ticket needed — confirmed `check_graduations()` exists).
- **Given** a deliberately fresh-initialized ("broken") tensor and an
  accumulated real event history, **when** retrain-from-replay runs (feeding
  014-b's output through `/cognition/train`), **then** the model is placed
  back at bootstrap ladder **shadow** stage (not silently carried over at
  whatever stage it was at) and must re-earn graduation per category via the
  existing gate.
  - **Runnable check:** an integration test/script asserts the
    cognition-service's `/cognition/control/state` (or equivalent) reports
    `bootstrap_mode == "shadow"` and an empty/reset `_graduated_categories`
    immediately after the retrained model is loaded, before any new
    agreement samples are recorded.
- **Given** that retrained model continuing to run against replayed history,
  **when** enough samples accumulate for the most-populated action category,
  **then** it reaches at least audit-stage agreement for that category (per
  the existing `check_graduations()` threshold, currently 0.85 per-category —
  confirmed at `bootstrap.py:50`).
  - **Runnable check:** the same integration script asserts
    `tracker.check_graduations()` (or the live equivalent endpoint) reports
    the most-populated category has crossed into at least the audit stage
    within the test run, using either real accumulated history or a
    documented, sufically-large synthetic-but-realistic fixture set.
- **Non-goals:** no graduation-threshold changes (uses the existing 0.85 /
  demotion-0.70 thresholds as-is); no new modalities; not a substitute for
  the coordinated Sylphie Snapshot (item 016) — this ticket runs against
  live/restored TimescaleDB history, it does not itself snapshot or restore
  anything.

## CANON check

- **Drive isolation:** replay reads TimescaleDB (event backbone) and feeds
  `/cognition/train` — the existing push path into cognition-service, not a
  new pull/RPC into the drive process. No new drive-process surface is
  touched. Clean.
- **Provenance-required:** every reconstructed sample must carry which event
  range/replay run produced it (so a retrained model's provenance is
  traceable back to real history, not synthetic data) — this should be an
  explicit field on the replay tool's output, called out in 014-b's build
  (added as an implementation note, not a new acceptance criterion, since the
  source doesn't ask for a new event/label field beyond what training already
  requires).
- **Confidence ceiling / guardian asymmetry / theater / no self-modification
  of evaluation:** the retrained model re-enters the bootstrap ladder at
  shadow and must re-earn graduation through the *existing, unmodified* gate
  (014-c's design) — this is the correct way to respect "no self-modification
  of evaluation": retraining does not get to skip or loosen the gate that
  judges it.

## Routing recommendation: replan

OQ-1 is a real architectural fork discovered during verification, not a
convenience question — it changes what "regenerates labeled training
samples" can honestly mean and materially changes ticket 014-b/014-c's scope
and their acceptance criteria's achievability. Per the pipeline's own rule
("ambiguity routes to replan with the question written down — never
guessed"), this item should go to **replan** so `architect` rules on OQ-1
before the tickets above are finalized and queued. The ticket bodies above are
written so that whichever branch architect picks, only 014-b/014-c's exact
acceptance wording needs adjusting — 014-a and the overall epic shape do not
change.
