# Multimodal Sensory Fusion for Sylphie 2.0
## Research Summary — April 2026 (Revised)

---

## The Problem

Sylphie's Decision Making panel receives three input streams: **text**, **video**, and **drive state**. These arrive at different rates, in different formats, and with different temporal characteristics. They need to be combined into a unified sensory picture that the executor engine and inner monologue can reason over.

| Input        | Source                                  | Format                        | Rate             |
|------------- |---------------------------------------- |-------------------------------|------------------|
| Text         | STT API → transcribed speech or typed   | String                        | Event-driven     |
| Video        | Python sidecar (OpenCV + YOLO)          | Structured detections/features| Continuous (~FPS) |
| Drive state  | Internal drive engine package           | 12-float pressure vector      | Internal tick    |

Audio is not a separate modality — STT converts speech to text, which feeds the text channel. TTS is outbound only (communication panel), not a sensory input.

---

## The Pattern: Intermediate Fusion

This is a well-studied problem in AI called **multimodal fusion**. The research landscape has converged on three strategies, and one maps directly to what Sylphie needs.

### Early Fusion — Combine raw inputs before processing
Concatenate or interleave raw data from all modalities into a single input and process them together. This works when modalities share similar dimensions (like stacking RGB + depth into a 4-channel image). It breaks down when modalities have fundamentally different structures — text is sequential tokens, video is spatial detections, and drive state is a numeric vector. Cramming these together at the raw level would be a mess.

**Not a fit.**

### Late Fusion — Process everything independently, merge decisions at the end
Each modality runs through its own complete pipeline and produces an independent output. These outputs get merged at the end — by voting, averaging, or a small combiner. This is modular but misses cross-modal interactions. Sylphie hearing "I'm fine" while seeing a frowning face should produce a different understanding than "I'm fine" with a smile. Late fusion can't capture that because the modalities never interact until it's too late.

**Too shallow.**

### Intermediate Fusion — Encode separately, fuse in a shared latent space
Each modality gets its own encoder that understands that specific data type. The encoders produce fixed-dimensional feature vectors (embeddings). These embeddings are then projected into a **shared latent space** where they can be combined, compared, and reasoned over together. This is the dominant pattern in modern multimodal AI.

**This is the one.**

---

## The Architecture

```
┌──────────────┐   ┌───────────────────┐   ┌──────────────────┐
│  Text Input  │   │   Video Input     │   │   Drive State    │
│              │   │                   │   │                  │
│ STT API or   │   │ Python sidecar    │   │ Internal drive   │
│ typed text   │   │ (OpenCV + YOLO)   │   │ engine package   │
└──────┬───────┘   └────────┬──────────┘   └────────┬─────────┘
       │                    │                       │
       ▼                    ▼                       ▼
┌──────────────┐   ┌───────────────────┐   ┌──────────────────┐
│ Text Encoder │   │  Video Encoder    │   │  Drive Encoder   │
│              │   │                   │   │                  │
│ Ollama embed │   │ Normalize YOLO    │   │ Normalize 12     │
│ → d-dim vec  │   │ output → d-dim   │   │ floats → d-dim   │
└──────┬───────┘   └────────┬──────────┘   └────────┬─────────┘
       │                    │                       │
       └────────────────────┼───────────────────────┘
                            │
                            ▼
                   ┌─────────────────┐
                   │  Sensory Fusion │
                   │     Layer       │
                   └────────┬────────┘
                            │
                            ▼
                   ┌─────────────────┐
                   │  SensoryFrame   │
                   │                 │
                   │  Consumed by    │
                   │  executor engine│
                   │  + inner        │
                   │  monologue      │
                   └─────────────────┘
```

---

## What Each Encoder Does

### Text Encoder
Takes the transcribed or typed text string. Calls Ollama's embed API with a local embedding model (e.g., `nomic-embed-text` or `mxbai-embed-large`). Returns a d-dimensional vector representing the semantic content. This is ~5 lines of TypeScript:

```typescript
import ollama from 'ollama';

async function encodeText(text: string): Promise<number[]> {
  const response = await ollama.embed({
    model: 'nomic-embed-text',
    input: text,
  });
  return response.embeddings[0]; // 768-dim vector
}
```

Runs locally via Ollama. No cloud dependency. Typical embedding models produce 384–1024 dimensional vectors.

### Video Encoder
Consumes structured output from the Python sidecar (OpenCV + YOLO). The sidecar does the heavy lifting — frame capture, object detection, bounding boxes, class labels, confidence scores. The TS-side encoder receives this structured data and normalizes it into a d-dimensional vector.

The Python sidecar output might look like:
```json
{
  "timestamp": 1712345678,
  "frame_id": 42,
  "detections": [
    { "class": "person", "confidence": 0.94, "bbox": [120, 80, 340, 460] },
    { "class": "cup", "confidence": 0.87, "bbox": [400, 300, 450, 380] }
  ],
  "scene_features": { ... }
}
```

The video encoder in TS takes this and produces a fixed-length numeric vector. How you do that projection depends on what features matter — you could encode detection counts by class, spatial positions, confidence distributions, scene-level features, or a combination. The key constraint is that the output must be d-dimensional, same as the other encoders.

For communication between the Python sidecar and TS: local HTTP endpoint, Unix socket, or shared memory. Local HTTP is simplest to start with — the sidecar runs a tiny Flask/FastAPI server, the TS side polls or subscribes.

### Drive Encoder
Takes the 12-float pressure vector from the drive engine package. This is already numeric — it just needs normalization (z-score or min-max scaling) and a projection to d dimensions. If d > 12, you're padding/projecting up via a weight matrix. If d matches or is close, it might be as simple as normalization alone.

```typescript
function encodeDrives(driveVector: number[]): number[] {
  const normalized = zScoreNormalize(driveVector);
  return linearProject(normalized, projectionMatrix); // 12 → d dims
}
```

This is the lightest encoder — pure math, no model calls, no external processes.

### The key constraint: same dimensionality out
Every encoder produces a vector of the **same dimensionality** `d`. This is what makes fusion work. Once everything is in the same vector space, you can combine them without needing to know what modality they came from. The choice of `d` depends on the embedding model — if you're using `nomic-embed-text` (768-dim), then d=768 and the video and drive encoders project to 768 as well.

---

## The SensoryFrame

The output of the fusion layer is a **SensoryFrame** — a single timestamped object representing Sylphie's complete perception at a given moment. This is what gets passed to the executor engine and the inner monologue.

```typescript
interface SensoryFrame {
  timestamp: number;

  // The fused embedding — the "gestalt" of all active modalities
  fused_embedding: number[];       // d-dimensional vector

  // Individual modality embeddings (preserved for downstream use)
  modality_embeddings: {
    text?: number[];               // present if text input arrived
    video?: number[];              // present if video sidecar active
    drives: number[];              // always present (internal tick)
  };

  // What's active this frame
  active_modalities: string[];     // e.g. ["text", "drives"] or ["text", "video", "drives"]

  // Raw values preserved for logging to TimescaleDB
  raw: {
    text?: string;
    drive_vector?: number[];
    video_detections?: {
      class: string;
      confidence: number;
      bbox: number[];
    }[];
  };
}
```

### Why preserve individual embeddings
Even though the fused embedding is what gets reasoned over, keeping individual modality embeddings lets downstream systems do modality-specific work. The inner monologue might want to check "what did they say vs what am I seeing" — that's a comparison between text and video embeddings. The learning pipeline might want to store the text embedding separately for knowledge graph operations. The drive engine only cares about its own vector.

### Why preserve raw values
TimescaleDB logging needs the actual text, the actual detections, the actual drive values — not just embeddings. The raw fields are for the "record every event in great detail" annotation from the diagram.

---

## Graceful Degradation: Modality Dropout

The system must work when modalities are missing. Video might not be running (no camera, sidecar not started). Text only arrives when someone is talking. Sometimes it's just drive state alone (idle, no interaction).

The pattern:
- Missing modalities get a zero vector (or a learned "absent" embedding)
- The fusion layer produces reasonable output regardless of which combination is present
- `active_modalities` on SensoryFrame tells downstream consumers what's actually available

This matters for incremental development. Text + drives will be all you have for a while. Video comes later when the Python sidecar is wired up. The fusion layer handles all of these states from day one without downstream changes.

---

## Fusion Strategies

Once you have d-dimensional embeddings from each encoder, how do you combine them? Three options in order of complexity:

### 1. Concatenation + Linear Projection (simplest, start here)
Stack all embeddings into a (3 × d) vector. Pass through a linear layer that projects back to d dimensions. Fast, easy to implement. Doesn't model interactions between modalities.

```
fused = Linear(concat(text_emb, video_emb, drive_emb))
```

For missing modalities, their slot in the concatenation is zeros. The linear projection learns to handle that.

### 2. Weighted Sum with Learned Weights
Each modality gets a weight. Sum the weighted embeddings. Lets the system learn "video matters more than text in this context." Simple but captures modality priority.

```
fused = w_text * text_emb + w_video * video_emb + w_drive * drive_emb
```

### 3. Cross-Attention Fusion (most powerful, add later if needed)
Attention mechanisms let modalities "attend" to each other. Text can attend to video features to ground language in visual context. Video can attend to drive state to interpret scenes through the lens of current emotional state. Captures rich cross-modal interactions. More complex to implement and heavier to run.

**Recommendation**: Start with concatenation + projection. It works, it's dead simple, and the SensoryFrame interface is identical regardless of fusion strategy. You can swap in cross-attention later without changing anything downstream.

---

## Temporal Alignment: The Tick Problem

Your modalities arrive at different rates:
- **Drive state**: Whatever tick rate the drive engine runs at (you decide this)
- **Text**: Event-driven (arrives when someone speaks or types)
- **Video**: Continuous frames from the Python sidecar (5–30 FPS depending on config)

You need a strategy for producing SensoryFrames at a consistent rate.

### Pattern: Tick-Driven Sampling
Run sensory fusion on a fixed tick aligned with the executor engine's tick rate. At each tick:
1. Take the latest drive state (always available — internal package)
2. Take the most recent text input (if any arrived since last tick)
3. Take the most recent video detection output (if sidecar is running)
4. Encode each active modality, fuse, emit SensoryFrame

This is a **latest-value** strategy — at each tick you snapshot the most recent state of each modality. Simple and it works when the downstream consumer (executor engine) is also tick-driven.

The tick rate is yours to choose. It should match whatever cadence the executor engine runs at. The drive engine's internal tick rate is the natural anchor since it's the only modality that's always producing.

### Pattern: Event-Driven with Accumulation
Instead of fixed ticks, emit a new SensoryFrame whenever a "significant" input arrives (new text, notable visual change). Drive state accumulates in the background. More efficient but more complex.

**Recommendation**: Start with tick-driven, anchored to the drive engine's tick rate. Simplest approach, aligns with what the executor already expects.

---

## Key Reference: Meta's ImageBind

The strongest prior art for unified multimodal embedding is Meta's **ImageBind** (2023, open source, Apache 2.0). It creates a single joint embedding space across six modalities: images, text, audio, depth, thermal, and IMU data.

The key insight: you don't need paired data across all modality combinations. ImageBind uses images as an anchor modality — it only trains on image-paired data (image+text, image+audio, etc.) and the other modalities emerge as aligned in the shared space. Each modality gets a separate encoder (ViT for images, CLIP's text encoder for text, ViT on spectrograms for audio) plus a linear projection head to reach the shared d-dimensional space.

For Sylphie, the takeaway is architectural: separate encoders per modality, linear projection to shared space, fusion via the shared space. You don't need ImageBind itself — Sylphie's modalities and tasks are different — but the pattern is proven.

**GitHub**: github.com/facebookresearch/ImageBind

---

## Implementation Plan

### Phase 1: Text + Drives (start here)
- Text encoder: `ollama.embed()` with `nomic-embed-text` or similar
- Drive encoder: normalize 12-float vector, linear projection to d dimensions
- Fusion: concatenation + linear projection (two modalities)
- Tick sampler: aligned to drive engine tick rate
- SensoryFrame flows to executor engine
- Frontend shows live SensoryFrame state

### Phase 2: Add Video
- Stand up the Python sidecar (OpenCV + YOLO)
- Video encoder in TS: normalize sidecar output → d-dim vector
- Plug into fusion layer — it gains a third embedding to concatenate
- SensoryFrame gains video data
- Consider upgrading fusion strategy if cross-modal interactions matter at this point

### Each phase is independent
The SensoryFrame interface stays the same throughout. The executor engine doesn't change when you add a modality. The fusion layer grows but its output shape doesn't. Add modalities without rewriting consumers.

---

## File Placement

```
packages/decision-making/src/inputs/
├── sensory-frame.ts           # SensoryFrame interface
├── encoders/
│   ├── text.encoder.ts        # Ollama embed call
│   ├── video.encoder.ts       # normalize Python sidecar output
│   └── drive.encoder.ts       # normalize + project 12-float vector
├── fusion/
│   └── sensory-fusion.ts      # combine encoder outputs → SensoryFrame
├── sampling/
│   └── tick-sampler.ts        # tick-driven frame production
└── index.ts
```

The `SensoryFrame` type should also be exported from `packages/shared/src/types/` since it's consumed by multiple panels.

---

## LLM Usage in This Layer

To be explicit about where LLMs are and aren't used in sensory input:

| Component       | LLM?  | What                                     |
|---------------- |-------|------------------------------------------|
| Text encoder    | Yes   | Ollama embed API (local embedding model) |
| Video encoder   | No    | YOLO is a vision model, not an LLM. TS side is pure math. |
| Drive encoder   | No    | Pure math — normalize + project          |
| Fusion layer    | No    | Linear algebra — concat + projection     |
| STT (upstream)  | Yes   | External API, not part of this layer     |

The only LLM call in the sensory pipeline is the text embedding, and that's a lightweight local model specifically designed for fast embedding generation — not inference or reasoning.
