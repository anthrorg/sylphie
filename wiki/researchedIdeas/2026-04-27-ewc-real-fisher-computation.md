# Research: Replace Uniform Fisher with Real Fisher Diagonal in EWC Regularizer

**Date:** 2026-04-27
**Status:** researched
**Verdict:** yes-with-caveats
**Source:** wiki/ideas/ewc-real-fisher-computation.md

## Idea

Replace the uniform Fisher matrix (all ones) currently used by `EWCRegularizer` in `packages/cognition-service/training/replay.py` with a real Fisher information diagonal, computed by averaging squared gradients of the log-likelihood over a calibration sample at each operational phase boundary (bootstrap → audit → partial autonomy). The current stand-in degenerates EWC to a uniform L2 anchor; a real Fisher diagonal would weight the regularizer by per-parameter task importance, the variant proposed by Kirkpatrick et al. (PNAS 2017).

## Key Questions

- Does real Fisher actually outperform L2 anchoring enough to justify the implementation cost for a 3-phase MLP-scale system?
- Where does the held-out calibration dataset come from, and how big does it need to be?
- What changes are required in the existing NumPy training pipeline, and how invasive are they?
- Is vanilla EWC the right algorithm here, or should we move directly to Online EWC / SI / MAS given the multi-phase setup?
- Does the codebase even have the phase-transition hook needed to call `set_reference()` at the right moment?

## Findings

### Prior Art

EWC (Kirkpatrick et al., 2017, PNAS 114(13):3521–3526) defines the Fisher diagonal as `E[(∇log p(y|x))²]` averaged over a calibration set, used as importance weights in the quadratic penalty `λ/2 · Σ_i F_i · (θ_i − θ*_i)²`. In production, almost all reference implementations use the **empirical** Fisher (squared gradients on observed labels) rather than the **true** Fisher (expectation over the model's predictive distribution); the empirical variant is widely accepted, with the caveat that it only approximates the true Fisher well when the model is well-calibrated on the calibration data (recent treatment in arxiv 2502.11756, "On the Computation of the Fisher Information in Continual Learning", 2025).

Empirical sample-size guidance from open-source implementations: a few hundred to a few thousand calibration samples is typical; 500 samples is a common explicit choice in the EWC reference repos. For a small MLP, 500–2000 should be ample for stable diagonal estimation.

Reference implementations worth mining for code patterns:
- `kuc2477/pytorch-ewc` — clean, educational PyTorch implementation of the Kirkpatrick paper.
- `GMvandeVen/continual-learning` — production-grade continual-learning suite (EWC, SI, MAS, A-GEM, ER, etc.) tested on standard benchmarks.
- `tfjgeorge/nngeometry` — heavyweight Fisher-matrix library with KFAC/EKFAC, diagonal approximations, and numerical-stability machinery.

The **alternatives** the literature now treats as serious competitors:
- **Online EWC** (Schwarz et al., 2018, "Progress & Compress") — replaces the linearly-growing penalty stack with a single running Fisher estimate. Strongly recommended once task count exceeds ~5; the EWC stack becomes problematic (penalty accumulation → rigidity) past that point.
- **Synaptic Intelligence (SI, Zenke et al., 2017)** — computes parameter importance *online* during training rather than via a post-hoc calibration pass. Comparable benchmark performance, no separate calibration phase.
- **Memory Aware Synapses (MAS)** — importance derived from the gradient of the squared output norm; no labels required.

### Theoretical Grounding

The Fisher diagonal is the right curvature term: it approximates the Hessian of the log-likelihood at the MAP estimate and is the precision of the Laplace approximation of the posterior. Weighting the quadratic penalty by Fisher is therefore a principled Bayesian-flavored regularizer, not just a heuristic.

That said, the empirical case for real Fisher over L2 anchoring is **mixed**:
- Kemker et al. (2018, "Measuring Catastrophic Forgetting") found EWC's gains modest under controlled comparison.
- Mirzadeh et al. (2020) showed that loss-basin geometry and learning-rate scheduling often dominate Fisher weighting in importance.
- Reported gains in domain studies (e.g., knowledge-graph continual learning) sit in the **5–15% accuracy preservation** range — meaningful but not transformative.

For Sylphie specifically, three theoretical wrinkles matter:

1. **Heterogeneous phases.** Sylphie's bootstrap → audit → partial transition is not a series of similar tasks; the agent's *behavior policy* is meant to change. Strong Fisher anchoring to bootstrap weights can prevent the necessary plasticity in audit, manifesting as the classic stability–plasticity dilemma (Mermillod et al., 2013). EWC's literature largely assumes similar task distributions; transferring its guarantees to deliberately shifting policies is not free.

2. **Penalty accumulation.** Vanilla EWC stacks one quadratic penalty per phase. Three phases is fine; if the system ever grows to 5+ phases or reuses the mechanism for finer-grained consolidation, the penalty stack causes rigidity. Online EWC sidesteps this and is the safer long-term default.

3. **Cognitive plausibility.** Benna & Fusi (2016, "Computational principles of biological memory") describe synaptic consolidation as a multi-timescale process with bidirectional coupling and dynamic gating, not a static importance mask. Pure Fisher anchoring is a weak analog. A more biologically-grounded direction would gate consolidation by task similarity / surprise — but this is a research bet, not a near-term ticket.

### Technical Feasibility

The current code is well-scoped for this change but has missing infrastructure around it.

**Existing wiring (in place):**
- `EWCRegularizer` instantiated at `trainer.py:396` with no arguments.
- `penalty_gradients()` called in the inner training step at `trainer.py:590` — already added into the gradient before the Adam update. No change needed here.
- The current uniform-Fisher path returns `np.ones_like(w)` from `_compute_uniform_fisher` (`replay.py:194`). This is the single drop-in replacement target.

**Gaps in the codebase:**
- `set_reference()` is **never called** anywhere in the current code. There is no phase-transition signal that the trainer subscribes to. `config.BOOTSTRAP_MODE` is read as a static env var, not a runtime state machine. A phase-transition hook (likely in `main.py` or the cognitive cycle layer) needs to be added to call `ewc.set_reference(weights)` at the right moment.
- `_backprop` at `trainer.py:228` returns batch-aggregated gradients only. Computing real Fisher requires *per-sample* squared gradients, which is not how the current backprop loop is shaped. The cleanest fix is **not** to refactor `_backprop` — instead, add a separate `compute_fisher()` calibration pass that iterates calibration samples one at a time (or in small chunks), runs forward + backward per chunk, and accumulates the squared gradients into a running diagonal. This isolates Fisher estimation from the hot training path.
- No held-out calibration store exists. The `DataBuffer` ring (`data_buffer.py`, capacity = `REPLAY_BUFFER_SIZE` = 100,000) is the natural source. A phase-end snapshot of 1,000–2,000 samples, drawn with stratified random sampling rather than recency-biased ring order, is the minimum viable approach.
- No tests cover `EWCRegularizer` (`grep` finds only the definition and instantiation sites). New tests are needed for the real-Fisher path and for the phase-transition glue.

**Numerical / scale check:** model parameter count is roughly 938K (`w1` + `b1` + `w2` + `b2` + `w_action` + `b_action` + `w_aux` + `b_aux`). A diagonal Fisher is one float per parameter — a few MB, trivial. The accumulation pass over 2,000 samples in pure NumPy is bounded by forward+backward cost; should complete in seconds, not minutes.

**Numerical stability requirements (well-known EWC failure modes):**
- Floor Fisher values at ~`1e-8` to avoid division/multiplication artifacts.
- Cap Fisher values at ~`1e2` per layer (or normalize per-layer) to prevent any single parameter dominating the penalty.
- Log Fisher statistics per phase transition for debuggability — Fisher collapse (everything near zero) is a silent failure mode where EWC stops doing anything.

**Adam interaction:** the current trainer uses Adam (`trainer.py` Adam optimizer step at line ~595). EWC's quadratic penalty added directly to the gradient interacts oddly with momentum buffers across a sudden λ change at phase boundaries. Mitigation: introduce λ gradually over the first N steps after `set_reference()` rather than slamming it on full-strength.

**TF path is out of scope.** The trainer's TF path (`if hasattr(model, "w1"): ... else return 0.0` at `trainer.py:575-577`) bypasses NumPy training entirely. Real Fisher in TF would need GradientTape integration — separate ticket if/when that path is exercised.

## Assessment

| Dimension    | Rating                                |
|--------------|---------------------------------------|
| Plausibility | high                                  |
| Complexity   | moderate (4–6 days, contingent on phase-transition wiring) |
| Fit          | moderate                              |
| Risk         | medium                                |

## Verdict

Real Fisher diagonal is technically feasible, theoretically sound, and modestly better than the L2-anchor stand-in — but the bigger blocker is that the surrounding infrastructure (phase-transition events, calibration sampling, λ tuning per transition) does not yet exist. **Recommend proceeding, but with two changes to the original spec:** (1) implement the calibration pass as an isolated `compute_fisher()` method rather than refactoring `_backprop`, and (2) target **Online EWC** (Schwarz 2018) from the start instead of vanilla EWC, since the multi-phase design is exactly the regime where vanilla EWC's penalty-stacking causes problems and the implementation cost difference is small. If audit-phase forgetting turns out to be empirically benign (<10% on bootstrap-task evaluation), the L2 anchor remains good enough and this work can be deprioritized.

## Implementation Path

1. **Add phase-transition signal.** In `main.py` or the cognitive-cycle layer, define a runtime phase state (currently only `config.BOOTSTRAP_MODE` env var) and emit a `phase_transition` event when it changes. The trainer subscribes and calls `ewc.set_reference()` and `ewc.compute_fisher(calibration)` on receipt. **This is the prerequisite — without it, real Fisher has nothing to anchor to.**

2. **Add calibration-set extraction to `DataBuffer`.** Method: `snapshot_calibration(n_samples: int, stratified: bool = True) -> list[dict]`. Stratified sampling avoids recency bias from the ring's head pointer.

3. **Add `compute_fisher()` to `EWCRegularizer`.** Signature: `compute_fisher(model, calibration_samples, n_samples_used: int)`. Iterates samples (or small chunks), runs forward + backward via the existing `_forward_with_cache` / `_backprop` helpers exposed as module-level functions, accumulates squared gradients into the diagonal, normalizes by `n_samples_used`, then floors at `1e-8` and clamps to a per-layer maximum.

4. **Switch storage to Online EWC update rule.** Instead of replacing `self._fisher` outright at each phase, maintain a running estimate: `F_new = γ · F_old + F_phase` with `γ ∈ [0.5, 0.95]`. This avoids unbounded growth and matches Schwarz et al. 2018. Same applies to `self._reference` — anchor to current weights; Fisher carries the historical importance.

5. **Tune λ per phase transition.** Bootstrap → audit needs higher λ (preserve learned competencies); audit → partial may need lower λ (allow behavioral shift). Make λ a per-transition parameter rather than a single constant.

6. **Add λ ramp-up.** First N=200 training steps after `set_reference()`, scale λ linearly from 0 to its target value to avoid Adam-momentum shock.

7. **Add Fisher diagnostics.** Log mean / max / fraction-near-zero per layer at every phase transition. Fisher collapse is silent and easy to miss; explicit metrics catch it.

8. **Tests** (`packages/cognition-service/training/tests/test_replay.py`):
   - `compute_fisher` correctness vs. a hand-computed example on a tiny model.
   - `set_reference` + `penalty_gradients` round-trip with non-uniform Fisher.
   - Phase-transition integration: simulate two phases, confirm Fisher updates and penalty applies correctly.
   - Numerical-edge cases: empty calibration, all-zero gradients, very large gradients.

### Key Design Decisions

- **Empirical Fisher, not true Fisher.** Sampling from the model's predictive distribution adds complexity for marginal accuracy gain; empirical Fisher is the production default.
- **Diagonal only.** Block-diagonal or KFAC approximations are out of scope for this size of model and would explode the implementation cost.
- **Online EWC update rule from day one.** Trivially small extra code over vanilla EWC and removes the multi-phase failure mode.
- **Calibration drawn from the buffer at phase end, not held back during training.** Simpler, doesn't require buffer redesign; recency bias is mitigated by stratified sampling.

### Risks to Mitigate

- **Phase-transition hook may not exist when this work starts** — the entire feature depends on it. If wiring it up turns out to be more invasive than expected, scope this ticket to the regularizer + tests and split the integration into a separate ticket.
- **Stability–plasticity** — strong Fisher anchoring across heterogeneous phases may suppress the behavior changes the phase transition is supposed to enable. Per-transition λ tuning + diagnostics on audit-phase performance are the early-warning signal.
- **Fisher collapse / explosion** — silent failure modes; explicit logging required.
- **No test coverage today** — adding real Fisher without tests creates correctness risk; tests are non-optional here, not nice-to-have.
- **Marginal payoff** — if empirical audit-phase forgetting is already benign with the L2 anchor, the work doesn't pay for itself. Recommend a baseline measurement on the L2 anchor *before* committing to the full implementation.

## Sources

- [Kirkpatrick et al., "Overcoming catastrophic forgetting in neural networks", PNAS 2017](https://www.pnas.org/doi/10.1073/pnas.1611835114)
- [arXiv:1612.00796 (preprint of the same paper)](https://arxiv.org/abs/1612.00796)
- [Schwarz et al., "Progress & Compress: A scalable framework for continual learning", ICML 2018](https://proceedings.mlr.press/v80/schwarz18a/schwarz18a.pdf)
- [Zenke et al., "Continual Learning Through Synaptic Intelligence" (SI)](https://ganguli-gang.stanford.edu/pdf/17.intelligentsynapses.pdf)
- [Kemker et al., "Measuring Catastrophic Forgetting in Neural Networks"](https://arxiv.org/abs/1708.02072)
- [Mirzadeh et al., "Understanding the Role of Training Regimes in Continual Learning"](https://openreview.net/pdf?id=Fmg_fQYUejf)
- [Mermillod et al., "The stability–plasticity dilemma"](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2013.00504/full)
- [Benna & Fusi, "Computational principles of synaptic memory consolidation"](https://www.nature.com/articles/nn.4401)
- [arXiv:2502.11756, "On the Computation of the Fisher Information in Continual Learning" (2025)](https://arxiv.org/abs/2502.11756)
- [Benzing et al., "Unifying Importance-Based Regularisation Methods for Continual Learning"](https://proceedings.mlr.press/v151/benzing22a/benzing22a.pdf)
- [Reference implementation: kuc2477/pytorch-ewc](https://github.com/kuc2477/pytorch-ewc)
- [Reference implementation: GMvandeVen/continual-learning](https://github.com/GMvandeVen/continual-learning)
- [Reference implementation: tfjgeorge/nngeometry](https://github.com/tfjgeorge/nngeometry)
- Sylphie codebase: `packages/cognition-service/training/replay.py`, `packages/cognition-service/training/trainer.py`, `packages/cognition-service/training/data_buffer.py`, `packages/cognition-service/config.py`
