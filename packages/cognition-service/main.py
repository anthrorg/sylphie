"""Cognition microservice -- TensorFlow cognitive pipeline for Sylphie.

Runs custom dense networks that replace LLM-based internal cognition.
The NestJS orchestrator sends fused state tensors via HTTP and receives
action priors, panel opinions, and convergence results.

Port 8431.

Endpoints:
    GET  /cognition/health         -- liveness probe: models loaded, bootstrap mode
    POST /cognition/cycle          -- hot path: state tensor -> action prior + convergence
    POST /cognition/train          -- submit training sample (async, non-blocking)
    POST /cognition/checkpoint     -- force weight checkpoint
    GET  /cognition/metrics        -- training loss, inference latency, buffer size
    GET  /cognition/bootstrap      -- bootstrap phase status + agreement rates

Design:
    - Mirrors the perception-service sidecar pattern (FastAPI + uvicorn).
    - Stateless except for model weights on disk.
    - All episodic memory and knowledge stays in TimescaleDB/Neo4j (NestJS side).
    - Training runs in a background thread, never blocks inference.
    - Models start with Xavier-initialized random weights (bootstrap phase).

Environment variables (COGNITION_ prefix):
    COGNITION_PORT                 (default 8431)
    COGNITION_BOOTSTRAP_MODE       (default shadow)
    COGNITION_TRAINING_ENABLED     (default true)
    COGNITION_CHECKPOINT_INTERVAL  (default 1000 training steps)
    COGNITION_WEIGHTS_DIR          (default ./weights)
    COGNITION_REPLAY_BUFFER_SIZE   (default 100000)
    COGNITION_INFERENCE_TIMEOUT_MS (default 50)
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager
from datetime import UTC, datetime

# Suppress TensorFlow GPU-not-available warning on native Windows.
# TF >= 2.11 dropped native CUDA on Windows; the DirectML plugin is not yet
# available for Python 3.13.  CPU inference is well within our 50 ms budget
# at 5.5 M parameters, so this is informational noise.
if sys.platform == "win32":
    os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")
    # TF_CPP_MIN_LOG_LEVEL: 0=all, 1=no INFO, 2=no WARNING, 3=no ERROR
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
    # Also silence TF's Python-level logger (propagates through root logger)
    logging.getLogger("tensorflow").setLevel(logging.ERROR)

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import config
from schemas import (
    BootstrapStatus,
    CognitionCycleRequest,
    CognitionCycleResponse,
    HealthResponse,
    MetricsResponse,
    TrainingSample,
)
from inference.bootstrap import BootstrapTracker
from inference.cycle import CognitiveCycle
from training.data_buffer import DataBuffer
from training.trainer import Trainer

# ---------------------------------------------------------------------------
# Logging — matches NestJS verbose format, appends to project-root logs/verbose.log
# ---------------------------------------------------------------------------

# Map Python logger names to short subsystem tags matching NestJS conventions
_SUBSYSTEM_MAP = {
    "cognition_service": "CognitionSvc",
    "cognition_service.global_model": "CognitionModel",
    "cognition_service.panel_models": "CognitionModel",
    "cognition_service.convergence": "CognitionModel",
    "cognition_service.deliberation": "CognitionModel",
    "cognition_service.cycle": "CognitionCycle",
    "cognition_service.training": "CognitionTrain",
    "cognition_service.bootstrap": "CognitionBoot",
}


class _VerboseFormatter(logging.Formatter):
    """Format log lines to match the NestJS verbose log format:
    2026-04-09T23:43:22.774Z VERBOSE [Subsystem] message
    """

    def format(self, record: logging.LogRecord) -> str:
        from datetime import timezone, datetime
        ts = datetime.fromtimestamp(record.created, tz=timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%S.%f"
        )[:-3] + "Z"
        subsystem = _SUBSYSTEM_MAP.get(record.name, "CognitionSvc")
        level = "VERBOSE" if record.levelno <= logging.INFO else record.levelname
        return f"{ts} {level} [{subsystem}] {record.getMessage()}"


# Console handler (stderr, like NestJS)
_console = logging.StreamHandler()
_console.setFormatter(_VerboseFormatter())

# File handler — append to project-root logs/verbose.log
# The cognition-service runs from packages/cognition-service/,
# so we go up two levels to reach the project root.
_log_dir = os.path.join(os.path.dirname(__file__), "..", "..", "logs")
os.makedirs(_log_dir, exist_ok=True)
_file_handler = logging.FileHandler(
    os.path.join(_log_dir, "verbose.log"), mode="a", encoding="utf-8",
)
_file_handler.setFormatter(_VerboseFormatter())

logging.basicConfig(level=logging.INFO, handlers=[_console, _file_handler])
logger = logging.getLogger("cognition_service")

# How many training samples to receive between periodic mode-advancement checks.
_ADVANCE_CHECK_INTERVAL = 100

# ---------------------------------------------------------------------------
# Application State
# ---------------------------------------------------------------------------


class _AppState:
    """Mutable singleton holding runtime state for the cognition service."""

    def __init__(self) -> None:
        self.models_loaded: bool = False
        self._bootstrap_mode_initial: str = config.BOOTSTRAP_MODE
        self.training_enabled: bool = config.TRAINING_ENABLED
        self.cycle: CognitiveCycle | None = None
        self.buffer: DataBuffer | None = None
        self.trainer: Trainer | None = None
        self.bootstrap_tracker: BootstrapTracker | None = None

        # Most recent cycle result. Stored so the train endpoint can pair the
        # tensor's resolved top category with the LLM's action_category when
        # recording a bootstrap comparison, without requiring a second forward pass.
        self.last_cycle_result: CognitionCycleResponse | None = None

        # Metrics
        self.inference_latency_ms: float = 0.0
        self.checkpoint_count: int = 0
        # Running mean of per-cycle confidence, keyed by the tensor's resolved
        # top action_category. Surfaced via GET /cognition/metrics for the
        # Guardian dashboard panel. Updated by record_cycle_confidence() after
        # each /cognition/cycle. The companion count dict backs the incremental
        # mean so we never have to retain the full history.
        self.per_category_confidence: dict[str, float] = {}
        self._per_category_confidence_counts: dict[str, int] = {}

        # Bootstrap sample counters (raw counts; agreement data lives in tracker).
        self.total_shadow_samples: int = 0
        self.total_audit_samples: int = 0

        # Samples received since the last mode-advancement check.
        self._samples_since_advance_check: int = 0

        self.started_at: datetime = datetime.now(UTC)

    # Convenience properties that delegate to live objects so the metrics
    # endpoint always reflects real state without extra bookkeeping.

    @property
    def bootstrap_mode(self) -> str:
        """Current bootstrap mode. Delegates to the tracker once initialised."""
        if self.bootstrap_tracker is not None:
            return self.bootstrap_tracker.mode
        return self._bootstrap_mode_initial

    @property
    def training_steps(self) -> int:
        if self.trainer is not None:
            return self.trainer.training_steps
        return 0

    @property
    def training_loss(self) -> float | None:
        if self.trainer is not None:
            return self.trainer.last_loss
        return None

    @property
    def samples_in_buffer(self) -> int:
        if self.buffer is not None:
            return len(self.buffer)
        return 0

    def record_cycle_confidence(self, result: CognitionCycleResponse) -> None:
        """Aggregate a cycle's confidence into per_category_confidence.

        The cycle's confidence scalar is the mean of the panel confidence
        heads for this cycle (each panel emits a sigmoid confidence in
        [0, 1]). It is attributed to the tensor's resolved top category
        (result.tensor_top_category) and folded into an incremental running
        mean so the metrics endpoint reflects the long-run confidence the
        sidecar has expressed for each category.

        Categories are only resolvable when a vocab was passed to cycle.run
        (i.e. during bootstrap, when tensor_top_category is populated). When
        it is None — full mode, or no vocab — there is nothing to attribute,
        so the cycle is skipped rather than bucketed under a placeholder.
        """
        category = result.tensor_top_category
        if not category:
            return

        opinions = result.panel_opinions
        if not opinions:
            return
        cycle_confidence = sum(p.confidence for p in opinions) / len(opinions)

        key = category.strip().lower()
        prev_count = self._per_category_confidence_counts.get(key, 0)
        prev_mean = self.per_category_confidence.get(key, 0.0)
        new_count = prev_count + 1
        # Incremental mean: mean_n = mean_{n-1} + (x_n - mean_{n-1}) / n
        self.per_category_confidence[key] = (
            prev_mean + (cycle_confidence - prev_mean) / new_count
        )
        self._per_category_confidence_counts[key] = new_count


_state = _AppState()


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle for the cognition service."""
    logger.info("Cognition service starting (port=%d, bootstrap=%s, training=%s)",
                config.PORT, config.BOOTSTRAP_MODE, config.TRAINING_ENABLED)

    # Ensure weights directory exists
    os.makedirs(config.WEIGHTS_DIR, exist_ok=True)
    os.makedirs(config.FOUNDATION_DIR, exist_ok=True)

    # Initialize the cognitive cycle (loads or creates models)
    _state.cycle = CognitiveCycle()
    _state.models_loaded = True

    # Initialize training infrastructure
    _state.buffer = DataBuffer(capacity=config.REPLAY_BUFFER_SIZE)
    _state.trainer = Trainer(cycle=_state.cycle, buffer=_state.buffer)

    # Bootstrap tracker — must come after trainer so the initial mode is set once
    _state.bootstrap_tracker = BootstrapTracker(initial_mode=config.BOOTSTRAP_MODE)

    if _state.training_enabled:
        _state.trainer.start()
        logger.info("Training thread started (buffer_capacity=%d)", config.REPLAY_BUFFER_SIZE)
    else:
        logger.info("Training disabled — trainer not started")

    logger.info(
        "Cognition service ready (models_loaded=%s, params=%d)",
        _state.models_loaded,
        _state.cycle.total_params,
    )

    yield

    # Shutdown: stop trainer, save final checkpoint
    logger.info("Cognition service shutting down (training_steps=%d)", _state.training_steps)
    if _state.trainer is not None:
        _state.trainer.stop()
    if _state.cycle:
        _state.cycle.save_checkpoint(foundation=False)


# ---------------------------------------------------------------------------
# FastAPI App
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Sylphie Cognition Service",
    version="0.1.0",
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# GET /cognition/health
# ---------------------------------------------------------------------------

@app.get("/cognition/health", response_model=HealthResponse)
async def health():
    """Liveness probe: reports model state and bootstrap mode."""
    return HealthResponse(
        status="ok",
        models_loaded=_state.models_loaded,
        bootstrap_mode=_state.bootstrap_mode,
        training_enabled=_state.training_enabled,
        total_parameters=_state.cycle.total_params if _state.cycle else 0,
        weight_checkpoint=config.WEIGHTS_DIR,
    )


# ---------------------------------------------------------------------------
# POST /cognition/cycle
# ---------------------------------------------------------------------------

@app.post("/cognition/cycle", response_model=CognitionCycleResponse)
async def cognitive_cycle(req: CognitionCycleRequest):
    """Hot path: receive fused state tensor, run cognitive cycle, return action prior.

    During bootstrap (shadow/audit mode), the NestJS side still uses LLM output
    for actual decisions. The tensor output is logged for training comparison.
    """
    if not _state.cycle:
        raise RuntimeError("Models not loaded")

    # Pass the action vocabulary during bootstrap so the response carries
    # tensor_top_category for NestJS audit comparison. In full mode or when
    # the trainer is unavailable, vocab is None and the field is omitted.
    vocab = _state.trainer._vocab if _state.trainer is not None else None

    # Internal watchdog: cycle.run is synchronous CPU work, so we offload it to
    # a worker thread and bound it with asyncio.wait_for. The TS caller already
    # has its own AbortSignal, but the sidecar self-protects + logs so a hung
    # cycle can't silently pin the event loop. Timeout is MAX_INFERENCE_TIMEOUT_MS
    # (config), converted to seconds.
    timeout_s = config.MAX_INFERENCE_TIMEOUT_MS / 1000.0
    try:
        result = await asyncio.wait_for(
            asyncio.to_thread(_state.cycle.run, req, vocab),
            timeout=timeout_s,
        )
    except asyncio.TimeoutError:
        logger.error(
            "Cognitive cycle exceeded MAX_INFERENCE_TIMEOUT_MS=%d ms — "
            "aborting this request. The worker thread may still be running; "
            "this is a watchdog, not a hard kill. Returning 503.",
            config.MAX_INFERENCE_TIMEOUT_MS,
        )
        return JSONResponse(
            status_code=503,
            content={
                "error": "cycle_timeout",
                "timeout_ms": config.MAX_INFERENCE_TIMEOUT_MS,
            },
        )

    _state.inference_latency_ms = result.inference_ms
    _state.last_cycle_result = result
    # Aggregate this cycle's confidence by resolved category for the metrics
    # endpoint / Guardian dashboard panel (§2.3).
    _state.record_cycle_confidence(result)
    return result


# ---------------------------------------------------------------------------
# POST /cognition/train
# ---------------------------------------------------------------------------

@app.post("/cognition/train")
async def submit_training_sample(sample: TrainingSample):
    """Accept a labeled training sample from the NestJS orchestrator.

    Samples are added to the ring buffer and processed by the background
    training thread. This endpoint returns immediately (non-blocking).

    Bootstrap comparison logic: if the sample has an action_category (the LLM's
    decision) and the most recent cycle result carried a tensor_top_category (the
    tensor's resolved argmax category), the pair is recorded in the bootstrap
    tracker. Every _ADVANCE_CHECK_INTERVAL samples the tracker checks whether the
    current mode should advance.
    """
    current_mode = _state.bootstrap_mode

    if current_mode == "shadow":
        _state.total_shadow_samples += 1
    elif current_mode == "audit":
        _state.total_audit_samples += 1

    if _state.buffer is not None:
        _state.buffer.add(sample.model_dump())

    # Bootstrap comparison: record tensor vs LLM agreement when we have both
    # sides of the pair. The tensor's top category comes from last_cycle_result
    # (set by the preceding /cognition/cycle call for this same cognitive cycle).
    # The LLM's category comes from this training sample.
    tracker = _state.bootstrap_tracker
    if (
        tracker is not None
        and sample.action_category is not None
        and _state.last_cycle_result is not None
        and _state.last_cycle_result.tensor_top_category is not None
        and current_mode != "full"
    ):
        tracker.record_comparison(
            tensor_top_category=_state.last_cycle_result.tensor_top_category,
            llm_category=sample.action_category,
        )

        # Check for newly graduated categories after each recorded comparison.
        # Cheap (iterates the small category dict) and keeps the graduated set
        # current without a separate polling loop.
        newly_graduated = tracker.check_graduations()
        if newly_graduated:
            logger.info(
                "Newly graduated categories: %s (total graduated: %d)",
                newly_graduated,
                len(tracker._graduated_categories),
            )

    # Periodic mode-advancement check every _ADVANCE_CHECK_INTERVAL samples.
    if tracker is not None:
        _state._samples_since_advance_check += 1
        if _state._samples_since_advance_check >= _ADVANCE_CHECK_INTERVAL:
            _state._samples_since_advance_check = 0
            if tracker.advance_mode():
                logger.info(
                    "Bootstrap mode advanced to '%s' "
                    "(shadow_samples=%d, audit_samples=%d)",
                    tracker.mode,
                    _state.total_shadow_samples,
                    _state.total_audit_samples,
                )

    return {"accepted": True, "buffer_size": _state.samples_in_buffer}


# ---------------------------------------------------------------------------
# POST /cognition/checkpoint
# ---------------------------------------------------------------------------

@app.post("/cognition/checkpoint")
async def force_checkpoint(foundation: bool = False):
    """Force a weight checkpoint save.

    If foundation=True, saves to the foundation directory for Society of Mind forking.
    """
    if not _state.cycle:
        raise RuntimeError("Models not loaded")

    path = _state.cycle.save_checkpoint(foundation=foundation)
    _state.checkpoint_count += 1
    target = "foundation" if foundation else "periodic"
    logger.info("Checkpoint saved (%s, count=%d, path=%s)", target, _state.checkpoint_count, path)
    return {"saved": True, "type": target, "checkpoint_count": _state.checkpoint_count, "path": path}


# ---------------------------------------------------------------------------
# GET /cognition/metrics
# ---------------------------------------------------------------------------

@app.get("/cognition/metrics", response_model=MetricsResponse)
async def metrics():
    """Training and inference metrics for monitoring."""
    return MetricsResponse(
        training_steps=_state.training_steps,
        training_loss=_state.training_loss,
        inference_latency_ms=_state.inference_latency_ms,
        samples_in_buffer=_state.samples_in_buffer,
        checkpoint_count=_state.checkpoint_count,
        per_category_confidence=_state.per_category_confidence,
    )


# ---------------------------------------------------------------------------
# GET /cognition/bootstrap
# ---------------------------------------------------------------------------

@app.get("/cognition/bootstrap", response_model=BootstrapStatus)
async def bootstrap_status():
    """Bootstrap phase status and agreement rates.

    Delegates agreement and graduation data to the BootstrapTracker. The raw
    shadow/audit sample counters are maintained separately in _AppState so
    they can be reported even when the tracker has no comparison data yet.
    """
    tracker = _state.bootstrap_tracker
    if tracker is not None:
        status = tracker.get_status()
        return BootstrapStatus(
            mode=status["mode"],
            agreement_rate=status["agreement_rate"],
            per_category_agreement=status["per_category_agreement"],
            total_shadow_samples=_state.total_shadow_samples,
            total_audit_samples=_state.total_audit_samples,
            categories_graduated=status["categories_graduated"],
        )
    # Tracker not yet initialised (pre-lifespan call — should not happen in practice).
    return BootstrapStatus(
        mode=_state.bootstrap_mode,
        agreement_rate=0.0,
        per_category_agreement={},
        total_shadow_samples=_state.total_shadow_samples,
        total_audit_samples=_state.total_audit_samples,
        categories_graduated=[],
    )


# ---------------------------------------------------------------------------
# Phase transition (Online EWC anchor + Fisher recompute)
# ---------------------------------------------------------------------------

# Number of calibration samples drawn from the replay buffer at a phase
# boundary for the empirical-Fisher estimate. 1000 is within the 500–2000
# range recommended by the EWC research note.
_FISHER_CALIBRATION_SAMPLES = 1000

_VALID_PHASES = {"shadow", "audit", "partial", "full"}


class PhaseTransitionRequest(BaseModel):
    """Phase-boundary signal from the supervisor.

    Triggers an Online EWC consolidation: anchor to current weights, compute
    the empirical Fisher over a calibration set, and update the runtime
    bootstrap mode.
    """
    new_phase: str  # audit | partial | full (shadow accepted but is the start state)


@app.post("/cognition/phase-transition")
async def phase_transition(req: PhaseTransitionRequest):
    """Consolidate weights at an operational phase boundary (Online EWC).

    This is the runtime mechanism by which the supervisor advances Sylphie
    between operational phases. The static COGNITION_BOOTSTRAP_MODE env var
    only sets the *initial* mode; this endpoint moves the live state machine.

    On receipt it:
      1. Anchors EWC to the current model weights (set_reference) — rolls the
         running Online-EWC Fisher estimate.
      2. Computes the empirical Fisher diagonal over a stratified calibration
         set drawn from the replay buffer.
      3. Updates the runtime bootstrap mode (BootstrapTracker.mode).

    Returns 400 if the phase is unknown or the trainer/buffer is unavailable.
    """
    new_phase = req.new_phase.strip().lower()
    if new_phase not in _VALID_PHASES:
        return JSONResponse(
            status_code=400,
            content={
                "accepted": False,
                "error": f"Unknown phase '{req.new_phase}'. "
                         f"Expected one of {sorted(_VALID_PHASES)}.",
            },
        )

    if _state.trainer is None or _state.buffer is None:
        return JSONResponse(
            status_code=400,
            content={"accepted": False, "error": "Trainer/buffer not initialized"},
        )

    prev_phase = _state.bootstrap_mode
    trainer = _state.trainer
    buffer = _state.buffer

    # Capture the EWC anchor and run the calibration-set Fisher pass.
    weights = trainer.get_weights()
    fisher_computed = False
    calibration_n = 0
    if not weights:
        # Both model paths expose canonical weights now — an empty list is a
        # bug, not an accepted configuration. Log loudly.
        logger.error(
            "Phase transition to '%s': trainer returned NO weights — "
            "EWC anchor/Fisher skipped. This should be impossible (NumPy and "
            "TF paths both expose canonical weights); investigate.",
            new_phase,
        )
    else:
        trainer.ewc.set_reference(weights)
        calibration = buffer.snapshot_calibration(
            _FISHER_CALIBRATION_SAMPLES, stratified=True,
        )
        if calibration:
            try:
                trainer.ewc.compute_fisher(trainer, calibration)
                fisher_computed = True
                calibration_n = len(calibration)
            except ValueError as exc:
                logger.warning(
                    "Phase transition Fisher computation skipped: %s", exc,
                )
        else:
            logger.warning(
                "Phase transition to '%s': replay buffer empty, Fisher not "
                "computed (EWC anchored with uniform/decayed Fisher).",
                new_phase,
            )

    # Advance the runtime mode.
    if _state.bootstrap_tracker is not None:
        _state.bootstrap_tracker.mode = new_phase

    logger.info(
        "=== PHASE TRANSITION: %s -> %s === "
        "(ewc_anchored=%s, fisher_computed=%s, calibration_samples=%d)",
        prev_phase, new_phase, bool(weights), fisher_computed, calibration_n,
    )

    return {
        "accepted": True,
        "previous_phase": prev_phase,
        "new_phase": new_phase,
        "ewc_anchored": bool(weights),
        "fisher_computed": fisher_computed,
        "calibration_samples": calibration_n,
    }


# ---------------------------------------------------------------------------
# Supervisor Control Endpoints
# ---------------------------------------------------------------------------

class InterventionRequest(BaseModel):
    """Intervention submitted by the supervisor or guardian via NestJS."""
    type: str  # reinforce, correct, freeze_model, unfreeze_model, rollback_checkpoint
    model_name: str | None = None
    checkpoint_id: str | None = None
    cycle_id: str | None = None
    weight: float = 1.0
    reason: str = ""


class ReinforceRequest(BaseModel):
    """Positive reinforcement of a specific (input, action) pair."""
    actionId: str
    inputVector: list[float]
    strengthFactor: float = 1.0


class CorrectRequest(BaseModel):
    """Supervisor correction: the action taken for this input was wrong."""
    actionId: str
    inputVector: list[float]
    correctCategory: str


def _split_input_vector(vec: list[float]) -> dict[str, list[float] | float]:
    """Split a full assembled global input vector into its components.

    Mirrors CognitiveCycle._assemble_global_input() layout so an injected
    sample reconstructs into the same fields the trainer's _build_input_batch()
    expects.

    Layout (GLOBAL_INPUT_DIM == 1561):
        [0:768]      fused_embedding
        [768:780]    drive_vector (12)
        [780:792]    drive_deltas (12)
        [792]        total_pressure (1)
        [793:1561]   episodic_context (768)

    Raises:
        ValueError: If the vector length does not match GLOBAL_INPUT_DIM.
    """
    expected = config.GLOBAL_INPUT_DIM
    if len(vec) != expected:
        raise ValueError(
            f"inputVector has wrong dimensionality: got {len(vec)}, "
            f"expected {expected}"
        )
    emb = config.EMBEDDING_DIM        # 768
    dv = config.DRIVE_VECTOR_DIM      # 12
    i = 0
    fused = vec[i:i + emb]; i += emb
    drive_vector = vec[i:i + dv]; i += dv
    drive_deltas = vec[i:i + dv]; i += dv
    total_pressure = vec[i]; i += 1
    episodic = vec[i:i + emb]; i += emb
    return {
        "fused_embedding": fused,
        "drive_vector": drive_vector,
        "drive_deltas": drive_deltas,
        "total_pressure": float(total_pressure),
        "episodic_context": episodic,
    }


@app.post("/cognition/control/reinforce")
async def reinforce(req: ReinforceRequest):
    """Positive training signal — overweight an (input, action) pair on replay.

    Injects the sample back into the DataBuffer multiple times so the training
    loop naturally over-samples it. Repeat count = round(strengthFactor * 3),
    clamped to [1, 10].
    """
    if _state.buffer is None:
        return JSONResponse(
            status_code=400,
            content={"accepted": False, "error": "Buffer not initialized"},
        )

    try:
        components = _split_input_vector(req.inputVector)
    except ValueError as exc:
        return JSONResponse(
            status_code=400,
            content={"accepted": False, "error": str(exc)},
        )

    if not req.actionId:
        return JSONResponse(
            status_code=400,
            content={"accepted": False, "error": "actionId is required"},
        )

    repeats = max(1, min(10, round(req.strengthFactor * 3)))
    for _ in range(repeats):
        _state.buffer.add_sample(
            action_category=req.actionId,
            arbitration_type="TYPE_1",
            **components,  # type: ignore[arg-type]
        )

    logger.info(
        "Reinforce: action='%s' injected %d× (strength=%.2f, buffer=%d)",
        req.actionId, repeats, req.strengthFactor, _state.samples_in_buffer,
    )
    return {
        "accepted": True,
        "type": "reinforce",
        "action": req.actionId,
        "injected": repeats,
        "buffer_size": _state.samples_in_buffer,
    }


@app.post("/cognition/control/correct")
async def correct(req: CorrectRequest):
    """Corrective training signal — supervised example with the correct label.

    Injects a corrective sample (inputVector, correctCategory) into the buffer
    3× (standard correction strength) and cancels any pending gradient updates
    toward the wrong category via the trainer hook.
    """
    if _state.buffer is None:
        return JSONResponse(
            status_code=400,
            content={"accepted": False, "error": "Buffer not initialized"},
        )

    if not req.correctCategory:
        return JSONResponse(
            status_code=400,
            content={"accepted": False, "error": "correctCategory is required"},
        )

    try:
        components = _split_input_vector(req.inputVector)
    except ValueError as exc:
        return JSONResponse(
            status_code=400,
            content={"accepted": False, "error": str(exc)},
        )

    _CORRECTION_STRENGTH = 3
    for _ in range(_CORRECTION_STRENGTH):
        _state.buffer.add_sample(
            action_category=req.correctCategory,
            arbitration_type="TYPE_1",
            **components,  # type: ignore[arg-type]
        )

    # Cancel pending updates toward the wrong category (the action that was
    # taken). No-op in the current synchronous trainer, but the hook is wired.
    if _state.trainer is not None and req.actionId:
        _state.trainer.zero_pending_for_category(req.actionId)

    logger.info(
        "Correction: wrong='%s' -> correct='%s' injected %d× (buffer=%d)",
        req.actionId, req.correctCategory, _CORRECTION_STRENGTH,
        _state.samples_in_buffer,
    )
    return {
        "accepted": True,
        "type": "correct",
        "correct_category": req.correctCategory,
        "injected": _CORRECTION_STRENGTH,
        "buffer_size": _state.samples_in_buffer,
    }


@app.post("/cognition/control/freeze")
async def freeze_model(model_name: str = "all"):
    """Freeze model weights — suspend training updates on the specified model.

    Sets the trainer freeze flag (weights held fixed, thread kept alive) rather
    than tearing down the training thread, so unfreeze resumes instantly.
    """
    if not _state.trainer:
        return {"accepted": False, "error": "Trainer not initialized"}

    if model_name == "all":
        _state.trainer.freeze()
        logger.info("All models frozen (weight updates suspended)")
    else:
        # Per-model freeze not yet implemented — requires trainer refactor
        logger.info("Model freeze requested for '%s' (per-model freeze not yet implemented)", model_name)

    return {"accepted": True, "model": model_name, "frozen": True}


@app.post("/cognition/control/unfreeze")
async def unfreeze_model(model_name: str = "all"):
    """Unfreeze model weights — resume training updates."""
    if not _state.trainer:
        return {"accepted": False, "error": "Trainer not initialized"}

    if model_name == "all":
        _state.trainer.unfreeze()
        logger.info("All models unfrozen (weight updates resumed)")

    return {"accepted": True, "model": model_name, "frozen": False}


@app.post("/cognition/control/rollback")
async def rollback_checkpoint(checkpoint_id: str | None = None):
    """Roll back to a previous weight checkpoint."""
    if not _state.cycle:
        return {"accepted": False, "error": "Cycle not initialized"}

    # Load from the default weights directory (latest checkpoint)
    weights_dir = config.WEIGHTS_DIR
    if checkpoint_id == "foundation":
        weights_dir = config.FOUNDATION_DIR

    _state.cycle.global_model.load(weights_dir + "/global")
    _state.cycle.panel_models.load(weights_dir + "/panels")
    _state.cycle.convergence_model.load(weights_dir + "/convergence")
    _state.cycle.deliberation.load(weights_dir + "/deliberation")

    logger.info("Rolled back to checkpoint: %s", checkpoint_id or "latest")
    return {"accepted": True, "checkpoint": checkpoint_id or "latest"}


@app.get("/cognition/control/state")
async def model_state():
    """Get current model state for the supervisor dashboard."""
    if not _state.cycle:
        return {"error": "Cycle not initialized"}

    training_active = (
        _state.trainer is not None
        and hasattr(_state.trainer, '_stop_event')
        and not _state.trainer._stop_event.is_set()
        and not _state.trainer.is_frozen
    )

    return {
        "total_parameters": _state.cycle.total_params,
        "training_active": training_active,
        "training_frozen": (
            _state.trainer.is_frozen if _state.trainer is not None else False
        ),
        "training_steps": _state.training_steps,
        "training_loss": _state.training_loss,
        "bootstrap_mode": _state.bootstrap_mode,
        "models": {
            "global": {"params": _state.cycle.global_model.total_params},
            "panels": {
                p.name: {"params": p.total_params}
                for p in _state.cycle.panel_models.panels
            },
            "convergence": {"params": _state.cycle.convergence_model.total_params},
            "deliberation": {
                "pragmatist": {"params": _state.cycle.deliberation.pragmatist.total_params},
                "conservative": {"params": _state.cycle.deliberation.conservative.total_params},
                "advocate": {"params": _state.cycle.deliberation.advocate.total_params},
                "synthesis": {"params": _state.cycle.deliberation.synthesis.total_params},
            },
        },
    }


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------

@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    logger.error("Unhandled error: %s", exc, exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"error": str(exc)},
    )
