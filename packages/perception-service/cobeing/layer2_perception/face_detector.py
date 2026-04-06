"""MediaPipe Face Landmarker wrapper and deterministic mock for testing.

This module provides two implementations:

- :class:`MediaPipeFaceDetector` -- wraps Google MediaPipe Face Landmarker
  using the Tasks API (mediapipe >= 0.10).  Returns 478 face mesh landmarks,
  bounding boxes derived from landmark extremes, and optional blendshapes
  (52 facial expressions).

- :class:`MockFaceDetector` -- returns predetermined :class:`FaceDetection`
  objects keyed by ``frame_sequence``.

The static face mesh connection topology is exposed via
:func:`get_face_connections` for wireframe rendering on the frontend.

MediaPipeFaceDetector usage::

    from cobeing.layer2_perception.face_detector import MediaPipeFaceDetector
    from cobeing.layer2_perception.config import FaceDetectionConfig

    detector = MediaPipeFaceDetector(FaceDetectionConfig(confidence_threshold=0.5))
    faces = detector.detect(frame)
"""

from __future__ import annotations

import logging
import os

from cobeing.layer2_perception.config import FaceDetectionConfig
from cobeing.layer2_perception.exceptions import DetectionError
from cobeing.layer2_perception.types import FaceDetection, Frame

logger = logging.getLogger(__name__)

# Default model path relative to the perception-service package root.
_DEFAULT_MODEL_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "face_landmarker.task",
)

# Cached connection topologies (populated on first call).
_face_connections_cache: list[list[int]] | None = None
_face_oval_cache: list[list[int]] | None = None


def get_face_connections() -> list[list[int]]:
    """Return the CONTOURS connection topology (124 connections).

    Covers eyes, eyebrows, nose, lips, and face oval -- suitable for
    wireframe mesh rendering.
    """
    global _face_connections_cache  # noqa: PLW0603
    if _face_connections_cache is not None:
        return _face_connections_cache

    try:
        from mediapipe.tasks.python.vision.face_landmarker import (  # noqa: PLC0415
            FaceLandmarksConnections,
        )

        _face_connections_cache = [
            [c.start, c.end]
            for c in FaceLandmarksConnections.FACE_LANDMARKS_CONTOURS
        ]
    except Exception:
        _face_connections_cache = []

    return _face_connections_cache


def get_face_oval_connections() -> list[list[int]]:
    """Return the FACE_OVAL connection topology (36 connections).

    Just the outer face contour -- jaw, forehead, temples.
    """
    global _face_oval_cache  # noqa: PLW0603
    if _face_oval_cache is not None:
        return _face_oval_cache

    try:
        from mediapipe.tasks.python.vision.face_landmarker import (  # noqa: PLC0415
            FaceLandmarksConnections,
        )

        _face_oval_cache = [
            [c.start, c.end]
            for c in FaceLandmarksConnections.FACE_LANDMARKS_FACE_OVAL
        ]
    except Exception:
        _face_oval_cache = []

    return _face_oval_cache


# ---------------------------------------------------------------------------
# MediaPipeFaceDetector
# ---------------------------------------------------------------------------


class MediaPipeFaceDetector:
    """MediaPipe Face Landmarker (478 landmarks + blendshapes).

    Implements the same call pattern as
    :class:`~cobeing.layer2_perception.detector.YoloDetector`:
    synchronous ``detect(frame)`` dispatched to a thread executor by the
    async pipeline layer.

    The ``mediapipe`` package is imported lazily inside ``__init__`` so that
    this class can be imported without mediapipe installed.

    Requires the ``face_landmarker.task`` model file (~3.7 MB).

    Args:
        config: Face detection configuration.
        model_path: Path to the ``.task`` model file.  Falls back to
            ``_DEFAULT_MODEL_PATH`` when ``None``.

    Raises:
        ImportError: If ``mediapipe`` is not installed.
        DetectionError: If the model file is not found.
    """

    def __init__(
        self,
        config: FaceDetectionConfig | None = None,
        model_path: str | None = None,
    ) -> None:
        self._config = config or FaceDetectionConfig()

        try:
            import mediapipe as mp  # type: ignore[import-untyped]
        except ImportError as exc:
            raise ImportError(
                "mediapipe is required for MediaPipeFaceDetector. "
                "Install with: pip install mediapipe"
            ) from exc

        self._mp = mp

        resolved_path = model_path or _DEFAULT_MODEL_PATH
        if not os.path.isfile(resolved_path):
            raise DetectionError(
                f"Face Landmarker model not found at '{resolved_path}'. "
                "Download face_landmarker.task from "
                "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
                "face_landmarker/float16/latest/face_landmarker.task"
            )

        from mediapipe.tasks.python.vision.face_landmarker import (  # noqa: PLC0415
            FaceLandmarker as _FaceLandmarker,
            FaceLandmarkerOptions as _FaceLandmarkerOptions,
        )
        from mediapipe.tasks.python.core.base_options import (  # noqa: PLC0415
            BaseOptions as _BaseOptions,
        )

        base_options = _BaseOptions(model_asset_path=resolved_path)
        options = _FaceLandmarkerOptions(
            base_options=base_options,
            num_faces=5,
            min_face_detection_confidence=self._config.confidence_threshold,
            min_face_presence_confidence=self._config.confidence_threshold,
            output_face_blendshapes=True,
        )
        self._landmarker = _FaceLandmarker.create_from_options(options)

        # Eagerly populate the connection cache.
        get_face_connections()

        logger.info(
            "MediaPipeFaceDetector initialized model=%s confidence=%.2f (Face Landmarker, 478 landmarks)",
            resolved_path,
            self._config.confidence_threshold,
        )

    def detect(self, frame: Frame) -> list[FaceDetection]:
        """Run MediaPipe Face Landmarker on a single frame.

        ``frame.data`` must be raw, uncompressed RGB bytes with exactly
        ``frame.width * frame.height * 3`` bytes.

        Returns one :class:`FaceDetection` per detected face, each carrying
        478 mesh landmarks in pixel coordinates, a bounding box derived
        from the landmark extremes, and optional blendshapes.

        Args:
            frame: The captured frame to run face detection on.

        Returns:
            A list of :class:`FaceDetection` objects.

        Raises:
            DetectionError: If the frame cannot be processed.
        """
        expected_bytes = frame.width * frame.height * 3
        if len(frame.data) != expected_bytes:
            raise DetectionError(
                f"frame.data has {len(frame.data)} bytes; "
                f"expected {expected_bytes} ({frame.width}x{frame.height}x3) "
                f"for frame '{frame.frame_id}'"
            )

        import numpy as np  # type: ignore[import-untyped]

        try:
            img: np.ndarray = np.frombuffer(frame.data, dtype=np.uint8).reshape(
                (frame.height, frame.width, 3)
            )
        except ValueError as exc:
            raise DetectionError(
                f"Failed to reshape frame.data for frame '{frame.frame_id}': {exc}"
            ) from exc

        mp_image = self._mp.Image(
            image_format=self._mp.ImageFormat.SRGB,
            data=np.ascontiguousarray(img),
        )

        try:
            result = self._landmarker.detect(mp_image)
        except Exception as exc:
            raise DetectionError(
                f"MediaPipe Face Landmarker failed for frame '{frame.frame_id}': {exc}"
            ) from exc

        faces: list[FaceDetection] = []

        if not result.face_landmarks:
            return faces

        w = float(frame.width)
        h = float(frame.height)

        for face_idx, face_lms in enumerate(result.face_landmarks):
            # Convert normalized landmarks to pixel coordinates.
            landmarks: list[tuple[float, float]] = []
            xs: list[float] = []
            ys: list[float] = []
            for lm in face_lms:
                px = (lm.x or 0.0) * w
                py = (lm.y or 0.0) * h
                landmarks.append((px, py))
                xs.append(px)
                ys.append(py)

            if not xs:
                continue

            # Derive bounding box from landmark extremes.
            x_min = max(0.0, min(xs))
            y_min = max(0.0, min(ys))
            x_max = min(w, max(xs))
            y_max = min(h, max(ys))

            # Estimate confidence from the first blendshape category
            # or fall back to the config threshold.
            confidence = self._config.confidence_threshold

            # Extract blendshapes if available.
            blendshapes: dict[str, float] | None = None
            if result.face_blendshapes and face_idx < len(result.face_blendshapes):
                blendshapes = {}
                for cat in result.face_blendshapes[face_idx]:
                    if cat.category_name:
                        blendshapes[cat.category_name] = float(cat.score or 0.0)

            faces.append(
                FaceDetection(
                    confidence=confidence,
                    bbox_x_min=x_min,
                    bbox_y_min=y_min,
                    bbox_x_max=x_max,
                    bbox_y_max=y_max,
                    landmarks=landmarks,
                    frame_id=frame.frame_id,
                    blendshapes=blendshapes,
                )
            )

        return faces


# ---------------------------------------------------------------------------
# MockFaceDetector
# ---------------------------------------------------------------------------


class MockFaceDetector:
    """Deterministic face detector for testing.

    Returns pre-configured :class:`FaceDetection` objects without invoking
    any model or performing any image processing.
    """

    def __init__(
        self,
        detections_by_sequence: dict[int, list[FaceDetection]] | None = None,
        default_detections: list[FaceDetection] | None = None,
    ) -> None:
        self._by_sequence: dict[int, list[FaceDetection]] = (
            detections_by_sequence if detections_by_sequence is not None else {}
        )
        self._default: list[FaceDetection] = (
            default_detections if default_detections is not None else []
        )

    def detect(self, frame: Frame) -> list[FaceDetection]:
        """Return pre-configured face detections for the given frame."""
        return self._by_sequence.get(frame.frame_sequence, self._default)


__all__ = [
    "MediaPipeFaceDetector",
    "MockFaceDetector",
    "get_face_connections",
    "get_face_oval_connections",
]
