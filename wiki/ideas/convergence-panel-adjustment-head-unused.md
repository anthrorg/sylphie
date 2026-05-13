# Idea: Wire (or remove) the convergence model's dead panel-adjustment head and define a graduation path from heuristic to learned routing

**Created:** 2026-04-27
**Status:** proposed

## Summary

The `ConvergenceModel` in `packages/cognition-service/models/convergence.py` allocates, persists, and parameter-counts a panel-adjustment head (`w_adj` 64x4, `b_adj` 4) that is never referenced in any forward pass. At the same time, the model's `use_learned` flag has no defined criterion for flipping from `False` (heuristic cosine) to `True` (learned model), so the learned path can never legitimately activate from experience. Either wire the adjustment head into the returned `panel_agreement` (and into routing) and define a graduation criterion driven by training loss / sample count, or drop the dead head entirely so the saved checkpoint reflects what the code actually uses.

## Motivation

The convergence checker decides whether a decision cycle stays on the Type 1 fast path or escalates to Type 2 deliberation — it is a load-bearing piece of the dual-process architecture. Today, three things are wrong with it:

1. **Dead head.** `_build` allocates `self.w_adj = xavier(64, 4)` and `self.b_adj = zeros(4)`, sums them into `total_params`, saves them to `convergence_model.npz`, and reloads them. Nothing in `_predict_learned`, `check`, the `cycle.py` consumer, or anywhere else in the package reads them. The class docstring even advertises "per-panel agreement adjustments" as part of the output, but the returned `panel_agreement` dict is always pure raw cosine similarity. The shipping checkpoint is carrying ~260 floats of pure noise.

2. **No graduation criterion.** The flag `use_learned: bool = False` is the only switch between heuristic and learned routing. Nothing in the file (or in the trainer/cycle) describes when it should flip. This mirrors the spirit of the existing `cognition-per-model-freeze` idea but is distinct — that one is about freezing trained weights; this one is about ever turning the trained path on at all. Without an explicit graduation rule (e.g., `flip when trained on >= N convergence samples AND validation loss < threshold`), either the learned model will be activated prematurely (random-weight routing decisions) or never activated at all (heuristic forever, defeating the purpose of training a 10K-param model).

3. **Threshold is fixed.** `DEFAULT_CONSENSUS_THRESHOLD = 0.3` is hardcoded, but the module docstring promises that "the learned convergence model replaces heuristic threshold routing with routing that adapts based on experience." Without (1) and (2) resolved, this promise is unmet.

This matters because escalation decisions directly trade Type 1 graduation pressure against Type 2 cost, and the CANON's Dual-Process Cognition principle requires that Type 2 carry cost and Type 1 develop coverage. A convergence checker that silently reverts to heuristic — and a panel-adjustment head that exists only as ballast — both undermine that contingency.

## Subsystems Affected

- Decision Making (cognition sidecar — `cognition-service/models/convergence.py`, `cognition-service/inference/cycle.py`)
- Cognition training pipeline (`cognition-service/training/trainer.py` — needs a convergence-loss path if the head is to be used)
- Supervisor narration (downstream consumer of `panel_agreement` via the sidecar state — see `narration-sidecar-model-state-enrichment` idea)

## Open Questions

- Should the `w_adj` head be wired in or removed? Wiring it in adds learned per-panel reweighting (e.g., trust Skinner's behavioral panel more for action questions, Piaget's for novelty), but requires a training signal — what's the supervised target for "panel reliability"? Is it derived from prediction-error attribution back to specific panels, or from guardian feedback contingent on which panel dominated?
- What is the right graduation criterion for `use_learned`? Candidates: (a) cumulative number of (cycle, post-hoc-correctness) training pairs above N; (b) held-out validation accuracy on heuristic-vs-learned escalation decisions; (c) guardian-feedback-weighted agreement. The CANON's Confidence Ceiling (no knowledge above 0.60 without retrieval-and-use) suggests we should require actual successful applications, not just training loss.
- If we keep the heuristic, should it use mean cosine or something more conservative (max disagreement, median, or drive-weighted)? A single panel disagreeing strongly on a high-stakes action seems more important than the current mean treatment allows.
- Does the threshold itself need to be drive-modulated? When Cognitive Effort drive is high, escalating to Type 2 is more costly — should the consensus threshold rise (more tolerance for disagreement) accordingly? This would be a new CANON-relevant interaction between the convergence checker and the Drive Engine.
- If we drop the head, does that constitute a checkpoint-format change that needs migration handling in `load()` (which currently keys directly on `data["w_adj"]`)?
