"""MediaPipe face detector wrapper and deterministic mock for testing.

This module provides two implementations:

- :class:`MediaPipeFaceDetector` -- wraps Google MediaPipe Face Detection
  using the Tasks API (mediapipe >= 0.10).  The ``mediapipe`` import is
  deferred to ``__init__`` time so that *importing this module* never fails
  even when mediapipe is absent.

- :class:`MockFaceDetector` -- returns predetermined :class:`FaceDetection`
  objects keyed by ``frame_sequence``.  No model, no numpy -- purely for
  deterministic test scenarios.

MediaPipeFaceDetector usage::

    from cobeing.layer2_perception.face_detector import MediaPipeFaceDetector
    from cobeing.layer2_perception.config import FaceDetectionConfig

    detector = MediaPipeFaceDetector(FaceDetectionConfig(confidence_threshold=0.5))
    faces = detector.detect(frame)

MockFaceDetector usage::

    from cobeing.layer2_perception.face_detector import MockFaceDetector
    from cobeing.layer2_perception.types import FaceDetection

    face = FaceDetection(
        confidence=0.95,
        bbox_x_min=100.0, bbox_y_min=50.0,
        bbox_x_max=200.0, bbox_y_max=180.0,
        frame_id="frame-001",
    )
    mock = MockFaceDetector(
        detections_by_sequence={1: [face]},
        default_detections=[],
    )
    faces = mock.detect(frame)
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
    "blaze_face_short_range.tflite",
)


# ---------------------------------------------------------------------------
# MediaPipeFaceDetector
# ---------------------------------------------------------------------------


class MediaPipeFaceDetector:
    """MediaPipe face detector using the Tasks API.

    Implements the same call pattern as
    :class:`~cobeing.layer2_perception.detector.YoloDetector`:
    synchronous ``detect(frame)`` dispatched to a thread executor by the
    async pipeline layer.

    The ``mediapipe`` package is imported lazily inside ``__init__`` so that
    this class can be imported without mediapipe installed.  If ``mediapipe``
    is not available an ``ImportError`` is raised at construction time.

    Requires the ``blaze_face_short_range.tflite`` model file.  By default
    the model is looked up next to the perception-service package root
    (``packages/perception-service/blaze_face_short_range.tflite``).
    Override via ``FaceDetectionConfig.model_path``.

    Args:
        config: Face detection configuration (confidence threshold, model
            selection).  Defaults to :class:`FaceDetectionConfig` with
            factory defaults (conf=0.5, model_selection=0).
        model_path: Path to the ``.tflite`` model file.  When ``None``,
            falls back to ``_DEFAULT_MODEL_PATH``.

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

        # Resolve model path.
        resolved_path = model_path or _DEFAULT_MODEL_PATH
        if not os.path.isfile(resolved_path):
            raise DetectionError(
                f"MediaPipe face detection model not found at '{resolved_path}'. "
                "Download blaze_face_short_range.tflite from "
                "https://storage.googleapis.com/mediapipe-models/face_detector/"
                "blaze_face_short_range/float16/latest/blaze_face_short_range.tflite"
            )

        # Import Tasks API components.
        from mediapipe.tasks.python.vision.face_detector import (  # noqa: PLC0415
            FaceDetector as _FaceDetector,
            FaceDetectorOptions as _FaceDetectorOptions,
        )
        from mediapipe.tasks.python.core.base_options import (  # noqa: PLC0415
            BaseOptions as _BaseOptions,
        )

        base_options = _BaseOptions(model_asset_path=resolved_path)
        options = _FaceDetectorOptions(
            base_options=base_options,
            min_detection_confidence=self._config.confidence_threshold,
        )
        self._detector = _FaceDetector.create_from_options(options)

        logger.info(
            "MediaPipeFaceDetector initialized model=%s confidence=%.2f",
            resolved_path,
            self._config.confidence_threshold,
        )

    def detect(self, frame: Frame) -> list[FaceDetection]:
        """Run MediaPipe face detection on a single frame.

        ``frame.data`` must be raw, uncompressed RGB bytes with exactly
        ``frame.width * frame.height * 3`` bytes -- the same format that
        :class:`~cobeing.layer2_perception.detector.YoloDetector` expects.

        MediaPipe Tasks API returns bounding boxes in pixel coordinates
        already, so no manual conversion is needed.

        Args:
            frame: The captured frame to run face detection on.

        Returns:
            A list of :class:`FaceDetection` objects.  Empty if no faces
            are detected above the confidence threshold.

        Raises:
            DetectionError: If the frame bytes cannot be reshaped or if
                MediaPipe raises an unrecoverable exception.
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

        # MediaPipe Tasks API requires mp.Image wrapping the numpy array.
        mp_image = self._mp.Image(
            image_format=self._mp.ImageFormat.SRGB,
            data=np.ascontiguousarray(img),
        )

        try:
            result = self._detector.detect(mp_image)
        except Exception as exc:
            raise DetectionError(
                f"MediaPipe face detection failed for frame '{frame.frame_id}': {exc}"
            ) from exc

        faces: list[FaceDetection] = []

        if not result.detections:
            return faces

        for detection in result.detections:
            # Tasks API returns confidence via categories.
            score = detection.categories[0].score if detection.categories else 0.0
            if score < self._config.confidence_threshold:
                continue

            bbox = detection.bounding_box
            # Tasks API bounding_box is in pixel coordinates:
            # origin_x, origin_y, width, height
            x_min = float(bbox.origin_x)
            y_min = float(bbox.origin_y)
            x_max = float(bbox.origin_x + bbox.width)
            y_max = float(bbox.origin_y + bbox.height)

            # Clamp to frame bounds.
            x_min = max(0.0, min(x_min, float(frame.width)))
            y_min = max(0.0, min(y_min, float(frame.height)))
            x_max = max(0.0, min(x_max, float(frame.width)))
            y_max = max(0.0, min(y_max, float(frame.height)))

            # Extract keypoints as pixel coordinates.
            landmarks: list[tuple[float, float]] = []
            if detection.keypoints:
                for kp in detection.keypoints:
                    lx = kp.x * frame.width
                    ly = kp.y * frame.height
                    landmarks.append((lx, ly))

            faces.append(
                FaceDetection(
                    confidence=float(score),
                    bbox_x_min=x_min,
                    bbox_y_min=y_min,
                    bbox_x_max=x_max,
                    bbox_y_max=y_max,
                    landmarks=landmarks if landmarks else None,
                    frame_id=frame.frame_id,
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

    Args:
        detections_by_sequence: Mapping from ``frame_sequence`` to the list
            of face detections to return for that frame.
        default_detections: Face detections to return for any frame whose
            ``frame_sequence`` is not in the mapping.
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


__all__ = ["MediaPipeFaceDetector", "MockFaceDetector"]
