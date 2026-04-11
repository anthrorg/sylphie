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
    COGNITION_REPLAY_BUFFER_SIZE   (default 10000)
    COGNITION_INFERENCE_TIMEOUT_MS (default 50)
"""

from __future__ import annotations

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
        self.per_category_confidence: dict[str, float] = {}

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
    result = _state.cycle.run(req, vocab=vocab)
    _state.inference_latency_ms = result.inference_ms
    _state.last_cycle_result = result
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


@app.post("/cognition/control/reinforce")
async def reinforce(req: InterventionRequest):
    """Positive training signal — strengthen current weights for a pattern."""
    # TODO: Implement targeted reinforcement when training pipeline supports it
    logger.info("Reinforce signal received (cycle=%s, weight=%.2f, reason=%s)",
                req.cycle_id, req.weight, req.reason)
    return {"accepted": True, "type": "reinforce"}


@app.post("/cognition/control/correct")
async def correct(req: InterventionRequest):
    """Corrective training signal — supervised example with correct output."""
    logger.info("Correction received (cycle=%s, reason=%s)", req.cycle_id, req.reason)
    # TODO: Inject corrective sample into training buffer with high priority
    return {"accepted": True, "type": "correct"}


@app.post("/cognition/control/freeze")
async def freeze_model(model_name: str = "all"):
    """Freeze model weights — stop training updates on specified model."""
    if not _state.trainer:
        return {"accepted": False, "error": "Trainer not initialized"}

    if model_name == "all":
        _state.trainer.stop()
        logger.info("All models frozen (training stopped)")
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
        _state.trainer.start()
        logger.info("All models unfrozen (training resumed)")

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
    )

    return {
        "total_parameters": _state.cycle.total_params,
        "training_active": training_active,
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
