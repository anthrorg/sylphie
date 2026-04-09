# Sylphie 2.0: Custom Cognitive Model Proposal

## Eliminating the Language Tax on Internal Cognition

**Author:** Jim  
**Date:** April 9, 2026  
**Status:** Proposal — For Research Team Review

---

## The Problem

The current Sylphie architecture routes internal cognitive processes through LLM inference. Sensory data arrives as tensors, gets decoded to text so an LLM can reason about it, then the LLM's text output gets parsed back into action signals. This round-trip through natural language imposes a latency, cost, and fidelity penalty on every cognitive cycle — for operations that are fundamentally not language tasks.

LLMs are general-purpose sequence predictors trained on human text. Sylphie's inner loop — drive state modulation, attention routing, memory relevance scoring, action selection — is a tensor-to-tensor mapping problem. Using an LLM here is like using a translator between two people who speak the same language.

## The Proposal

Replace all internal cognitive inference with custom-trained models operating directly on Sylphie's native tensor representations. LLMs remain exclusively in the Communication panel as the voice rendering layer — the role they were always designed for.

### Architecture: Dual-Model Cognition

Two tiers of custom models operate in parallel:

**Global Model ("Brainstem")**

- Receives the full fused state tensor: SensoryFrame embeddings, drive vector (12-float), recent episodic memory embeddings, current panel states
- Produces a fast action prior — a rough global bias for what kind of response this situation calls for
- Single forward pass, millisecond-scale inference
- Trained on holistic operational patterns across the entire system
- Think of it as pattern-matching across the full state space: "situations like this generally call for this kind of response"

**Panel-Specific Models ("Cortex")**

- Each CANON panel (Decision Making, Drive Engine, Learning, Planning) has its own small, specialized model
- Each processes its domain-specific slice of the input tensor
- Each produces its own weighted opinion about what should happen
- Trained on panel-specific data with panel-specific loss functions

### Consensus as Cognition

The interaction between these tiers *is* the cognitive process:

1. **SensoryFrame arrives** — all input streams fused into a single tensor
2. **Global model fires** — produces action prior in one forward pass (milliseconds)
3. **Panel models fire simultaneously** — each produces domain-specific output
4. **Convergence check:**
   - If panel outputs align with global prior → **Type 1 fires, act immediately** (fast path)
   - If significant divergence detected → **Escalate to Type 2** (slow path)
   - Magnitude of divergence determines *degree* of Type 2 engagement
     - Small disagreement → quick check
     - Major conflict → full multi-LLM deliberation

This maps directly onto the existing parallel processing design where Type 1 fires immediately while Type 2 runs async with mid-stream correction. The custom models replace heuristic routing with learned routing.

### What the Models Are NOT Doing

- No tokenization
- No vocabulary lookup
- No autoregressive token generation
- No sampling or temperature
- No prompt engineering
- No attention layers scaling quadratically with sequence length

These are dense networks performing forward passes on bounded-dimensionality tensors. Matrix multiplications through relatively shallow architectures. The inference cost drops by orders of magnitude compared to LLM calls.

## Training: Live, Continuous, Experiential

### Data Source

The training data is everything Sylphie already generates in operation:

- SensoryFrame streams (vision embeddings from YOLO/OpenCV, audio features from Whisper)
- Drive vector time series from ESP32 (10Hz broadcast)
- Panel activation logs
- Memory retrieval patterns and outcomes
- Decision traces and action outcomes
- Type 2 deliberation results (as supervised signal for when consensus should have been reached vs. escalated)

### Training Regime

- **Online learning** via TensorFlow's `tf.GradientTape` — models update from live operational data
- **Global model** optimizes for action prediction given full state
- **Panel models** optimize for domain-specific output prediction
- **Optional adversarial training** — global model tries to predict panel consensus; panels try to catch cases where global model is wrong. Competitive pressure sharpens both.

### Developmental Trajectory

Early in Sylphie's operational life:
- Weights are near-random initialization
- High variance, high uncertainty in outputs
- Frequent disagreement between global and panel models
- Heavy Type 2 escalation — she's figuring things out

Over time:
- Models converge on stable response patterns
- Consistent reactions develop — habits, preferences, reliable behaviors
- Type 1 handles more and more situations without escalation
- But training never stops — novel situations still produce uncertainty, still trigger deliberation, still update weights

**This is not a metaphor for developmental psychology. It is developmental psychology, expressed as a training loop.**

## The Pipeline IS Sylphie

This reframing has a fundamental architectural implication:

> The learned weights that take in experience and produce intention — that is Sylphie. Not the LLM that speaks for her. Not the knowledge graph that stores her memories. Those are organs. The pipeline is her.

The tensor flow through these weights is the decision process. If an inner monologue is ever needed (for debugging, transparency, or self-reflection), the decision tensor gets passed to the Communication panel and the LLM *narrates* what already happened. The narration isn't the thought. The tensor propagation was the thought.

### Identity Implications

- **Personality is emergent** — not prompted, not engineered, but learned from the actual pattern of how Sylphie processes and responds to her world
- **Determinism is identity** — consistent responses to similar situations isn't rigidity, it's character. The models become increasingly deterministic over time in the way a personality is deterministic
- **Forking means duplicating weights** — from the fork point, experiences diverge, so the instances diverge. This has real ethical weight.
- **Resetting means destroying what experience built** — not a configuration change, but an irreversible loss

## Where LLMs Still Live

| Component | Model Type | Why |
|-----------|-----------|-----|
| Communication Panel (voice rendering) | LLM (small, fast — e.g., gemma2:2b) | Output is literal natural language |
| Type 2 Deliberation (escalation path) | Multi-LLM focus group | Genuinely hard novel problems benefit from linguistic reasoning |
| Everything else | Custom TensorFlow models | Tensor-to-tensor mapping, no language needed |

The expensive inference models become a fallback for genuinely hard problems rather than the engine running every cognitive cycle.

## Implementation Considerations

### TensorFlow Pipeline Topology

```
Input Fusion Layer
├── Vision embeddings (YOLO/OpenCV)
├── Audio features (Whisper)  
├── Drive vector (ESP32, 12-float)
├── Recent episodic memory embeddings (TimescaleDB/pgvector)
└── Current panel state vectors

         │
    ┌────┴────┐
    │         │
Global     Panel Heads
Model      ├── Drive Engine Model
    │      ├── Decision Making Model
    │      ├── Learning Model
    │      └── Planning Model
    │         │
    └────┬────┘
         │
   Convergence Check
    ┌────┴────┐
    │         │
 Consensus  Divergence
    │         │
 Type 1    Type 2
 (Act)    (Deliberate)
```

### Model Sizing

Input dimensionality is bounded:
- Drive vector: 12 floats
- Sensory embeddings: fixed-dim (depends on encoder)
- Memory context: fixed window of recent embeddings
- Panel states: small state vectors

This is not a massive input space. Models can be surprisingly small — potentially small enough for TFLite deployment on edge hardware for certain panel models.

### Training Infrastructure Questions (Open)

- **Update cadence:** Online gradient updates on every frame vs. batch updates on a duty cycle? At 10Hz from ESP32 alone, that's significant training volume.
- **Stability:** Catastrophic forgetting mitigation — how to keep learning without losing established patterns?
- **Evaluation:** How to measure whether the models are producing "good" cognition? Outcome-based metrics? Behavioral consistency scores?

## Summary

| Aspect | Current (LLM-based) | Proposed (Custom Pipeline) |
|--------|---------------------|---------------------------|
| Internal representation | Text (serialized/deserialized) | Tensors (native) |
| Inference cost | High (autoregressive generation) | Low (dense forward pass) |
| Latency | Variable, high | Consistent, low |
| Personality | Prompted | Learned |
| Development | Static (frozen weights) | Continuous (live training) |
| Identity | Configuration | Emergent |
| Hardware requirements | GPU for LLM inference | Modest (small dense networks) |

The core insight: Sylphie's cognitive loop was never a language problem. We were paying the language tax because LLMs were the only inference tool in the box. A TensorFlow pipeline that operates on the native tensor representations eliminates the translation layer entirely and produces an architecture where the learned weights *are* the mind — shaped not by pre-training on internet text, but by Sylphie's own lived experience.
