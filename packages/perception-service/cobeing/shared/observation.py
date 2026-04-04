"""Co-Being observation models -- the Layer 2 / Layer 3 contract.

An Observation is the structured output of the perception pipeline (Layer 2).
It is the primary data structure that crosses the boundary between perception
and the knowledge graph (Layer 3). Everything Layer 3 knows about the physical
world arrives as an Observation.

The BoundingBox model captures pixel-space detection coordinates along with
the frame dimensions needed to compute relative properties like area fraction.

Both models are frozen (immutable after construction). Once a perception event
is recorded, its data does not change. If a correction is needed, a new
Observation is created with its own provenance.

Usage::

    from cobeing.shared.observation import Observation, BoundingBox
    from cobeing.shared.provenance import Provenance, ProvenanceSource

    bbox = BoundingBox(
        x_min=100.0,
        y_min=150.0,
        x_max=300.0,
        y_max=400.0,
        frame_width=640,
        frame_height=480,
    )

    obs = Observation(
        observation_id="obs-abc-123",
        session_id="session-001",
        label_raw="cup",
        confidence=0.92,
        bounding_box=bbox,
        provenance=Provenance(
            source=ProvenanceSource.SENSOR,
            source_id="camera-frame-042",
            confidence=0.92,
        ),
    )

    # Computed properties on BoundingBox:
    print(bbox.center_x)       # 200.0
    print(bbox.center_y)       # 275.0
    print(bbox.width)          # 200.0
    print(bbox.height)         # 250.0
    print(bbox.area_fraction)  # ~0.1627 (fraction of total frame area)
"""

from datetime import UTC, datetime

from pydantic import BaseModel, ConfigDict, Field, model_validator

from cobeing.shared.provenance import Provenance


def _utc_now() -> datetime:
    """Return the current UTC time as a timezone-aware datetime.

    Used as the default factory for ``Observation.timestamp``.
    Timezone-aware datetimes prevent ambiguity when comparing timestamps
    across sessions or serializing to JSON.
    """
    return datetime.now(UTC)


class BoundingBox(BaseModel):
    """Pixel-space bounding box from an object detection result.

    Represents the rectangular region in a camera frame where an object
    was detected. Stores both the box coordinates and the full frame
    dimensions so that relative properties (center position, area fraction)
    can be computed without external context.

    The coordinate system follows image conventions:
    - Origin (0, 0) is top-left of the frame.
    - x increases rightward, y increases downward.
    - All coordinates are in pixels (float for sub-pixel precision).

    Validation ensures x_min < x_max and y_min < y_max. Coordinates are
    not clamped to frame boundaries -- detections may extend slightly
    outside the frame depending on the detector.

    Attributes:
        x_min: Left edge of the bounding box in pixels.
        y_min: Top edge of the bounding box in pixels.
        x_max: Right edge of the bounding box in pixels.
        y_max: Bottom edge of the bounding box in pixels.
        frame_width: Width of the full camera frame in pixels.
        frame_height: Height of the full camera frame in pixels.
    """

    model_config = ConfigDict(frozen=True)

    x_min: float
    y_min: float
    x_max: float
    y_max: float
    frame_width: int = Field(gt=0)
    frame_height: int = Field(gt=0)

    @model_validator(mode="after")
    def _validate_box_coordinates(self) -> "BoundingBox":
        """Ensure x_min < x_max and y_min < y_max.

        A bounding box with zero or negative area is not a valid detection
        result. This catches swapped or equal coordinates.

        Returns:
            The validated BoundingBox instance.

        Raises:
            ValueError: If x_min >= x_max or y_min >= y_max.
        """
        if self.x_min >= self.x_max:
            raise ValueError(
                f"x_min ({self.x_min}) must be strictly less than x_max ({self.x_max})"
            )
        if self.y_min >= self.y_max:
            raise ValueError(
                f"y_min ({self.y_min}) must be strictly less than y_max ({self.y_max})"
            )
        return self

    @property
    def center_x(self) -> float:
        """Horizontal center of the bounding box in pixels."""
        return (self.x_min + self.x_max) / 2.0

    @property
    def center_y(self) -> float:
        """Vertical center of the bounding box in pixels."""
        return (self.y_min + self.y_max) / 2.0

    @property
    def width(self) -> float:
        """Width of the bounding box in pixels."""
        return self.x_max - self.x_min

    @property
    def height(self) -> float:
        """Height of the bounding box in pixels."""
        return self.y_max - self.y_min

    @property
    def area_fraction(self) -> float:
        """Fraction of the total frame area occupied by this bounding box.

        Returns a value between 0.0 (exclusive) and some positive number.
        A value of 1.0 means the bounding box covers the entire frame.
        Values greater than 1.0 are possible if the detection extends
        beyond frame boundaries.
        """
        box_area = self.width * self.height
        frame_area = float(self.frame_width * self.frame_height)
        return box_area / frame_area


class Observation(BaseModel):
    """A single structured observation from the perception pipeline.

    This is the primary data structure crossing the Layer 2 / Layer 3
    boundary. Every piece of information the knowledge graph receives about
    the physical world arrives as an Observation.

    An Observation captures what was detected (label, confidence, bounding box),
    when it was detected (timestamp, session), and where the information came
    from (provenance). Optional fields (embedding, dominant_colors,
    candidate_node_id) support enriched perception without requiring all
    capabilities from day one.

    The model is frozen (immutable after construction). Observations are
    facts about what was perceived at a point in time -- they do not change.

    Attributes:
        observation_id: Unique identifier for this observation (UUID string).
        session_id: Which ObservationSession this belongs to (CANON A.10).
        label_raw: Raw label from the detector (e.g., "cup", "cell phone").
            Not normalized -- normalization happens in Layer 3.
        confidence: Detection confidence from YOLO, 0.0 to 1.0 inclusive.
        bounding_box: Pixel-space location of the detected object.
        embedding: Optional visual embedding vector from EfficientNet-B0
            or similar. Not required in Phase 1.
        dominant_colors: Optional list of dominant RGB color tuples extracted
            from the bounding box region. Not required in Phase 1.
        timestamp: UTC timestamp of when this observation was captured.
            Defaults to current UTC time.
        provenance: Source metadata (CANON A.11). Typically SENSOR for
            camera-based detections.
        candidate_node_id: If Layer 2 matched this observation to an existing
            knowledge graph node, that node's ID. None if no match was found
            or matching was not attempted.
    """

    model_config = ConfigDict(frozen=True)

    observation_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    label_raw: str = Field(min_length=1)
    confidence: float = Field(ge=0.0, le=1.0)
    bounding_box: BoundingBox
    embedding: list[float] | None = None
    dominant_colors: list[tuple[int, int, int]] | None = None
    timestamp: datetime = Field(default_factory=_utc_now)
    provenance: Provenance
    candidate_node_id: str | None = None
