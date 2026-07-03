# Trim docket — spreading-activation engine + perception THEATER rows

**Scope:** `packages/perception-service/cobeing/layer3_knowledge/spreading_activation.py`
(primary target) plus, as narrow additions once the primary target closed quickly, the two
other perception-service rows flagged THEATER in `sylphie-feature-inventory.md`: tracker
env config (§ "Tracker config via env") and face-detection confidence (§ "Face detection
confidence").
**Commit:** `228df73` **Date:** 2026-07-02
**Total scope LOC:** ~1,090 (`spreading_activation.py`, the whole file) + ~41 LOC
(`TrackingConfig` class + the hardcoded `IoUTracker(...)` call site) + ~9 LOC
(`FaceDetectionConfig.confidence_threshold` + the fabrication line) = **~1,140 LOC directly
implicated**, inside three files whose combined size is 2,768 LOC (`spreading_activation.py`
1,090 + `face_detector.py` 318 + `main.py` 1,401 + `config.py` 529 minus double count — the
charged surfaces are narrow cuts through much larger, genuinely-live files).
**Summary ratio — scope LOC vs. gate-proven behaviors in scope:** 1,140 : 0. Nothing in this
docket is currently exercised by any test or gate. One candidate (spreading_activation.py)
is *deliberately* ungated (parked reference spec); the other two are gated in intent only —
pipeline item 20260702-007 states acceptance criteria for them but no test yet asserts real
per-detection confidence or config-driven tracker construction.

---

## Charges

### 1. Tracker config via env (`COBEING_PERCEPTION_TRACKING__*`)

- **What it is:** `packages/perception-service/cobeing/layer2_perception/config.py:131-166`
  (`TrackingConfig` — `iou_threshold`, `max_lost_frames`, `min_confirm_frames`, each a
  pydantic `Field` bound to `COBEING_PERCEPTION_TRACKING__*` env vars) and the consumption
  site `packages/perception-service/main.py:376-380`, which constructs
  `IoUTracker(iou_threshold=0.3, min_confirm_frames=3, max_lost_frames=15)` with **literal
  constants**, never reading `cfg.tracking`. Weight: ~41 LOC, 3 env-bound fields, 1 call
  site; no DB surface.
- **Charge: FIX-BY-DATE-OR-DELETE.**
- **Evidence:** `config.py:131-166` defines and validates the three fields (pydantic
  `Field(ge=..., le=...)`, real validation runs on every boot). `main.py:376-380`
  hardcodes the three values the config class exists to hold. Repo-wide grep for
  `cfg.tracking` / `config.tracking` turns up exactly one other hit —
  `config.py:33`, a **docstring example** (`print(config.tracking.iou_threshold)  # 0.3`)
  — confirming there is no live consumer anywhere. An operator can set any
  `COBEING_PERCEPTION_TRACKING__*` var, watch it validate successfully at boot, and it will
  have zero runtime effect. This is textbook theater (validates, does nothing) — not
  DEAD code (the class *is* imported/instantiated as part of `AppConfig`), which is why the
  mechanical DEAD rule doesn't apply, but the THEATER rule does.
- **Deletion risk:** Honest assessment — the "delete" branch of this charge means removing
  `TrackingConfig`'s three fields and their env bindings (collapsing back to the literal
  constants already in `main.py`), which is low-risk and mechanical. The "fix" branch (wire
  `cfg.tracking` into the `IoUTracker(...)` call) is *also* low-risk and is the outcome
  Jim's own bug report already specifies — deleting the surface would be the wrong call
  while that fix is live-scoped work, not a hypothetical.
- **Pipeline impact: STAY 20260702-007.** `pipeline/planning/20260702-007-bug-perception-service-fabricated-face-confidenc/source.md:10,18,26,39` names this exact gap ("Tracker config knobs are silently dead... every `COBEING_PERCEPTION_TRACKING__*` env var validates and does nothing") with an explicit acceptance criterion ("Given `COBEING_PERCEPTION_TRACKING__MIN_CONFIRM_FRAMES` (etc.) set, when the tracker is constructed, then it uses the configured value (unit test)"). The item is in pipeline state `planning` (ingested 2026-07-02, no `plan.md` yet — weaker than a queued ticket, but the acceptance criteria are already concrete, not vague). No `planning/contract.yaml` ticket references it yet. **Recommendation to the judge:** stay the delete/fix call on this item's disposition rather than have this docket duplicate it; if it stalls past a reasonable date, the FIX-BY-DATE-OR-DELETE charge should convert to an actual DELETE (collapse `TrackingConfig` back to constants) rather than let the false affordance sit indefinitely.

### 2. Face detection confidence

- **What it is:** `packages/perception-service/cobeing/layer2_perception/face_detector.py:256-258`
  — the comment reads "Estimate confidence from the first blendshape category or fall back
  to the config threshold," but the code only does the fallback:
  `confidence = self._config.confidence_threshold`. That default is
  `config.py:183-188` (`FaceDetectionConfig.confidence_threshold`, default `0.5`). Every
  face reported by this detector carries the identical constant 0.5, regardless of actual
  detection quality. Weight: ~9 LOC directly implicated, but the blast radius is a whole
  downstream feature (see below).
- **Charge: FIX-BY-DATE-OR-DELETE.**
- **Evidence:** Confirmed by direct read — `face_detector.py:256-258` has no blendshape-based
  confidence computation despite the comment claiming one; `blendshapes` is extracted
  separately (lines 260-266) and never consulted for `confidence`. Downstream, the sole
  consumer `apps/sylphie/src/services/face-snapshot.service.ts:101,316` gates crop
  collection on `MIN_CONFIDENCE=0.65`. Since `0.5 < 0.65` unconditionally, this silently
  zeroes face-snapshot enrollment on every single frame, with no error or log — the
  textbook definition of theater (a hardcoded value presented as a real model output that
  disables a downstream feature without surfacing the failure).
- **Deletion risk:** The "delete" branch here would mean removing the `confidence` field or
  the fallback entirely, which would either break the `FaceDetection` type contract or
  require the consumer's gate to be re-derived — worse than the status quo, not better. The
  real fix (derive confidence from the blendshape score or MediaPipe's own detection
  confidence) is the only branch that actually recovers value; a straight deletion here is
  not a live option, which is exactly why this charge is FIX-BY-DATE-OR-DELETE rather than
  a candidate for the judge to simply kill.
- **Pipeline impact: STAY 20260702-007.** Same item as charge 1 —
  `pipeline/planning/20260702-007-bug-perception-service-fabricated-face-confidenc/source.md:8,17,24,38`
  names this exact defect ("Fabricated face confidence disables enrollment (theater)")
  as the item's own highest-priority bullet ("The face-confidence fix is the highest-value
  one: it silently disables an entire enrollment feature today," line 47). Same caveat as
  above: `planning` state, acceptance criteria present, no ticket yet.

## Acquittal

### `packages/perception-service/cobeing/layer3_knowledge/spreading_activation.py` (the primary scope target)

- **Charge: ACQUITTED.** This was the primary target of the pass; it is acquitted, not
  deleted, on explicit prior ruling — not on my own discretion.
- **Reachability (self-verified, not just trusted from the inventory):** grepped the whole
  repo for `spreading_activation` / `SpreadingActivation` — the only non-doc/non-wiki hits
  outside the file itself are `packages/decision-making/src/working-memory/activation.ts`
  (a **live TypeScript file**, not a caller — it references the Python file only in a
  comment aligning constants) and the file's own internal references. `main.py` — the sole
  FastAPI entrypoint for `perception-service` — imports only from `cobeing.layer2_perception`
  and never imports `cobeing.layer3_knowledge` (grepped `main.py` directly, zero hits for
  `layer3_knowledge`). No test under `packages/perception-service/tests/` imports
  `spreading_activation` (grepped the whole `tests/` tree, zero hits). Read the file in full
  (1,090 lines): it is a complete, internally-consistent four-layer spreading-activation
  engine (`SpreadingActivationEngine`, `SessionActivationMap`, bootstrap/persistence
  helpers) with zero live callers anywhere in first-party code. Module-dead at runtime,
  confirmed independently of the inventory row.
- **Why it is NOT charged despite being DEAD-flagged twice:** `docs/decisions/architect-log.yaml`
  **AD-0013** (2026-06-16, status `accepted`) rules explicitly: *"Keep the file as the
  Phase-3 reference spec; do NOT delete. Bind its fate to the existing multi-hop deferral
  DEF-2."* `planning/contract.yaml:5981-5983` records this as governance deferral **DEF-4**
  (`converted_from: Q-3`, scope `FEAT-1`), sharing DEF-2's `revisit_trigger`: retire only if
  multi-hop is permanently abandoned. `docs/audits/dead-code.md:67-72` (an earlier trim/dead-code
  pass, commit `5aa7821`) independently re-confirmed the same finding and the same
  disposition: *"DELIBERATE Phase-3 reference spec... No drift — entry remains correct."*
  `docs/future/codebase-audit-remediation.md:130-131` lists it under **"What's already
  coherent (don't 'fix' these)."** And the newest pipeline item itself
  (`pipeline/planning/20260702-007-.../source.md:48`) states as an explicit non-goal:
  *"wiring the dead layer3 spreading-activation engine (separate architectural decision —
  leave as labeled Phase-3 reference spec per stub-inventory §2.9)."* Four independent
  surfaces (an accepted architect decision, a contract governance deferral, a prior
  dead-code audit, and the newest bug report's own non-goals list) all converge on KEEP.
  This is squarely the charter's "Anything Jim has explicitly ruled kept" exclusion — a
  domain expert (Fable `architect`) has already ruled, on the record, with rationale (it is
  the design reference `activation.ts:12` aligns its live constants to, and deleting it would
  orphan that reference while discarding a specialist-reviewed design for parked work).
  Occam does not re-litigate a standing architect ruling; it surfaces that the ruling exists
  and still holds at current HEAD.
- **Companion-file check:** none found. Everything `spreading_activation.py` imports
  (`node_types`, `protocols`, `semantic_query.MIN_CONFIDENCE_FLOOR`, `shared.provenance`,
  `shared.types`) is genuinely shared infrastructure consumed by dozens of other
  `layer3_knowledge` modules — nothing in the package exists solely to serve this file, so
  there is no "exists solely to serve it" companion to charge alongside it.
- **Pipeline impact: STAY DEF-4 / DEF-2.** The file's continued existence is the explicit
  subject of an accepted deferral, not merely unreferenced by one. No pull is needed —
  nothing is being deleted.

---

## Handoff

Docket ready for architect ruling. Kills that survive judgment need plan nodes before
execution. In this pass there are no clean DELETE verdicts: the primary target is acquitted
by a standing architect decision (AD-0013 / DEF-4), and the two secondary THEATER rows are
both already the explicit subject of a live pipeline bug item (20260702-007) with concrete
acceptance criteria — the honest disposition is FIX-BY-DATE-OR-DELETE, staying on that
item's outcome rather than duplicating it. This is a lean docket by design: the scope named
in the task was mostly settled ground, and occam's job here was to confirm the settlement
still holds at HEAD (it does) rather than manufacture charges to fill a docket.

---

## Charter feedback (smoke-test findings — occam.md, first live run)

1. **Mechanical rule vs. explicit-keep exclusion has no stated precedence, and they
   collide on this exact file.** § "Mechanical rules (no discretion)" says "Flagged DEAD in
   two consecutive trim/audit passes → automatic docket entry as DELETE" with no
   discretion. `spreading_activation.py` *is* flagged DEAD twice (dead-code.md at 5aa7821,
   and the feature-inventory row "unchanged since 2026-06-13"). § "What you may never
   charge" says explicitly-ruled-kept items are off the table. The charter never says which
   wins. I resolved it in favor of the explicit-keep ruling (a specific, reasoned,
   evidenced architect decision should outrank a generic two-strikes mechanical trigger),
   but a fresh occam run without this note could just as validly auto-DELETE it per the
   mechanical rule and be "following the charter exactly." Recommend the charter state the
   precedence outright: explicit-keep rulings always override the mechanical DEAD-twice
   rule, since a mechanical trigger cannot know it is re-litigating a decision.

2. **"Anything that exists solely to serve it" needs a definition of "solely."** The charter
   scope note (from the calling task, mirroring how occam would be briefed generally) asks
   for companion files that exist "solely to serve" the primary candidate. In practice this
   required tracing every import in the target file and checking each import's *other*
   consumers across the whole `layer3_knowledge` package (75 modules) — doable here because
   the imports were few, but the charter gives no guidance on how deep to chase this
   (one hop? transitive closure?) before concluding "shared, not solely-serving." Worth a
   one-line clarification: one-hop import check is sufficient, deeper transitive checks are
   at the prosecutor's discretion for genuinely load-bearing calls.

3. **THEATER charges that are structurally undeletable strain the DELETE-shaped docket
   template.** Both secondary charges here (tracker config, face confidence) are THEATER
   rows where the honest "delete" branch is actively harmful (deleting the confidence field
   breaks the type contract; deleting the config knobs regresses documented intent) — the
   only real remedy is FIX. The charter already anticipates this with FIX-BY-DATE-OR-DELETE
   as a verdict, which worked fine, but the **"Deletion risk"** field name reads oddly for a
   charge where nobody is proposing deletion as the live branch. Not a blocker — the field
   still had useful content once reframed as "risk of each branch" — but a rename ("Risk /
   downside" or splitting into "Fix risk" / "Delete risk") would fit THEATER charges more
   naturally than "Deletion risk" alone, since occam is chartered to touch DEAD/THEATER/STUB
   rows generically, not just clean-DELETE dead code.

4. **The future-work cross-check surfaces genuinely improved this docket** — pipeline item
   20260702-007 (ingested the same day as this run, 2026-07-02) would have been invisible
   without the mandatory `pipeline.py list` + per-item `source.md` read, and it is the exact
   thing that turns both secondary charges from "orphan theater, charge DELETE" into
   "actively-scoped fix, STAY." No complaint here — flagging that this step earned its
   mandatory status on the very first live run.

5. **No friction with the "never charge" CANON-machinery exclusion** on this scope — none of
   the three candidates touch CANON enforcement, so that rule wasn't exercised this pass.
   Noting only that it remains untested by this smoke run; a future pass touching
   `packages/decision-making/src/wkg` or similar would be a better test of that exclusion.
