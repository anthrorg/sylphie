"""Co-Being provenance metadata.

Every node and edge in the knowledge graph carries provenance tracing it
to its source (CANON A.11). This module defines the provenance model and
the five permitted source categories.

The five categories are fixed by CANON A.11 / A.18::

    SENSOR                      -- direct sensor observation
    GUARDIAN                    -- human guardian statement
    INFERENCE                   -- system inference from sensor/guardian data
    GUARDIAN_APPROVED_INFERENCE  -- LLM inference approved by the guardian
    TAUGHT_PROCEDURE            -- procedural infrastructure pre-loaded at bootstrap
                                   (CANON A.18: methods and concept primitives only,
                                   never world knowledge or computed results)

No other source categories are permitted without an explicit CANON amendment.

Usage::

    from cobeing.shared.provenance import Provenance, ProvenanceSource

    p = Provenance(
        source=ProvenanceSource.SENSOR,
        source_id="camera-frame-0042",
        confidence=0.85,
    )

    # Provenance is frozen (immutable after creation):
    p.confidence = 0.9  # raises ValidationError

    # Serialize to dict / JSON and back:
    data = p.model_dump()
    restored = Provenance.model_validate(data)
"""

from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field


class ProvenanceSource(StrEnum):
    """The five permitted provenance source categories (CANON A.11).

    Each value is a lowercase string suitable for storage and serialization.
    As a ``StrEnum``, ``ProvenanceSource.SENSOR == "sensor"`` is True,
    which simplifies comparisons in graph queries.

    Attributes:
        SENSOR: Direct sensor observation (camera, microphone, etc.).
        GUARDIAN: Statement or correction from the human guardian.
        INFERENCE: System inference derived from sensor and/or guardian data.
            Also used for bootstrap EvolutionRule nodes (CANON A.11).
        GUARDIAN_APPROVED_INFERENCE: LLM-proposed inference that the guardian
            has explicitly approved. Example: LLM proposes a type merge
            based on graph patterns, guardian approves.
        TAUGHT_PROCEDURE: Procedural infrastructure pre-loaded at bootstrap
            (CANON A.18). Restricted to ProceduralTemplate, ProcedureStep,
            WorkedExample, ConceptPrimitive, and ValueNodes 0-20. These are
            methods and symbols, not world knowledge. The guardian can modify
            or deprecate any TAUGHT_PROCEDURE entity via normal interaction.
    """

    SENSOR = "sensor"
    GUARDIAN = "guardian"
    INFERENCE = "inference"
    GUARDIAN_APPROVED_INFERENCE = "guardian_approved_inference"
    TAUGHT_PROCEDURE = "taught_procedure"


def _utc_now() -> datetime:
    """Return the current UTC time as a timezone-aware datetime.

    Used as the default factory for ``Provenance.timestamp``.
    Timezone-aware datetimes prevent ambiguity when comparing timestamps
    across sessions or serializing to JSON.
    """
    return datetime.now(UTC)


class Provenance(BaseModel):
    """Immutable provenance metadata attached to every graph node and edge.

    Provenance answers: *where did this piece of knowledge come from?*
    It is a structural requirement of the graph schema from day one
    (CANON A.11) and cannot be retrofitted.

    The model is frozen (immutable after construction). Once provenance
    is recorded, it does not change. If provenance needs to be updated
    (e.g., an INFERENCE is later approved by the guardian), a new
    Provenance instance is created -- the old one is preserved for
    audit trail purposes.

    Attributes:
        source: Which of the five CANON A.11 categories produced this data.
        source_id: Identifier of the specific source (e.g., camera frame ID,
            guardian session ID, LLM request correlation ID). Must not be empty.
        timestamp: When this provenance was recorded. Defaults to current
            UTC time. Always timezone-aware.
        confidence: How confident the source is in this data, on a 0.0-1.0
            scale. 0.0 means no confidence, 1.0 means absolute certainty.
            Guardian statements default to 1.0. Sensor observations carry
            the detector's confidence score.
    """

    model_config = ConfigDict(frozen=True)

    source: ProvenanceSource
    source_id: str = Field(min_length=1)
    timestamp: datetime = Field(default_factory=_utc_now)
    confidence: float = Field(ge=0.0, le=1.0)
