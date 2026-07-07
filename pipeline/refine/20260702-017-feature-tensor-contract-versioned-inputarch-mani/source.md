# Feature: Tensor contract — versioned input/arch manifest + fusion-slot registry

**Priority:** P1  ·  **Engineering level:** production
**Area / component:** cognition-service / tensor persistence

## Why (required)
The tensor is the one store where "the schema" includes the shape of the model itself. A
careless code change (adding a modality, resizing a panel) silently invalidates thousands
of training steps — and a silently mis-loaded checkpoint is worse than none, because it
produces confident garbage and poisons graduation. The fusion projection `W` is the single
most schema-sensitive object in the system: every input, including drives, feeds through
it, so reordering modalities invalidates every downstream weight. This contract must exist
**before** the next modality addition or architecture change, not after.

## What it should do (required)
- **Three version axes separated** and recorded in `tensor_manifest.json`: input contract
  (fused `SensoryFrame` schema version), architecture version, and weights. The
  cognition-service **refuses to load** weights whose contract/arch versions don't match
  the running code — fail loud on mismatch.
- **Fusion-slot registry:** the fusion input layout is a versioned, ordered registry with
  fixed slot indices per modality. Appending a new modality at a new slot is allowed (old
  slots keep meaning; expand the projection by initializing only the new slice).
  Reordering or repurposing an existing slot without a full retrain is **forbidden and
  mechanically prevented**.
- **Migration strategies encoded:** *continue* (versions match → load and keep training);
  *expand* (additive change → load old weights into the matching sub-tensor, init only the
  new slice, **re-anchor EWC Fisher** on the new shape, and force a shadow-audit period —
  an expanded model may not act until it re-passes the agreement gate); *retrain-from-
  experience* (breaking change → regenerate from the event log; see
  feature-replay-from-events).
- **Fisher anchors bound to weights:** the manifest ties each Fisher set to the exact
  weights and bootstrap stage it was computed against; loading weights without matching
  Fisher is refused.

## Scope hints
`packages/cognition-service/**` (owner: `meridian`, conceptual reviewer `ashby`); the
modality-fusion layer and `SensoryFrame` type in `packages/shared` (`forge` consult);
checkpoint save/load paths. Ties into the snapshot layout (`tensor/weights/`,
`tensor/fisher/`, `tensor_manifest.json`).

## Dependencies (required)
Depends on **feature-snapshot-restore** (tensor snapshot layout) and
**feature-schema-versioning** (invariant #5 hooks into these checks). Must land **before**
any feature that adds a modality or resizes the tensor. Sequence AFTER
**bug-audit-cognition-sidecar** — it rewrites the same cognition-service files
(`main.py`, `trainer.py`, the inference adapter contract) and the sidecar must be alive
before a load-time contract check is meaningful. Conflict risk: shares cognition-service
checkpoint code with feature-replay-from-events — sequence them.

## Database impact (required)
**Touches a database / schema / migration?** no
Tensor checkpoints and manifests are files, not database stores. (The event log is read
only in the retrain path, which is a separate feature.)

## Acceptance — how we'll know it works (required)
1. Given a checkpoint whose input-contract or arch version differs from the running code,
   when the cognition-service starts, then it refuses to load the weights with a specific
   mismatch error and does not fall back to silent re-init.
2. Given an appended modality (new slot), when expand runs, then old slots load into the
   matching sub-tensor, only the new slice is fresh-initialized, Fisher is re-anchored,
   and the model is forced back to shadow/audit stage for that expansion.
3. Given an attempt to reorder or repurpose an existing fusion slot, then the registry
   check fails the build/boot — it is not possible to load weights across a reorder.
4. Given weights without their matching Fisher set, when loading, then load is refused.

## Non-goals / scope guard (required)
No new modalities added as part of this work (the registry just makes them safe later).
No changes to training logic or the bootstrap ladder thresholds. No replay tooling
(separate feature).

## Source / references
`docs/future/sylphie-persistence-migration-plan.md` §4 (§4.1–§4.4), §7 (build order
item 3).
