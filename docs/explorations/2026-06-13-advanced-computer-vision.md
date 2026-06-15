# Exploration: How do we make the most advanced computer vision for Sylphie?

> **Date:** 2026-06-13
> **Method:** `/explore-topic` — 6 specialist agents in parallel over the verified `wiki/cv-framework.md` baseline + live code.
> Technical: `mythos` (cutting-edge architecture), `cortex` (consuming-side feasibility).
> Science: `luria` (neuro grounding), `scout` (information theory / attention), `piaget` (concept formation), `ashby` (systems / stability).

---

## 0. Framing

"Most advanced" was deliberately read **not** as "best CV models" but as "what makes Sylphie *see and understand* like an advanced mind, without destabilizing the system that consumes it." All six agents read the same ground truth and converged hard. This is a high-consensus exploration — rare.

**A baseline correction surfaced first.** `wiki/cv-framework.md` (authored 2026-06-13, pre-WS5) is **stale on two points**, found independently by `luria` and `scout`:
- Vision is **no longer purely ambient.** WS5 T1.0 wired `tickSampler.nudgeSceneChange()` — a confirmed-object scene change now *forces* a cognitive cycle (deduped by `SCENE_CYCLE_COOLDOWN_MS`). `luria` calls this a correct **superior-colliculus / reflexive-orienting analog.**
- A **live, graded, habituating surprise signal already exists** — `ScenePredictionService` (`packages/decision-making/src/prediction/scene-prediction.service.ts`). It emits per-object `novel/missing/moved` magnitudes in [0,1], attenuated per-identity by `1/(1+k·count)` (repetition suppression), aggregated to `totalSurprise`, routed to Curiosity/Anxiety and an encode-attention `saliencyTerm`.

So we are further along than the doc says. The predictive-coding *spine* is built. The gap is that it predicts **tracker geometry**, not **content** — and the rich machinery downstream of it is starved by a thin, lossy representation. **→ Action item: refresh `cv-framework.md` to cover WS5's scene-prediction + nudge.**

---

## 1. The single highest-consensus finding

**The representation entering cognition carries almost no visual information, and the fix is nearly free.**

- `mythos` + `cortex` (verified in code): the EfficientNet-Lite4 **1280-D embeddings are already computed per CONFIRMED track** and reach NestJS on `TrackedObjectDTO.embedding` (`perception.gateway.ts:175`) — then are **discarded at the cognitive boundary**. `VideoEncoder` consumes `{class,confidence,bbox}` only (the embedding is dropped when `VideoDetection` is built, `perception.gateway.ts:131-136`); `SceneEncoder` iterates objects that *carry* `embedding` but never reads it. Cognition's entire "video understanding" is a **26-float COCO histogram → fixed Xavier-random 768-D projection.** No nonlinearity, no training.
- The richest visual signal Sylphie already pays to compute never reaches her decision loop.

**This is the foundation.** Every other upgrade (open-vocab detection, depth, VLM reasoning) is wasted if it collapses through a 26→768 random matrix. Fix the representation first.

---

## 2. Where all six agents agree

| Finding | Who | Why it matters |
|---|---|---|
| **Feed the existing 1280-D embeddings into cognition (Phase 0)** | mythos, cortex | ~1–2 days, near-zero risk. Multiplies information content immediately. Johnson-Lindenstrauss: even a *fixed random* 1280→768 projection approximately preserves cosine neighborhoods, so it's a legit no-training stopgap. **Additive, not a replacement** — keep scene/video encoders for counts & geometry. |
| **Promote the dormant A.5 multi-signal scorer + surprise_flag to the live path** | **all six** | Unanimous. The live VWM re-IDs on **single-signal cosine 0.75 only**; the dormant A.5 (`persistence_check_service.py`) adds embedding+spatial+color+size+label with confirmation-count-dynamic weights and a genuine novelty flag. `ashby`: **highest-leverage, lowest-risk, stability-neutral** (better scoring over the *same* embeddings — no new representation, no fingerprint risk, no new loop). Lift it **stateless into `/detect`**, don't boot the whole dead pipeline. |
| **Activate the dormant dorsal stream (`SpatialRelationshipExtractor`)** | luria, scout, piaget | `left_of/on_top_of/near` already built & tested. `luria`: it *is* the dorsal "where" pathway (the code cites him). Land relations as **WKG INFERENCE edges between `:VisualObject` nodes** — reconverge what+where **in the graph, not the embedding**. Currently spatial features are computed then *destroyed* by the Xavier projection (a lesion profile that recognizes objects but can't say how they're arranged). |
| **Extend surprise from geometry → content** | luria, scout, piaget | The live predictor can't see "same place, looks different." Add embedding-prediction-error on stable tracks (`errorType:'changed'`) reusing WS5 machinery + EWMA infra. This is the cheapest path to graded *visual* novelty and unifies with A.5's identity-level surprise into one hierarchy (coarse scene-level + fine identity-level). |
| **Migrate visual recall off the lossy fingerprint onto cosine** | cortex, scout, ashby | The episodic key is `SHA-256(first **64 of 768** fused dims, 2dp)`. With a *random* fusion matrix there's no guarantee variance concentrates early → ~8% of dims kept → visual scenes collide ("guardian+mug+laptop" ≈ "guardian+book+laptop"). Text already has a grounded cosine path (`resolveQueryEmbedding`); **vision deserves the same.** Split exact-dedup (keep short hash) from similarity-recall (cosine over full/1280-D vector). |

---

## 3. The central tension: learned backbone vs. memory stability

This is where the technical ambition meets the hardest systems constraint. **`mythos`/`cortex` want a learned representation; `ashby`/`cortex` warn it can detonate memory.** They reconcile cleanly.

**The ambition (`mythos`):** swap EfficientNet-Lite4 → **frozen DINOv3** (or CLIP/DINOv2) + a **small learnable head (1–2 layer MLP)** into 768-D. Frozen-backbone-plus-probe is the realistic path to "learned vision" for a solo dev with no labels and no training pipeline.

**The hazard (`ashby`, emphatic):** the fixed Xavier projection is a **load-bearing stability guarantee**, not a limitation. Three things key on embedding stability — object re-ID (pgvector cosine), face recognition, and **episodic fingerprints (a hash — no notion of "close")**. An **online/drifting** learned backbone causes:
1. **Fingerprint catastrophe** — every weight update makes the same scene hash differently → all prior episodic memory becomes *unaddressable* (discontinuous, total).
2. **Re-ID drift** — stored vectors live in the old space; thresholds tuned for one space compare across two. Looks like regression of object permanence / agnosia. Catastrophic interference at the systems level.
3. **Fusion contamination** — the fixed N×768 fusion matrix's input-slot meanings drift, polluting the shared latent every modality reads.

**The reconciliation (all three agree):** a learned backbone is fine **iff**:
- **Frozen + versioned + migration-gated**, never online-drifting. Treat a backbone swap as a discrete **phase transition / re-embedding migration**, not a live swap. Embedding-model-version becomes a provenance field.
- **Decouple the episodic key from the learned space** — build the hash from stable symbolic features (category + drive + quantized stable features); use the learned embedding only for *similarity ranking within* a retrieved candidate set. This is the right architecture regardless of any future model change.
- **CANON (`mythos`):** the learnable head must **not** train on any evaluation-derived/reward signal (Standard: no self-modification of evaluation). Train it self-supervised (predict next-frame embedding / contrastive same-track-vs-different). Route the training-objective design to `learning` (EWC owner). A learned *backbone* is fine (fixed perceptual frontend); a learned *fusion* is the line not to cross casually.

**Sequencing rule (`cortex`):** do Phase 0 with the *existing* EfficientNet vectors and prove the fusion/fingerprint **migration end-to-end first**, *then* swap the backbone (a one-line input-dim change if Phase 0 is built generically). Don't couple the hard migration to a new model download.

---

## 4. Making vision attentionally intelligent

Three agents converge on **active, attention-gated perception** — the deepest divergence from biology and the biggest compute win.

- **`luria` (foveation):** biological vision is saccadic/foveated, not uniform 15 FPS capture. Run cheap low-res whole-frame detection (periphery), then **re-process only attended regions at high res** (fovea). The saccade controller already has its inputs and **throws them away**: drives compute *what matters* (curiosity/social pressure = frontal-eye-field top-down), the scene predictor computes *where the surprise is* (bottom-up salience) — but `routeScenePredictionErrors` keeps only aggregate `totalSurprise` and **discards which object / where.** That per-object location *is* the saccade target.
- **`scout` (bandit):** frame the expensive models (VLM, embeddings) as a **multi-armed bandit over regions**, cost = compute, payoff = expected information gain. Cheap YOLO always-on; ration VLM/embedding by `max(surprise, graph-uncertainty, task-relevance)` with **inhibition-of-return** (per-region cooldown, not the current *global* caption cooldown). Exploration coefficient driven by Curiosity pressure. Promote the dormant change-detection/debounce gate (IoU>0.95 + embedding-unchanged → skip re-embed).
- **`scout` + `ashby` (compute homeostasis):** replace fixed timers (caption every 30s) with **value-gated spend** (fire VLM on settled-semantic novelty, suppress on known-stable scenes). `ashby`: unify perception spend + deliberation spend under **one regulated "cognitive effort" essential variable** (mirror the Type-2 cost tax) with an **adaptive degradation ladder** (VLM → periodic-only → detection-only → drop FPS) under load.

---

## 5. Constructing visual *knowledge* (not just matching it)

`piaget` reframes "advanced" as **constructive**, and gives a build order that must not be skipped (each stage grounds the next):

1. **Make instance embeddings mutable** — running centroid per `:VisualObject`, updated each confirmed sighting. *Precondition for any accommodation* — today embeddings are write-once, so the live path can recognize but **cannot develop** (arrested at the sensorimotor stage, pure assimilation).
2. **A.5 dynamic weights = the developmental trajectory.** New object → `spatial 0.50` (sensorimotor: a thing is a thing-at-a-location); well-known → `embedding 0.45` (object permanence: identity migrated to intrinsic appearance). The live path applies the *mature* weighting to *immature* objects — backwards, and the source of first-sighting duplicate nodes.
3. **Surprise → equilibration.** Transient surprise (lighting/coffee/occlusion) → *assimilate* (widen prototype). Persistent surprise (recurs across frames) → *accommodate* + **raise pressure → ask the guardian** (ZPD: she can detect disequilibrium alone but resolves restructuring with the guardian — worth 3× under CANON asymmetry). Discriminator = recurrence over VWM's temporal window. Bracket magnitude (Berlyne): max surprise = "new object," not "my mug changed."
4. **Basic-level concept formation.** Today the graph is a **proper-noun graph** — every node is "this specific cup," never "a cup." Form `:VisualConcept` prototype nodes (Rosch) via embedding-cluster cohesion (COCO label as *scaffold*, not definition). Lets Sylphie recognize a cup she's never seen. Confidence: count-driven growth above 0.60 once guardian-touched (preserves asymmetry, allows real accumulation).
5. **Scene schemas / affordances** — only *after* concepts are stable (horizontal décalage). Compositional relational schemas ("what a kitchen looks like") make surprise cheap: predict the scene, spend cognition only on the violation. **This is the real meaning of advanced — seeing less, understanding more.**

---

## 6. Stability invariants to protect through ANY vision upgrade (`ashby`)

These are restatements of the system's existing good instincts. "More advanced vision" is safe *exactly to the extent it enriches perception while leaving these intact*:

1. **Relief stays epistemic.** Enrich the pressure side freely; **never pay curiosity/social relief for anything but durable knowledge/identity change.** This (+ drive isolation) is what prevents the Curiosity Trap — a system that parks in front of clutter. A surprise flag may raise pressure/route to Anxiety; it must **never short-circuit the information-gain relief gate.**
2. **The embedding stays stable, or its instability is discretized** (frozen+versioned+migration; episodic key decoupled). §3.
3. **The world cannot unconditionally command the decision loop.** Vision triggers only on **settled-semantic change** (VWM hysteresis upstream of the nudge — never raw YOLO flicker), rate-limited below the loop's service rate, with **adaptive habituation** to busy-but-uninformative scenes. `ashby`'s loop-gain ruling: hold the scene-nudge cooldown ≥ one typical Type-2 cycle (5s defensible floor); the real fix is the *gating predicate* + adaptive gain, not the constant.

**`cortex`'s sequencing corollary:** event-driven vision *without* learned-embedding cosine retrieval just **manufactures Type-2 load** (visual cycles can't resolve to Type-1 procedures → drift toward the "Type 2 Addict" attractor). **Embedding + retrieval must land before triggering.**

---

## 7. Recommended sequence (synthesized, dependency-ordered)

Ordered by *(value × safety) / effort*, respecting the developmental and stability dependencies above.

| # | Move | Effort | Risk | Owner(s) |
|---|---|---|---|---|
| **0** | **Wire existing 1280-D embeddings into a `visual_embedding` modality** (JL random projection, additive to scene/video) | ~1–2 d | very low | `opus-agent` + `cortex` |
| **1** | **Promote A.5 multi-signal scorer + surprise_flag stateless into `/detect`**; thread surprise through VWM | ~1–1.5 wk | low | `opus-agent`; `piaget`/`skinner` tune weights |
| **2** | **Mutable instance embeddings** (running centroid) — precondition for accommodation | ~2–3 d | low | `learning` + `atlas` |
| **3** | **Grounded visual recall**: cosine over full/1280-D vector; **version the fingerprint** (`embeddingVersion`), split dedup from similarity | ~3–4 d | med (continuity) | `cortex` + `atlas` + episodic |
| **4** | **Extend surprise geometry→content** (`errorType:'changed'` on stable tracks) + **learning-progress gating** (d(surprise)/dt — avoids noisy-TV fixation) | ~3–5 d | low | `cortex` + `scout` |
| **5** | **Activate dorsal stream** — spatial relations as WKG INFERENCE edges (reconverge in graph) | ~3–5 d | low | `opus-agent` + `atlas` |
| **6** | **Attention/foveation**: stop discarding surprise *location*; two-pass periphery→fovea; per-region VLM bandit + value-gated spend | ~1–2 wk | med | `scout` + perception + `forge` |
| **7** | **Open-vocab detector** (YOLOE/YOLO-World) — *only after #0/#4*; 20-class histogram becomes the bottleneck the moment detection is open-vocab | ~3–5 d | low | perception sidecar |
| **8** | **Frozen DINOv3/CLIP backbone + small learned head** — as a *versioned migration* (#3 must land first); head trained self-supervised, **not** on evaluation signal | ~1–2 wk | med-high | `learning` + `opus-agent` |
| **9** | **VLM as queryable tool** (`/perception/query`, upgrade to Qwen2.5-VL-3B): deliberation *pulls* visual answers; outputs `INFERENCE`, 0.60-capped, non-promoting until corroborated | ~1–2 wk | med-high (theater) | `meridian` + `canon` |
| **10** | **Basic-level `:VisualConcept` prototypes**; then **scene schemas** (only after concepts stable) | larger | med | `piaget` + `atlas` + `learning` |
| **11** | **Dedicated face embedder** (ArcFace/FaceNet vs generic object net) + **direct expression→drive affect route** (amygdala analog); raises ID threshold, cuts mis-ID (guardian-asymmetry correctness) | ~1 wk | med | perception + `drive` |
| **12** | **Depth (Depth Anything V2)** + temporal video — genuinely frontier, lowest ROI *now*; budget as a phase transition. Fix 640×480 hardcoding first. | ~2 wk | med | perception + `ashby` budget |

**Cheapest, do-first cluster: #0 + #1 + #2** — mostly promotion/refinement of code that already exists, all stability-neutral or stability-positive. **Batch #0 + #3 into a single fingerprint-version bump** to avoid two separate continuity breaks.

---

## 8. CANON flags to surface (do not code around)

1. **Learned head training signal** — must be self-supervised, never evaluation/reward-derived (Standard 6: no self-modification of evaluation). → `learning` + `canon`.
2. **Surprise must have a consumer** — a computed-but-unacted surprise flag is **theater**. Ship surprise *with* its consumer (salience gate / pressure routing). → `canon`.
3. **VLM outputs = `INFERENCE`, 0.60-capped, non-promoting until corroborated** — the single biggest theater-prohibition risk in the roadmap (fluent wrong captions). Never become WKG facts directly. → `canon` ruling before wiring deliberation.
4. **Curiosity relief-proportionality** — tying relief to *measured information gain* (entropy drop) rather than count change modifies the Curiosity drive contract. → `drive` + `canon` review.
5. **Confidence floors (0.40 SENSOR / 0.60 GUARDIAN) preserved** through all A.5 / concept-formation changes. Concept prototypes may grow above 0.60 via count *only once guardian-touched*.

---

## 9. Open questions / what to verify next

- **Latency budget (gates #8/#9/#12).** No one has measured the live sidecar's per-frame time on Jim's actual GPU. Run `/perception/detect` under load before committing to DINOv3-S + on-demand VLM. → live smoke test (`mythos`/`hopper`).
- **Object crops retained for re-embedding migration?** The face cold layer keeps base64 crops; objects may not — a backbone swap (#8) needs retained crops or the migration can't re-embed history. → verify (`sentinel`/`atlas`).
- **Refresh `cv-framework.md`** to document WS5's live scene-prediction + `nudgeSceneChange` (currently stale — §0).

---

## 10. One-paragraph synthesis

Sylphie's vision isn't behind on *models* — it's behind on *representation and construction*. The richest signal she computes (1280-D embeddings) is thrown away at the door; the cleverest machinery she owns (A.5 multi-signal scoring, the dorsal spatial extractor, occlusion-capable geometry) is dormant; and the predictive-coding spine WS5 built predicts *geometry* when it should predict *content*. The path to "most advanced" is therefore **promote what's built, feed cognition what it already computes, and let sightings change schemas** — in that order — while protecting three invariants the whole system silently relies on: relief stays epistemic, the embedding stays stable (or its change is a versioned migration), and the world can't seize the decision loop. A learned backbone and a queryable VLM are the genuinely cutting-edge moves, and they're safe *only after* the grounded-recall and stability scaffolding is in place. Do the cheap promotions first; they're stability-neutral and they unblock everything else.
