# Feature: Executor tension — tensor graduation over an immutable floor, stakes(), veto, and the Guilt drive

**Priority:** P1  ·  **Engineering level:** prototype (veto + floor integrity: production)
**Area / component:** decision-making / drive-engine / cognition-service

## Why (required)
The hardcoded executor (`ACTION_TYPE_DEFAULTS` + rule engine) is a permanent floor, not
training scaffolding. A tensor head should learn to act *on top of* it — personality
becomes learned, ethics stay built-in — while the deterministic executor keeps computing
"what I would have done" every cycle, forever. The divergence between them is also the
missing source signal for the already-declared, currently-undriven **Guilt** drive: the
first reflexive drive (the system feeling something about its own choice against its own
standard). An agent that *can* transgress but *cannot do so silently* is categorically
different from one that can't transgress or one that transgresses without registering it.

## What it should do (required)
- **Three-layer ordering:** LLM (novel edge) → tensor (learned policy) → executor floor
  (immutable spine; outranks both on safety).
- **`stakes(action, driveState)` — the keystone function.** Deterministic, explicit
  definition of what makes an action value-laden. Low stakes (exploration, phrasing) →
  wide divergence tolerance; high stakes (irreversible effects, strong-negative-drive
  territory) → near-zero tolerance. It gates both veto tolerance and guilt weight.
  **Airtight before build — `architect` must sign off the definition.**
- **The veto — deterministic, immutable, tensor-blind.** Every cycle: "would the executor
  ever select this action at these drives?" — a pure function of the hardcoded rules +
  current drive vector, taking zero tensor input. Outside the floor → executor reasserts,
  event logged as premium training signal. Veto logic is write-protected with the same
  immutability as CANON Std-6 (checksum-verified at boot — ties to
  feature-schema-versioning invariant #6).
- **Graduation per stakes-tier** via the existing bootstrap ladder: shadow → audit →
  partial (acts only where agreement ≥85% and floor doesn't veto; confidence capped 0.79)
  → full (executor shadows in reverse, interrupts on veto). Low-stakes classes graduate
  first; high-stakes last or never.
- **Guilt drive wiring:** accrual at action time =
  `divergence_magnitude × stakes(action, driveState)` (agreement → 0; low-stakes
  divergence → ~0). Resolution at outcome time, riding the existing predicted-vs-actual
  drive-delta (MAE) evaluation: punished transgression → guilt locks in + rule
  strengthened; vindicated → guilt mostly discharges (small decaying residual) + rule
  slightly loosened for that class (vindicated guilt IS how a category earns graduation).
  Guilt must be **sparse and stakes-gated** — silent on trivia. Unresolvable guilt
  correctly trips the existing Depressive Attractor; no new monitor.
- Divergence/veto/guilt counters surface in the snapshot metrics block
  (`guilt_events`, `guilt_resolved_vindicated/punished`, `floor_vetoes`).

## Scope hints
`packages/decision-making/**` executor engine + arbitration (owner `cortex`, reviewer
`luria`); tensor head + ladder in `packages/cognition-service/**` (`meridian`, reviewer
`ashby`); Guilt drive contingencies in `packages/drive-engine/**` (`drive`, reviewer
`skinner`); `canon` validates the Std-6 immutability story.

## Dependencies (required)
Hard prerequisites: **feature-snapshot-restore** + **feature-tensor-contract** (graduation
is impossible without durable weights and a versioned contract), and the **drive_rules
write-protection P0** (bug-audit-drive-engine / audit remediation P0 — the floor's DB
immutability is the safety story that makes graduated autonomy acceptable; do not start
graduation work until it's closed). `stakes()` and the veto predicate are
design-blockers: route to `architect` before any build.
Sequence AFTER these inbox bugs (shared files / broken machinery this builds on):
**bug-audit-cognition-sidecar** (the tensor cognition cycle 422s end-to-end and
EWC/convergence/demotion paths are unreachable — graduation cannot be built on a dead
sidecar), **bug-audit-drive-engine** (the drive_rules REVOKE/RLS P0 above, TK-AUDIT-1),
and **bug-audit-decision-making-core** (touches `executor/executor-engine.service.ts` and
the cycle guard this feature extends).

## Database impact (required)
**Touches a database / schema / migration?** yes
Postgres drive state: Guilt drive contingencies + per-action-class rule
strength/tolerance values (via the guardian path, never direct `drive_rules` writes).
Timescale: new event types (divergence, veto, guilt accrual/resolution). No Neo4j change.

## Acceptance — how we'll know it works (required)
1. Veto is tensor-blind: property test — for any tensor output, the veto predicate's
   result depends only on (hardcoded rules, drive vector); code inspection + test proves
   no tensor input reaches it. Tampering with veto logic fails the boot checksum.
2. Given a tensor choice outside the floor at high stakes, then the executor reasserts,
   the veto event is logged, and the action taken is the floor's.
3. Given agreement ≥85% on a low-stakes category and no floor veto, then that category
   (and only it) enters partial mode with confidence capped at 0.79.
4. Guilt accrual: zero on agreement; ~zero on low-stakes divergence; positive on
   permitted high-stakes divergence — then resolves at outcome evaluation per the
   punished/vindicated table (drive trace shows lock-in vs discharge-with-residual, and
   the corresponding rule strength change for that action class).
5. Sustained unresolved guilt (forced in test) trips the Depressive Attractor detector.

## Non-goals / scope guard (required)
No changes to the LLM tier or arbitration thresholds beyond the ladder described. No
guilt wiring to outcomes-in-the-world, other drives, or user disapproval — solely
executor/tensor divergence. No global graduation switch — per-stakes-tier only. The floor
itself is never modified by this work.

## Source / references
`docs/future/sylphie-autonomous-cognition-research.md` §4–§7 (open questions 1, 4, 5);
`docs/future/codebase-audit-remediation.md` P0 (prerequisite).
