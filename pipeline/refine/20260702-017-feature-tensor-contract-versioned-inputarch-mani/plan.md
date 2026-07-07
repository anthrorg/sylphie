# Plan — 20260702-017: Tensor contract (versioned input/arch manifest + fusion-slot registry)

## Source verification (claims checked against the actual codebase)

Source.md's problem statement is **accurate and the risk is real and currently live** —
verified directly in code, not assumed:

- **`GlobalModel.load()` (`packages/cognition-service/models/global_model.py:271-321`)
  has zero version checking today.** On any exception (including a shape mismatch from
  a stale/incompatible checkpoint) it logs a warning and silently keeps the
  Xavier-initialized weights (`except Exception as e: logger.warning(...); return False`,
  lines 316-321) — the exact "confident garbage" failure mode source.md describes. No
  manifest, no version stamp, no refusal path exists anywhere in the load call chain
  (confirmed via grep across `training/`, `models/`, `main.py` — zero hits for
  `tensor_manifest`, `checkpoint_version`, or any `Fisher` persistence).
- **`EWCRegularizer` (`training/replay.py:82-...`) has NO save/load at all.** `_fisher`,
  `_reference`, `_phase_fisher` are pure in-memory NumPy attributes with no persistence
  path. "Fisher anchors bound to weights" is genuinely greenfield — there is nothing on
  disk to bind today.
- **The Python-side global-input layout is a hardcoded literal, not a registry.**
  `CognitiveCycle._assemble_global_input()` (`inference/cycle.py:176-198`) concatenates
  `[fused_embedding(768), drive_vector(12), drive_deltas(12), total_pressure(1),
  episodic_context(768)] = 1561`, documented only in a docstring comment — nothing
  mechanically stops a future edit from silently reordering `parts`. A complementary
  round-trip test already exists (`training/tests/test_global_input_surface.py`) that
  would catch `_assemble_global_input`/`main._split_input_vector` drifting out of sync
  with *each other*, but it does **not** catch the code drifting out of sync with an
  **already-trained checkpoint** — that's exactly this ticket's job.
- **Correction to source.md's scope hints — the fusion-slot registry does not live in
  `packages/shared`.** It lives in `packages/decision-making/src/inputs/registry/
  modality-registry.service.ts` + `.../fusion/sensory-fusion.ts`. `packages/shared` only
  holds the `SensoryFrame` *type* and `EMBEDDING_VERSION` (already a versioned constant,
  currently 3, per `packages/shared/src/types/sensory-frame.ts:41`). This matters for
  ownership: per CLAUDE.md's work-trio table, `packages/decision-making/**` is owned by
  **`cortex`** (conceptual reviewer `luria`), not `forge`/`meridian` as source.md's scope
  hints imply.
- **New finding beyond what source.md flagged — the current TS registry order is
  ALPHABETICAL, not fixed, and this already contradicts the very invariant this feature
  is supposed to enforce.** `ModalityRegistryService.getAll()`
  (`modality-registry.service.ts:28-32`) does
  `[...this.encoders.values()].sort((a,b) => a.modalityName.localeCompare(b.modalityName))`,
  and `SensoryFusionService.concatAndProject()` derives every modality's concat offset
  directly from that alphabetical order (comment at `sensory-fusion.ts:178-179`:
  *"registry order is ALPHABETICAL — the concat offset for every modality is DERIVED
  from modalityOrder, never a literal"*). Registering one new modality whose name sorts
  before an existing one (e.g. adding `audio` when `drives` is already registered) would
  silently shift every later modality's slot **today, with no tensor-contract ticket
  needed to trigger it** — this is a live landmine independent of, but squarely inside,
  what this feature must fix.
- **Dependency claims verified against `docs/future/sylphie-persistence-migration-plan.md`
  §7 build order**: item 1 = snapshot+restore (pipeline item `20260702-016`), item 2 =
  schema versioning (`20260702-015`), item 3 = **this item** (tensor contract), item 4 =
  migration framework, item 5 = replay-from-events (`20260702-014`). Source.md's stated
  dependencies match this doc exactly. **None of 016/015/014 have landed in
  `planning/contract.yaml` yet** — all three are still sitting in `pipeline/planning/`
  themselves (unplanned). `bug-audit-cognition-sidecar` (`20260702-002`) is further along:
  it is in `pipeline/working/` as `EP-23`/`TK-119..122`, mid-build (tiered workflow
  `wf_02dd585c`), touching `main.py` and `training/trainer.py` — the same files this
  item's load-path changes need. Source.md's "sequence AFTER" note is correct and current.
- **DB impact claim confirmed correct.** Checkpoints (`global_model.weights.h5` /
  `*_np.npz`) and the proposed `tensor_manifest.json` are plain files under
  `config.WEIGHTS_DIR`/`config.FOUNDATION_DIR` (`packages/cognition-service/config.py:23-24`).
  No Postgres/Timescale/Neo4j surface is touched. `docs/future/...plan.md §5` invariant #5
  (tensor contract match) is itself explicitly listed as a *consumer* of this ticket's
  checks, not a blocker on this ticket — 015's own non-goals say "No tensor-shape handling
  (separate feature)", confirming the dependency direction is: 015's invariant #5 will
  call into what this ticket builds, not the reverse. The literal "depends on
  feature-schema-versioning" in source.md is best read as *sequencing* (015 lands first
  per the build-order doc, and this ticket's checks should be written so 015 can wrap
  them later), not a hard code dependency — noted, not treated as a blocker.

**No fiction found.** Source.md's acceptance criteria and design (three version axes,
fusion-slot registry, continue/expand/retrain-from-experience strategies, Fisher binding)
are all buildable against real, located code paths.

## Existing contract.yaml overlap

Searched `planning/contract.yaml` for `tensor_manifest`, `fusion.slot`, `snapshot-restore`,
`schema-versioning`, `EWC`/Fisher persistence, and `cognition-service` file paths.
**No existing epic or ticket covers tensor-manifest versioning, the fusion-slot registry,
or Fisher persistence.** The only contract nodes touching the same files are from
unrelated, already-in-flight work on `20260702-002` (`EP-23`, `TK-119`, `TK-120`, `TK-121`,
`TK-122` — the dead-sidecar bug fix) and older convergence/bootstrap tickets (e.g. the
`TK-` cluster around `models/convergence.py`, `inference/bootstrap.py` demotion threshold).
None of these implement versioning, manifests, or Fisher persistence — they are safe to
build on top of once `EP-23` merges, per source.md's own sequencing note.

**No existing epic to attach to. This item needs a new epic.**

## Proposed epic

**Working id:** `20260702-017` → propose `EP-<next>: Tensor contract — versioned
input/arch manifest + fusion-slot registry`
**Priority:** P1 (source's own argued case: a silently mis-loaded checkpoint corrupts
training data covertly, is worse than a hard failure, and blocks the entire tensor
graduation story — treated as a correctness/data-integrity issue, not a plain feature ask)
**Engineering level:** production
**Sequencing (hard):** land `20260702-017-a` any time (self-contained TS change). Land
`20260702-017-b` through `-e` only after `bug-audit-cognition-sidecar` (`20260702-002` /
`EP-23`/`TK-119..122`) merges — same files (`main.py`, `training/trainer.py`), source.md's
own stated reason. `20260702-016` (snapshot-restore) and `20260702-015` (schema
versioning) do not block this item's code (confirmed above — no code dependency, only a
doc-level build-order preference); if either lands first, `-b`'s manifest path should be
re-checked against whatever snapshot-directory convention `016` establishes, but that is a
small path-config change, not a redesign.

### Ticket `20260702-017-a` — Fixed-order, versioned fusion-slot registry (TS)

**Files:** `packages/decision-making/src/inputs/registry/modality-registry.service.ts`,
`packages/decision-making/src/inputs/fusion/sensory-fusion.ts`,
`packages/decision-making/package.json` (add a `"test": "jest"` script — mirrors
`packages/shared/package.json:12`; currently missing so the existing `jest.config.js` /
`bounded-fusion.spec.ts` have no yarn-script runnable entry point, violating the repo's
"use package scripts" convention).
**Owner:** `cortex` (domain expert) · **Conceptual reviewer:** `luria` · **Code reviewer:**
`code-reviewer`. (Corrects source.md's scope hint, which named `forge`/`packages/shared`.)
**Priority:** P1 · **Engineering level:** production
**depends_on:** none

Given/When/Then (every criterion has a runnable check):

1. Given the modality set registered today, when `ModalityRegistryService` initializes,
   then modality order is read from a new explicit, exported `FUSION_SLOT_ORDER: readonly
   string[]` constant (not `Array.prototype.sort`), and the resulting concat layout is
   byte-identical to today's alphabetical output for the current modality set.
   **Check:** a new `modality-registry.spec.ts` test captures
   `SensoryFusionService`'s `fuse()` output for a fixed synthetic input against the
   current code, then asserts identical output after the change
   (`yarn workspace @sylphie/decision-making test`, added `"test": "jest"` script).
2. Given a newly-registered modality not yet in `FUSION_SLOT_ORDER`, when it calls
   `register()`, then the registry throws a named error (`UnregisteredFusionSlotError`)
   rather than silently appending it in registration order — a new modality slot is an
   explicit, reviewed edit to `FUSION_SLOT_ORDER`, never automatic.
   **Check:** `modality-registry.spec.ts` registers a fake encoder with a name absent
   from `FUSION_SLOT_ORDER` and asserts the throw (`yarn workspace @sylphie/decision-making
   test`).
3. Given an edit that removes or reorders an existing entry already present in a
   **previously recorded** `FUSION_SLOT_ORDER` snapshot, when the module loads, then a
   module-load-time assertion throws rather than silently accepting the new order.
   **Check:** `modality-registry.spec.ts` mutates a copy of the order array (swap two
   existing entries) and asserts the guard function used at load time throws
   (`yarn workspace @sylphie/decision-making test`).
4. Given `FUSION_REGISTRY_VERSION` (new exported constant, starts at `1`), when it is
   bumped, then a code comment/test documents that bumping it is the ONLY sanctioned way
   to add a new fusion slot, and existing slots' indices are provably unchanged by the
   bump (regression test extends #1's byte-identical assertion).
   **Check:** same `modality-registry.spec.ts` suite (`yarn workspace @sylphie/decision-making
   test`).

**Non-goals:** no new modality added; no change to `MODALITY_FUSION_SCALES` or
`EMBEDDING_DIM`; no change to encoder implementations; does not touch
`packages/cognition-service`.

### Ticket `20260702-017-b` — Tensor manifest + version constants (Python)

**Files:** new `packages/cognition-service/tensor_contract.py`, `config.py` (add
`INPUT_CONTRACT_VERSION`, `ARCH_VERSION` constants), `inference/cycle.py` (`save_checkpoint`
writes the manifest).
**Owner:** `meridian` · **Conceptual reviewer:** `ashby` · **Code reviewer:** `code-reviewer`
**Priority:** P1 · **Engineering level:** production
**depends_on:** `20260702-017-a` (for `FUSION_REGISTRY_VERSION`, which feeds
`INPUT_CONTRACT_VERSION`'s composition — see below), and `20260702-002`/`EP-23` merge
(shares `main.py`/`trainer.py` region per source.md's stated sequencing).

1. Given `CognitiveCycle.save_checkpoint()` runs, when it completes, then
   `tensor_manifest.json` is written/updated alongside the checkpoint directory containing
   `input_contract_version` (composed from `packages/shared`'s `EMBEDDING_VERSION` +
   `FUSION_REGISTRY_VERSION` + a Python-side `MACRO_LAYOUT_VERSION` for the 5-slot
   `_assemble_global_input` order), `arch_version` (`config.ARCH_VERSION`), and a
   structural fingerprint of the macro-slot field-name order.
   **Check:** `packages/cognition-service/training/tests/test_tensor_manifest.py::
   test_save_checkpoint_writes_manifest` — calls `save_checkpoint()` in a temp dir, asserts
   `tensor_manifest.json` exists and `json.load()` has the three keys with expected types.
   Run: `cd packages/cognition-service && .venv/Scripts/python -m pytest
   training/tests/test_tensor_manifest.py -v`.
2. Given two saves in a row with no code change, when both manifests are compared, then
   `input_contract_version`, `arch_version`, and the fingerprint are identical
   (deterministic, not timestamp-dependent for the version fields).
   **Check:** same test file, `test_manifest_versions_stable_across_saves`.
3. Given the manifest schema, when written, then it separates the three axes
   (input-contract, arch, weights identity/timestamp) into distinct top-level keys —
   never a single blob — matching source.md's "three version axes separated" requirement.
   **Check:** same test file, `test_manifest_has_three_separated_axes`.

**Non-goals:** does not yet refuse any load (that's `-c`); does not touch Fisher (`-d`);
does not implement `expand` (`-e`); does not add a `snapshot/` directory redesign (that's
`20260702-016`'s job if/when it lands — this ticket writes the manifest next to the
existing flat `config.WEIGHTS_DIR/<model>/` layout).

### Ticket `20260702-017-c` — Boot-time contract-mismatch refusal (Python)

**Files:** `tensor_contract.py`, `inference/cycle.py` (`CognitiveCycle.__init__`),
`models/global_model.py` (`load()`), `models/panel_models.py` (`load()`), `main.py`
(`/cognition/control/rollback`).
**Owner:** `meridian` · **Conceptual reviewer:** `ashby` · **Code reviewer:** `code-reviewer`
**Priority:** P1 · **Engineering level:** production
**depends_on:** `20260702-017-b`

1. Given a checkpoint directory whose `tensor_manifest.json` `arch_version` differs from
   the running code's `config.ARCH_VERSION`, when `CognitiveCycle()` constructs, then it
   raises `TensorContractMismatchError` naming the specific mismatched field and value, and
   does **not** fall through to Xavier-initialized weights.
   **Check:** `training/tests/test_tensor_contract_boot.py::
   test_arch_version_mismatch_refuses_load` — writes a manifest with a stale
   `arch_version`, asserts `pytest.raises(TensorContractMismatchError)`. Run: `cd
   packages/cognition-service && .venv/Scripts/python -m pytest
   training/tests/test_tensor_contract_boot.py -v`.
2. Given a checkpoint whose macro-slot structural fingerprint (from `-b`) does not match
   the running code's live fingerprint of `_assemble_global_input`'s field order — even
   if a human forgot to bump `arch_version` — then load is still refused (the mechanical
   guard does not rely solely on a manually-maintained integer).
   **Check:** same test file, `test_structural_fingerprint_drift_refuses_load_even_without_
   version_bump`.
3. Given a checkpoint directory with **no** `tensor_manifest.json` at all (every checkpoint
   that predates this ticket, including the currently-running production one), when
   loading, then it is treated as `"unstamped-legacy"`, a loud one-time warning is logged,
   the checkpoint loads normally, and a manifest is written on the next save — this ticket
   must not brick the live deployment on its own rollout.
   **Check:** same test file, `test_legacy_checkpoint_without_manifest_loads_with_warning`.
4. Given `GlobalModel.load()`'s existing broad `except Exception` fallback (line
   316-321 today), when any tensor-contract-specific exception is raised inside the try
   block, then it propagates (is not swallowed into the generic warning-and-keep-init-
   weights path) — closing the exact silent-reinit hole this ticket exists to fix. (CANON
   theater-prohibition tie-in: a service that "looks loaded" while secretly running fresh
   random weights is exactly the theater this closes.)
   **Check:** same test file, `test_contract_mismatch_exception_not_swallowed_by_generic_
   handler`.

**Non-goals:** does not implement `expand` (weights ARE refused wholesale here, even for
an additive/appendable change — `-e` adds the controlled exception); does not implement
`retrain-from-experience` (separate feature, `20260702-014`, explicit non-goal per
source.md).

### Ticket `20260702-017-d` — Fisher-anchor persistence + binding (Python)

**Files:** `training/replay.py` (`EWCRegularizer` gains `save()`/`load()`), `tensor_contract.py`
(manifest gains a `fisher` section), `inference/cycle.py` / `training/trainer.py` (wire
Fisher save into `save_checkpoint`, load into boot).
**Owner:** `meridian` · **Conceptual reviewer:** `ashby` · **Code reviewer:** `code-reviewer`
**Priority:** P1 · **Engineering level:** production
**depends_on:** `20260702-017-c`

1. Given `EWCRegularizer.save(directory)` is called after `set_reference()` +
   `compute_fisher()` have run, when it completes, then `_fisher`, `_reference`, and the
   bootstrap stage/weights identity they were anchored against are written to disk
   (e.g. `fisher/ewc_state.npz` + a manifest `fisher` entry naming the weights checksum and
   bootstrap mode at anchor time).
   **Check:** `training/tests/test_ewc_persistence.py::test_save_then_load_restores_fisher_
   and_reference` — round-trips an `EWCRegularizer`, asserts restored `_fisher`/`_reference`
   arrays are `np.allclose` to the originals. Run: `cd packages/cognition-service &&
   .venv/Scripts/python -m pytest training/tests/test_ewc_persistence.py -v`.
2. Given a weights checkpoint whose manifest names a Fisher set that is missing on disk (or
   whose recorded weights-checksum doesn't match the checkpoint being loaded), when
   `CognitiveCycle()` loads, then load is refused with a specific error naming the missing/
   mismatched Fisher binding.
   **Check:** same test file, `test_load_refuses_when_fisher_missing_for_checkpoint`.
3. Given weights and a correctly-bound Fisher set both present and matching, when
   `CognitiveCycle()` loads, then both load successfully and `trainer.ewc._fisher` is
   non-`None` immediately after boot (no separate "warm-up" step required).
   **Check:** same test file, `test_matching_fisher_loads_successfully_and_arms_ewc`.

**Non-goals:** no change to the EWC penalty math itself (`penalty_gradients`,
`_ONLINE_GAMMA`, ramp logic) — persistence only; no change to `compute_fisher`'s
calibration-sample logic.

### Ticket `20260702-017-e` — Expand migration strategy (additive modality)

**Files:** `tensor_contract.py` (new `expand_checkpoint()` helper), `models/global_model.py`
/ `panel_models.py` (sub-tensor slice load + fresh-init new slice), `training/replay.py`
(re-anchor call), `inference/bootstrap.py` (force mode to `audit`/`shadow` for the affected
category).
**Owner:** `meridian` · **Conceptual reviewer:** `ashby` · **Code reviewer:** `code-reviewer`
**Priority:** P1 · **Engineering level:** production
**depends_on:** `20260702-017-c`, `20260702-017-d`

1. Given a checkpoint whose `input_contract_version` differs from the running code by
   exactly an **appended** fusion slot (per `-a`'s registry: existing slot indices
   unchanged, one new trailing slot added) and whose `arch_version` differs only in the
   corresponding widened input dimension, when `expand_checkpoint()` runs, then old weight
   sub-matrices load unchanged into the matching rows/columns and only the new slice is
   freshly Xavier-initialized.
   **Check:** `training/tests/test_expand_migration.py::
   test_expand_loads_old_subtensor_and_inits_only_new_slice` — builds a small
   `GlobalModel` with `input_dim=N`, saves it, constructs a second model with
   `input_dim=N+D`, runs `expand_checkpoint()`, and asserts the first `N` input rows of
   `w1` are `np.array_equal` to the original while the new `D` rows differ from the
   original's (uninitialized) state and are not all-zero. Run: `cd
   packages/cognition-service && .venv/Scripts/python -m pytest
   training/tests/test_expand_migration.py -v`.
2. Given expand runs, when it completes, then `EWCRegularizer.set_reference()` is called
   with the newly-shaped weights (re-anchoring Fisher on the new shape, per `-d`'s
   persistence) rather than silently keeping the old-shape Fisher arrays (which would
   shape-mismatch on the next `penalty_gradients()` call).
   **Check:** same test file, `test_expand_reanchors_fisher_on_new_shape`.
3. Given expand runs for a category that had already graduated to `partial`/`full`
   bootstrap mode, when it completes, then `BootstrapTracker.mode` for that category is
   forced back to no better than `audit` (never `partial`/`full`) until it re-passes the
   agreement gate — matching source.md's exact wording ("forced back to shadow/audit
   stage").
   **Check:** same test file, `test_expand_forces_bootstrap_mode_to_audit_or_shadow`.
4. Given any OTHER kind of checkpoint delta (a slot **reorder**, a slot **repurpose**, or
   a breaking arch change not explainable as "one appended trailing slot"), when
   `expand_checkpoint()` is asked to run, then it refuses and raises the same
   `TensorContractMismatchError` from `-c` rather than attempting a best-effort partial
   load — expand is the one narrow, explicit exception to `-c`'s refuse-by-default rule,
   never a general escape hatch.
   **Check:** same test file, `test_expand_refuses_on_non_additive_delta`.

**Non-goals:** `retrain-from-experience` is out of scope (separate feature,
`20260702-014`); no new modality is actually added by this ticket — it only makes a
*future* addition mechanically safe, per source.md's own non-goal.

## Split recommendation

None. All five tickets are facets of one coherent "tensor contract" concept (the three
version axes, the registry that backs the input-contract axis, and the two persistence
concerns — manifest + Fisher — that the load-time check needs). `-a` is independently
shippable and low-risk; `-b` through `-e` form a strict dependency chain because they
share the same load path. No unrelated concern is bundled in.

## DB gate

**n/a — no database surface.** Verified directly: `save_checkpoint`/`load` operate only on
`config.WEIGHTS_DIR`/`config.FOUNDATION_DIR`, plain files (`.npz`/`.h5` + the new
`tensor_manifest.json` and `fisher/*.npz`). No Postgres/Timescale/Neo4j table, migration,
or `vector(N)` dimension is touched by any of the five tickets. `pipeline.py dbcheck`'s
keyword scan may flag "migration" (used here only in the ML sense — "migration strategy",
"migration framework" — not a database migration) as a false positive; this note
pre-empts that (see the pipeline's own tracked gotcha: "keyword scan false-positives on
prose mentions of migration/postgres").

## Routing recommendation: **refine**

The plan is clean, atomic, and every acceptance criterion has a concrete runnable check
against real, located code. No design fork or ambiguity needs an architect/Jim ruling —
source.md's own dependency claims check out against the actual build-order doc, and the
one place source.md was factually wrong (fusion-slot registry file location/ownership) is
a plain correction, not a judgment call. Sequencing is handled via `depends_on` on sibling
pipeline items/contract nodes, which is normal pipeline choreography, not a blocker on
staging the tickets now.

## Open questions (non-blocking, recorded for governance, not routing to replan)

1. `input_contract_version`'s exact composition (concatenating
   `EMBEDDING_VERSION` + `FUSION_REGISTRY_VERSION` + a new `MACRO_LAYOUT_VERSION` into one
   value vs. keeping them as three separate stamped fields inside `input_contract`) is left
   to the build stage as an implementation detail — either satisfies ticket `-b`'s ACs.
   Not architect-worthy; noted so the builder doesn't treat it as undecided.
2. If `20260702-016` (snapshot-restore) lands before `-b` through `-e` are built, its
   directory-layout convention (`tensor/weights/`, `tensor/fisher/`) should be adopted for
   the manifest/Fisher paths instead of the flat `config.WEIGHTS_DIR` layout assumed here —
   a small path-config change, flagged so the builder checks contract.yaml for `016`'s
   landed epic before hardcoding paths.
