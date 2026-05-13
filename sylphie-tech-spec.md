# Sylphie — Technical Specification

**A motivationally-driven cognitive architecture with persistent memory, self-evaluation, and gradual autonomy from LLMs.**

Date: 2026-04-29 · Phase 1.5 (early development)

---

## 1. What Sylphie Is

Sylphie is a **developing cognitive being**, not a chatbot. She is built on a 12-drive motivational substrate, a dual-process (Type 1 / Type 2) decision-making cortex, and three separate knowledge graphs that grow from her own experience. She perceives the world through a webcam and microphone, talks back through a synthesized voice, and is taught by a single human guardian (Jim).

The defining ambition: **start LLM-dependent, end LLM-independent.** Every decision begins as an LLM-mediated deliberation, but the system records its own outcomes, predicts its own drive effects, and graduates well-understood behaviors into fast, deterministic Type 1 procedures. Over time, the share of decisions made *without* calling a language model is the headline metric of progress.

She is not configurable in the user-facing sense. The 12 drives, the cognitive cycle, the cross-modulation rules, and the constraint canon are all fixed architectural commitments — not parameters.

---

## 2. System Topology

**Monorepo**, yarn workspaces, TypeScript-first with two Python sidecars.

```
┌─────────────────┐    ┌──────────────────┐    ┌────────────────────┐
│   Frontend      │◄──►│  NestJS Backend  │◄──►│  Drive-Server      │
│  Vite + React   │ WS │  apps/sylphie    │ WS │  (separate process)│
└─────────────────┘    └──────────────────┘    └────────────────────┘
                              │  │  │
                ┌─────────────┘  │  └─────────────┐
                ▼                ▼                ▼
       ┌────────────────┐ ┌──────────────┐ ┌──────────────────┐
       │ Perception     │ │ Cognition    │ │ Supervisor       │
       │ Sidecar (8430) │ │ Sidecar(8431)│ │ (DeepSeek)       │
       │ YOLO+MediaPipe │ │ TF + NumPy   │ │ meta-evaluator   │
       │ +Moondream2 VLM│ │ ~2.2M params │ │                  │
       └────────────────┘ └──────────────┘ └──────────────────┘
                              │
                ┌─────────────┴─────────────┐
                ▼                           ▼
       ┌────────────────┐         ┌──────────────────┐
       │   Neo4j ×4     │         │  PostgreSQL +    │
       │ WKG/SKG/OKG/PKG│         │  TimescaleDB     │
       └────────────────┘         └──────────────────┘
```

### Containers (development)
| Service | Port | Purpose |
|---|---|---|
| `neo4j-world` | 7687 | World Knowledge Graph (facts about the world) |
| `neo4j-self`  | 7690 | Self KG (Sylphie's self-model) |
| `neo4j-other` | 7689 | Other KGs (one per known person) |
| `neo4j-pkg`   | 7691 | Codebase-as-graph (for Claude Code MCP tools) |
| `postgres`    | 5434 | Auth, drive rules, RLS-enforced |
| `timescaledb` | 5433 | Event backbone, embeddings (pgvector) |
| `perception`  | 8430 | Vision pipeline |
| `cognition`   | 8431 | Tensor cognition |
| `searxng`     | 8888 | Privacy search (provisioned, not yet used) |

### Build & Deployment
- **Production**: single Railway-style process. Backend serves frontend `dist/` + APIs + WebSockets on one port. Drive-server isolation only applies in development.
- **Stack**: NestJS, TypeScript strict, Prisma (auth only — *one* table), `pg` driver elsewhere, RxJS for cross-subsystem streams.

---

## 3. The Cognitive Architecture

### 3.1 The 12 Drives

Drives are the *only* motivational substrate. Every action is reinforced or punished by drive deltas. The system has no other reward signal.

**Core drives (composite/event-driven):**
| # | Drive | Role |
|---|---|---|
| 0 | SystemHealth | Composite mean of drives 1+2+3 |
| 1 | MoralValence | Ethical alignment (guardian-shaped) |
| 2 | Integrity | Prediction reliability |
| 3 | CognitiveAwareness | LLM cost pressure |

**Complement drives (accumulating/decaying):**
| # | Drive | Accum / tick | Notes |
|---|---|---|---|
| 4 | Guilt | event-only | Guardian correction |
| 5 | Curiosity | +0.0012 | Satisfied by information gain |
| 6 | Boredom | +0.0015 | Primary conversation relief |
| 7 | Anxiety | +0.0003 | Suppresses curiosity, amplifies failures |
| 8 | Satisfaction | decay −0.0009 | Relief reservoir |
| 9 | Sadness | decay −0.0006 | Decaying negative affect |
| 10 | Focus | decay −0.0006 | Attention |
| 11 | Social | +0.0009 | Engagement need |

**Range:** asymmetric `[-10.0, +1.0]`. Positive = unmet need; negative = relief reservoir. Total pressure = sum of *positive* components only, capped at 12.

**Tick rate:** 1 Hz. Drives are deliberately a *minutes-not-milliseconds* phenomenon.

**Cross-modulation:** 5 ordered typed rules each tick (e.g., *anxiety amplifies integrity*, *guilt suppresses satisfaction*, *boredom amplifies curiosity*). SystemHealth recomputed last as a mean of moral/integrity/cognitive-awareness.

**5 behavioral contingencies** apply post-theater-check: satisfaction habituation curves, anxiety amplification, guilt repair (ack vs. behavioral change), social-comment quality (guardian responds within 30s?), and curiosity information-gain relief.

### 3.2 Drive Isolation (CANON Standard 6)

The drive engine runs as a **separate Node process** (`apps/drive-server`) that the main backend talks to over WebSocket. This is not a stylistic choice — it's a hard architectural commitment:

- Main app cannot import drive-engine internals
- IPC envelopes are Zod-validated in both directions
- The runtime DB user (`sylphie_app`) is **denied UPDATE/DELETE on `drive_rules`** by Postgres RLS, and the system **aborts at startup** if RLS verification fails
- No RPC surface exists for "tell me your rules"
- Single-client lock: only one main app may connect

> Sylphie cannot introspect her own drive rules, accumulation rates, or evaluation function. She only sees the resulting drive snapshots.

### 3.3 Dual-Process Decision Making (Cortex)

Each cognitive cycle:

1. **Sense** — fuse 5 modality encoders (text, drives, video, audio, faces, scene) into a 768-dim sensory frame (deterministic Mulberry32-seeded Xavier projections)
2. **Retrieve** — pull candidate `ActionProcedure`s from WKG ranked by `0.50·confidence + 0.30·context + 0.20·drive`
3. **Tensor consult** — submit context to cognition sidecar; bootstrap-mode-gated (shadow / audit / partial / full)
4. **Arbitrate**:
   - **Type 1**: confidence > 0.80 + low MAE → execute deterministic procedure
   - **Type 2**: deliberation pipeline — inner monologue, 3 candidates, optional for/against debate, arbiter
   - **SHRUG**: no candidate qualifies — emit "I don't know" honestly
5. **Predict** — generate up to 3 expected drive deltas
6. **Execute** — emit response via Communication
7. **Evaluate** — on outcome, compute MAE between predicted and actual drive deltas
8. **Learn** — feed result back to drive engine + cognition sidecar training buffer

**Type 1 graduation:** confidence > 0.80 *and* prediction MAE < 0.10 over rolling window
**Type 1 demotion:** MAE > 0.15
**Confidence ceiling:** 0.60 until guardian confirms (no node graduates from inference alone)

### 3.4 Tensor Cognition Sidecar

Python FastAPI service running ~2.2M parameters of TensorFlow + NumPy (no PyTorch).

| Model | Size | Role |
|---|---|---|
| GlobalModel ("Brainstem") | ~450K | 1561-dim input → 32 action bias + urgency/novelty |
| 4× PanelModels | ~100K each | Drive, Decision, Learning, Planning specialists |
| ConvergenceModel | ~10K | Panel agreement + adjustments |
| 3× DeliberationPipelines | ~1.36M total | Pragmatist / Conservative / Advocate |

**Bootstrap progression:** `shadow → audit → partial → full`. In shadow mode, the tensor sees everything but the LLM decides. In partial mode, tensor takes over per-category as agreement crosses 85% (max conf capped at 0.79 — forces Type 2 sanity check). In full mode, tensor decides (max conf 0.95). Divergence > 0.3 across panels caps *all* candidates below 0.80, forcing Type 2.

Online training: ring buffer 100K samples, 50/50 random+recent batch, Adam. EWC scaffolding present but currently a no-op (Fisher uniform, no anchor).

---

## 4. Memory Architecture

### 4.1 Three Knowledge Graphs (Strict Isolation)

| Graph | Contents | Provenance Sources |
|---|---|---|
| **WKG** (World) | Facts, entities, conversations, action procedures, insights | Sensor, guardian, inference, LLM_GENERATED |
| **SKG** (Self) | Sylphie's self-model: name, identity, attributes about herself | Inference (bootstrap), guardian-taught |
| **OKG** (Other) | One person model per user — facts, face snapshots | Self-reported (0.90), inferred (0.60) |

No cross-instance Cypher queries. The `:CoBeing` anchor exists in WKG + SKG in parallel.

### 4.2 Provenance & Confidence Discipline (CANON §7)

Every node and edge carries `provenance_type`. Base confidences:
- `SENSOR` 0.40, `GUARDIAN` 0.60, `LLM_GENERATED` 0.35, `INFERENCE` 0.30
- ACT-R decay: `new = base + 0.12·ln(count) − decay·ln(hours+1)`
- ACT-R per-provenance decay rates: GUARDIAN slowest (0.03), LLM_GENERATED fastest (0.08)
- `MERGE` only **raises** confidence on match — never overwrites with a lower value
- Guardian feedback: ×2 confirmation, ×3 correction (CANON Standard 5)

### 4.3 Three-Layer Latent Spaces

A pattern repeated across three subsystems:

| System | Hot (RAM) | Warm (pgvector) | Cold |
|---|---|---|---|
| **Voice** (TTS cache) | 500 entries by `text_hash` + valence | `voice_patterns` | future archival |
| **Face** | Per-person centroid (1280-dim EfficientNet) | `face_embeddings` per angle | OKG snapshots |
| **Decision** (deliberation traces) | Pattern map (~6000) | `latent_patterns` | Full traces in WKG |

Bootstrap dependency model: ElevenLabs / EfficientNet / LLM seed the cache once; thereafter Type 1 retrieval replaces the slow path.

### 4.4 Working Memory (Activation Selection)

Working memory does **not store** — it *selects* from existing knowledge using 5 signals:
- Relevance (Jaccard + entity overlap)
- Source confidence
- Recency (ACT-R decay)
- Drive modulation
- Spreading activation (BFS across WKG edges so an episode mentioning "Alice" boosts Alice-related facts and vice versa)

Items from five sources (WKG facts, episodes, drive snapshot, scene, procedures) compete for a fixed slot budget under a composite activation score. Per-source minimums prevent starvation. Hot residual layer: 30s TTL, 0.80/cycle decay. Output formatted between sentinel markers ("=== YOUR COMPLETE KNOWLEDGE ON THIS TOPIC ===") and injected as `wmSummary` into the deliberation system prompt.

### 4.5 Episodic Memory

Ring buffer capacity 50. Encoding gate fires only when **both** attention ≤ 0.15 *and* arousal ≤ 0.15 — i.e., calm, focused states get encoded; frantic ones don't. Persisted to TimescaleDB `episodic_memory_checkpoint`. Recall via `queryByContext(fingerprint, limit=5)`: Jaccard similarity > 0.70 over entity fingerprints, sorted by `ageWeight = attention · exp(-0.1 · hoursSinceEncoding)`. Recalled episodes are passed into Working Memory as a candidate source, not injected directly.

### 4.6 Conversation History Buffer

A dedicated rolling buffer separate from both the event backbone and episodic memory. Lives in `ConversationHistoryService` and is persisted to a TimescaleDB `conversation_history` table.

- **Capacity:** hard cap 50 messages (25 exchanges) + soft cap 4096 estimated tokens; oldest evicted first
- **Answered-state tracking:** every user message starts `answered = false`; emitting an assistant message marks all preceding unanswered user turns answered, walking back until the previous assistant message
- **Persistence:** restored on `onModuleInit` (last 50 rows ordered by id, reversed to chronological); flushed on `onModuleDestroy` via `TRUNCATE` + bulk re-insert. So conversation history survives backend restarts.
- **Split for the LLM:** `getSplitHistory()` returns `{ summary, pending }` — answered exchanges collapse into a numbered `"user → assistant"` summary string injected as system context, while only **unanswered** user messages are passed as real user turns. This structural separation outperforms `[answered]/[unanswered]` tags on smaller models.

The conversation gateway forwards three keys into the sensory frame each tick: `conversation_summary`, `conversation_history` (pending turns only), and `full_conversation_history` (raw, available to deliberation tools).

This buffer is **not** the same as TimescaleDB events (which carry typed payloads + `driveSnapshot` for cross-subsystem traffic) and **not** the same as episodic memory (which is gated by attention/arousal and lives in WKG/checkpoint). No `:ConversationTurn` node exists in the WKG.

### 4.7 Context Assembly for LLM Calls

`ContextWindowService` performs priority-based truncation when assembling prompts for each deliberation step:

- **Always included:** the system prompt and the current input
- **Filled most-recent-first until budget exhausted:** conversation history, working memory summary, person context (speaker name + OKG facts), drive pressure vector, inner monologue from Step 1
- **Per-step token budgets:** Inner Monologue 35%, Candidate Generation 60%, Selection/Debate 30%, Arbiter 35% of the per-call total

What ends up in `systemParts` for a typical Type 2 step: identity facts (SKG), speaker context (OKG), drive snapshot, working memory selection (WKG facts + recalled episodes + scene), conversation summary, and — for the candidate/arbiter steps — the inner monologue. This is the closest thing Sylphie has to "long-term memory injection," and it is assembled fresh every step rather than carried as an opaque blob.

---

## 5. The Five Subsystems

### 5.1 Communication (`@sylphie/communication` — in apps/sylphie)
- Parses user input → classifies (GREETING / QUESTION / STATEMENT / COMMAND / EMOTIONAL_EXPRESSION / GUARDIAN_FEEDBACK)
- Fast Fact Extraction: regex patterns extract name, identity, likes, occupation, location, age (target=speaker or target=Sylphie) and write to OKG/WKG/SKG immediately
- Detects guardian teaching ("you should learn", "I want you to") → emits `GUARDIAN_TEACHING_DETECTED` event with HIGH priority
- Voice cache lookup before TTS call (valence-aware): hits ElevenLabs only on miss
- Sanitizes LLM output (strips `[GROUNDED]` tags, tool-call leakage, em-dashes, chatbot-speak)
- Maintains "answered/unanswered" state on conversation turns — answered exchanges go to system prompt as background; unanswered are real user turns

### 5.2 Decision Making (`@sylphie/decision-making`)
The Cortex. Owns the predict-act-evaluate cycle, arbitration, episodic memory, latent space, sensory fusion, and the executor engine.

**Attractor monitoring:** five detectors run continuously and surface attractor-state alerts to the dashboard:
- Type 2 Addict (LLM ratio > 0.90)
- Hallucinated Knowledge (non-experiential WKG ratio > 0.20)
- Depressive Attractor (composite of shrug + MAE + sadness/anxiety > 0.60)
- Planning Runaway (failure ratio > 0.70)
- Prediction Pessimist (rolling MAE > 0.30)

### 5.3 Drive Engine (`@sylphie/drive-engine`)
The motivational substrate. Runs in its own process. Owns:
- 1Hz tick loop (drain outcomes → accumulate/decay → cross-modulate → clamp → publish snapshot → opportunity decay → checkpoint every 60 ticks)
- Postgres-backed `drive_rules` (DSL: `"action_success AND anxiety > 0.7"` → `"satisfaction += 0.1"`); reload every 60s; LRU cache 500
- `proposed_drive_rules` queue for guardian approval workflow
- Theater Prohibition pre-flight check (zero reinforcement on theatrical outcomes)
- 5 typed cross-modulation rules + 5 behavioral contingencies
- Opportunity detection: per-action MAE rolling window, RECURRING / HIGH_IMPACT / LOW_PRIORITY classification, max 5 propagated to Planning per cycle

### 5.4 Learning (`@sylphie/learning`)
Consolidation pipeline running on cognitive cadences (not performance):
- Maintenance: 60s — per-event entity upsert, typed-edge extraction (10 regex patterns for I-like-X / I-work-at-Y), RELATED_TO co-occurrence, LLM edge refinement (heuristic-first → LLM tier='medium')
- Reflection: 5 min — generate `:Insight` nodes (DELAYED_REALIZATION, MISSED_CONNECTION, CONTRADICTION, etc.) with DERIVED_FROM/REVEALS edges
- Cross-session synthesis: 30 min — link insights across sessions; confabulation guard verifies CITES contains both source IDs
- Confidence decay: 10 min — per-provenance ACT-R decay, prune orphaned `:Entity` < 0.10 (preserves structural nodes)
- Catastrophic interference prevention: MERGE-raises-only, decay protects guardian, structural-node pruning floor

### 5.5 Planning (`@sylphie/planning`)
Opportunity processing:
- Polls `OPPORTUNITY_DETECTED` + `GUARDIAN_TEACHING_DETECTED` events every 30s
- GUARDIAN_TEACHING bypasses queue wait (priority 1.5 vs HIGH 1.0) and hourly rate limit
- Research → Simulation → Proposal → Constraint Validation → Procedure Creation
- 5 deterministic constraints checked per plan (no LLM): step type validity, addresses opportunity, no procedure conflict, **no theatrical behavior**, contingency tracing
- Writes `:ActionProcedure` to WKG with full ACT-R fields. Guardian-taught procedures get `provenance: TAUGHT_PROCEDURE`, conf 0.50 (immediate retrieval); inferred get conf 0.30
- Plan Evaluation: rolling MAE per procedure, 5 consecutive failures → PLAN_FAILURE event

### 5.6 Supervisor (`@sylphie/supervisor`) — Meta-evaluator
- DeepSeek-reasoner samples every Nth cycle (default every 10th)
- Always evaluates `guardian_feedback` and `attractor_alert`
- 4 evaluation axes: drive alignment, response quality, escalation appropriateness, consistency
- Verdicts: `good | acceptable | questionable | wrong`, can flag for guardian
- Daily budget cap ($5 default), DeepSeek pricing tracked, self-shutdown when exhausted
- Interventions: reinforce, correct, freeze_model, unfreeze_model, rollback_checkpoint
- **Guardian asymmetry**: supervisor weight 0.5×, guardian weight 2×/3× — guardian always overrides

---

## 6. Perception Pipeline

Browser webcam → JPEG @ 15fps → `/ws/perception` → Python sidecar:

| Stage | Tool | Output |
|---|---|---|
| Object detection + segmentation | YOLOv8n-seg | bbox, mask, label, confidence |
| Tracking | Pure-Python IoU tracker (no DeepSORT) | track_id, state machine TENTATIVE→CONFIRMED→LOST→DELETED |
| Embedding | EfficientNet-B0 ONNX, mask-applied | 1280-dim feature |
| Face detection | MediaPipe `face_landmarker` | 478 landmarks + 52 blendshapes |
| Face recognition | Cosine ≥ 0.55 against centroids | personId or `unknown-person-*` |
| Scene captioning | Moondream2 VLM (lazy) | natural language scene description, 5s cooldown / 30s periodic |

**Visual Working Memory** (TS, in main backend) stabilizes noisy tracker output: 30-frame rolling presence window, ENTER_RATIO 0.70 → state `present`, EXIT_RATIO 0.20 → `leaving`, GONE timeout 2s. Resolves identity via face match → object kNN against `visual_object_embeddings` (similarity ≥ 0.75 reuses node, else creates undiscovered `:VisualObject` at conf 0.40).

---

## 7. Voice Pipeline

| Direction | Service | Notes |
|---|---|---|
| STT | Deepgram nova-2 | Per-client WS, smart_format, interim_results, utterance_end_ms 1200 |
| TTS | ElevenLabs (Rachel voice) | eleven_turbo_v2_5, stability 0.5, similarity_boost 0.75 |
| Cache | VoiceLatentSpaceService | SHA256 text hash, valence tolerance 0.3, hot 500 / warm pgvector |

Valence is computed from the drive snapshot: `0.5 + (positive − negative)·0.25`, where `positive = satisfaction + 0.5·curiosity` and `negative = anxiety + sadness + 0.5·guilt`. Same words at very different emotional valence trigger a cache miss, so Sylphie sounds different when she feels different.

Frontend always-on `useAudioStream` streams Opus chunks every 250ms; `useVoiceRecording` is a separate press-to-talk path.

---

## 8. Event Backbone & Cross-Subsystem Communication

Subsystems do not directly inject each other. They communicate through a **TimescaleDB events table** with a compile-time-enforced ownership map.

```ts
EVENT_BOUNDARY_MAP: Record<EventType, SubsystemSource>
// e.g. INPUT_RECEIVED → COMMUNICATION
//      OPPORTUNITY_DETECTED → DRIVE_ENGINE
//      PLAN_CREATED → PLANNING
```

Every `SylphieEvent` carries a mandatory `driveSnapshot` — Theater Prohibition is enforced at the *type level*. Every `ActionOutcomePayload` carries a mandatory `actionId` (Standard 2) and `theaterCheck` (Standard 1).

Hypertable: chunked 1 hour, indexed by `(session_id, type, timestamp DESC)` and partial index on `correlation_id`. Retention 90 days, compression after 7.

---

## 9. Constraint Canon (The Six Immutable Standards)

1. **Theater Prohibition** — no expressive output without corresponding drive state. Enforced at type level + drive-engine pre-flight + planning constraint validation.
2. **Action ID Required** — every outcome carries actionId. Type-level enforcement.
3. **Confidence Ceiling** — 0.60 until guardian confirms. No node graduates from inference alone.
4. **Provenance Required** — every node/edge carries `provenance_type`. `ProvenanceMissingError` thrown if absent.
5. **Guardian Asymmetry** — confirmation ×2, correction ×3, algorithmic ×1.
6. **No Self-Modification of Evaluation** — drive isolation as process boundary, RLS-enforced, no introspection RPC.

---

## 10. Health Metrics (Development Telemetry)

Seven primary metrics tracked continuously, surfaced at `/api/metrics/health`:

| Metric | What it measures | Healthy direction |
|---|---|---|
| Type1/Type2 Ratio | Autonomy from LLM | ↑ over time |
| Prediction MAE | Self-model accuracy | < 0.10 |
| Provenance Ratio | (Sensor+Guardian+Inference) / total | ↑ "experiential" |
| Behavioral Diversity | Distinct action types in last 20 | Watch for narrowing |
| Guardian Response Rate | % social comments answered within 30s | Engagement quality |
| Interoceptive Accuracy | Self-reported vs. actual pressure agreement | > 0.6 |
| Mean Drive Resolution Time | Per-drive elevated→resolved latency | Stable distributions |

Observatory dashboard exposes per-session historical charts: vocabulary growth, drive evolution, action diversity, developmental stage (pre-autonomy < 0.20 → emerging 0.20–0.50 → consolidating 0.50–0.80 → autonomous ≥ 0.80), and comprehension accuracy.

---

## 11. Graceful Degradation (The Lesion Test)

Every LLM-dependent path checks `isAvailable()` and degrades:

| System | Without LLM |
|---|---|
| Learning edge refinement | Edges remain `RELATED_TO` |
| WHO_AM_I trigger | Plain fact list |
| Planning proposal | Template fallback (2-step WKG_QUERY + LLM_GENERATE) |
| Tensor inference | Returns null → LLM-only path |
| Supervisor | Skipped, system continues |

Sylphie should **survive** running without any LLM connection — degraded but coherent.

---

## 12. Frontend (Dashboard)

Vite + React 18 + Zustand + MUI dark mode. Six routes under `/dashboard`:

- **Graphs** — 3D ambient WKG view (react-force-graph-3d) + OKG/SKG mini graphs
- **Analytics** — drive radar, executor state, prediction history, attractor alerts, observatory charts
- **Chat** — conversation panel with knowledge-grounding colors (GROUNDED green, LLM_ASSISTED amber italic, UNKNOWN dim grey) + camera column
- **Codebase** — PKG explorer (the codebase-as-graph)
- **Guardian** — drive rule approval queue + tensor cognition dashboard (bootstrap progress, per-category agreement, training metrics)

**Inner Monologue panel** displays VERBATIM TimescaleDB events — the frontend never re-paraphrases through an LLM. What you see is what happened.

WebSocket channels: `/ws/conversation`, `/ws/perception`, `/ws/audio`, `/ws/graph`, `/ws/telemetry`, `/ws/supervisor`, `/ws/webrtc`. All hooks share an exponential backoff (1000·2^attempt, max 30s, jitter 0.8–1.2×).

---

## 13. Codebase-as-Graph (PKG)

A separate Neo4j instance (port 7691) indexed by ts-morph parses Sylphie's own source. Two consumer surfaces, both **outside** the cognitive loop:

**MCP tools for Claude Code** (`mcp__sylphie-pkg__*`):
- `searchContent` — pattern search inside CodeBlock bodies
- `getFunctionDetail` — body + types + callers + callees + recent changes + tests
- `getDataFlow` — variable-length traversal of CALLS / USES_TYPE / IMPORTS / INJECTS / EXTENDS / IMPLEMENTS up to depth 6
- `getModuleContext` — entry-point query by module/service/function name
- `getConstraints` — surface CANON constraints attached to a scope
- `getLogContext` — read `./logs/*.log` (NOT Neo4j) filtered by query/service/severity
- `getRecentChanges` — :Change nodes with affected functions/types

**REST surface for the dashboard:** the runtime backend exposes `PkgQueryService` via `/graph/pkg/search`, `/graph/pkg/function/:name`, and `/graph/pkg/dataflow/:name`. These power the Codebase Explorer panel — they are read-only Cypher against the PKG instance, called by the frontend, never by deliberation.

Initial seed walks 5 watched packages, batches 50 files, runs 6-way integrity check, advances cursor to `git rev-parse HEAD`. Sync pipeline diffs against last cursor and applies mutations transactionally.

**Sylphie does not query the PKG.** No deliberation step, working-memory source, or planning constraint reads from the PKG instance. Self-introspection of code is a *tooling* affordance for Jim and Claude Code, not a cognitive capability — consistent with Standard 6 (no self-modification of evaluation).

---

## 14. Cycle Cadence (Cognitive Constraint, Not Performance Concession)

| Cycle | Interval | Why this rate |
|---|---|---|
| Drive tick | 1 s | Drives change over minutes, not ms |
| Telemetry broadcast | 500 ms (2 Hz) | Frontend refresh budget |
| Planning processing | 30 s | Don't churn opportunities |
| Learning maintenance | 60 s | Consolidation, not transcription |
| Confidence decay | 10 min | ACT-R-style forgetting |
| Conversation reflection | 5 min | Insight requires distance |
| Cross-session synthesis | 30 min | Cross-conversation patterns |

Cadence is deliberate. A motivational system with millisecond drives would chase noise.

---

## 15. Architectural Principles (Distilled)

1. **Drive isolation as process boundary** — not an interface, a separate executable + RLS
2. **Theater Prohibition at the type level** — every event carries drive context
3. **Lesion Test as first-class constraint** — every LLM path has a graceful fallback
4. **Provenance + confidence discipline** — MERGE raises only; decay penalizes age; guardian protects
5. **Event backbone for cross-subsystem comms** — no direct injection between subsystems
6. **Three-layer latent spaces** — hot/warm/cold pattern repeated for voice, face, deliberation
7. **Determinism via seeded Mulberry32** — reproducible embeddings across restarts
8. **Verbatim telemetry** — no LLM re-summarization between event source and UI
9. **Guardian asymmetry** — guardian feedback is structurally privileged
10. **Working memory as activation selection** — not a store, a 5-signal selector
11. **Tensor shadow + LLM reality** — graduate categories, not the whole system
12. **12-dimensional affective substrate** — fixed enum, hand-tuned rates
13. **Three KGs in strict separation** — no cross-instance queries
14. **PKG separate from cognition** — fourth Neo4j is for tooling, not thinking
15. **Cycle cadence as cognitive constraint** — minutes-not-milliseconds is the design

---

## 16. Status Snapshot

**Operational** (verified end-to-end):
- 12-drive substrate with cross-modulation and behavioral contingencies
- Full perception pipeline (YOLO + MediaPipe + Moondream2) wired to VWM and KG
- Three-graph memory architecture with provenance discipline
- Type 1 / Type 2 / SHRUG arbitration with deliberation
- Learning consolidation cycles + reflection + cross-session synthesis
- Tensor cognition sidecar in shadow/audit mode
- DeepSeek supervisor with budget tracking
- Voice cache with valence-aware lookup

**Scaffolded but not realized** (called out honestly):
- EWC / Fisher anchoring in cognition (uniform, never anchored)
- Pressure-driven learning trigger (TODO comment only)
- Cognition reinforce/correct/freeze HTTP endpoints (stubs)
- `boost_salience` intervention (not implemented)
- `ConvergenceModel.use_learned` (always false; heuristic path used)
- Theater check in CommunicationService (flag-only; full enforcement in drive-engine)
- SearXNG container (provisioned, no consumer code)

The honesty about what is and isn't real is itself an architectural commitment — the system flags its own stubs rather than pretending.

---

*This spec describes commit `ab45de0` (main), 2026-04-29.*
