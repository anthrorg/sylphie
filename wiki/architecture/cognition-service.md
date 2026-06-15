# cognition-service — Architecture Reference

> Living document. Last updated: 2026-06-13. Auto-generated from full-file reads (one agent per file); verify before trusting any single line.

**19 files** mapped.

## File-by-file

### `packages/cognition-service/`

#### config.py
*config* — Cognition service environment configuration and model hyperparameters

Loads server port, training modes, and model dimensions from environment variables with development defaults. Defines bootstrap mode (shadow|audit|partial|full), training settings (enabled flag, checkpoint/replay-buffer sizes), and weights directory paths. Specifies model architecture dimensions: EMBEDDING_DIM=768, DRIVE_VECTOR_DIM=12, GLOBAL_INPUT_DIM=1561 (sum of embeddings + drive vectors + flags), ACTION_SPACE_DIM=32. Inference timeout default 50ms. Checkpoint saved every 1000 steps; replay buffer holds 100k transitions by default. Foundation weights stored in weights/foundation subdirectory.

- **Exports:** `PORT`, `BOOTSTRAP_MODE`, `TRAINING_ENABLED`, `CHECKPOINT_INTERVAL`, `REPLAY_BUFFER_SIZE`, `WEIGHTS_DIR`, `FOUNDATION_DIR`, `EMBEDDING_DIM`, `DRIVE_VECTOR_DIM`, `GLOBAL_INPUT_DIM`, `ACTION_SPACE_DIM`, `MAX_INFERENCE_TIMEOUT_MS`
- **Key constants:** `PORT=8431`, `BOOTSTRAP_MODE=shadow`, `TRAINING_ENABLED=true`, `CHECKPOINT_INTERVAL=1000`, `REPLAY_BUFFER_SIZE=100000`, `EMBEDDING_DIM=768`, `DRIVE_VECTOR_DIM=12`, `GLOBAL_INPUT_DIM=1561`, `ACTION_SPACE_DIM=32`, `MAX_INFERENCE_TIMEOUT_MS=50`
- **Deps:** `os`
- **Gotchas:** WEIGHTS_DIR computed relative to __dirname; relies on runtime file structure. Comment notes input dimensions must match NestJS SensoryFrame + DriveSnapshot schema (potential coupling risk).

#### conftest.py
*config* — Pytest configuration that adds the cognition service package root to sys.path for test imports

Registers the cognition-service directory on sys.path (insert at position 0) so test modules can import service submodules directly by their top-level names (config, training.trainer, models.convergence, etc.) matching runtime import style. Uses os.path.dirname(__file__) to locate the package root, guarded against duplicate insertions with a membership check. No fixtures, hooks, or other pytest machinery defined.

- **Key constants:** `_PACKAGE_ROOT is os.path.dirname(__file__)`
- **Gotchas:** sys.path modification is implicit side-effect on module load; no explicit fixtures or test functions

#### main.py
*service* — FastAPI microservice (port 8431) that runs TensorFlow cognitive pipeline replacing LLM-based internal cognition, receiving fused state tensors via HTTP and returning action priors and convergence results.

Core FastAPI app with lifespan (startup/shutdown), liveness probe, hot-path cycle endpoint, async training submission, checkpoint control, metrics, and bootstrap status reporting. Initializes CognitiveCycle with global/panel/convergence/deliberation models; DataBuffer for replay; Trainer thread for async training; BootstrapTracker for shadow/audit/full mode advancement with agreement-rate graduation. Endpoints: GET /cognition/health (models_loaded, bootstrap_mode, training_enabled, total_parameters), POST /cognition/cycle (req: state tensor -> CognitionCycleResponse with action prior + tensor_top_category during bootstrap), POST /cognition/train (labeled sample -> async buffer, triggers bootstrap comparison + agreement tracking + periodic mode advance every 100 samples), POST /cognition/checkpoint (force save, foundation optional), GET /cognition/metrics (training_steps, loss, inference_latency_ms, samples_in_buffer), GET /cognition/bootstrap (mode, agreement_rate, per_category_agreement, categories_graduated). Phase-transition endpoint (Online EWC anchor + empirical-Fisher calibration over 1000 samples from replay buffer). Supervisor control: /reinforce (inject sample repeat count = clamp(strengthFactor*3, 1-10)), /correct (inject 3× with correct label, zero_pending for wrong category), /freeze (suspend updates, thread stays alive), /unfreeze, /rollback (load from checkpoint_id or FOUNDATION_DIR), /model-state (param counts, training active/frozen, loss, mode breakdown). Logging uses _VerboseFormatter matching NestJS format (2026-04-09T23:43:22.774Z VERBOSE [Subsystem]), appends to logs/verbose.log. Windows TensorFlow noise suppressed (TF_CPP_MIN_LOG_LEVEL=2, oneDNN disabled, GPU warnings silenced).

- **Exports:** `app`, `lifespan`, `health`, `cognitive_cycle`, `submit_training_sample`, `force_checkpoint`, `metrics`, `bootstrap_status`, `phase_transition`, `reinforce`, `correct`, `freeze_model`, `unfreeze_model`, `rollback_checkpoint`, `model_state`
- **Key constants:** `PORT=8431`, `BOOTSTRAP_MODE=shadow`, `TRAINING_ENABLED=true`, `CHECKPOINT_INTERVAL=1000`, `REPLAY_BUFFER_SIZE=100000`, `INFERENCE_TIMEOUT_MS=50`, `EMBEDDING_DIM=768`, `DRIVE_VECTOR_DIM=12`, `GLOBAL_INPUT_DIM=1561`, `_ADVANCE_CHECK_INTERVAL=100`, `_FISHER_CALIBRATION_SAMPLES=1000`, `_CORRECTION_STRENGTH=3`
- **Deps:** `config`, `schemas`, `inference.bootstrap.BootstrapTracker`, `inference.cycle.CognitiveCycle`, `training.data_buffer.DataBuffer`, `training.trainer.Trainer`
- **Gotchas:** Per-model freeze not yet implemented (line 735). Tensor_top_category field omitted from response when trainer unavailable or in full mode (line 284). EWC anchor/Fisher computation can log errors but continues phase transition (lines 501-526). If weights list is empty from trainer (impossible per comment) phase transition still proceeds with uniform/decayed Fisher. Bootstrap comparison only recorded when both tensor_top_category and action_category present and mode != 'full' (lines 323-333).

#### schemas.py
*type* — Pydantic request/response schemas for cognition service API

Defines core inference pipeline schemas: CognitionCycleRequest (fused_embedding, drive_vector, drive_deltas, total_pressure, episodic_context, modality_embeddings, optional panel-domain slices) and CognitionCycleResponse (global_prior, panel_opinions, convergence_result, deliberation outputs, bootstrap audit field tensor_top_category). Training schema TrainingSample mirrors request plus labels (arbitration_type, action_category, response_embedding, outcome, drive_effects, prediction_mae, supervisor_verdict/correction). Health/metrics schemas: HealthResponse (status, models_loaded, bootstrap_mode, training_enabled, total_parameters, weight_checkpoint), MetricsResponse (training_steps, training_loss, inference_latency_ms, samples_in_buffer, checkpoint_count, per_category_confidence), BootstrapStatus (mode, agreement_rate, per_category_agreement, total_shadow_samples, total_audit_samples, categories_graduated). BootstrapMode enum: SHADOW, AUDIT, PARTIAL, FULL. Validation: Field constraints on embedding dims via config constants (EMBEDDING_DIM, DRIVE_VECTOR_DIM, ACTION_SPACE_DIM), confidence/urgency/novelty bounds [0, 1], divergence_score [0, 1].

- **Exports:** `BootstrapMode`, `CognitionCycleRequest`, `GlobalPrior`, `PanelOpinion`, `ConvergenceResult`, `CognitionCycleResponse`, `TrainingSample`, `HealthResponse`, `MetricsResponse`, `BootstrapStatus`
- **Key constants:** `BootstrapMode.SHADOW=shadow`, `BootstrapMode.AUDIT=audit`, `BootstrapMode.PARTIAL=partial`, `BootstrapMode.FULL=full`
- **Deps:** `config`
- **Gotchas:** No validation on modality_embeddings dict values (could be malformed); domain_signal defaults to 8-dim zero vector (hardcoded, not config-driven); deliberation_pipeline_weights=[pragmatist, conservative, advocate] is documented but no validation on length

### `packages/cognition-service/inference/`

#### __init__.py
*barrel* — Barrel module for inference subpackage

Empty barrel module containing only a docstring ("Inference orchestration and bootstrap logic."). No classes, functions, or exports defined. The actual implementation lives in sibling modules: bootstrap.py (bootstrap harness) and cycle.py (cycle orchestration). This __init__.py serves as the package marker and namespace declaration.

- **Gotchas:** Barrel file with no actual exports or re-exports. All implementation is in sibling modules; users must import from bootstrap or cycle directly.

#### bootstrap.py
*module* — Tracks LLM-vs-tensor model agreement and manages bootstrap mode progression from shadow → audit → partial → full

Defines BootstrapTracker class that records per-category agreement comparisons between tensor model outputs and LLM decisions. Maintains sliding windows (100-sample max) of boolean agreement per category. Implements mode transitions: shadow→audit at 100+ total comparisons, audit→partial when any category reaches 85% agreement (min 20 samples), partial→full when overall agreement ≥90% with 3+ graduated categories. should_use_tensor() gate returns False in shadow/audit (LLM decides), returns True for graduated categories in partial mode, returns True for all in full mode. Provides get_overall_agreement() and get_per_category_agreement() for monitoring. No internal threading — FastAPI-safe, accessed only from main async thread.

- **Exports:** `BootstrapTracker`
- **Key constants:** `_window_size=100`, `_graduation_threshold=0.85`, `_full_threshold=0.90`, `shadow_to_audit_threshold=100`, `graduation_sample_minimum=20`
- **Gotchas:** Thread safety comment warns against calling from training thread; case normalization (PascalCase→lowercase) for tensor/LLM category comparison; sliding window aggressively pops oldest on overflow; no explicit error handling for malformed categories

#### cycle.py
*module* — Cognitive cycle orchestration — assembles input tensor from NestJS state and runs global, panel, convergence, and deliberation models end-to-end.

CognitiveCycle is the main class that loads four model subsystems (GlobalModel, PanelModels, ConvergenceModel, DeliberationSystem) on init and combines them in a stateless hot path. The run() method receives a CognitionCycleRequest, assembles a 1561-float global tensor via _assemble_global_input (layout: fused_embedding [0:768], drive_vector [768:780], drive_deltas [780:792], total_pressure [792], episodic_context [793:1561]), executes global model prediction, feeds global tensor plus domain slices to panel models, checks convergence, triggers deliberation if divergent, and returns a CognitionCycleResponse with global priors, panel opinions, convergence metadata, and optional deliberation results. Includes bootstrap audit support: when a _VocabLookup is passed, response includes tensor_top_category (argmax of action_bias reverse-mapped to category name). save_checkpoint() persists all four model weights, with optional foundation=True for Society of Mind forking.

- **Exports:** `CognitiveCycle`, `_VocabLookup`
- **Key constants:** `GLOBAL_INPUT_DIM=1561 (implied; asserted in tensor shape check)`, `fused_embedding=[0:768] (768 floats)`, `drive_vector=[768:780] (12 floats)`, `drive_deltas=[780:792] (12 floats)`, `total_pressure=[792] (1 float)`, `episodic_context=[793:1561] (768 floats)`
- **Deps:** `models.global_model.GlobalModel`, `models.panel_models.PanelModels`, `models.convergence.ConvergenceModel`, `models.deliberation.DeliberationSystem`, `schemas.*`
- **Gotchas:** Panel models and convergence check receive slices of optional fields (drive_history, latent_match_scores, recent_mae_values, opportunity_features) that may be None; deliberation system only called if convergence.consensus is False; tensor_top_category is None unless vocab is provided (clients must opt-in to bootstrap audit); all state assumed to live in weights and NestJS side — sidecar is pure stateless computation.

### `packages/cognition-service/models/`

#### __init__.py
*barrel* — Entry point barrel for TensorFlow model definitions.

File declares itself as the barrel for TensorFlow model definitions for the cognitive pipeline but contains only a module docstring. No classes, functions, constants, or imports are currently defined. This is a stub barrel awaiting implementation of model definitions. The file is minimal (2 lines: docstring + blank).

- **Gotchas:** Stub barrel with no actual exports — any code importing from this module will fail. Models directory exists but is not yet wired into the cognitive pipeline.

#### convergence.py
*module* — Learned convergence checker that routes decisions between Type 1 (consensus) and Type 2 (deliberation) paths by comparing global and panel model agreement.

The module exports ConvergenceModel (a ~10K-param learned classifier that outputs divergence_score and consensus bool), ConvergenceOutput (dataclass holding consensus/divergence/per-panel similarity), and cosine_similarity() utility. ConvergenceModel takes global_action_bias (32 floats) + up to 4 panel opinions (32 each) = 160-dim input, passes through Dense(160→64 ReLU) then outputs divergence via sigmoid. During bootstrap, check() falls back to heuristic (1 - mean_cosine_sim) until use_learned is True; thereafter uses the learned forward pass. save()/load() handle checkpoint persistence with atomic replace and backward-compat for removed panel-adjustment head. Key threshold: DEFAULT_CONSENSUS_THRESHOLD=0.3 (divergence below this = consensus, above = Type 2). Xavier initialization with seed 0xC0DE. Notable: panel-adjustment head (64→4) was removed because it never fired (never wired to training signal); deferred until real gradient signal exists.

- **Exports:** `ConvergenceModel`, `ConvergenceOutput`, `cosine_similarity`, `DEFAULT_CONSENSUS_THRESHOLD`
- **Key constants:** `DEFAULT_CONSENSUS_THRESHOLD=0.3`, `input_dim=160 (32*5)`, `total_params~10K`, `xavier_seed=0xC0DE`, `cosine_norm_epsilon=1e-8`
- **Deps:** `config`, `models.panel_models.PanelOutput`
- **Gotchas:** Panel-adjustment head removed (lines 90-94): was never activated, contributed 260 random params that influenced nothing. Backward-compat load() silently ignores legacy w_adj/b_adj keys. use_learned graduation deferred (line 162 TODO): flip to True only after >=N trained convergence samples with >threshold accuracy, target >=1000 cycles. Currently check() always uses heuristic fallback.

#### deliberation.py
*module* — Three specialized tensor pipelines (Pragmatist, Conservative, Advocate) + Synthesis model for Type 2 deliberation when global/panel models diverge.

DeliberationSystem orchestrates three independent DeliberationPipeline instances (pragmatist, conservative, advocate), each a Dense(1561→512→256→32+1) network trained on different outcome/constraint data, producing 32-dim action biases. SynthesisModel (Dense(96→64→32+4)) combines the three outputs via concatenation, producing final synthesized action_bias (32-dim), pipeline_weights (3-dim softmax for trust attribution), and confidence (sigmoid). Deterministic Xavier uniform initialization per pipeline (seeds: pragmatist=0xD1A6, conservative=0xC0A5, advocate=0xAD10, synthesis=0x5171). Total ~1.36M params. Supports atomic save/load with .npz files and recovery tolerance for corrupted checkpoints.

- **Exports:** `PipelineOutput`, `DeliberationOutput`, `DeliberationPipeline`, `SynthesisModel`, `DeliberationSystem`
- **Key constants:** `GLOBAL_INPUT_DIM=1561`, `ACTION_SPACE_DIM=32`, `pragmatist_seed=0xD1A6`, `conservative_seed=0xC0A5`, `advocate_seed=0xAD10`, `synthesis_seed=0x5171`
- **Deps:** `config`
- **Gotchas:** Config imports GLOBAL_INPUT_DIM and ACTION_SPACE_DIM as module attributes; no explicit error handling for missing config values. Synthesis model pads input if fewer than 3 pipelines provided. Load methods log warnings but silently retain initialized weights on failure, potentially masking checkpoint corruption. No gradient/training code present—inference-only module.

#### global_model.py
*module* — Global action prior: dense feedforward network that fuses full cognitive state into action distribution and urgency/novelty scalars.

Dense network: 1561 → 512 → 256 → (32 + 2). Single class GlobalModel with dual implementation: TensorFlow Keras (preferred) with fallback to NumPy matrix math for environments without TF. _build_tf() creates functional model with ReLU hidden layers, softmax action head, sigmoid aux head. _build_numpy() initializes weight matrices using Xavier uniform (seed 0xBEEF). predict() runs 2D forward pass returning action_bias (32-element softmax), urgency and novelty_score (sigmoid scalars). Supports training via tf_variables() and weights_np() in canonical tensor order [w1, b1, w2, b2, w_action, b_action, w_aux, b_aux]. Shape validation ensures EWC weight anchor stability. Persistence via save()/load() handles atomic .h5 (TF) and .npz (NumPy) checkpoint formats with cross-format fallback. Tolerates corrupted checkpoints gracefully.

- **Exports:** `GlobalModel`
- **Key constants:** `input_dim=1561`, `action_dim=32`, `hidden_1_dim=512`, `hidden_2_dim=256`, `aux_output_dim=2`, `total_params~450K`, `xavier_seed=0xBEEF`
- **Deps:** `logging`, `os`, `numpy`, `tensorflow (optional)`, `config`
- **Gotchas:** TF dependency is optional; logger warns on import failure. Shape validation in tf_variables() is defensive against future Keras ordering changes. Weight locks are caller's responsibility during concurrent inference+training. Checkpoint corruptions are logged but don't crash—existing weights retained.

#### panel_models.py
*module* — Domain-specific panel models (Cortex) for four CANON decision panels: Drive Engine, Decision Making, Learning, Planning.

Four independent neural network panels (Drive, Decision, Learning, Planning) each with ~100K parameters. PanelModel class: dense feed-forward (input→256→128→32+1+8) with Xavier initialization, NumPy-only. Each panel produces action_bias (32-dim softmax), confidence (sigmoid [0,1]), and domain_signal (8-dim tanh). PanelModels container orchestrates predict_all() across global_tensor (1561 dims) plus domain-specific extras: Drive adds 120 (drive history), Decision adds 5 (latent scores), Learning adds 14 (MAE+novelty), Planning adds 8 (opportunity features). Save/load weights atomically via .npz with temp-file safety; graceful degradation on corrupted checkpoints (keeps Xavier init, logs warning).

- **Exports:** `PanelOutput`, `PanelModel`, `PanelModels`, `DRIVE_PANEL_INPUT`, `DECISION_PANEL_INPUT`, `LEARNING_PANEL_INPUT`, `PLANNING_PANEL_INPUT`
- **Key constants:** `DRIVE_PANEL_EXTRA=120`, `DRIVE_PANEL_INPUT=1681`, `DECISION_PANEL_EXTRA=5`, `DECISION_PANEL_INPUT=1566`, `LEARNING_PANEL_EXTRA=14`, `LEARNING_PANEL_INPUT=1575`, `PLANNING_PANEL_EXTRA=8`, `PLANNING_PANEL_INPUT=1569`
- **Deps:** `config`
- **Gotchas:** All panels share identical global_tensor (1561 dims) plus concat domain slices—no per-panel weighting or gating between them; Xavier seed keyed only on panel name hash, deterministic but not crypto-secure; load() silently keeps broken checkpoints as Xavier init without re-save (potential stale weights in multi-process scenario); domain_signal uses tanh for richer signal space but interpretation not documented

### `packages/cognition-service/training/`

#### __init__.py
*barrel* — Package initialization and re-export point for training module.

This is a minimal package __init__.py containing only a module docstring. It declares that this package provides training loop, data buffer, and experience replay functionality. No classes, functions, or symbols are defined or exported in this file. The actual implementations are expected to be in submodules within the training/ directory.

- **Gotchas:** Empty barrel file; no actual implementations are exposed. Real training components must be in sibling submodules (e.g., training/loop.py, training/buffer.py, training/replay.py). This file does not re-export anything from those submodules.

#### data_buffer.py
*component* — Thread-safe ring buffer for training samples with experience replay and Fisher-information calibration support.

DataBuffer is a fixed-capacity FIFO ring buffer (default 10000 samples from config.REPLAY_BUFFER_SIZE) that stores training samples as dicts with thread-safe access via threading.Lock(). Core methods: add() inserts samples (wrapping at capacity), sample_batch() returns mixed batches (replay_fraction [0,1] from random buffer positions + recent entries for recency bias), snapshot_calibration() draws unbiased calibration sets for EWC (with optional stratification by action_category). Helper _convert_to_numpy() transforms list fields to float32 arrays for batch efficiency. All writes are circular (head pointer modulo capacity); valid region tracking supports both pre-full and wrapped states.

- **Exports:** `DataBuffer`
- **Key constants:** `REPLAY_BUFFER_SIZE (from config)`, `_LIST_FIELDS={fused_embedding, drive_vector, drive_deltas, episodic_context, response_embedding}`
- **Deps:** `config`, `logging`, `threading`, `typing`, `numpy`
- **Gotchas:** No repetition in batches (np.random.choice replace=False) — caller must handle undersized buffers; stratified calibration falls back to plain random if no action_category field present; all public methods hold self._lock during access, safe for concurrent training + FastAPI threads.

#### replay.py
*module* — Experience replay batch mixing and Online Elastic Weight Consolidation (EWC) regularizer for continual learning across phase boundaries.

ExperienceReplay coordinates sampling from a DataBuffer with configurable replay_fraction and batch_size; the actual mixing logic delegates to DataBuffer.sample_batch(). EWCRegularizer implements Online EWC (Schwarz et al., 2018) to protect important weights during phase transitions (bootstrap→audit→partial→full). It maintains a running Fisher information diagonal estimate F_new = γ·F_old + F_phase, anchors to reference weights at each boundary, computes empirical Fisher (squared gradients on observed labels) from calibration samples, and applies a penalty λ/2·Σ_i F_i·(θ_i − θ*_i)². A per-phase λ ramp-up over _RAMP_STEPS=200 avoids Adam-momentum shock at transitions. Key constants: _ONLINE_GAMMA=0.7 (history decay), _FISHER_FLOOR=1e-8 (numerical stability floor), _FISHER_MAX=1e2 (per-layer clamp). The regularizer remains inactive until set_reference() is called; compute_fisher() processes calibration samples in chunks via compute_batch_gradients(), normalizes by sample count, applies floor/clamp, and stores the phase Fisher awaiting blend at the next boundary. penalty() and penalty_gradients() return scaled contributions with active ramp factor. Empirical Fisher is chosen over true Fisher by design per research rationale in wiki/researchedIdeas/2026-04-27-ewc-real-fisher-computation.md.

- **Exports:** `ExperienceReplay`, `EWCRegularizer`
- **Key constants:** `_ONLINE_GAMMA=0.7`, `_RAMP_STEPS=200`, `_FISHER_FLOOR=1e-8`, `_FISHER_MAX=1e2`
- **Deps:** `training.trainer._build_input_batch`, `training.trainer._build_labels`, `training.trainer.compute_batch_gradients`
- **Gotchas:** compute_fisher() raises ValueError on empty calibration set to prevent silent degenerate Fisher; _phase_fisher persists across set_reference() calls awaiting Online EWC blend, so compute_fisher() must be called at each phase to update; uniform fallback Fisher is used only if set_reference() called before any compute_fisher() — then logged as warning; chunk_size>1 trades estimator variance for speed but uses batch-aggregated gradients not per-sample

#### trainer.py
*module* — Background training loop that continuously updates cognition model weights via supervised learning on action categories.

Runs in a daemon thread with minimal lock contention to avoid blocking inference. Core classes: ActionVocabulary (thread-safe mapping from action_category strings to 0-31 indices, 31 reserved for "shrug", 0 for "unknown"), AdamOptimizer (standard Adam with lazy state init), Trainer (lifecycle and training orchestration). Backprop path supports both NumPy and TensorFlow GlobalModel implementations: compute_batch_gradients() dispatches to either _backprop() (hand-derived gradient computation) or _tf_batch_gradients() (GradientTape). Training uses cross-entropy loss on the 32-dim action head only; aux head (urgency/novelty) receives zero gradients during bootstrap until observed drive effects become reliable supervision signals. Numeric stability: clipped softmax, shifted logits. Loss signal: -sum(one_hot_label * log(clipped_probs)) / batch_size. Weight update cycle: fetch batch, compute gradients, add EWC penalty gradients, apply Adam step to copies, write back under brief lock. No cross-step gradient accumulation; supervisor freeze flag holds weights fixed without killing the thread. Checkpoints gated on both step count (config.CHECKPOINT_INTERVAL) and wall-clock interval (60s min).

- **Exports:** `ActionVocabulary`, `AdamOptimizer`, `Trainer`, `compute_batch_gradients`
- **Key constants:** `_SHRUG_INDEX=31`, `_UNKNOWN_INDEX=0`, `_BATCH_SIZE=32`, `_LOG_INTERVAL=100`, `_MIN_BUFFER_SIZE=10`, `_MIN_CHECKPOINT_INTERVAL_SEC=60.0`, `ACTION_SPACE_DIM=32`, `GLOBAL_INPUT_DIM=1561`
- **Deps:** `config`, `inference.cycle`, `training.data_buffer`, `training.replay`
- **Gotchas:** Aux head w_aux/b_aux receive zero gradients (logged as deliberate); no cross-step pending queue despite zero_pending_for_category() hook (documented as design choice for future async gradient queues); TensorFlow path may observe partial cross-tensor updates during concurrent inference but individual tensor assignment is atomic; weight order convention strictly [w1,b1,w2,b2,w_action,b_action,w_aux,b_aux] must match GlobalModel.save/load and tf_variables().

### `packages/cognition-service/training/tests/`

#### __init__.py
*barrel* — Empty Python package marker file for test module

This is a bare __init__.py file with no content. It serves as a Python package marker for the training.tests submodule hierarchy. Contains no classes, functions, exports, imports, constants, side effects, or executable code.

- **Gotchas:** Empty file; no test fixtures or shared test utilities defined here

#### test_replay.py
*test* — Unit tests for Online EWC regularizer (empirical Fisher computation, blend rule, λ ramp-up, numerical stability).

Tests the EWCRegularizer class from training/replay.py across four domains: Fisher diagonal correctness verified against hand-computed gradients and full trainer pipeline (test_compute_fisher_correctness, test_penalty_gradients_with_real_fisher); Online EWC blending rule F_new = γ·F_old + F_phase (test_online_ewc_update); λ ramp-up from 0 at step 0 to full strength after _RAMP_STEPS (test_lambda_ramp, test_penalty_inactive_before_set_reference); numerical stability for edge cases (all-zero gradients floored, large gradients clamped to _FISHER_MAX, empty calibration raises ValueError, chunking consistency). Test doubles include _TinyModel (8-weight NumPy network), _FakeCycle, _FakeVocab, _FakeTrainer, and _make_sample (generates random input samples partitioned into fused/drive/deltas/pressure/episodic).

- **Exports:** `test_compute_fisher_correctness`, `test_penalty_gradients_with_real_fisher`, `test_online_ewc_update`, `test_lambda_ramp`, `test_penalty_inactive_before_set_reference`, `test_fisher_numerical_stability`, `test_compute_fisher_chunking_consistency`
- **Key constants:** `_FISHER_FLOOR (clamped in EWCRegularizer)`, `_FISHER_MAX (clamped in EWCRegularizer)`, `_ONLINE_GAMMA (Online EWC blend factor)`, `_RAMP_STEPS (λ ramp duration)`, `ACTION_SPACE_DIM (from config)`, `input_dim=6 (default _TinyModel)`, `h1=4, h2=3 (hidden dims _TinyModel)`
- **Deps:** `training.replay.EWCRegularizer`, `training.trainer._backprop`, `training.trainer._build_input_batch`, `training.trainer._build_labels`, `training.trainer._forward_with_cache`, `config`
- **Gotchas:** Empirical-Fisher uses per-batch mean gradient; chunk_size≥2 produces slightly different estimates than per-sample (chunk=1) but should be same order of magnitude and finite. Unsupervised aux head (w_aux, b_aux) always has zero gradient and must be floored, not above floor. w_aux and b_aux are indices 6 and 7 in weight list. Fisher floor/max bounds prevent inf/nan on extreme gradient values. Empty calibration set raises ValueError (explicit guard).

#### test_tf_training.py
*test* — Verify TensorFlow training path parity with NumPy reference implementation

Test suite for TensorFlow gradient computation, weight handling, and training loop. Establishes 6 load-bearing assumptions: (1) TF trainable_variables order matches canonical 8-tensor convention; (2) weight round-trip TF<->NumPy preserves forward outputs; (3) GradientTape gradients match hand-derived backprop; (4) Fisher computation identical under TF; (5) training reduces loss on TF path; (6) Trainer end-to-end operations work under TF. Key test functions: test_tf_variable_order_canonical() verifies 8-tensor shape tuple, total_params==939,810. test_forward_parity_after_weight_transfer() transfers weights between models and compares action_bias, urgency, novelty_score outputs. test_gradient_parity() checks grads via compute_batch_gradients() match within rtol=1e-3. test_fisher_parity() validates EWCRegularizer._phase_fisher across both paths. test_tf_training_reduces_loss() runs 40 Adam steps, verifies loss < initial * 0.5. test_trainer_train_step_tf() exercises Trainer._train_step(), get_weights(), freeze()/unfreeze() under TF. Fixtures: tf_model (GlobalModel with TF active), np_model (GlobalModel with HAS_TF=False). Batch creation via _make_batch() uses standard_normal samples with 4 action categories. Test tolerances: forward parity rtol=1e-4, gradient parity rtol=1e-3, Fisher parity rtol=1e-3.

- **Key constants:** `n=8 (default batch size)`, `n=16 (training batch)`, `40 (Adam steps)`, `lr=0.001 (learning rate)`, `chunk_size=4 (Fisher computation)`, `loss_threshold=0.5 (reduction factor)`
- **Deps:** `numpy`, `pytest`, `tensorflow`, `config`, `models.global_model`, `training.replay.EWCRegularizer`, `training.trainer.{ActionVocabulary,AdamOptimizer,Trainer,_build_input_batch,_build_labels,compute_batch_gradients}`
- **Gotchas:** Fixture np_model temporarily masks HAS_TF global to force NumPy path; must be reset in finally block. Aux head (canonical tensors 6-7) has zero gradients and Fisher floored at _FISHER_FLOOR constant—tested explicitly. _CycleStub and _BufferStub are minimal mocks without full cycle/buffer semantics.

## Risks / stubs / TODOs

- `packages/cognition-service/config.py` — WEIGHTS_DIR computed relative to __dirname; relies on runtime file structure. Comment notes input dimensions must match NestJS SensoryFrame + DriveSnapshot schema (potential coupling risk).
- `packages/cognition-service/conftest.py` — sys.path modification is implicit side-effect on module load; no explicit fixtures or test functions
- `packages/cognition-service/inference/__init__.py` — Barrel file with no actual exports or re-exports. All implementation is in sibling modules; users must import from bootstrap or cycle directly.
- `packages/cognition-service/inference/bootstrap.py` — Thread safety comment warns against calling from training thread; case normalization (PascalCase→lowercase) for tensor/LLM category comparison; sliding window aggressively pops oldest on overflow; no explicit error handling for malformed categories
- `packages/cognition-service/inference/cycle.py` — Panel models and convergence check receive slices of optional fields (drive_history, latent_match_scores, recent_mae_values, opportunity_features) that may be None; deliberation system only called if convergence.consensus is False; tensor_top_category is None unless vocab is provided (clients must opt-in to bootstrap audit); all state assumed to live in weights and NestJS side — sidecar is pure stateless computation.
- `packages/cognition-service/main.py` — Per-model freeze not yet implemented (line 735). Tensor_top_category field omitted from response when trainer unavailable or in full mode (line 284). EWC anchor/Fisher computation can log errors but continues phase transition (lines 501-526). If weights list is empty from trainer (impossible per comment) phase transition still proceeds with uniform/decayed Fisher. Bootstrap comparison only recorded when both tensor_top_category and action_category present and mode != 'full' (lines 323-333).
- `packages/cognition-service/models/__init__.py` — Stub barrel with no actual exports — any code importing from this module will fail. Models directory exists but is not yet wired into the cognitive pipeline.
- `packages/cognition-service/models/convergence.py` — Panel-adjustment head removed (lines 90-94): was never activated, contributed 260 random params that influenced nothing. Backward-compat load() silently ignores legacy w_adj/b_adj keys. use_learned graduation deferred (line 162 TODO): flip to True only after >=N trained convergence samples with >threshold accuracy, target >=1000 cycles. Currently check() always uses heuristic fallback.
- `packages/cognition-service/models/deliberation.py` — Config imports GLOBAL_INPUT_DIM and ACTION_SPACE_DIM as module attributes; no explicit error handling for missing config values. Synthesis model pads input if fewer than 3 pipelines provided. Load methods log warnings but silently retain initialized weights on failure, potentially masking checkpoint corruption. No gradient/training code present—inference-only module.
- `packages/cognition-service/models/global_model.py` — TF dependency is optional; logger warns on import failure. Shape validation in tf_variables() is defensive against future Keras ordering changes. Weight locks are caller's responsibility during concurrent inference+training. Checkpoint corruptions are logged but don't crash—existing weights retained.
- `packages/cognition-service/models/panel_models.py` — All panels share identical global_tensor (1561 dims) plus concat domain slices—no per-panel weighting or gating between them; Xavier seed keyed only on panel name hash, deterministic but not crypto-secure; load() silently keeps broken checkpoints as Xavier init without re-save (potential stale weights in multi-process scenario); domain_signal uses tanh for richer signal space but interpretation not documented
- `packages/cognition-service/schemas.py` — No validation on modality_embeddings dict values (could be malformed); domain_signal defaults to 8-dim zero vector (hardcoded, not config-driven); deliberation_pipeline_weights=[pragmatist, conservative, advocate] is documented but no validation on length
- `packages/cognition-service/training/__init__.py` — Empty barrel file; no actual implementations are exposed. Real training components must be in sibling submodules (e.g., training/loop.py, training/buffer.py, training/replay.py). This file does not re-export anything from those submodules.
- `packages/cognition-service/training/data_buffer.py` — No repetition in batches (np.random.choice replace=False) — caller must handle undersized buffers; stratified calibration falls back to plain random if no action_category field present; all public methods hold self._lock during access, safe for concurrent training + FastAPI threads.
- `packages/cognition-service/training/replay.py` — compute_fisher() raises ValueError on empty calibration set to prevent silent degenerate Fisher; _phase_fisher persists across set_reference() calls awaiting Online EWC blend, so compute_fisher() must be called at each phase to update; uniform fallback Fisher is used only if set_reference() called before any compute_fisher() — then logged as warning; chunk_size>1 trades estimator variance for speed but uses batch-aggregated gradients not per-sample
- `packages/cognition-service/training/tests/__init__.py` — Empty file; no test fixtures or shared test utilities defined here
- `packages/cognition-service/training/tests/test_replay.py` — Empirical-Fisher uses per-batch mean gradient; chunk_size≥2 produces slightly different estimates than per-sample (chunk=1) but should be same order of magnitude and finite. Unsupervised aux head (w_aux, b_aux) always has zero gradient and must be floored, not above floor. w_aux and b_aux are indices 6 and 7 in weight list. Fisher floor/max bounds prevent inf/nan on extreme gradient values. Empty calibration set raises ValueError (explicit guard).
- `packages/cognition-service/training/tests/test_tf_training.py` — Fixture np_model temporarily masks HAS_TF global to force NumPy path; must be reset in finally block. Aux head (canonical tensors 6-7) has zero gradients and Fisher floored at _FISHER_FLOOR constant—tested explicitly. _CycleStub and _BufferStub are minimal mocks without full cycle/buffer semantics.
- `packages/cognition-service/training/trainer.py` — Aux head w_aux/b_aux receive zero gradients (logged as deliberate); no cross-step pending queue despite zero_pending_for_category() hook (documented as design choice for future async gradient queues); TensorFlow path may observe partial cross-tensor updates during concurrent inference but individual tensor assignment is atomic; weight order convention strictly [w1,b1,w2,b2,w_action,b_action,w_aux,b_aux] must match GlobalModel.save/load and tf_variables().

## Change log
- 2026-06-13 — Initial auto-generated map (19 files read in full).
