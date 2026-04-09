"""Layer 2: Perception -- sensor data to structured observations.

This package processes raw camera frames into structured perceptual data
that can be written to the Layer 3 knowledge graph. It is the perception
pipeline described in CANON Layer 2: "processes raw sensor data into
structured information; object detection, spatial mapping; runs continuously,
feeds the knowledge graph."

The package contains no dependency on OpenCV, YOLO, or numpy at import time.
Those dependencies are loaded lazily inside the implementation modules that
actually perform CV work. Types, configuration, and exceptions are safe to
import in any context.

Public API::

    from cobeing.layer2_perception import (
        # Types
        TrackState, TrackId,
        Frame, Detection, FeatureProfile, TrackedObject, PersistenceResult,
        # Configuration
        PerceptionConfig, CameraConfig, DetectionConfig,
        TrackingConfig, PersistenceCheckConfig, ValidationConfig,
        # Exceptions
        PerceptionError, CaptureError, DetectionError,
        TrackingError, PersistenceCheckError,
        # Protocols
        FrameSource, ObjectDetector, ObjectTracker, PersistenceCheck,
        # Detectors
        YoloDetector,
        MockDetector,
        # Feature extractors
        DominantColorExtractor,
        EmbeddingExtractor,
        MockEmbeddingExtractor,
        OnnxEmbeddingExtractor,
        # Tracker
        IoUTracker,
        # Frame buffer and session management
        FrameBuffer,
        ObservationSessionManager,
        # Persistence check service
        PersistenceCheckService,
        compute_match_score,
        # Observation builder
        ObservationBuilder,
        # Observation validator
        ObservationValidator,
        ValidationResult,
        # Spatial relationship extractor
        SpatialRelationshipExtractor,
        SpatialRelation,
        # Synthetic frame source (testing)
        SyntheticFrameSource,
        SyntheticObject,
        # Camera frame sources (live camera + video file)
        CameraFrameSource,
        VideoFileSource,
        # Pipeline orchestrator
        PerceptionPipeline,
    )
"""

from .config import (
    CameraConfig,
    DetectionConfig,
    PerceptionConfig,
    PersistenceCheckConfig,
    TrackingConfig,
    ValidationConfig,
)
from .detector import MockDetector, YoloDetector
from .exceptions import (
    CaptureError,
    DetectionError,
    PerceptionError,
    PersistenceCheckError,
    TrackingError,
)
from .feature_extraction import (
    DominantColorExtractor,
    EmbeddingExtractor,
    MockEmbeddingExtractor,
    OnnxEmbeddingExtractor,
)
from .frame_buffer import (
    FrameBuffer,
    ObservationSessionManager,
)
from .frame_sources import CameraFrameSource, VideoFileSource
from .observation_builder import ObservationBuilder
from .observation_validator import ObservationValidator, ValidationResult
from .persistence_check_service import (
    PersistenceCheckService,
    compute_match_score,
)
from .pipeline import PerceptionPipeline
from .protocols import (
    FrameSource,
    ObjectDetector,
    ObjectTracker,
    PersistenceCheck,
)
from .spatial_extractor import SpatialRelation, SpatialRelationshipExtractor
from .synthetic_source import SyntheticFrameSource, SyntheticObject
from .tracker import IoUTracker
from .types import (
    Detection,
    FeatureProfile,
    Frame,
    PersistenceResult,
    TrackId,
    TrackState,
    TrackedObject,
)

__all__ = [
    # Types
    "Detection",
    "FeatureProfile",
    "Frame",
    "PersistenceResult",
    "TrackId",
    "TrackState",
    "TrackedObject",
    # Configuration
    "CameraConfig",
    "DetectionConfig",
    "PerceptionConfig",
    "PersistenceCheckConfig",
    "TrackingConfig",
    "ValidationConfig",
    # Exceptions
    "CaptureError",
    "DetectionError",
    "PerceptionError",
    "PersistenceCheckError",
    "TrackingError",
    # Protocols
    "FrameSource",
    "ObjectDetector",
    "ObjectTracker",
    "PersistenceCheck",
    # Detectors
    "MockDetector",
    "YoloDetector",
    # Feature extractors
    "DominantColorExtractor",
    "EmbeddingExtractor",
    "MockEmbeddingExtractor",
    "OnnxEmbeddingExtractor",
    # Tracker
    "IoUTracker",
    # Frame buffer and session management
    "FrameBuffer",
    "ObservationSessionManager",
    # Persistence check service
    "PersistenceCheckService",
    "compute_match_score",
    # Observation builder
    "ObservationBuilder",
    # Observation validator
    "ObservationValidator",
    "ValidationResult",
    # Spatial relationship extractor
    "SpatialRelationshipExtractor",
    "SpatialRelation",
    # Synthetic frame source (testing)
    "SyntheticFrameSource",
    "SyntheticObject",
    # Camera frame sources (live camera + video file)
    "CameraFrameSource",
    "VideoFileSource",
    # Pipeline orchestrator
    "PerceptionPipeline",
]
