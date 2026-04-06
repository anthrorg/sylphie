# Voice Latent Space — TTS Bootstrap & Cache Architecture

## Overview

Sylphie's voice system treats a TTS service (e.g., ElevenLabs) as a **bootstrap dependency**, not a permanent one. Every TTS-generated utterance is captured, encoded, and stored in a voice latent space. Over time, Type 1 retrieval from cached audio replaces live TTS calls, reducing latency, cost, and external dependency.

This follows the same learning loop as semantic Type 1/Type 2 reasoning: the slow, expensive path (TTS API) fires only when the fast path (cached audio retrieval) has no match.

---

## Core Flow

```
Sylphie needs to speak
       │
       ▼
┌──────────────────────────┐
│  Query Voice Latent Space │
│  (cosine similarity on    │
│   semantic + phoneme       │
│   embeddings)              │
└──────────┬───────────────┘
           │
     ┌─────┴─────┐
     │            │
   HIT          MISS
     │            │
     ▼            ▼
┌─────────┐  ┌──────────────────┐
│ Retrieve │  │ Call TTS Service  │
│ cached   │  │ (ElevenLabs API)  │
│ audio    │  └────────┬─────────┘
└────┬────┘           │
     │                ▼
     │         ┌──────────────────┐
     │         │ Capture output   │
     │         │ audio stream     │
     │         └────────┬─────────┘
     │                  │
     │                  ▼
     │         ┌──────────────────┐
     │         │ Encode & store   │
     │         │ in voice latent  │
     │         │ space            │
     │         └────────┬─────────┘
     │                  │
     ▼                  ▼
┌────────────────────────────┐
│      Play audio output      │
└────────────────────────────┘
```

---

## Storage Granularity

Not all utterances should be cached at the same level. The system uses a tiered granularity strategy:

### Full Phrase Cache (High Priority)
- High-frequency complete utterances: greetings, acknowledgments, transitions
- Examples: "Hello", "I understand", "Let me think about that", "Goodbye"
- Stored as complete audio clips — no stitching needed
- Fastest retrieval, highest quality

### Word/Short-Phrase Segments (Medium Priority)
- Common words and 2-3 word phrases extracted from full utterances
- Used for constructing novel sentences from cached segments
- Requires alignment metadata (timing, prosody markers) for smooth concatenation

### Phoneme-Level Patterns (Long-Term Goal)
- Sub-word audio units capturing Sylphie's specific voice characteristics
- Enables synthesis of arbitrary utterances without TTS fallback
- This is the evolutionary endgame — effectively a learned vocoder

---

## Data Model

Each entry in the voice latent space consists of:

```
VoicePattern {
  id:               UUID
  semantic_embedding: float[768]     // What is being said (text meaning)
  audio_embedding:    float[512]     // How it sounds (neural codec encoding)
  audio_data:         bytes          // Raw audio clip (WAV/PCM)
  text_content:       string         // Original text that was spoken
  duration_ms:        int            // Clip length
  prosody_metadata: {
    pitch_contour:    float[]        // F0 over time
    energy_contour:   float[]        // Volume/emphasis over time
    speaking_rate:    float          // Words per second
    emotional_valence: float         // Drive engine valence at time of generation
  }
  granularity:        enum           // FULL_PHRASE | SEGMENT | PHONEME
  usage_count:        int            // Frequency tracking for cache prioritization
  created_at:         timestamp
  last_used_at:       timestamp
  source:             enum           // TTS_BOOTSTRAP | SELF_GENERATED
}
```

---

## Persistence Architecture

Mirrors the semantic latent space three-tier model:

| Layer | Store | Purpose | Access Speed |
|-------|-------|---------|-------------|
| **Hot** | In-memory index | Active Type 1 voice lookups | Microseconds |
| **Warm** | TimescaleDB + pgvector | Durable pattern store, survives reboot | Milliseconds |
| **Cold** | Object storage (S3/MinIO) | Full audio blobs, bulk archival | Seconds |

### Boot Sequence
1. Load high-frequency voice patterns (by `usage_count`) into hot layer
2. Lazy-load remaining patterns as needed
3. Sylphie is vocally functional within seconds of startup

### Write Path
1. TTS generates audio → audio streams to output AND capture pipeline
2. Audio is encoded via neural codec (EnCodec / SoundStream) → `audio_embedding`
3. Text is encoded via sentence transformer → `semantic_embedding`
4. Prosody is extracted (pitch, energy, rate) → `prosody_metadata`
5. Full record written to warm layer (TimescaleDB)
6. Hot layer updated with new pattern
7. Audio blob written to cold layer

---

## Retrieval Strategy

### Type 1 Voice Lookup
1. Incoming text to speak is encoded → `query_embedding`
2. Cosine similarity search against `semantic_embedding` in hot layer
3. If similarity > threshold (e.g., 0.92):
   - Retrieve cached audio
   - Adjust prosody if current drive engine valence differs from stored valence
   - Play directly — no TTS call
4. If similarity < threshold:
   - Fall back to TTS (Type 2 voice path)
   - Capture and store result

### Similarity Considerations
The threshold must account for the fact that semantically similar text may require very different audio. "I'm fine" said reassuringly vs. sarcastically are the same text but different voice patterns. The query should factor in:
- Semantic content (what)
- Emotional valence from drive engine (how)
- Conversational context (e.g., question vs. statement)

A composite similarity score across these dimensions prevents false cache hits.

---

## Prosody Adaptation

Cached audio won't always match the current emotional state. If the drive engine valence has shifted since the clip was originally generated, basic prosody adjustments can be applied:

- **Pitch shifting** — raise/lower F0 to match target valence
- **Rate adjustment** — speed up (excitement) or slow down (contemplation)
- **Energy scaling** — amplify (urgency) or attenuate (calm)

These are lightweight DSP operations that can be applied to cached audio without regenerating from TTS. Libraries like `librosa` or `rubberband` handle this in real-time.

This means a cached "I understand" generated in a neutral state can be adapted to sound empathetic, excited, or concerned without a new TTS call.

---

## Maturity Curve

| Phase | Voice Latent Space State | TTS Dependency |
|-------|-------------------------|----------------|
| **Day 1** | Empty | 100% TTS — every utterance hits the API |
| **Week 1** | Common phrases cached | ~70% TTS — greetings and frequent responses served locally |
| **Month 1** | Rich phrase library + segments | ~30% TTS — only novel sentences hit the API |
| **Month 6** | Dense coverage + phoneme patterns | ~5-10% TTS — long-tail novelty only |
| **Long-term** | Learned voice model from accumulated data | TTS as rare fallback, potential for full independence |

---

## Cost Implications

ElevenLabs charges per character. With voice caching:

- **Without caching**: Every utterance = API call = cost
- **With caching**: Only first occurrence of each phrase pattern = cost
- **Projected savings**: 80-90% reduction in TTS API costs within first few months
- **Latency improvement**: Cached retrieval (~1ms) vs. API call (~600-900ms)

---

## Voice Identity & Evolution

### Initial Voice Setup
The TTS service is configured with a custom voice — either:
- A voice designed via ElevenLabs Voice Design (specifying age, gender, accent, tone)
- A cloned voice (subject to ElevenLabs terms — own voice only for PVC)

This base voice seeds the latent space. All cached patterns carry this voice's characteristics.

### Evolutionary Drift
Over time, if prosody adaptations are applied frequently in a consistent direction (e.g., Sylphie tends to speak more softly than the base TTS voice), these adapted versions become the new cached standard. The voice subtly evolves through use — not through retraining, but through accumulated micro-adjustments.

This is emergent voice identity. No two Sylphie instances running long enough would sound exactly the same.

---

## Integration Points

| System | Role |
|--------|------|
| **Drive Engine** | Provides emotional valence for prosody selection and adaptation |
| **Communication Panel (CANON)** | Decides *what* to say; voice system decides *how* it sounds |
| **TimescaleDB / pgvector** | Warm storage for voice pattern persistence |
| **SensoryFrame** | Incoming audio (STT) may inform prosody matching (mirror speaking style) |
| **Learning Panel** | Tracks voice cache hit rates, identifies gaps, logs evolution |

---

## Open Questions

1. **Stitching quality** — Can word-level segments be concatenated smoothly enough to sound natural, or will seams be audible? Need to prototype and evaluate.
2. **Similarity threshold tuning** — Too low = wrong clips retrieved. Too high = unnecessary TTS calls. Requires empirical calibration.
3. **Storage growth** — Audio is larger than text embeddings. What's the realistic storage footprint after 6 months of conversation? Need to estimate and plan.
4. **Prosody adaptation limits** — How far can pitch/rate/energy be shifted before artifacts appear? There's a window of natural-sounding modification beyond which re-synthesis is better.
5. **Codec selection** — EnCodec vs. SoundStream vs. other neural codecs for the audio embedding. Need benchmarking on reconstruction quality at target bitrate.
