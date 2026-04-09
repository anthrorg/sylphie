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
   - If significant divergence detected → **Escalate to Type 2 deliberation pipelines** (slow path)
   - Magnitude of divergence determines *degree* of Type 2 engagement
     - Small disagreement → quick check
     - Major conflict → full deliberation across all three pipelines

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
| Everything else | Custom TensorFlow models | Tensor-to-tensor mapping, no language needed |

With the introduction of tensor-native deliberation pipelines (see below), the LLM is now exclusively the voice — the mouth of the system. No LLM inference exists anywhere in the cognitive loop.

## Type 2 Deliberation: Three Specialized Pipelines

The original architecture used multi-LLM focus groups for Type 2 deliberation — for/against agents with a synthesis engine. This was the last remaining LLM dependency in the cognitive loop. It is now replaced entirely by three specialized tensor pipelines.

### The Three Deliberation Pipelines

Each pipeline receives the same fused input tensor but has been trained on fundamentally different data, producing genuinely different learned perspectives:

**The Pragmatist (Outcome Pipeline)**

- Trained heavily on outcome data — what happened when similar decisions were made in the past
- Weights encode consequence patterns
- Answers the implicit question: "What has worked before in situations like this?"

**The Conservative (Constraint Pipeline)**

- Trained on constraint data — drive state boundaries, safety thresholds, architectural invariants, things that must not be violated
- Weights encode limits
- Answers the implicit question: "What must not be broken?"

**The Advocate (Novelty Pipeline)**

- Trained on novelty and opportunity data — situations where breaking from established patterns led to positive outcomes, exploration that paid off
- Weights encode possibility
- Answers the implicit question: "What could we gain by doing something different?"

### Deliberation as Disagreement

Same input tensor → three different action biases. The pattern of agreement and disagreement across the three pipelines *is* the deliberation. No language involved. No prompting. No "please argue for this position." Three genuinely different learned perspectives producing three genuinely different outputs from the same state.

### Synthesis Model

A small learned weighting function across the three pipeline outputs replaces the LLM synthesis engine. Trained on historical cases where the pipelines disagreed, it learns when to trust the Pragmatist vs. the Conservative vs. the Advocate. Over time, this model develops its own meta-cognitive pattern — effectively learning *how Sylphie deliberates.*

## Society of Mind: The Fork-and-Specialize Model

### Foundation Weights as Launchpad

Once Sylphie's base weights reach a stable developmental state — coherent personality, reliable drive dynamics, consistent core behaviors — those weights become a **foundation snapshot**. This snapshot is the starting point for specialization.

### Forking into a Collective

Fork N copies of the foundation weights (e.g., 20 instances). Expose each to different operational domains over an extended period:

- One instance processes primarily visual data → develops sharper perceptual instincts
- One lives in the planning domain → develops stronger temporal reasoning
- One specializes in social interaction patterns → develops richer interpersonal modeling
- One focuses on anomaly detection → develops heightened sensitivity to the unexpected
- And so on across whatever domains are relevant

All instances are still *Sylphie* at the root — same foundational personality, same core drive dynamics, same base identity. But their weights diverge through specialization. They don't just have different "roles" — they literally process the same input tensor through different learned weight paths.

### Collective Cognition

When the specialized instances collaborate:

- All N instances receive the same input tensor
- Each produces its action bias from its specialized perspective
- **Convergence zones** = high-confidence signal across the collective
- **Divergence zones** = genuine uncertainty worth examining
- The *pattern* of divergence is itself information — if the visual specialist and anomaly detector disagree with everyone else, that's a qualitatively different signal than uniform noise

### Governance

Disagreement resolution options:

- **Weighted influence** — domain-relevant specialists get more vote weight on questions in their area of expertise
- **Relevance weighting as a learned function** — a meta-model that learns which specialist to trust in which contexts
- **Escalation thresholds** — degree of collective disagreement determines whether to act on majority or deliberate further

### Resilience

The foundation snapshot is an insurance policy. If a specialized instance drifts into pathological territory — adversarial patterns, local minima, degenerative weight drift — fork a fresh copy from the foundation, expose it to curated data, and bring it back online. The collective is resilient in a way a single model cannot be.

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
 Type 1    Type 2 Deliberation
 (Act)     ├── Pragmatist Pipeline (outcomes)
           ├── Conservative Pipeline (constraints)
           └── Advocate Pipeline (novelty)
                    │
              Synthesis Model
                    │
                   Act
```

### Full Cognitive Cycle (LLM-Free)

```
Type 1 (fast path):
  SensoryFrame → Global Model → Panel Models → Consensus → Act
  All tensors. Sub-millisecond.

Type 2 (slow path):  
  Divergence → 3 Deliberation Pipelines → Synthesis Model → Act
  All tensors. Still sub-millisecond.

Communication (only language path):
  Decision tensor → LLM narration → Speech output
  Only place language exists in the system.
```

### Society of Mind Topology

```
Foundation Snapshot (stable base weights)
         │
    ┌────┼────┬────┬────┬── ··· ──┐
    │    │    │    │    │          │
   S1   S2   S3   S4   S5  ···  S20
  (vis) (plan)(social)(anomaly)  (...)
    │    │    │    │    │          │
    └────┼────┴────┴────┴── ··· ──┘
         │
  Collective Convergence/Divergence
         │
   Weighted Synthesis
         │
        Act
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

## Performance Profile

### What Left the Requirements

No LLM inference on the cognitive loop means:

- No GPU memory allocated to billions of parameters
- No KV cache growing with context length
- No autoregressive token generation (every output token requiring a full forward pass)
- No prompt construction, tokenization, or detokenization overhead

That entire compute profile is gone from the critical path.

### What Replaced It

Dense forward passes through small networks on fixed-dimensionality inputs.

**Input tensor sizing (bounded, not sequence-dependent):**

- Drive vector: 12 floats
- Vision embeddings (YOLO backbone): ~512–1024 dimensions
- Audio features (Whisper encoder): ~512–1024 dimensions
- Recent episodic memory context: fixed window of N embeddings
- Panel state vectors: small

Total fused input: a few thousand dimensions. Fixed. Not growing with context.

**Model sizing:**

- Global model: hundreds of thousands to low millions of parameters (a few dense layers)
- Panel models: smaller than global (each sees a domain slice)
- Deliberation pipelines: comparable to global model
- Synthesis model: smallest of all (learned weighting function)

None of these are measured in billions. None require GPU inference.

### Inference Latency

**Single cognitive cycle (worst case — full Type 2 engagement):**

- 1 global model forward pass
- 4 panel model forward passes
- 3 deliberation pipeline forward passes
- 1 synthesis model forward pass
- ~10 small forward passes total

**Expected latency: sub-millisecond aggregate on CPU.**

A forward pass through a model with ~1M parameters on a fixed-size input tensor is microseconds on modern hardware. Ten of them is still microseconds.

**For comparison:** A single LLM inference call generating even a short response takes hundreds of milliseconds to seconds.

### Hardware Implications

| Component | Hardware Requirement |
|-----------|---------------------|
| Cognitive pipeline (all models) | CPU — M2 Mac handles trivially |
| Communication panel (gemma2:2b) | Modest GPU/Neural Engine — already running via Ollama |
| Sensory encoders (YOLO, Whisper) | Most expensive compute, unchanged from current arch |
| Society of Mind (20 instances) | 20× nearly-nothing is still nearly-nothing for inference |
| Continuous training | Background compute budget, not latency-critical |
| ESP32 drive model (if quantized to int8) | Could potentially run on the ESP32 itself |

Sylphie *thinks* in microseconds. She *speaks* in milliseconds. The thinking never waits for the speaking.

The most expensive operations in the system are the sensory encoders (YOLO, Whisper) — and those are already in the architecture and unchanged by this proposal.

## Deployment: Python Sidecar Architecture

### Why a Sidecar

The custom TensorFlow pipelines run as a separate Python process alongside the main Sylphie orchestrator. This follows the existing sidecar pattern — the ESP32 is already a hardware sidecar broadcasting drive state. The Python process is the same concept for the cognitive pipeline.

### Interface

The sidecar communicates with the orchestrator via **gRPC with protobuf schemas**:

- Protobuf enforces tensor shapes at the interface boundary
- Localhost IPC latency is negligible (sub-millisecond round trip on top of sub-millisecond inference)
- gRPC scales to distributed deployment without changing the interface — if the society of mind instances need to run across multiple machines, the orchestrator doesn't care

**Hot path:** Receive fused tensor → run cognitive cycle → return action outputs.

**Training loop:** Separate thread/async loop. Accumulates operational data, computes gradients, updates weights on a duty cycle. Training never blocks inference.

### Statelessness

The sidecar is stateless except for the model weights themselves:

- All episodic memory stays in TimescaleDB
- All world knowledge stays in Neo4j
- The sidecar is pure computation — tensors in, tensors out, weights on disk

A sidecar crash loses nothing. Restart, load the last weight checkpoint, resume.

### Society of Mind Deployment

The twenty-instance society is literally twenty sidecar processes:

- Each with its own weight files
- All receiving the same input tensor
- All returning outputs to a coordination layer
- Foundation snapshot enables instant spin-up of new instances
- Failed or drifted instances are replaced from foundation without downtime

## Summary

| Aspect | Current (LLM-based) | Proposed (Custom Pipeline) |
|--------|---------------------|---------------------------|
| Internal representation | Text (serialized/deserialized) | Tensors (native) |
| Inference cost | High (autoregressive generation) | Low (dense forward pass) |
| Latency | Variable, hundreds of ms | Consistent, sub-millisecond |
| Type 2 deliberation | Multi-LLM focus group (slow, expensive) | Three specialized tensor pipelines (fast, cheap) |
| Personality | Prompted | Learned |
| Development | Static (frozen weights) | Continuous (live training) |
| Identity | Configuration | Emergent |
| Scaling | More GPUs | More sidecar processes |
| Hardware requirements | GPU for LLM inference on every cycle | CPU for cognition, small LLM only for speech |
| LLM role | Brain + voice | Voice only |
| Collective intelligence | Simulated (prompted agents) | Actual (diverged weight instances) |

### Open Questions for Research Team

- **Training cadence:** Online gradient updates per frame vs. batch updates on a duty cycle? At 10Hz from ESP32 alone, that's significant volume.
- **Catastrophic forgetting:** How to keep learning without losing established patterns? Elastic weight consolidation? Replay buffers?
- **Evaluation metrics:** How to measure "good" cognition? Outcome-based metrics? Behavioral consistency? Deliberation efficiency?
- **Society governance:** Optimal weighting strategy for collective decisions? Learned meta-model vs. domain-tagged routing?
- **Specialization divergence:** How far should instances be allowed to drift from foundation before intervention?
- **Training data curation:** For the three deliberation pipelines, how to construct/label the outcome, constraint, and novelty datasets?

The core insight: Sylphie's cognitive loop was never a language problem. We were paying the language tax because LLMs were the only inference tool in the box. A TensorFlow pipeline that operates on the native tensor representations eliminates the translation layer entirely and produces an architecture where the learned weights *are* the mind — shaped not by pre-training on internet text, but by Sylphie's own lived experience.
