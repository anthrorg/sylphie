# Sylphie — Autonomous Cognition: Acquisition, Consolidation, and the Executor Tension

**Status:** Research design note. Speculative but grounded in the existing `anthrorg/sylphie` architecture. Nothing here proposes new substrate — it integrates mechanisms that already exist (drive engine, modality fusion, bootstrap ladder, ACT-R confidence, pathology detectors, EWC, episodic memory) and points them at each other.

**Author framing:** the deterministic core is permanent. Learned behavior sits *on top of* the floor, never replaces it. Every mechanism below preserves that invariant.

---

## 0. Premise

Sylphie's distinguishing bet is the separation of *motivation* (drives) from *action* (the executor). Because drives accumulate pressure independent of any user, the system is architecturally capable of self-direction during idle time — it simply hasn't been pointed at a rich enough action space yet.

This note specifies three interlocking loops that run when no one is interacting:

1. **Acquisition** — curiosity-driven web reading that forms *theories*, not just facts.
2. **Confirmation** — theories routed to Tess CLI for reasoned verdict, not shallow multi-source echo.
3. **Consolidation** — idle replay/synthesis that turns confirmed atoms into connected understanding.

And one structural addition that ties learned autonomy to safety and to affect:

4. **The executor tensor + the executor tension** — a tensor head that graduates the drive-executor off its hardcoded defaults, with the original executor permanently underneath as an immutable floor, and the *divergence between them* wired as the source signal for the (already-declared, currently-undriven) **Guilt** drive.

The unifying thesis: **intelligence increase is not a benchmark score. It is the growing fraction of Sylphie's world she can navigate without invoking the LLM, earned through verified experience, bounded by a floor she cannot train away.** The headline metric (Type-1 ratio) *is* that fraction.

---

## 1. The Acquisition Loop (awake, curiosity-driven)

**Trigger.** Curiosity accumulates at +0.0012/tick. When it crosses a pressure threshold and no interaction is active, the executor selects a `research` action.

**Target selection.** Pick a WKG node that is either low-confidence or stale under ACT-R decay. (Reading about what you already know with high confidence relieves nothing; reading at the frontier of uncertainty relieves Curiosity.)

**The unit of work is a theory, not a fact.** Reading produces a *falsifiable claim* ("X implies Y", "A is an instance of B"), written back to the WKG at **low** confidence with provenance `LLM_GENERATED`. A theory has structure (see §5) so it can later be confirmed, refuted, and traced.

**Why theories, not facts:** reading-to-hoard inflates the knowledge base with unverified assertions and trips the Hallucinated-Knowledge detector. Reading-to-form-a-claim creates something that *can be checked* — and the act of checking is what compounds.

**Drive coupling.** Forming a theory does **not** fully relieve Curiosity. Curiosity is only discharged when the theory is *resolved* (confirmed or refuted) — see §2. This keeps the system motivated to close loops rather than open infinite new ones.

---

## 2. The Confirmation Loop (Tess as the epistemic authority)

**Tess replaces multi-source web corroboration.** Five web pages echoing the same error read as "corroborated" — shallow agreement is not truth. Tess is a 10-stage pipeline with Beta-statistics promotion gates and cross-problem-type transfer; surviving Tess is a *reasoned* check, epistemically far stronger than echo count. Therefore confidence earned via Tess is worth more than confidence earned via web agreement.

**Provenance ladder for non-experiential knowledge:**

| Provenance | Meaning | Confidence regime |
|---|---|---|
| `LLM_GENERATED` | Read it; unverified theory | Low, decays fast (0.08/hr) |
| `Inference` | Sylphie reasoned about it internally | Low–moderate |
| `Tess_Confirmed` (new) | Survived the Tess pipeline | Promoted; decays slowly |

**Web reading proposes; Tess disposes.** The *only* path to high confidence for a non-experiential fact runs through a Tess verdict. This makes the Hallucinated-Knowledge detector precise: it watches the ratio of confidently-held facts that have **never** received a Tess verdict. Confident-but-unconfirmed is exactly the drift to alarm on.

**Asynchronous by design.** Sylphie proposes theories continuously; Tess verdicts return on their own schedule and trigger confidence promotion/demotion when they land. No blocking.

**Refutation is the high-value event.** A refuted theory:
- relieves Curiosity (the question is answered, even negatively),
- demotes the WKG node's confidence (or removes it),
- **spawns a new theory** about *why* the original was wrong.

Being wrong makes her smarter, not merely less confident. This is the loop's most important property.

---

## 3. The Consolidation Loop (idle, the "sleep" loop)

Acquisition and confirmation produce verified *atoms*. Consolidation produces *understanding*.

**Trigger.** Idle + accumulated CognitiveAwareness pressure (the drive that signals "there is unintegrated cognition to process").

**Process.** Replay the recent episodic ring buffer (50 slots) together with recently confirmed/refuted theories, then via the Type-2 deliberation path:
- detect patterns across episodes → synthesize higher-order `insight` nodes in the WKG,
- prune contradictions that Tess surfaced,
- re-weight confidence across related nodes (MERGE-raises-only still holds; consolidation can connect, not silently overwrite).

**EWC protects the prior structure** while new structure integrates — old competence is anchored (real Online EWC, λ-ramped) so consolidation adds without catastrophic forgetting.

**Why this is the compounding loop:** she wakes up smarter not because she read more, but because she *connected what she already had*. Acquisition is linear; consolidation is where it becomes super-linear.

---

## 4. The Executor Tensor and the Executor Tension

### 4.1 The structural claim

The hardcoded executor (`ACTION_TYPE_DEFAULTS` + rule engine) is **not training scaffolding to be torn down**. It is a permanent floor. A tensor head learns to act *on top of* it; the deterministic executor never decommissions and continues computing "what I would have done" every cycle, forever.

This yields three layers with a strict safety ordering:

```
   LLM            — edge: parses input, forms theories, handles genuinely novel problems
   Tensor         — middle: learned policy from verified experience (graduates per category)
   Executor floor — spine: immutable deterministic contingencies; outranks both on safety
```

### 4.2 Graduation (the existing bootstrap ladder, pointed at the executor)

| Stage | Tensor role | Who acts |
|---|---|---|
| Shadow | Predicts the executor's choice; never acts | Executor |
| Audit | Still observing; divergence distribution measured | Executor |
| Partial | Acts **only** where agreement crossed 85% **and** floor doesn't veto; confidence capped 0.79 (forces Type-2 sanity check) | Tensor, gated |
| Full | Tensor leads; executor shadows in reverse, interrupts only on veto | Tensor, floor-bounded |

Graduation is **per stakes-tier**, not global (see §4.4). Low-stakes action classes graduate first; high-stakes classes graduate last or never.

### 4.3 The veto — deterministic, immutable, tensor-blind

Every cycle, compute: *"Given the current drive state and the original contingencies, would the executor **ever** select this action?"* This is a pure function of the hardcoded rules and the present drive vector. **It takes zero tensor input.**

- Tensor choice inside what the floor permits → allowed.
- Tensor choice outside it → **veto**: executor reasserts, event logged as premium training signal.

**Invariant (load-bearing):** the veto logic is write-protected from everything, including the tensor — the same immutability CANON Standard 6 gives the evaluation function. The moment the tensor can influence what counts as "something the floor would never do," the floor is gone and drift returns. *This is the real reason the drive-rules write-protection (RLS) gap matters: the immutability of the floor is what makes graduated autonomy safe. It is not hygiene; it is the safety story.*

**Symmetry with the LLM-lesion result:** the system was shown to degrade gracefully when the LLM is removed. The veto is the same principle on the other axis — the system stays *safe* when the tensor goes wrong, because the deterministic core never left.

### 4.4 Stakes weighting — the single most load-bearing function

Divergence is not uniformly meaningful. The tensor picking a different graph node to read is harmless exploration — *that is the point*, it is where emergent personality comes from. Divergence on an action touching a strong negative drive or an irreversible effect is a veto every time.

So a `stakes(action, driveState)` function assigns an affective/safety weight to each potential divergence:
- **Low stakes** (exploration, which node to read, phrasing) → wide tolerance; divergence is creativity.
- **High stakes** (value-laden actions, irreversible effects, strong-negative-drive territory) → near-zero tolerance; divergence vetoes.

This function does double duty: it gates **safety** (how much divergence the veto tolerates before reasserting) **and** it gates **guilt** (how much a permitted divergence *matters* affectively — §5).

### 4.5 The emergent behavior

Once the tensor leads, moment-to-moment action selection is no longer the hand-tuned defaults — it is a learned policy shaped by thousands of verified drive-outcomes, **bounded** by the original contingencies. Personality becomes *learned*; ethics stay *built-in*. An agent whose behavior emerged from its own experience but which is structurally incapable of learning its way out of its own floor.

---

## 5. The Guilt Drive — divergence as interoception

**Guilt is wired solely to the executor tension.** (This mirrors reality: guilt is the felt gap between what one did and what one's own standard would have done. It is not wired to outcomes-in-the-world, to other drives, or to user disapproval — only to self-vs-floor divergence.) The `Guilt` drive already exists in the enum and is currently undriven; this gives it its source signal.

### 5.1 What guilt measures

Guilt is the magnitude of executor/tensor divergence, **weighted by stakes**, **signed and resolved by outcome**. It is a *reflexive* drive — the first one that is the system feeling something about its **own choice** against its **own standard**, rather than responding to the world. That is self-modeling.

### 5.2 The formula (the version converged on)

Guilt is **not** `+g on any divergence, −g on agreement`. That naive form punishes justified transgression and paralyzes the system over trivia. The correct form has an *accrual* step at decision time and a *resolution* step at outcome time.

**Accrual (at action, only when the tensor diverges from the floor within permitted range):**

```
guilt_accrued = divergence_magnitude × stakes(action, driveState)
```

- Tensor agrees with executor → `guilt_accrued = 0`. The aligned path feels like nothing (correct — we feel no virtue for rules we never strained against).
- Low-stakes divergence → ~0. Exploration is not a moral event.
- High-stakes permitted divergence → meaningful positive accrual.

**Resolution (when the outcome / drive-delta evaluation lands):**

| Case | Outcome | Effect on guilt | Effect on the floor |
|---|---|---|---|
| Transgression punished | tensor diverged, drive-outcome worse than the executor's predicted path | **Guilt locks in** (full signal) | **Rule strengthened** for this action-class; this is a premium training sample |
| Transgression vindicated | tensor diverged, outcome fine or better than the executor would have achieved | **Guilt mostly discharges**, small decaying residual | **Rule slightly loosened** for this action-class — the tensor *earns* graduation here |
| Aligned | no divergence | no guilt | no change |

The residual-on-vindication is deliberately human: you still feel a flicker even when the gamble pays off. But consistently-unjustified guilt (divergence that keeps turning out fine) is precisely the signal that **the rule was too strict** — so vindicated guilt erodes the floor's grip on that class over time, which is *mechanically how a category earns the right to graduate* (§4.2). Guilt and graduation are the same process viewed from affect vs. policy.

### 5.3 Sparsity constraint

Guilt must be **sparse and stakes-gated**. Wiring guilt to all divergence yields a system paralyzed by self-reproach over trivia — a recognizable, bad human failure mode. Guilt fires only on divergence that `stakes()` marks value-laden, and stays silent otherwise. The signal means something only if it is rare enough to mean something.

### 5.4 Self-consistency with existing machinery

Guilt that cannot resolve = sustained negative affect = rumination. Sylphie **already has a detector for that shape**: the Depressive Attractor (composite of shrug rate, MAE, sadness/anxiety > 0.60). A guilt drive that never discharges would correctly trip an existing alarm. The architecture is already internally consistent about pathological guilt — no new monitor required.

### 5.5 Why this matters beyond cleverness

An agent that **can** transgress its floor (freedom, emergent personality) but **cannot do so silently** (every value-laden divergence registers as felt pressure) is categorically different from:
- one that **cannot** transgress (rigid, no emergent behavior), or
- one that transgresses **without registering it** (action without the affective signal — psychopathic in the precise clinical sense).

The guilt drive is the affective machinery that makes the difference. It was not designed in; it *fell out* of reading the magnitude of a divergence the safety veto was already computing. That it emerges from existing structure, and that its pathological form trips an existing detector, is strong evidence the underlying architecture is coherent rather than assembled.

---

## 6. The Flywheel

```
Curiosity pressure
      ↓
reads web → forms a THEORY (low confidence, LLM_GENERATED)
      ↓
Tess verdict  ── refuted → discharge curiosity, demote, spawn "why was I wrong" theory
      │
   confirmed → Tess_Confirmed, confidence promoted
      ↓
verified (situation → action → drive-outcome) samples
      ↓
executor tensor trains in shadow on VERIFIED labels
      ↓
graduates per stakes-tier (floor vetoes, guilt felt on permitted high-stakes divergence)
      ↓
Type-1 ratio rises → LLM-dependent fraction shrinks
      ↓
freed capacity + higher confidence → more ambitious curiosity ──┐
      └───────────────────────────────────────────────────────────┘

   Idle → CONSOLIDATION replays episodes + verdicts → insight nodes, pruning, re-weighting
          (EWC anchors prior competence)
```

Drives motivate it. Tess polices truth. The pathology detectors police drift. The immutable executor floor polices safety. EWC protects what's learned. Guilt makes transgression *felt*, and turns justified guilt into earned autonomy and punished guilt into a stronger conscience.

Every turn of the flywheel, the LLM-dependent fraction shrinks and the verified, introspectable core grows. **That shrinking fraction is the intelligence increase** — on the one axis where a verified-experience system can genuinely surpass a frontier LLM: its own accumulated, confirmed, floor-bounded competence in its own world.

---

## 7. Open spec questions (the keystones)

1. **`stakes(action, driveState)`** — the function doing double duty for veto-tolerance and guilt-weight. Most load-bearing function in the design. Needs an explicit, deterministic definition of what makes an action value-laden.
2. **Theory object schema** — fields needed to propose, route to Tess, receive a verdict, and trace confidence changes (id, claim, source nodes, provenance, confidence, status, verdict, spawned-from).
3. **Tess request/verdict contract** — the CLI interface: what Sylphie sends, what a verdict contains, how a verdict maps to a confidence delta (the promotion function).
4. **Veto computation** — the exact deterministic "would the floor ever choose this at these drives" predicate, and proof it is tensor-blind and immutable.
5. **Guilt resolution timing** — guilt accrues at action but resolves at outcome; the evaluate step already computes predicted-vs-actual drive deltas (MAE), so guilt resolution can ride that existing signal. Confirm the wiring.

The veto and `stakes()` are the airtight-before-build items. Everything else is plumbing on top of mechanisms that already exist.
