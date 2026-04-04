"""Configuration for the Layer 2 perception pipeline.

All perception configuration is validated at startup using Pydantic. The
top-level :class:`PerceptionConfig` loads from environment variables
(prefixed ``COBEING_PERCEPTION_``) and a ``.env`` file.

Subsection models (:class:`CameraConfig`, :class:`DetectionConfig`,
:class:`TrackingConfig`, :class:`PersistenceCheckConfig`) are plain
``BaseModel`` classes, not ``BaseSettings``. Only the root
``PerceptionConfig`` reads from the environment. This keeps the config
hierarchy flat and predictable.

Environment variable mapping (nested delimiter ``__``)::

    COBEING_PERCEPTION_CAMERA__DEVICE=0
    COBEING_PERCEPTION_CAMERA__WIDTH=1280
    COBEING_PERCEPTION_CAMERA__FPS=15
    COBEING_PERCEPTION_DETECTION__MODEL_PATH=yolov8n.pt
    COBEING_PERCEPTION_DETECTION__CONFIDENCE_THRESHOLD=0.25
    COBEING_PERCEPTION_TRACKING__MAX_LOST_FRAMES=15
    COBEING_PERCEPTION_PERSISTENCE__SIMILARITY_THRESHOLD=0.7

Usage::

    from cobeing.layer2_perception.config import PerceptionConfig

    # Load from environment / .env file:
    config = PerceptionConfig()

    # Access subsections:
    print(config.camera.fps)           # 15
    print(config.detection.model_path) # "yolov8n.pt"
    print(config.tracking.iou_threshold)  # 0.3
    print(config.persistence.surprise_threshold)  # 0.3

    # Override in tests without touching the environment:
    config = PerceptionConfig(
        camera=CameraConfig(fps=5),
        detection=DetectionConfig(confidence_threshold=0.5),
    )
"""

from __future__ import annotations

from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class CameraConfig(BaseModel):
    """Camera device configuration.

    Controls which camera device is opened and the capture parameters.
    These values are passed directly to the ``cv2.VideoCapture`` calls
    inside the capture source adapter.

    Attributes:
        device: OpenCV device index. ``0`` is typically the first connected
            camera. Increment for additional cameras.
        width: Requested capture width in pixels. The camera driver may
            round to the nearest supported resolution.
        height: Requested capture height in pixels. Same rounding caveat.
        fps: Target capture frame rate. Passed to ``CAP_PROP_FPS``. Actual
            frame rate depends on camera hardware capabilities.
        buffer_size: ``CAP_PROP_BUFFERSIZE`` value. Setting to ``1`` reduces
            capture latency by discarding older buffered frames, at the cost
            of potentially missing frames under heavy load.
    """

    device: int = Field(default=0, ge=0, description="OpenCV camera device index")
    width: int = Field(default=1280, gt=0, description="Capture width in pixels")
    height: int = Field(default=720, gt=0, description="Capture height in pixels")
    fps: int = Field(default=15, ge=1, le=60, description="Target frames per second")
    buffer_size: int = Field(
        default=1,
        ge=1,
        description="cv2 CAP_PROP_BUFFERSIZE. 1 = lowest latency.",
    )


class DetectionConfig(BaseModel):
    """YOLO object detection model configuration.

    Controls which model is loaded and the inference thresholds applied
    to raw YOLO output. Lower ``confidence_threshold`` values produce
    more detections (higher recall, lower precision). Lower
    ``nms_threshold`` values suppress more overlapping boxes.

    Attributes:
        model_path: Path or filename of the YOLO model weights file.
            Relative paths are resolved from the working directory.
            Ultralytics will download ``yolov8n.pt`` on first use if the
            file is not found locally.
        confidence_threshold: Minimum detection confidence to retain a
            bounding box. Boxes below this score are discarded before NMS.
            Range [0.0, 1.0].
        nms_threshold: IoU threshold for non-maximum suppression. Boxes
            with IoU above this value with a higher-confidence box are
            suppressed. Range [0.0, 1.0].
    """

    model_path: str = Field(
        default="yolov8n.pt",
        min_length=1,
        description="Path to YOLO model weights file",
    )
    confidence_threshold: float = Field(
        default=0.25,
        ge=0.0,
        le=1.0,
        description="Minimum confidence to retain a detection",
    )
    nms_threshold: float = Field(
        default=0.45,
        ge=0.0,
        le=1.0,
        description="IoU threshold for non-maximum suppression",
    )


class TrackingConfig(BaseModel):
    """Multi-object tracker configuration.

    Controls the SORT-style tracker state machine thresholds. These values
    balance track stability (fewer false LOST transitions) against tracking
    lag (quickly detecting when an object has genuinely left the frame).

    Attributes:
        iou_threshold: Minimum IoU overlap required to match a detection
            to an existing track. Detections below this overlap score
            are treated as new objects. Range [0.0, 1.0].
        max_lost_frames: Number of consecutive frames a track can go
            unmatched before transitioning to DELETED state. Higher values
            tolerate occlusion better but delay cleanup of gone objects.
        min_confirm_frames: Number of consecutive frames a track must be
            matched before transitioning from TENTATIVE to CONFIRMED state.
            Higher values reduce false-positive tracks at the cost of
            delayed confirmation for real objects.
    """

    iou_threshold: float = Field(
        default=0.3,
        ge=0.0,
        le=1.0,
        description="Minimum IoU to match detection to existing track",
    )
    max_lost_frames: int = Field(
        default=15,
        ge=1,
        description="Frames without match before track is DELETED",
    )
    min_confirm_frames: int = Field(
        default=3,
        ge=1,
        description="Consecutive matches required to confirm a track",
    )


class PersistenceCheckConfig(BaseModel):
    """Configuration for the Layer 2 -> Layer 3 persistence-check interface.

    These thresholds govern the narrow read interface defined by CANON A.5:
    Layer 2 checks whether a tracked object matches a persisted node in
    Layer 3. The thresholds control when a match is declared, when the
    situation is considered ambiguous, and when a detection is flagged as
    surprising.

    Attributes:
        similarity_threshold: Minimum embedding cosine similarity to consider
            two feature profiles as representing the same object. Range [0.0, 1.0].
        spatial_tolerance: Maximum normalized distance (fraction of frame
            dimension) between the current bounding box centroid and the
            stored location to consider a spatial match valid. E.g., 0.15
            means the centroid must be within 15% of the frame width/height.
        recency_window_hours: How far back in time to search for matching
            nodes. Nodes last seen more than this many hours ago are not
            considered candidates for re-identification.
        surprise_threshold: If the best match confidence falls below this
            value in a location where an object was expected, the
            ``surprise_flag`` on :class:`~cobeing.layer2_perception.types.PersistenceResult`
            is set (Piaget R2 novelty signal). Range [0.0, 1.0].
        match_threshold: Minimum confidence required to declare a definitive
            match. Scores at or above this declare ``matched_node_id``.
            Must be >= ``ambiguity_threshold``. Range [0.0, 1.0].
        ambiguity_threshold: Minimum confidence for a candidate to appear in
            ``ambiguous_candidates``. Candidates in the range
            [``ambiguity_threshold``, ``match_threshold``) are ambiguous.
            Range [0.0, 1.0].
    """

    similarity_threshold: float = Field(
        default=0.7,
        ge=0.0,
        le=1.0,
        description="Minimum embedding similarity for object re-identification",
    )
    spatial_tolerance: float = Field(
        default=0.15,
        ge=0.0,
        le=1.0,
        description="Max normalized centroid distance for spatial match",
    )
    recency_window_hours: float = Field(
        default=24.0,
        gt=0.0,
        description="Hours back to search for matching nodes",
    )
    surprise_threshold: float = Field(
        default=0.3,
        ge=0.0,
        le=1.0,
        description="Confidence below which a mismatch triggers surprise_flag",
    )
    match_threshold: float = Field(
        default=0.75,
        ge=0.0,
        le=1.0,
        description="Minimum confidence to declare a definitive match",
    )
    ambiguity_threshold: float = Field(
        default=0.45,
        ge=0.0,
        le=1.0,
        description="Minimum confidence for a candidate to appear as ambiguous",
    )


class PerceptionConfig(BaseSettings):
    """Top-level configuration for the perception pipeline.

    Loads configuration from the environment and a ``.env`` file. Environment
    variables use the prefix ``COBEING_PERCEPTION_`` with ``__`` as the nested
    delimiter for subsection fields.

    Example environment variable overrides::

        COBEING_PERCEPTION_CAMERA__DEVICE=1
        COBEING_PERCEPTION_DETECTION__CONFIDENCE_THRESHOLD=0.4
        COBEING_PERCEPTION_TRACKING__MAX_LOST_FRAMES=20

    Attributes:
        camera: Camera device configuration.
        detection: YOLO model and inference thresholds.
        tracking: Multi-object tracker state machine thresholds.
        persistence: Layer 3 persistence-check interface thresholds.
    """

    model_config = SettingsConfigDict(
        env_prefix="COBEING_PERCEPTION_",
        env_nested_delimiter="__",
        env_file=".env",
        env_file_encoding="utf-8",
        # Ignore extra env vars that don't map to a field.
        extra="ignore",
    )

    camera: CameraConfig = Field(default_factory=CameraConfig)
    detection: DetectionConfig = Field(default_factory=DetectionConfig)
    tracking: TrackingConfig = Field(default_factory=TrackingConfig)
    persistence: PersistenceCheckConfig = Field(default_factory=PersistenceCheckConfig)


__all__ = [
    "CameraConfig",
    "DetectionConfig",
    "PerceptionConfig",
    "PersistenceCheckConfig",
    "TrackingConfig",
]
