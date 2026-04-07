"""Perception microservice -- thin FastAPI wrapper around the Layer 2 perception stack.

Exposes the existing OpenCV+YOLO perception pipeline as an HTTP service so that
the NestJS backend can call it without any Python dependency.

Port 8430 (migration plan Phase M6 mock endpoint).

Endpoints:
    GET  /perception/health         -- liveness probe: model loaded flag
    POST /perception/detect         -- one-shot detection on a submitted JPEG
    GET  /perception/status         -- pipeline running state + tracked object count
    GET  /perception/stream         -- MJPEG stream, annotated frames
    GET  /perception/stream/raw     -- MJPEG stream, unannotated frames

Design:
    - Imports from src/cobeing/layer2_perception via PYTHONPATH (no copy).
    - NestJS handles all graph writes. The persistence check here uses a null
      implementation that always returns "no match" so the pipeline does not
      attempt to reach Neo4j.
    - CameraFrameSource raises CaptureError when no camera device is available;
      the service handles that gracefully via the /perception/health endpoint.
    - CPU-bound detection (YoloDetector.detect) is already synchronous; calls
      from the /detect endpoint are dispatched to a thread executor.
    - MJPEG stream polls DebugFrameStore at ~10 Hz, matching the existing
      routes_debug_camera.py pattern.

Environment variables (COBEING_PERCEPTION_ prefix, double-underscore for nesting):
    COBEING_PERCEPTION_CAMERA__DEVICE          (default 0)
    COBEING_PERCEPTION_CAMERA__WIDTH           (default 1280)
    COBEING_PERCEPTION_CAMERA__HEIGHT          (default 720)
    COBEING_PERCEPTION_CAMERA__FPS             (default 15)
    COBEING_PERCEPTION_DETECTION__MODEL_PATH   (default yolov8n.pt)
    COBEING_PERCEPTION_DETECTION__CONFIDENCE_THRESHOLD  (default 0.25)
"""

from __future__ import annotations

import asyncio
import logging
import signal
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger("perception_service")

# ---------------------------------------------------------------------------
# Null persistence check
#
# NestJS owns all graph writes during the migration. The perception microservice
# detects objects and streams annotated video; it does NOT perform identity
# resolution against Neo4j. A null PersistenceCheck always returns None so the
# pipeline's persistence-check loop is a clean no-op.
# ---------------------------------------------------------------------------


class _NullPersistenceCheck:
    """Always returns None (no match). NestJS handles graph persistence."""

    async def find_match(self, observation: Any) -> None:  # noqa: ANN401
        return None


# ---------------------------------------------------------------------------
# Application state
#
# All mutable state lives here to keep it out of the global scope and to make
# the lifespan wiring explicit. The lifespan function populates these fields
# on startup and clears them on shutdown.
# ---------------------------------------------------------------------------


class _AppState:
    pipeline: Any | None = None          # PerceptionPipeline, or None if no camera
    pipeline_task: asyncio.Task | None = None  # background task running pipeline.run()
    debug_frame_store: Any | None = None  # DebugFrameStore
    detector: Any | None = None          # YoloDetector, for the /detect endpoint
    face_detector: Any | None = None     # MediaPipeFaceDetector, for face detection
    embedding_extractor: Any | None = None  # OnnxEmbeddingExtractor, lazy-init
    config: Any | None = None            # PerceptionConfig
    model_loaded: bool = False
    face_model_loaded: bool = False
    pipeline_active: bool = False
    tracker: Any | None = None           # IoUTracker, for per-object tracking
    frame_sequence: int = 0              # Auto-incrementing frame counter


_state = _AppState()

# ---------------------------------------------------------------------------
# Lifespan: build the pipeline on startup, stop on shutdown
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ANN001
    """FastAPI lifespan: initialise the perception pipeline, yield, then stop."""
    await _startup()

    # Register SIGTERM handler so Docker/Kubernetes terminates gracefully.
    loop = asyncio.get_event_loop()
    loop.add_signal_handler(signal.SIGTERM, lambda: asyncio.create_task(_shutdown()))

    try:
        yield
    finally:
        await _shutdown()


async def _startup() -> None:
    """Build and start the perception pipeline.

    Non-fatal: if the [cv] extras are not installed or the camera device
    cannot be opened, the service starts anyway with model_loaded=False.
    The /perception/health endpoint reports the failure. The /perception/detect
    and /perception/stream endpoints return 503 in that case.
    """
    try:
        from cobeing.layer2_perception.config import PerceptionConfig  # noqa: PLC0415
        from cobeing.layer2_perception.detector import YoloDetector  # noqa: PLC0415

        cfg = PerceptionConfig()
        _state.config = cfg

        logger.info(
            "perception_service_startup "
            "camera_device=%d model=%s confidence_threshold=%.2f",
            cfg.camera.device,
            cfg.detection.model_path,
            cfg.detection.confidence_threshold,
        )

        # Detector: used by the /detect and /detect-annotated endpoints.
        # No camera pipeline — frames come from the browser via NestJS.
        detector = YoloDetector(config=cfg.detection)
        _state.detector = detector
        _state.model_loaded = True

        # Tracker: IoU-based frame-to-frame object tracker, runs as a singleton
        # so tracked state persists across HTTP calls to /detect.
        from cobeing.layer2_perception.tracker import IoUTracker  # noqa: PLC0415

        _state.tracker = IoUTracker(
            iou_threshold=0.3,
            min_confirm_frames=3,
            max_lost_frames=15,
        )
        logger.info("perception_service_tracker_ok")

        logger.info("perception_service_startup_ok model=%s", cfg.detection.model_path)

        # Face detector: MediaPipe face detection as a second layer.
        try:
            from cobeing.layer2_perception.face_detector import MediaPipeFaceDetector  # noqa: PLC0415

            face_detector = MediaPipeFaceDetector(config=cfg.face_detection)
            _state.face_detector = face_detector
            _state.face_model_loaded = True
            logger.info("perception_service_face_detector_ok")
        except Exception as exc:
            logger.warning(
                "perception_service_face_detector_skip reason=%s error=%s",
                type(exc).__name__,
                exc,
            )

    except ImportError as exc:
        logger.warning(
            "perception_service_startup_skip reason=missing_cv_extras error=%s", exc
        )
    except Exception as exc:
        logger.warning(
            "perception_service_startup_skip reason=init_failed error=%s", exc
        )


async def _run_pipeline(pipeline: Any) -> None:  # noqa: ANN401
    """Background task: run pipeline until stop() is called or an exception occurs."""
    try:
        await pipeline.run()
    except asyncio.CancelledError:
        pass
    except Exception as exc:
        logger.error("perception_pipeline_error error=%s", exc, exc_info=True)
    finally:
        _state.pipeline_active = False
        logger.info("perception_pipeline_stopped")


async def _shutdown() -> None:
    """Stop the pipeline gracefully."""
    if _state.pipeline is not None:
        await _state.pipeline.stop()

    if _state.pipeline_task is not None and not _state.pipeline_task.done():
        _state.pipeline_task.cancel()
        try:
            await _state.pipeline_task
        except (asyncio.CancelledError, Exception):
            pass

    _state.pipeline_active = False
    logger.info("perception_service_shutdown_ok")


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Co-Being Perception Service",
    description="OpenCV+YOLO perception pipeline as an HTTP microservice.",
    version="1.0.0",
    lifespan=lifespan,
)

# ---------------------------------------------------------------------------
# GET /perception/health
# ---------------------------------------------------------------------------


@app.get("/perception/health")
async def health() -> JSONResponse:
    """Liveness probe.

    Returns:
        {"status": "ok", "model_loaded": bool}

    model_loaded is False if ultralytics/cv2 are not installed or the model
    failed to load at startup.
    """
    return JSONResponse({
        "status": "ok",
        "model_loaded": _state.model_loaded,
        "face_model_loaded": _state.face_model_loaded,
    })


# ---------------------------------------------------------------------------
# POST /perception/detect
# ---------------------------------------------------------------------------


@app.post("/perception/detect")
async def detect(request: Request) -> JSONResponse:
    """Run one-shot object detection on a submitted JPEG frame.

    Request body: raw JPEG bytes (Content-Type: image/jpeg or application/octet-stream).

    Returns:
        JSON array of Detection objects:
        [
          {
            "label_raw": "cup",
            "confidence": 0.87,
            "bbox_x_min": 120.0,
            "bbox_y_min": 80.0,
            "bbox_x_max": 240.0,
            "bbox_y_max": 200.0,
            "frame_id": "<uuid>"
          },
          ...
        ]

    Returns HTTP 503 if the model is not loaded.
    Returns HTTP 400 if the body is empty or cannot be decoded as an image.

    Notes:
        YoloDetector.detect() expects Frame.data to contain raw RGB bytes
        (shape: height * width * 3). CameraFrameSource stores JPEG bytes in
        Frame.data; this endpoint decodes the submitted JPEG to raw RGB before
        calling detect(), matching what the pipeline's capture path produces
        after OpenCV reads from the camera (raw pixel data before JPEG encoding).
    """
    if not _state.model_loaded or _state.detector is None:
        raise HTTPException(status_code=503, detail="Perception model not loaded")

    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Request body is empty")

    loop = asyncio.get_event_loop()

    # Increment frame sequence for tracker temporal ordering.
    _state.frame_sequence += 1
    current_sequence = _state.frame_sequence

    try:
        frame = await loop.run_in_executor(
            None, _decode_jpeg_to_frame, body, current_sequence,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        detections = await loop.run_in_executor(None, _state.detector.detect, frame)
    except Exception as exc:
        logger.error("detect_endpoint_error error=%s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail="Detection failed") from exc

    # Run face detection in parallel if the face model is loaded.
    face_detections_json: list[dict] = []
    if _state.face_model_loaded and _state.face_detector is not None:
        try:
            face_detections = await loop.run_in_executor(
                None, _state.face_detector.detect, frame
            )
            face_detections_json = [
                {
                    "confidence": f.confidence,
                    "bbox_x_min": f.bbox_x_min,
                    "bbox_y_min": f.bbox_y_min,
                    "bbox_x_max": f.bbox_x_max,
                    "bbox_y_max": f.bbox_y_max,
                    "landmarks": f.landmarks,
                    "blendshapes": f.blendshapes,
                    "frame_id": f.frame_id,
                }
                for f in face_detections
            ]
        except Exception as exc:
            logger.warning("face_detect_endpoint_error error=%s", exc)

    # Face mesh connection topologies for wireframe rendering.
    face_connections: list[list[int]] = []
    face_oval: list[list[int]] = []
    if _state.face_model_loaded:
        try:
            from cobeing.layer2_perception.face_detector import (  # noqa: PLC0415
                get_face_connections,
                get_face_oval_connections,
            )

            face_connections = get_face_connections()
            face_oval = get_face_oval_connections()
        except Exception:
            pass

    # --- Per-object tracking ---
    # Run the IoU tracker to maintain persistent track IDs across frames.
    # The tracker is a singleton on _state so identity persists across calls.
    tracked_objects_json: list[dict] = []
    scene_summary: dict = {
        "total_tracks": 0,
        "confirmed_count": 0,
        "lost_count": 0,
        "new_count": 0,
        "frame_sequence": current_sequence,
    }

    if _state.tracker is not None:
        from cobeing.layer2_perception.types import TrackState  # noqa: PLC0415

        tracked_objects = _state.tracker.update(detections, frame.frame_id)

        confirmed_count = 0
        lost_count = 0
        new_count = 0

        for t in tracked_objects:
            is_confirmed = t.state == TrackState.CONFIRMED
            if is_confirmed:
                confirmed_count += 1
            if t.state == TrackState.LOST:
                lost_count += 1
            if t.frames_seen == 1:
                new_count += 1

            # Extract embedding for CONFIRMED tracks (lazy-init extractor).
            embedding: list[float] | None = None
            if is_confirmed:
                embedding = await loop.run_in_executor(
                    None,
                    _extract_track_embedding,
                    frame,
                    t.detection,
                )

            tracked_objects_json.append({
                "track_id": int(t.track_id),
                "state": t.state.value,
                "label": t.detection.label_raw,
                "confidence": t.detection.confidence,
                "bbox": [
                    t.detection.bbox_x_min,
                    t.detection.bbox_y_min,
                    t.detection.bbox_x_max,
                    t.detection.bbox_y_max,
                ],
                "frames_seen": t.frames_seen,
                "frames_lost": t.frames_lost,
                "first_seen_at": (
                    t.first_seen_at.isoformat() if t.first_seen_at else None
                ),
                "last_seen_at": (
                    t.last_seen_at.isoformat() if t.last_seen_at else None
                ),
                "embedding": embedding,
            })

        scene_summary = {
            "total_tracks": len(tracked_objects),
            "confirmed_count": confirmed_count,
            "lost_count": lost_count,
            "new_count": new_count,
            "frame_sequence": current_sequence,
        }

    return JSONResponse({
        "detections": [
            {
                "label_raw": d.label_raw,
                "confidence": d.confidence,
                "bbox_x_min": d.bbox_x_min,
                "bbox_y_min": d.bbox_y_min,
                "bbox_x_max": d.bbox_x_max,
                "bbox_y_max": d.bbox_y_max,
                "mask_polygon": d.mask_polygon,
                "frame_id": d.frame_id,
            }
            for d in detections
        ],
        "faces": face_detections_json,
        "face_connections": face_connections,
        "face_oval": face_oval,
        "tracked_objects": tracked_objects_json,
        "scene_summary": scene_summary,
    })


# ---------------------------------------------------------------------------
# POST /perception/detect-annotated
# ---------------------------------------------------------------------------


@app.post("/perception/detect-annotated")
async def detect_annotated(request: Request) -> JSONResponse:
    """Run detection and return both detections JSON and annotated JPEG.

    Request body: raw JPEG bytes.

    Returns:
        {
          "detections": [ ... ],          -- same as /detect
          "annotated_frame": "<base64>"   -- JPEG with bounding boxes drawn
        }
    """
    import base64  # noqa: PLC0415

    if not _state.model_loaded or _state.detector is None:
        raise HTTPException(status_code=503, detail="Perception model not loaded")

    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Request body is empty")

    loop = asyncio.get_event_loop()

    try:
        frame = await loop.run_in_executor(None, _decode_jpeg_to_frame, body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        detections = await loop.run_in_executor(None, _state.detector.detect, frame)
    except Exception as exc:
        logger.error("detect_annotated_error error=%s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail="Detection failed") from exc

    # Draw bounding boxes on the original JPEG
    annotated_jpeg = await loop.run_in_executor(
        None, _annotate_frame, body, detections
    )

    return JSONResponse({
        "detections": [
            {
                "label_raw": d.label_raw,
                "confidence": d.confidence,
                "bbox_x_min": d.bbox_x_min,
                "bbox_y_min": d.bbox_y_min,
                "bbox_x_max": d.bbox_x_max,
                "bbox_y_max": d.bbox_y_max,
                "frame_id": d.frame_id,
            }
            for d in detections
        ],
        "annotated_frame": base64.b64encode(annotated_jpeg).decode("ascii"),
    })


# ---------------------------------------------------------------------------
# POST /perception/crop-face
# ---------------------------------------------------------------------------


@app.post("/perception/crop-face")
async def crop_face(request: Request) -> JSONResponse:
    """Crop a face region from a JPEG frame and return as base64 + embedding.

    Request body: raw JPEG bytes (same as /detect).
    Query params:
        x_min, y_min, x_max, y_max  -- bounding box in pixel coordinates
        target_size                  -- crop resize target (default 160)

    Returns:
        {
          "face_crop_b64": "<base64 JPEG>",
          "embedding": [float x 1280]   -- EfficientNet-B0 visual embedding
        }
    """
    import base64  # noqa: PLC0415
    import cv2  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415

    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Request body is empty")

    # Parse bbox from query params
    try:
        x_min = float(request.query_params["x_min"])
        y_min = float(request.query_params["y_min"])
        x_max = float(request.query_params["x_max"])
        y_max = float(request.query_params["y_max"])
    except (KeyError, ValueError) as exc:
        raise HTTPException(
            status_code=400,
            detail="Missing or invalid bbox query params (x_min, y_min, x_max, y_max)",
        ) from exc

    target_size = int(request.query_params.get("target_size", "160"))

    # Decode JPEG
    buf = np.frombuffer(body, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="Could not decode JPEG")

    h, w = img.shape[:2]

    # Pad bbox by 15% on each side for context (forehead, chin)
    bw = x_max - x_min
    bh = y_max - y_min
    pad_x = bw * 0.15
    pad_y = bh * 0.15
    cx_min = max(0, int(x_min - pad_x))
    cy_min = max(0, int(y_min - pad_y))
    cx_max = min(w, int(x_max + pad_x))
    cy_max = min(h, int(y_max + pad_y))

    if cx_min >= cx_max or cy_min >= cy_max:
        raise HTTPException(status_code=400, detail="Degenerate bounding box")

    # Crop and resize
    crop = img[cy_min:cy_max, cx_min:cx_max]
    resized = cv2.resize(crop, (target_size, target_size), interpolation=cv2.INTER_LINEAR)

    # Encode to JPEG base64
    _, jpeg_buf = cv2.imencode(".jpg", resized, [cv2.IMWRITE_JPEG_QUALITY, 85])
    crop_b64 = base64.b64encode(jpeg_buf.tobytes()).decode("ascii")

    # Generate visual embedding via OnnxEmbeddingExtractor (lazy-init)
    embedding: list[float] = []
    loop = asyncio.get_event_loop()

    def _compute_embedding() -> list[float] | None:
        if _state.embedding_extractor is None:
            try:
                from cobeing.layer2_perception.feature_extraction import (  # noqa: PLC0415
                    OnnxEmbeddingExtractor,
                )
                _state.embedding_extractor = OnnxEmbeddingExtractor()
                logger.info("OnnxEmbeddingExtractor initialized for face crops")
            except (ImportError, RuntimeError) as exc:
                logger.warning("Could not initialize OnnxEmbeddingExtractor: %s", exc)
                return None

        # Convert crop to raw RGB bytes for the extractor
        crop_rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
        raw_bytes = crop_rgb.tobytes()
        return _state.embedding_extractor.extract(
            raw_bytes,
            (0, 0, target_size, target_size),
            target_size,
            target_size,
        )

    try:
        result = await loop.run_in_executor(None, _compute_embedding)
        if result is not None:
            embedding = result
    except Exception as exc:
        logger.warning("Face embedding extraction failed: %s", exc)

    return JSONResponse({
        "face_crop_b64": crop_b64,
        "embedding": embedding,
    })


_embedding_init_failed: bool = False


def _extract_track_embedding(frame: Any, detection: Any) -> list[float] | None:  # noqa: ANN401
    """Extract a 1280D EfficientNet-B0 embedding for a tracked object's bbox.

    Uses the same lazy-init OnnxEmbeddingExtractor pattern as /crop-face.
    Returns None if extraction fails or the extractor cannot be initialised.
    """
    global _embedding_init_failed  # noqa: PLW0603

    if _embedding_init_failed:
        return None

    if _state.embedding_extractor is None:
        try:
            from cobeing.layer2_perception.feature_extraction import (  # noqa: PLC0415
                OnnxEmbeddingExtractor,
            )
            _state.embedding_extractor = OnnxEmbeddingExtractor()
            logger.info("OnnxEmbeddingExtractor initialized for tracked objects")
        except (ImportError, RuntimeError) as exc:
            logger.warning("OnnxEmbeddingExtractor unavailable (embeddings will be null): %s", exc)
            _embedding_init_failed = True
            return None

    try:
        return _state.embedding_extractor.extract(
            frame.data,
            (
                detection.bbox_x_min,
                detection.bbox_y_min,
                detection.bbox_x_max,
                detection.bbox_y_max,
            ),
            frame.width,
            frame.height,
        )
    except Exception as exc:
        logger.warning("Track embedding extraction failed: %s", exc)
        return None


def _annotate_frame(jpeg_bytes: bytes, detections: list) -> bytes:
    """Draw bounding boxes on JPEG and return annotated JPEG bytes."""
    import cv2  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415

    buf = np.frombuffer(jpeg_bytes, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        return jpeg_bytes

    for d in detections:
        x1, y1 = int(d.bbox_x_min), int(d.bbox_y_min)
        x2, y2 = int(d.bbox_x_max), int(d.bbox_y_max)
        cv2.rectangle(img, (x1, y1), (x2, y2), (0, 255, 0), 2)

    _, encoded = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 75])
    return encoded.tobytes()


def _decode_jpeg_to_frame(jpeg_bytes: bytes, frame_sequence: int = 0) -> Any:  # noqa: ANN401
    """Decode JPEG bytes to a Frame with raw RGB data.

    YoloDetector.detect() calls np.frombuffer(frame.data).reshape(height, width, 3),
    so Frame.data must contain raw RGB bytes, not JPEG bytes. This helper decodes
    the submitted JPEG to a numpy RGB array and stores those raw bytes in the Frame.

    Args:
        jpeg_bytes: JPEG-encoded image bytes from the request body.
        frame_sequence: Monotonically increasing counter for frame ordering.

    Returns:
        A Frame suitable for passing to YoloDetector.detect().

    Raises:
        ValueError: If cv2 cannot decode the bytes as an image.
        ImportError: If cv2 is not installed (should not reach here since
            model_loaded would be False if cv2 was missing at startup).
    """
    import cv2  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415

    from cobeing.layer2_perception.types import Frame  # noqa: PLC0415

    buf = np.frombuffer(jpeg_bytes, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode request body as a JPEG image")

    # Convert BGR (OpenCV default) to RGB for YOLO
    img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    height, width = img_rgb.shape[:2]

    return Frame(
        frame_id=str(uuid.uuid4()),
        frame_sequence=frame_sequence,
        observed_at=datetime.now(UTC),
        width=width,
        height=height,
        data=img_rgb.tobytes(),
        session_id="detect-endpoint",
    )


# ---------------------------------------------------------------------------
# GET /perception/status
# ---------------------------------------------------------------------------


@app.get("/perception/status")
async def status() -> JSONResponse:
    """Return pipeline running state and basic metrics.

    Returns:
        {
          "active": bool,        -- True while the pipeline task is running
          "tracked_objects": int, -- count of currently active tracks (non-DELETED)
          "fps": float           -- configured processing fps (from PerceptionConfig)
        }

    tracked_objects reflects the tracker's current state. When the pipeline is
    not active it reports 0.
    """
    tracked_count = 0
    fps = 0.0

    if _state.tracker is not None:
        # IoUTracker stores active tracks in _tracks list (non-DELETED).
        try:
            tracked_count = len(_state.tracker._tracks)  # noqa: SLF001
        except AttributeError:
            tracked_count = 0

    if _state.config is not None:
        fps = float(_state.config.camera.fps)

    return JSONResponse({
        "active": _state.pipeline_active,
        "tracked_objects": tracked_count,
        "fps": fps,
    })


# ---------------------------------------------------------------------------
# GET /perception/stream  (annotated MJPEG)
# GET /perception/stream/raw  (unannotated MJPEG)
# ---------------------------------------------------------------------------


@app.get("/perception/stream")
async def stream_annotated() -> StreamingResponse:
    """Stream annotated MJPEG frames from the perception pipeline.

    Polls DebugFrameStore.get_annotated() at ~10 Hz and yields frames as
    multipart/x-mixed-replace, identical to routes_debug_camera.py.

    Returns HTTP 503 if the pipeline is not active.
    """
    return _make_mjpeg_response(annotated=True)


@app.get("/perception/stream/raw")
async def stream_raw() -> StreamingResponse:
    """Stream raw (unannotated) MJPEG frames from the perception pipeline.

    Returns HTTP 503 if the pipeline is not active.
    """
    return _make_mjpeg_response(annotated=False)


def _make_mjpeg_response(*, annotated: bool) -> StreamingResponse:
    """Build a StreamingResponse for the MJPEG stream endpoints.

    Args:
        annotated: True for annotated frames, False for raw frames.

    Returns:
        A StreamingResponse with multipart/x-mixed-replace content type,
        or a 503 plain-text response if the pipeline is not active.
    """
    store = _state.debug_frame_store

    if store is None or not _state.pipeline_active:
        return StreamingResponse(
            iter([b"Perception pipeline not active"]),
            status_code=503,
            media_type="text/plain",
        )

    async def _generate():
        """Yield MJPEG frames at ~10 Hz. Mirrors routes_debug_camera.py."""
        while True:
            if annotated:
                frame_bytes = await store.get_annotated()
            else:
                frame_bytes = await store.get_raw()

            if frame_bytes is not None:
                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n"
                    b"Content-Length: " + str(len(frame_bytes)).encode() + b"\r\n"
                    b"\r\n" + frame_bytes + b"\r\n"
                )

            await asyncio.sleep(0.1)  # ~10 Hz polling

    return StreamingResponse(
        _generate(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )
