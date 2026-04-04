"""Observation ingestion write path for the Co-Being knowledge graph.

This module implements the core ingestion pipeline that carries structured
observations from Layer 2 (Perception) into Layer 3 (Knowledge Graph).

**Ingestion contract:**

Every ``Observation`` produced by the perception pipeline is either:

1. A **new detection** -- ``candidate_node_id`` is ``None``. A fresh
   ``ObjectInstance`` node is created and saved.

2. A **repeat detection** -- ``candidate_node_id`` points to an existing
   node. The existing node's confidence is refreshed, its
   ``last_confirmed`` timestamp is updated, and its ``confirmation_count``
   is incremented.

The confidence refresh formula (D-TS-10) is::

    new_confidence = min(1.0, current_confidence + (1.0 - current_confidence) * 0.1)

Each confirmation moves confidence 10% of the remaining distance to 1.0,
producing an asymptotic curve that approaches but never exceeds 1.0.

**Epic 4 post-write hooks:**

After the node write completes, two optional hooks run when their
respective components are provided:

1. **Similarity computation** (``similarity_computer`` parameter):
   Computes SIMILAR_TO edges between the written node and all existing
   nodes sharing the same ``label_raw``. Only runs when the observation
   carries an embedding. Produces a ``SimilarityComputedEvent``.

2. **Expectation check** (``expectation_manager`` parameter):
   Compares the new embedding against the active ``PropertyExpectation``
   for the node's schema type, if one exists. Only runs for typed
   instances (nodes that have an INSTANCE_OF edge in the graph). Produces
   either a ``PredictionSuccessEvent`` or ``PredictionErrorDetectedEvent``.
   On success, ``update_expectations`` is called to incorporate the new
   embedding into the running statistics.

Both hooks are entirely optional. Existing callers that omit them receive
the same ``IngestionResult`` as before (backward-compatible). This design
avoids circular imports: the caller (typically the composition root in
``app.py``) injects the components; the module never imports them.

**Session lifecycle:**

Observation sessions group detections into discrete camera-on periods
(CANON A.10). Call ``create_observation_session`` at process start and
``close_observation_session`` at process stop. The session node records
``started_at`` and ``ended_at`` timestamps for temporal queries.

**Provenance:**

All data entering through this pipeline carries SENSOR provenance.
Provenance is structural -- it is never omitted.

Usage::

    from cobeing.layer3_knowledge.observation_ingestion import (
        add_observation,
        create_observation_session,
        close_observation_session,
        IngestionResult,
        ObservationSession,
    )
    from cobeing.layer3_knowledge.in_memory_persistence import (
        InMemoryGraphPersistence,
    )

    persistence = InMemoryGraphPersistence()

    # Start a session
    session = await create_observation_session(persistence, "session-001")

    # Ingest an observation (new object), no Epic 4 hooks
    result = await add_observation(persistence, observation)
    print(result.is_new)          # True
    print(result.confirmation_count)  # 0

    # Ingest with Epic 4 hooks wired in
    result = await add_observation(
        persistence,
        observation,
        similarity_computer=computer,
        expectation_manager=manager,
        session_id="session-001",
    )
    print(result.similarity_event)  # SimilarityComputedEvent | None
    print(result.prediction_check)  # PredictionCheckResult | None

    # Close session
    await close_observation_session(persistence, "session-001")
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any

from cobeing.layer3_knowledge.node_types import KnowledgeNode, SchemaLevel
from cobeing.layer3_knowledge.query_types import EdgeFilter
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.shared.observation import Observation
from cobeing.shared.time_utils import utc_now
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import CorrelationId, NodeId

# TYPE_CHECKING guard avoids a runtime circular import while still allowing
# mypy to resolve the forward references used in the function signatures.
# SimilarityComputer and ExpectationManager live in the same layer package,
# so they import GraphPersistence. Importing them at runtime here would not
# create a true circular import (no cycle exists), but keeping them under
# TYPE_CHECKING is good practice: it documents that these types are only
# needed for annotation, not for runtime logic.
if TYPE_CHECKING:
    from cobeing.layer3_knowledge.expectation_manager import (
        ExpectationManager,
        PredictionCheckResult,
    )
    from cobeing.layer3_knowledge.similarity import SimilarityComputedEvent
    from cobeing.layer3_knowledge.similarity_computer import SimilarityComputer


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class IngestionResult:
    """Result of a single observation ingestion operation.

    Returned by ``add_observation`` to communicate what happened:
    whether a new node was created or an existing node was updated,
    what the final confidence level is, how many times this node has
    been confirmed, and the outcomes of any Epic 4 post-write hooks.

    The Epic 4 fields (``similarity_event`` and ``prediction_check``) are
    ``None`` when the corresponding hook was not provided to
    ``add_observation``. Callers that do not supply those hooks can ignore
    these fields entirely.

    Attributes:
        node_id: ID of the created or updated node.
        is_new: ``True`` if a new node was created, ``False`` if an
            existing node was updated (repeat detection).
        confidence: Final confidence value on the node after the
            operation. For new nodes this is the observation's detection
            confidence. For repeat detections this is the post-refresh
            value.
        confirmation_count: How many times this node has been confirmed
            by repeat detections. Zero for a brand-new node. Incremented
            by one for each repeat detection.
        similarity_event: The ``SimilarityComputedEvent`` produced by the
            similarity computation hook, or ``None`` if no
            ``similarity_computer`` was provided or the observation had
            no embedding.
        prediction_check: The ``PredictionCheckResult`` produced by the
            expectation check hook, or ``None`` if no
            ``expectation_manager`` was provided, the instance is
            untyped, or the observation had no embedding.
    """

    node_id: NodeId
    is_new: bool
    confidence: float
    confirmation_count: int
    similarity_event: SimilarityComputedEvent | None = field(default=None)
    prediction_check: PredictionCheckResult | None = field(default=None)


@dataclass(frozen=True)
class ObservationSession:
    """Lightweight record of a newly created observation session node.

    Returned by ``create_observation_session`` to give the caller the
    node ID and start time of the session that was just opened.

    Attributes:
        session_id: The application-level session identifier (the same
            string passed to ``create_observation_session``).
        node_id: The graph node ID for the ``ObservationSession`` node.
            This is the identity of the session inside the knowledge graph.
        started_at: UTC timestamp recorded when the session was created.
    """

    session_id: str
    node_id: NodeId
    started_at: datetime


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------


def _refresh_confidence(current: float) -> float:
    """Apply the D-TS-10 confidence refresh formula.

    Moves confidence 10% of the remaining distance to 1.0. This produces
    an asymptotic curve that approaches but never exceeds 1.0.

    Formula::

        new = min(1.0, current + (1.0 - current) * 0.1)

    Args:
        current: Current confidence value, in the range [0.0, 1.0].

    Returns:
        Updated confidence value. Always in the range [0.0, 1.0].
    """
    return min(1.0, current + (1.0 - current) * 0.1)


def _session_node_id(session_id: str) -> NodeId:
    """Derive a graph NodeId from an application-level session_id."""
    return NodeId(f"session-{session_id}")


async def _find_instance_type(
    persistence: GraphPersistence,
    node_id: NodeId,
) -> NodeId | None:
    """Find the schema type this instance belongs to via an INSTANCE_OF edge.

    Uses the ``query_edges`` convenience method on the persistence backend
    if available (duck-type check with ``hasattr``). This method is not part
    of the ``GraphPersistence`` Protocol; it is an extension present on
    ``InMemoryGraphPersistence`` and any production backend that supports
    it. If the backend does not expose ``query_edges``, the function
    returns ``None`` -- the expectation hook is then skipped silently.

    An instance has an INSTANCE_OF edge when the schema pipeline has
    assigned it to a schema type (Epic 3). Untyped instances (no such
    edge) are not checked against expectations -- there is nothing to
    check them against.

    Args:
        persistence: The graph storage backend. May or may not expose
            ``query_edges``.
        node_id: The instance node to inspect.

    Returns:
        The ``NodeId`` of the schema type this instance belongs to,
        or ``None`` if the instance is untyped or edge traversal is
        unavailable.
    """
    # query_edges is now on the GraphPersistence Protocol (T303).
    # Filter directly for INSTANCE_OF edges from this instance node.
    edges = await persistence.query_edges(
        EdgeFilter(edge_type="INSTANCE_OF", source_node_id=str(node_id))
    )
    for edge in edges:
        if edge.source_id == node_id:
            return NodeId(edge.target_id)

    return None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def add_observation(
    persistence: GraphPersistence,
    observation: Observation,
    similarity_computer: SimilarityComputer | None = None,
    expectation_manager: ExpectationManager | None = None,
    session_id: str = "",
) -> IngestionResult:
    """Ingest a single structured observation into the knowledge graph.

    Examines ``observation.candidate_node_id`` to decide whether this is
    a new detection or a repeat detection of an already-known object.

    **New detection** (``candidate_node_id`` is ``None``):
        A new ``ObjectInstance`` node is created with all fields drawn
        from the ``Observation``. The node starts with
        ``confirmation_count=0`` and confidence equal to
        ``observation.confidence``.

    **Repeat detection** (``candidate_node_id`` is set):
        The existing node is retrieved, its confidence is refreshed using
        the D-TS-10 formula, ``last_confirmed`` is updated to now, and
        ``confirmation_count`` is incremented by one. The updated node is
        saved back to persistence.

    All data carries ``SENSOR`` provenance.

    **Epic 4 post-write hooks:**

    After the node write, two optional hooks run in order:

    1. **Similarity** -- if ``similarity_computer`` is provided and the
       observation has an embedding, ``compute_for_new_node`` is called.
       The resulting ``SimilarityComputedEvent`` is attached to the
       returned ``IngestionResult``.

    2. **Expectation** -- if ``expectation_manager`` is provided and the
       observation has an embedding, the instance type is looked up via
       INSTANCE_OF edges. If the instance is typed, ``check_prediction_error``
       runs. On confirmation (no error), ``update_expectations`` is called
       to fold the new embedding into the running statistics. The
       ``PredictionCheckResult`` is attached to the returned
       ``IngestionResult``.

    Both hooks default to ``None`` and are entirely optional. Omitting them
    produces the same result as the pre-Epic-4 behavior (backward-compatible).

    Args:
        persistence: The graph storage backend to write into.
        observation: Structured observation from the perception pipeline.
        similarity_computer: Optional ``SimilarityComputer`` instance.
            When provided and the observation has an embedding, SIMILAR_TO
            edges are computed for the ingested node.
        expectation_manager: Optional ``ExpectationManager`` instance.
            When provided and the observation has an embedding, the new
            node is checked against the active expectation for its schema
            type (typed instances only).
        session_id: The application-level session identifier, forwarded
            to ``expectation_manager.check_prediction_error`` for session-
            level event attribution. Has no effect when
            ``expectation_manager`` is ``None``.

    Returns:
        An ``IngestionResult`` describing what happened. ``is_new`` is
        ``True`` for new nodes, ``False`` for updated nodes.
        ``similarity_event`` and ``prediction_check`` are populated when
        the corresponding hooks ran.
    """
    if observation.candidate_node_id is not None:
        # ------------------------------------------------------------------
        # Repeat detection path -- update existing node
        # ------------------------------------------------------------------
        existing_node_id = NodeId(observation.candidate_node_id)
        existing_node = await persistence.get_node(existing_node_id)

        if existing_node is None:
            # The candidate ID was stale or incorrect -- treat as a new node.
            # This is a graceful fallback: we do not crash, we create a fresh
            # node and let the graph accumulate evidence.
            new_node_id = NodeId(f"instance-{observation.observation_id}")
            new_node = KnowledgeNode(
                node_id=new_node_id,
                node_type="ObjectInstance",
                schema_level=SchemaLevel.INSTANCE,
                properties=_build_instance_properties(observation),
                provenance=Provenance(
                    source=ProvenanceSource.SENSOR,
                    source_id=observation.observation_id,
                    confidence=observation.confidence,
                ),
                confidence=observation.confidence,
            )
            await persistence.save_node(new_node)
            result = IngestionResult(
                node_id=new_node_id,
                is_new=True,
                confidence=new_node.confidence,
                confirmation_count=new_node.confirmation_count,
            )
        else:
            # Refresh confidence and update confirmation tracking
            new_confidence = _refresh_confidence(existing_node.confidence)
            existing_node.confidence = new_confidence
            existing_node.last_confirmed = utc_now()
            existing_node.confirmation_count = existing_node.confirmation_count + 1

            await persistence.save_node(existing_node)

            result = IngestionResult(
                node_id=existing_node_id,
                is_new=False,
                confidence=new_confidence,
                confirmation_count=existing_node.confirmation_count,
            )
    else:
        # ------------------------------------------------------------------
        # New detection path -- create fresh instance node
        # ------------------------------------------------------------------
        new_node_id = NodeId(f"instance-{observation.observation_id}")
        new_node = KnowledgeNode(
            node_id=new_node_id,
            node_type="ObjectInstance",
            schema_level=SchemaLevel.INSTANCE,
            properties=_build_instance_properties(observation),
            provenance=Provenance(
                source=ProvenanceSource.SENSOR,
                source_id=observation.observation_id,
                confidence=observation.confidence,
            ),
            confidence=observation.confidence,
        )
        await persistence.save_node(new_node)

        result = IngestionResult(
            node_id=new_node_id,
            is_new=True,
            confidence=new_node.confidence,
            confirmation_count=new_node.confirmation_count,
        )

    # ------------------------------------------------------------------
    # Epic 4 post-write hook 1: Similarity computation
    # ------------------------------------------------------------------
    similarity_event: SimilarityComputedEvent | None = None
    if similarity_computer is not None and observation.embedding is not None:
        correlation_id = CorrelationId(observation.observation_id)
        similarity_event = await similarity_computer.compute_for_new_node(
            node_id=result.node_id,
            label_raw=observation.label_raw,
            embedding=observation.embedding,
            correlation_id=correlation_id,
        )

    # ------------------------------------------------------------------
    # Epic 4 post-write hook 2: Expectation check (typed instances only)
    # ------------------------------------------------------------------
    prediction_check: PredictionCheckResult | None = None
    if expectation_manager is not None and observation.embedding is not None:
        schema_type_id = await _find_instance_type(persistence, result.node_id)
        if schema_type_id is not None:
            correlation_id = CorrelationId(observation.observation_id)
            prediction_check = await expectation_manager.check_prediction_error(
                schema_type_id=schema_type_id,
                instance_node_id=result.node_id,
                embedding=observation.embedding,
                property_key="embedding",
                session_id=session_id,
                correlation_id=correlation_id,
            )
            # On confirmation (no error), update running statistics so the
            # expectation's centroid and variance evolve with new evidence.
            if prediction_check.error is None and prediction_check.success_event is not None:
                await expectation_manager.update_expectations(
                    schema_type_id=schema_type_id,
                    new_embedding=observation.embedding,
                    property_key="embedding",
                )

    # ------------------------------------------------------------------
    # Assemble final result with hook outcomes attached
    # ------------------------------------------------------------------
    if similarity_event is not None or prediction_check is not None:
        result = IngestionResult(
            node_id=result.node_id,
            is_new=result.is_new,
            confidence=result.confidence,
            confirmation_count=result.confirmation_count,
            similarity_event=similarity_event,
            prediction_check=prediction_check,
        )

    return result


async def create_observation_session(
    persistence: GraphPersistence,
    session_id: str,
) -> ObservationSession:
    """Create and persist a new observation session node.

    An ObservationSession node represents one continuous camera-on period
    (CANON A.10). Its existence in the graph marks the temporal scope of
    the observations associated with it.

    The node is saved to persistence immediately. The returned
    ``ObservationSession`` gives the caller the graph node ID and start
    time.

    Args:
        persistence: The graph storage backend to write into.
        session_id: Application-level identifier for this session.
            Used to derive the graph node ID and stored as a property.

    Returns:
        ``ObservationSession`` with the graph node ID, the session_id,
        and the recorded start timestamp.
    """
    started_at = utc_now()
    node_id = _session_node_id(session_id)

    session_node = KnowledgeNode(
        node_id=node_id,
        node_type="ObservationSession",
        schema_level=SchemaLevel.INSTANCE,
        properties={
            "session_id": session_id,
            "started_at": started_at.isoformat(),
        },
        provenance=Provenance(
            source=ProvenanceSource.SENSOR,
            source_id=session_id,
            confidence=1.0,
        ),
        confidence=1.0,
        valid_from=started_at,
    )

    await persistence.save_node(session_node)

    return ObservationSession(
        session_id=session_id,
        node_id=node_id,
        started_at=started_at,
    )


async def close_observation_session(
    persistence: GraphPersistence,
    session_id: str,
) -> None:
    """Mark an observation session as closed.

    Retrieves the session node from persistence and updates it with:
    - ``ended_at`` property set to the current UTC time
    - ``valid_to`` field set to the current UTC time

    This records when the camera-on period ended, enabling temporal
    queries like "what changed since last session" to work correctly.

    If no session node is found for ``session_id``, the function returns
    without error. This is a safe no-op to handle cases where the session
    was never explicitly opened (e.g., during testing).

    Args:
        persistence: The graph storage backend to read from and write to.
        session_id: Application-level identifier of the session to close.
    """
    node_id = _session_node_id(session_id)
    session_node = await persistence.get_node(node_id)

    if session_node is None:
        # No session node found -- nothing to close.
        return

    ended_at = utc_now()
    session_node.properties = {
        **session_node.properties,
        "ended_at": ended_at.isoformat(),
    }
    session_node.valid_to = ended_at

    await persistence.save_node(session_node)


# ---------------------------------------------------------------------------
# Private helpers (module-internal)
# ---------------------------------------------------------------------------


def _build_instance_properties(observation: Observation) -> dict[str, object]:
    """Build the properties dict for a new ObjectInstance node.

    Extracts the relevant fields from the observation and converts them
    into the flat key-value structure used by ``KnowledgeNode.properties``.

    The bounding box is stored as a plain dict so it can be serialized
    to any backend without requiring a Pydantic model at the storage layer.

    Args:
        observation: The source observation from the perception pipeline.

    Returns:
        Properties dict ready for assignment to ``KnowledgeNode.properties``.
    """
    bbox = observation.bounding_box
    properties: dict[str, object] = {
        "label_raw": observation.label_raw,
        "observation_confidence": observation.confidence,
        "bounding_box": {
            "x_min": bbox.x_min,
            "y_min": bbox.y_min,
            "x_max": bbox.x_max,
            "y_max": bbox.y_max,
            "frame_width": bbox.frame_width,
            "frame_height": bbox.frame_height,
        },
        "embedding": observation.embedding,
        "dominant_colors": observation.dominant_colors,
    }
    return properties


__all__ = [
    "IngestionResult",
    "ObservationSession",
    "add_observation",
    "close_observation_session",
    "create_observation_session",
]
