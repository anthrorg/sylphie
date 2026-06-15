# Sylphie Vision — Seeing Clearly

> A frontier-grounded perception architecture for Sylphie. Maps five capabilities —
> temporal object detection, facial recognition, scene understanding, temporal memory,
> and object memory — onto the current `cv-framework`, stating exactly what to **keep**,
> **change**, **remove**, and **add**. Every capability is anchored to current (2025–2026)
> literature; citations in [brackets], full list at the end.
>
> Author's stance: claims here are grounded against both the field and the actual codebase.
> Where the released tooling does **not** do what a design wants, that is said plainly
> rather than assumed — see §7.

---

## 0. The organizing idea

"Seeing clearly" is not better detection. A pile of per-frame detections is not sight; it is
twitching. Seeing clearly means maintaining a **coherent, queryable model of what is happening,
who and what is involved, where, and how it is changing over time** — and being able to recognize
that *this* is the same pen, the same person, the same room as before.

Two architectural commitments make that tractable, and both are where the frontier has converged:

1. **Decouple the fast perception loop from heavy cognition.** Lightweight perception runs at
   frame rate; the expensive model fires only when something warrants it. Microsoft's StreamMind
   names this an *event-gated network* that separates fast perception from deeper analysis, letting
   perception run at video speed while the heavy model activates only when needed [1]. Dispider
   formalizes the same split into disentangled perception / decision / reaction modules [2].

2. **Store structured memory, not raw-frame context.** The streaming-VLM line (StreamingVLM,
   VideoLLM-online) holds an unbounded video stream as a transformer KV cache and spends its
   research budget bounding that cache with eviction and retrieval [3][4]. Sylphie's CANON premise —
   the LLM is a voice box, not the decision loop — means the stream collapses into **structured
   scene state**, not tokens. That sidesteps the unbounded-KV problem the entire streaming-VLM field
   exists to manage. The cost is fidelity (a symbolic summary, not every pixel), which is the
   right trade for an agent that needs *what is happening*, not *answer arbitrary questions about
   any past frame*.

### The coherent layer stack (the target)

```
  SENSING            per-frame detect / segment / track / embed        (stateless-ish, hot)
      │
  WORKING MEMORY     VisualWorkingMemory — stabilize into SceneEntities (seconds, hot)
      │
  SCENE-STATE GRAPH  temporal scene graph — what's happening over time  (minutes, warm)  ← MISSING
      │
  SEMANTIC KNOWLEDGE WKG / OKG — durable identity & world/self/other     (persistent, cold)
```

The middle layer is the keystone of this whole document. Sylphie has the top and bottom; it is
missing the warm, time-anchored scene layer that turns detections into *seeing*. Every capability
below either feeds that layer or reads from it. (Detail in §4.)

---

## 1. Temporal object detection

**Frontier.** Three separable jobs: *detect* (where/what), *associate across time* (same object,
frame to frame), *embed* (a vector that identifies the specific instance). The modern open-vocab
detector line is YOLOE — real-time open-vocabulary detection and instance segmentation [5] — and
SAM 3 sets the bar for concept-promptable segmentation and tracking, with a memory-propagation
tracker and SAM 3.1's object multiplex processing many objects in one pass [6][7]. Temporal
association at production speed is typically a dedicated tracker (ByteTrack-class), and per-object
identity comes from a strong self-supervised embedding — DINOv2, which is state of the art for
instance-level recognition via non-parametric cosine matching [8].

**In your framework today.** `YOLOv8n-seg` (closed COCO, 20 classes used) + a **greedy IoU tracker
with no motion model** (`TENTATIVE→CONFIRMED→LOST→DELETED`) + `EfficientNet-Lite4` embeddings
(1280-D). The tracker breaks on occlusion and crossing because nothing predicts motion; EfficientNet
is a 2019-era generic backbone.

**Change / remove.**
- **Keep** YOLO-seg as the detector; **optionally upgrade to YOLOE** for open-vocabulary (kills the
  20-class ceiling without the SAM weight problem — see §7).
- **Replace** the greedy IoU matcher with **ByteTrack** (motion model + two-stage association). This
  is the direct fix for the occlusion/crossing failure.
- **Remove** `EfficientNet-Lite4`; **replace with DINOv2** (instance-grade embeddings). This single
  swap is the highest-leverage quality change in the system — every downstream re-id and surprise
  decision rests on embedding separation.

---

## 2. Facial recognition — enroll a user, know them on entry

**Frontier.** Face *recognition* (identity) is a distinct model from face *landmarking* (mesh/pose).
The open-source gold standard is the InsightFace stack: SCRFD / RetinaFace detection + **ArcFace**
embedding, packaged as `buffalo_l`, ONNX/CUDA, ~99.86% on LFW [9][10]. ArcFace's additive angular
margin loss maps faces onto a hypersphere where same-person clusters are tight and identities are
cleanly separated; the embedding is **512-D** and compared by cosine similarity [11][12]. The exact
capability you want — *"know who they are when they step into the frame"* — is **1:N identification**:
"who, if anyone, is this among N enrolled identities?" against an enrolled gallery, at a chosen
operating point (FMR, not a hand-tuned accuracy number) [13].

**In your framework today.** `MediaPipe Face Landmarker` (478 landmarks + 52 blendshapes) — genuinely
good at mesh, expression, and pose — plus `FaceSnapshot` doing identity via **EfficientNet embeddings
on face crops** (3-tier hot/warm/cold gallery, cosine 0.55). The problem: a generic backbone on a
face crop is *not* a face-recognition embedding. Identity quality is the weak link, and the low 0.55
threshold is a symptom of poorly separated vectors.

**Change / remove.**
- **Keep** MediaPipe for landmarks / expression / pose (it feeds the `FaceEncoder` and is the right
  tool for that job).
- **Keep** the 3-tier hot/warm/cold gallery — it is a clean enrollment design.
- **Remove** EfficientNet from the face path; **replace with ArcFace / InsightFace** (512-D). Re-key
  the gallery on ArcFace vectors and set the match threshold from a real **FMR operating point**
  instead of 0.55. **Enrollment** = store an ArcFace template per user; **on entry** = detect → embed
  → cosine vs gallery → identify above threshold. This is the entire "saves users and knows them on
  sight" feature, done the way production systems do it.

---

## 3. Scene understanding — what / who / where / when / colors

**Frontier.** A full scene read is composed, not monolithic: a **VLM** for the semantic "what's going
on" (Moondream2 at the small end; Qwen-VL / Florence-class for richer reads), a **scene graph** for
spatial structure (who is near what, what is on what), **face recognition** for *who* (§2), a
**timestamp / temporal anchor** for *when* (§4), and **color extraction** for *colors*. The field's
direction is explicitly toward *structured* scene representation rather than a flat caption [1][14].

**In your framework today.** `Moondream2` captions (fire-and-forget, on a 5s cooldown / 30s timer) +
`SceneEventDetector` (appeared/left/arrived) + VWM. Crucially, the parts that would make this a real
scene *understanding* rather than a caption are **dormant**: the `SpatialRelationshipExtractor`
(`left_of` / `near` / `on_top_of`) and the `DominantColorExtractor` (512-bin RGB histogram) are built
but never run on the live path.

**Change / remove.**
- **Activate** the dormant spatial-relationship and color extractors and route their output into the
  scene representation (this is *who/where/colors* — already built, just unplugged).
- **Re-gate the VLM**: fire on surprise/intent instead of a fixed timer (cheaper *and* more
  responsive — the event-gating pattern [1]). Because it is now low-frequency, the 4080 budget
  permits **upgrading Moondream2** to a stronger gated VLM if caption quality limits you.
- *Who* comes from §2, *when* from §4. **Remove**: nothing — this capability is mostly activation and
  routing of components you already wrote. That is the recurring theme of this system.

---

## 4. Temporal memory — the keystone layer

**Frontier.** The established way to hold *what is happening over time* is a **temporal scene graph**:
entities as time-anchored nodes, edges encoding both spatial relations and temporal/causal relations
(before/after, appeared/persisted/left). EgoGraph builds a dynamic knowledge graph that encodes
long-term cross-entity dependencies in video streams, unifying people/objects/locations/events and
accumulating stable memory over days [15]. Video-QTR holds a graph-based memory that encodes the
video as a dynamic event graph anchored to time indices, with nodes as event hypotheses and edges as
temporal/causal relations [16]. (The streaming-VLM KV-cache approach [3][4] is the *other* school —
but it is for LLM-in-the-loop systems and is unnecessary under CANON.)

**In your framework today.** VWM (hot, seconds) and WKG / OKG (cold, **semantic identity**). There is
**no temporal/episodic scene layer** — nothing whose job is to represent what is going on over the
last few minutes. Two honest notes: this is *why* the system reads as "people asking what's going
on"; and durability itself is a build item, because only `InMemoryGraphPersistence` exists today —
`Neo4jGraphPersistence` is referenced in production but not implemented.

**Change / remove (this is the central addition).**
- **Add the temporal scene-state graph** between VWM and WKG/OKG.
  - **Nodes** = VWM `SceneEntity`s, **bound by reference** to their WKG/OKG identity node (do not
    duplicate identity — this is the masklet→node binding).
  - **Spatial edges** = the now-active `SpatialRelationshipExtractor`.
  - **Temporal edges** = the `SceneEventDetector` (appeared/persisted/left, before/after), time-anchored.
- **Implement `Neo4jGraphPersistence`** so the layer is durable (and Sylphie can re-recognize across
  sessions).
- **Remove**: nothing. This layer is the missing middle. It gives the "dormant sophisticated pipeline"
  (spatial relations, surprise, observation building) a *home*, which dissolves the two-coexisting-
  pipelines incoherence — that pipeline was never a competitor, it was the populate-the-scene-graph
  logic for a graph that did not exist yet. It is also what lets episodic memory consolidate from real
  structure ("person arrived, sat near the laptop, mug present then gone") instead of a flattened
  vector. This is the line between *emitting detections* and *seeing*.

---

## 5. Object memory — "this is my favorite pen"

**Frontier.** Recognizing *this specific pen* (instance) is a different problem from detecting *pens*
(category), and the frontier solves it with **DINOv2 embeddings + a per-instance prototype/exemplar
gallery, one-shot enrollment, zero training**. Swiss DINO is exactly this: one-shot *personal object
search* on DINOv2, handling multi-instance personalization via one-shot transfer with no adaptation
training [17]. DINOv2 itself does instance-level recognition non-parametrically by cosine-ranking
against a feature bank [8], and the prototype-feature-bank pattern (store prototypes, cosine-match)
is well established [18]. "This is my pen" = store the DINOv2 embedding of *this* pen as a named
instance; re-recognize by cosine against the instance gallery.

**In your framework today.** VWM object identity (single-signal cosine over EfficientNet, 0.75) +
guardian-naming → `:VisualObject` discovery (confidence 0.40→0.60). And, dormant, the **CANON A.5
multi-signal scorer** — embedding + spatial + color + size + label with Piaget dynamic weights and a
**surprise flag** — which is genuinely frontier-grade and is *not running*.

**Change / remove.**
- DINOv2 embeddings (from §1) make the instance gallery actually discriminative — Swiss DINO confirms
  DINOv2 is the right backbone for personal object search [17].
- **Promote the dormant A.5 multi-signal scorer to the live path.** Multi-signal beats single-signal
  cosine for re-id, and its `surprise_flag` is "this known object changed." **Remove** the single-
  signal VWM cosine matcher in favor of it.
- **Teaching is one-shot**: guardian names an object → store its DINOv2 instance embedding as a named
  node in the scene-state / identity graph → re-recognized on sight thereafter, across sessions.

---

## 6. Consolidated keep / change / remove / add

| Component (current) | Verdict | Replacement / Action |
|---|---|---|
| `YOLOv8n-seg` | **Keep** (optional upgrade) | → YOLOE for open-vocab [5] |
| Greedy IoU tracker | **Remove** | → ByteTrack (motion + association) |
| `EfficientNet-Lite4` (objects) | **Remove** | → DINOv2 (instance embeddings) [8] |
| `EfficientNet-Lite4` (faces) | **Remove** | → ArcFace / InsightFace (512-D) [9][11] |
| `MediaPipe Face Landmarker` | **Keep** | landmarks / expression / pose |
| `FaceSnapshot` 3-tier gallery | **Keep** | re-key on ArcFace; FMR-set threshold [13] |
| `Moondream2` VLM | **Change** | periodic → surprise/intent-gated [1]; upgrade if needed |
| `SpatialRelationshipExtractor` | **Activate** | feeds scene-graph spatial edges |
| `DominantColorExtractor` | **Activate** | feeds scene "colors" |
| `SceneEventDetector` | **Keep + route** | feeds scene-graph temporal edges |
| VWM | **Keep** | nodes for the scene-state graph |
| A.5 multi-signal scorer | **Activate** | replaces single-signal cosine; surprise signal |
| WKG / OKG | **Keep** | identity nodes the scene graph references |
| `Neo4jGraphPersistence` | **Add (build)** | durability for the scene-state layer |
| **Temporal scene-state graph** | **Add (new)** | the missing middle layer (§4) |
| Fixed-random-projection fingerprint | **Change** | hash the real latent, not 64 random dims |

**Net new models:** DINOv2 (objects), InsightFace/ArcFace (faces), ByteTrack (tracking).
**Net removed:** EfficientNet-Lite4 (both paths), greedy IoU matching, timer-based VLM triggering.
**Net activated (already built):** spatial relations, color, A.5 multi-signal + surprise.
**Net added (new build):** the temporal scene-state graph + its Neo4j durability.

---

## 7. Honest constraints (so nothing here is assumed)

- **SAM 3.1 is not a drop-in live tracker in your stack.** The released SAM video predictors are
  *finite-clip* — they pre-count and pre-allocate per-frame memory for a known N-frame sequence —
  with no unbounded push-one-frame-forever session API in any SAM variant; and no SAM 3 weights are
  distributed in your environment (only SAM 2 / 2.1). SAM is therefore an **optional periodic
  high-detail segmenter** (run SAM 2.1, whose weights exist, on a short clip when detail is wanted),
  **not** the continuous tracker. The continuous job is YOLO(E) + ByteTrack + DINOv2.
- **Runtime is currently dormant.** The perception venv is missing `onnxruntime` / `mediapipe` /
  `neo4j`, so object embeddings, faces, and graph reads do not run until dependencies are installed.
  First task before any of the above: install deps and verify the existing path runs end-to-end.
- **Hardware fits.** On the 4080 (16 GB), YOLO(E) + DINOv2 (ViT-L, ~1 GB) + InsightFace + MediaPipe
  resident is comfortable (~5 GB); the gated VLM loads lazily. The architecture is GPU-bound but
  well within budget.
- **Frame-dim correctness.** Encoders currently hardcode 640×480; `getUserMedia` "ideal" is not
  guaranteed. Read true negotiated dims, or spatial/size features (and the scene graph's spatial
  edges) skew silently.

---

## References

1. StreamMind: AI system that responds to video in real time. Microsoft Research, 2025. https://www.microsoft.com/en-us/research/articles/streammind-ai-system-that-responds-to-video-in-real-time/
2. Dispider: Enabling Video LLMs with Active Real-Time Interaction via Disentangled Perception, Decision, and Reaction. arXiv:2501.03218.
3. StreamingVLM: Real-Time Video-Language Model (unbounded streams via attention sinks + asymmetric KV eviction). https://www.emergentmind.com/topics/streamingvlm
4. VideoLLM-online: Online Video Large Language Model for Streaming Video. arXiv, 2024. https://www.researchgate.net/publication/384205376
5. YOLOE — real-time open-vocabulary object detection and instance segmentation (Ultralytics). https://learnopencv.com/dinov2-self-supervised-vision-transformer/ (overview); Ultralytics YOLOE docs.
6. Segment Anything Model 3. Meta AI, 2025. https://ai.meta.com/blog/segment-anything-model-3/
7. SAM 3.1 Object Multiplex (shared-memory multi-object tracking). facebookresearch/sam3. https://github.com/facebookresearch/sam3
8. DINOv2: Learning Robust Visual Features without Supervision (instance-level recognition via non-parametric cosine). Oquab et al. arXiv:2304.07193.
9. InsightFace: State-of-the-art 2D & 3D Face Analysis (SCRFD/RetinaFace + ArcFace, buffalo_l). https://github.com/deepinsight/insightface
10. Best Face Recognition APIs 2026 — InsightFace 99.86% LFW. https://mixpeek.com/curated-lists/best-face-recognition-apis
11. ArcFace: Additive Angular Margin Loss for Deep Face Recognition (512-D hypersphere embedding). Deng et al. https://insightface.ai/arcface
12. ArcFace Paper Explained — additive angular margin, cosine verification. https://www.insightface.ai/research/arcface
13. Choosing a Face Recognition Model: 1:1, 1:N Testing, and Threshold Selection (FMR/FPIR operating points). InsightFace Guides. https://www.insightface.ai/guides/choose-face-recognition-model-and-evaluate
14. Top Multimodal / Vision-Language Models (Qwen-VL, Florence-2, Moondream2). https://blog.roboflow.com/multimodal-vision-models/
15. EgoGraph: Temporal Knowledge Graph for Egocentric Video Understanding. arXiv:2602.23709.
16. Video-QTR: Query-Driven Temporal Reasoning (graph-based temporal memory, dynamic event graph anchored to time). arXiv:2512.09354.
17. Swiss DINO: Efficient and Versatile Vision Framework for On-device Personal Object Search (one-shot personal object search on DINOv2). arXiv:2407.07541.
18. PROWL / DE-ViT: prototype-feature-bank instance recognition on DINOv2. arXiv:2404.07664; Springer NPL 2025.
19. Active Video Perception / OmniAgent: active, attention-gated perception (plan–observe–reflect; concentrate high-resolution inference on salient segments). arXiv:2512.05774; arXiv:2512.23646.

---

*Closing note: almost nothing here is exotic invention. Four of the five capabilities are "use the
established frontier method and plug in what you already built"; the one genuinely structural addition
— the temporal scene-state graph — is itself the established frontier pattern for video state
[15][16], not a novel risk. The work is integration judgment, not research gambling. That is exactly
why it is worth doing carefully, and worth writing down.*
