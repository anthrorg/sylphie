"""YOLO object detector wrapper and deterministic mock for testing.

This module provides two implementations of the
:class:`~cobeing.layer2_perception.protocols.ObjectDetector` protocol:

- :class:`YoloDetector` -- wraps YOLOv8n via ``ultralytics``.  The
  ``ultralytics`` import is deferred to ``__init__`` time so that *importing
  this module* never fails even when the ``[cv]`` optional extras are absent.
  This matches the design contract documented in the package ``__init__.py``.

- :class:`MockDetector` -- returns predetermined :class:`Detection` objects
  keyed by ``frame_sequence`` (or a default list).  No model, no numpy, no
  OpenCV -- purely for deterministic test scenarios.

Both classes satisfy the :class:`~cobeing.layer2_perception.protocols.ObjectDetector`
structural protocol.  At the composition root you can verify this with::

    assert isinstance(detector, ObjectDetector)

YoloDetector usage::

    from cobeing.layer2_perception.detector import YoloDetector
    from cobeing.layer2_perception.config import DetectionConfig

    detector = YoloDetector(DetectionConfig(confidence_threshold=0.4))
    detections = detector.detect(frame)

MockDetector usage::

    from cobeing.layer2_perception.detector import MockDetector
    from cobeing.layer2_perception.types import Detection

    cup = Detection(
        label_raw="cup",
        confidence=0.9,
        bbox_x_min=10.0, bbox_y_min=20.0,
        bbox_x_max=110.0, bbox_y_max=120.0,
        frame_id="frame-001",
    )
    mock = MockDetector(
        detections_by_sequence={1: [cup]},
        default_detections=[],
    )
    detections = mock.detect(frame)  # returns [cup] when frame.frame_sequence == 1
"""

from __future__ import annotations

from cobeing.layer2_perception.config import DetectionConfig
from cobeing.layer2_perception.exceptions import DetectionError
from cobeing.layer2_perception.types import Detection, Frame


# ---------------------------------------------------------------------------
# YoloDetector
# ---------------------------------------------------------------------------


class YoloDetector:
    """YOLOv8n object detector wrapping the ``ultralytics`` library.

    Implements :class:`~cobeing.layer2_perception.protocols.ObjectDetector`.

    The ``ultralytics`` package (and its transitive dependency on PyTorch) is
    imported lazily inside ``__init__`` so that this class can be imported
    without the ``[cv]`` optional extras installed.  If ``ultralytics`` is not
    available an ``ImportError`` is raised at construction time, not at import
    time.

    YOLOv8n weights are downloaded automatically on first use when
    ``model_path`` resolves to a model name that ultralytics recognises (e.g.
    ``"yolov8n.pt"``).  Pass an absolute path to a local ``.pt`` file to skip
    the download.

    ``detect`` is synchronous because YOLO inference is CPU-bound.  The async
    pipeline layer wraps this call in ``loop.run_in_executor()`` -- see the
    protocol docstring for the rationale.

    Args:
        config: Detection configuration (model path, confidence threshold, NMS
            threshold).  Defaults to :class:`~cobeing.layer2_perception.config.DetectionConfig`
            with its factory defaults (``yolov8n.pt``, conf=0.25, nms=0.45).

    Raises:
        ImportError: If ``ultralytics`` is not installed.
        DetectionError: If the model file cannot be loaded.
    """

    def __init__(self, config: DetectionConfig | None = None) -> None:
        self._config = config or DetectionConfig()

        # Lazy import -- will raise ImportError here, not at module import.
        try:
            from ultralytics import YOLO  # type: ignore[import-untyped]
        except ImportError as exc:
            raise ImportError(
                "ultralytics is required for YoloDetector. "
                "Install with: pip install 'cobeing[cv]'"
            ) from exc

        try:
            self._model = YOLO(self._config.model_path)
        except Exception as exc:
            raise DetectionError(
                f"Failed to load YOLO model from '{self._config.model_path}': {exc}"
            ) from exc

    def detect(self, frame: Frame) -> list[Detection]:
        """Run YOLOv8 inference on a single frame and return filtered detections.

        ``frame.data`` must be raw, uncompressed RGB bytes with exactly
        ``frame.width * frame.height * 3`` bytes.  The bytes are reshaped
        into a ``(height, width, 3)`` uint8 numpy array before being passed
        to YOLO.

        Detections below ``config.confidence_threshold`` are discarded before
        the list is returned.  NMS is applied by YOLO internally using
        ``config.nms_threshold``.

        The ``label_raw`` field is set to the raw YOLO class name string
        (e.g. ``"cup"``, ``"person"``) exactly as returned by the model --
        no normalisation or remapping is performed here.  Remapping to
        knowledge-graph schema labels is a Layer 3 concern.

        Args:
            frame: The captured frame to run detection on.  ``frame.data``
                must contain raw RGB bytes of length
                ``frame.width * frame.height * 3``.

        Returns:
            A list of :class:`~cobeing.layer2_perception.types.Detection`
            objects filtered by ``confidence_threshold``.  Empty if no objects
            are detected above the threshold.

        Raises:
            DetectionError: If the frame bytes cannot be decoded, or if YOLO
                inference raises an unrecoverable exception.
        """
        # Validate byte length before importing numpy so the error is raised
        # cleanly even in environments where the [cv] extras are not installed.
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

        try:
            results = self._model(
                img,
                conf=self._config.confidence_threshold,
                iou=self._config.nms_threshold,
                verbose=False,
            )
        except Exception as exc:
            raise DetectionError(
                f"YOLO inference failed for frame '{frame.frame_id}': {exc}"
            ) from exc

        detections: list[Detection] = []

        for result in results:
            if result.boxes is None:
                continue

            boxes_xyxy = result.boxes.xyxy.tolist()
            confidences = result.boxes.conf.tolist()
            class_ids = result.boxes.cls.tolist()
            names: dict[int, str] = result.names  # {class_id: class_name}

            # Extract segmentation masks if available (yolov8n-seg models).
            has_masks = result.masks is not None and hasattr(result.masks, "xy")
            mask_polygons = result.masks.xy if has_masks else None

            for i, (xyxy, conf, cls_id) in enumerate(
                zip(boxes_xyxy, confidences, class_ids)
            ):
                if conf < self._config.confidence_threshold:
                    continue

                label = names.get(int(cls_id), "unknown")

                # Convert mask polygon (Nx2 numpy array) to list[list[float]].
                mask_polygon: list[list[float]] | None = None
                if mask_polygons is not None and i < len(mask_polygons):
                    poly = mask_polygons[i]
                    if len(poly) > 2:
                        mask_polygon = [[float(pt[0]), float(pt[1])] for pt in poly]

                detections.append(
                    Detection(
                        label_raw=label,
                        confidence=float(conf),
                        bbox_x_min=float(xyxy[0]),
                        bbox_y_min=float(xyxy[1]),
                        bbox_x_max=float(xyxy[2]),
                        bbox_y_max=float(xyxy[3]),
                        frame_id=frame.frame_id,
                        mask_polygon=mask_polygon,
                    )
                )

        return detections


# ---------------------------------------------------------------------------
# MockDetector
# ---------------------------------------------------------------------------


class MockDetector:
    """Deterministic object detector for testing.

    Implements :class:`~cobeing.layer2_perception.protocols.ObjectDetector`.

    Returns pre-configured :class:`~cobeing.layer2_perception.types.Detection`
    objects without invoking any model or performing any image processing.
    This makes tests fully deterministic and free of CV dependencies.

    Lookup order for ``detect(frame)``:

    1. If ``detections_by_sequence`` contains ``frame.frame_sequence``, return
       that list.
    2. Otherwise return ``default_detections`` (empty list if not provided).

    Note: the ``Detection`` objects stored in the mapping are returned as-is --
    their ``frame_id`` is whatever was set when they were constructed.  If you
    need the returned detections to carry the *input frame*'s ``frame_id``,
    build them with the matching ``frame_id`` in the mapping.

    Args:
        detections_by_sequence: Mapping from ``frame_sequence`` (int) to the
            list of detections to return for that frame.  ``None`` means no
            per-sequence overrides (use ``default_detections`` for everything).
        default_detections: Detections to return for any frame whose
            ``frame_sequence`` is not in ``detections_by_sequence``.  Defaults
            to an empty list.

    Example::

        cup = Detection(label_raw="cup", confidence=0.9,
                        bbox_x_min=0, bbox_y_min=0,
                        bbox_x_max=100, bbox_y_max=100,
                        frame_id="frame-001")

        mock = MockDetector(
            detections_by_sequence={0: [cup]},
            default_detections=[],
        )
        assert mock.detect(frame_seq_0) == [cup]
        assert mock.detect(frame_seq_5) == []
    """

    def __init__(
        self,
        detections_by_sequence: dict[int, list[Detection]] | None = None,
        default_detections: list[Detection] | None = None,
    ) -> None:
        self._by_sequence: dict[int, list[Detection]] = (
            detections_by_sequence if detections_by_sequence is not None else {}
        )
        self._default: list[Detection] = (
            default_detections if default_detections is not None else []
        )

    def detect(self, frame: Frame) -> list[Detection]:
        """Return pre-configured detections for the given frame.

        Looks up ``frame.frame_sequence`` in the configured mapping.  If no
        entry exists, returns the default detections list.

        Args:
            frame: The frame whose ``frame_sequence`` is used as the lookup key.
                The ``data`` bytes are not read.

        Returns:
            The list of :class:`~cobeing.layer2_perception.types.Detection`
            objects associated with this frame's sequence number, or the
            default list if the sequence is not mapped.
        """
        return self._by_sequence.get(frame.frame_sequence, self._default)


__all__ = ["MockDetector", "YoloDetector"]
