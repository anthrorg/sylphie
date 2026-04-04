"""ExpectationManager: formation, incremental update, and prediction checking.

This module implements the full Epic 4 expectation pipeline across two tickets:

- **T046a** -- :meth:`ExpectationManager.form_expectations` and
  :meth:`ExpectationManager.update_expectations`: form a
  :class:`PropertyExpectation` from instance nodes and keep its running
  statistics up to date using Welford's online algorithm.

- **T046b** -- :meth:`ExpectationManager.check_prediction_error`: compare a
  new embedding against an active :class:`PropertyExpectation` and apply the
  asymmetric confidence update formula (D4-04). Returns a
  :class:`PredictionCheckResult` carrying the event and updated expectation.

Key responsibilities:

- :meth:`ExpectationManager.form_expectations` -- scan all instance nodes for
  a schema type, compute the centroid and variance using Welford's online
  algorithm, and persist a :class:`PropertyExpectation` if at least 3 unique
  instances are available (CANON A.5, D-TS-15).

- :meth:`ExpectationManager.update_expectations` -- incorporate a new embedding
  into an existing expectation using Welford online update, rejecting outliers
  that exceed the configured sigma threshold (D-TS-09: 2.0).

- :meth:`ExpectationManager.check_prediction_error` -- compare a new embedding
  to an active expectation. If the sigma distance exceeds the threshold, return
  a :class:`PredictionError` and apply the contradiction confidence penalty
  (beta). If within range, return a :class:`PredictionSuccessEvent` and apply
  the confirmation confidence boost (alpha). Both formulas are asymmetric
  (D4-04).

**No LLM involvement (CANON A.12):**

All methods operate entirely from graph data -- node properties, edge
traversal, and rule node configuration. No language model is called at any
point. The sigma threshold and asymmetric confidence parameters are read from
the PREDICTION_ERROR_DEMOTION EvolutionRule node in the graph (A.10 compliant:
reads from graph, not from in-memory constants).

**Session counting (A.10 compliant):**

The activation check ("is this expectation ready to be used for prediction?")
requires both a minimum sample count (5 instances) and a minimum session count
(2 sessions). Session count is read from the graph by querying
``ObservationSession`` nodes -- not from any in-memory counter.

**Welford online algorithm:**

Mean and variance are maintained using Welford's method, which allows
incremental updates without storing all historical observations. This is
critical for a long-running system: instance nodes accumulate over time and
recomputing from scratch on every update would scale quadratically.

**Asymmetric confidence updates (D4-04):**

Confirmation and contradiction apply different formulas with different rates:

- Confirmation (within range):
  ``new_conf = min(ceiling, old + alpha * (ceiling - old))``
  Default: alpha=0.03, ceiling=0.95. Each confirmation inches confidence
  toward the ceiling with diminishing returns.

- Contradiction (beyond sigma threshold):
  ``new_conf = max(floor, old * (1 - beta))``
  Default: beta=0.15, floor=0.10. Each contradiction cuts confidence by 15%,
  never below the floor.

All parameters are read from the PREDICTION_ERROR_DEMOTION rule node.

Usage::

    from cobeing.layer3_knowledge.expectation_manager import (
        ExpectationManager,
        PredictionCheckResult,
    )
    from cobeing.layer3_knowledge.in_memory_persistence import InMemoryGraphPersistence
    from cobeing.shared.types import CorrelationId, NodeId

    persistence = InMemoryGraphPersistence()
    manager = ExpectationManager(persistence)

    # Form a new expectation after seeing enough instances of a schema type:
    expectation = await manager.form_expectations(
        schema_type_id=NodeId("type-mug"),
        property_key="embedding",
    )

    # Update running statistics when a new instance arrives:
    updated = await manager.update_expectations(
        schema_type_id=NodeId("type-mug"),
        new_embedding=[0.1, 0.2, 0.3],
        property_key="embedding",
    )

    # Check a new observation against the active expectation:
    result = await manager.check_prediction_error(
        schema_type_id=NodeId("type-mug"),
        instance_node_id=NodeId("inst-mug-042"),
        embedding=[0.1, 0.19, 0.31],
        property_key="embedding",
        session_id="session-2026-02-25-001",
        correlation_id=CorrelationId("corr-abc-123"),
    )
    if result.error is not None:
        print("Prediction error detected:", result.error.observed_sigma_distance)
    if result.success_event is not None:
        print("Confirmed! count:", result.success_event.confirmation_count)
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from cobeing.layer3_knowledge.expectation_types import PropertyExpectation
from cobeing.layer3_knowledge.expectations import (
    PredictionError,
    PredictionErrorDetectedEvent,
    PredictionSuccessEvent,
)
from cobeing.layer3_knowledge.node_types import KnowledgeNode
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.query_types import EdgeFilter, NodeFilter
from cobeing.shared.provenance import ProvenanceSource
from cobeing.shared.types import CorrelationId, NodeId


# ---------------------------------------------------------------------------
# Module-level pure math helpers
# ---------------------------------------------------------------------------


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    """Compute the cosine similarity between two equal-length vectors.

    Returns the cosine of the angle between the two vectors: 1.0 for
    identical direction, 0.0 for orthogonal, -1.0 for opposite direction.
    If either vector has zero magnitude, returns 0.0 to avoid division by
    zero.

    Args:
        a: First vector.
        b: Second vector. Must be the same length as ``a``.

    Returns:
        Cosine similarity in the range ``[-1.0, 1.0]``. Returns 0.0 if
        either vector has zero magnitude.

    Raises:
        ValueError: If ``a`` and ``b`` have different lengths.
    """
    if len(a) != len(b):
        raise ValueError(
            f"Embedding length mismatch: {len(a)} vs {len(b)}."
        )
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


def _welford_update_centroid(
    old_mean: list[float],
    new_observation: list[float],
    old_count: int,
) -> list[float]:
    """Update a running centroid with a new observation using Welford's formula.

    Welford's online algorithm maintains a running mean without storing all
    historical values. The update formula is::

        new_mean[i] = old_mean[i] + (obs[i] - old_mean[i]) / new_count

    This is numerically stable: it accumulates small corrections rather than
    recomputing from a growing sum, which avoids catastrophic cancellation
    for large counts.

    Args:
        old_mean: The current centroid vector. Must be the same length as
            ``new_observation``.
        new_observation: The new data point being incorporated.
        old_count: The number of observations that produced ``old_mean``.
            The new count used in the update is ``old_count + 1``.

    Returns:
        A new centroid vector of the same length as ``old_mean``.
    """
    new_count = old_count + 1
    return [
        old_mean[i] + (new_observation[i] - old_mean[i]) / new_count
        for i in range(len(old_mean))
    ]


def _welford_update_variance(
    old_variance: float,
    old_mean: list[float],
    new_mean: list[float],
    new_observation: list[float],
    old_count: int,
) -> float:
    """Update running scalar variance of cosine distances using Welford's method.

    Variance here is the mean squared cosine distance from the centroid across
    all observations. The update avoids a full recompute by using the cosine
    distance from the old and new means::

        cos_dist_old = 1 - cosine_similarity(obs, old_mean)
        cos_dist_new = 1 - cosine_similarity(obs, new_mean)
        new_M2 = old_variance * old_count + cos_dist_old * cos_dist_new
        new_variance = new_M2 / new_count

    This approximates Welford's two-pass variance update adapted for cosine
    distance spread rather than Euclidean distance.

    Args:
        old_variance: The current scalar variance value. Must be >= 0.0.
        old_mean: The centroid before incorporating the new observation.
        new_mean: The centroid after incorporating the new observation.
        new_observation: The new data point being incorporated.
        old_count: The number of observations that produced ``old_mean``
            and ``old_variance``.

    Returns:
        Updated scalar variance. Always >= 0.0.
    """
    new_count = old_count + 1
    cos_dist_old = 1.0 - _cosine_similarity(new_observation, old_mean)
    cos_dist_new = 1.0 - _cosine_similarity(new_observation, new_mean)
    new_m2 = old_variance * old_count + cos_dist_old * cos_dist_new
    return new_m2 / new_count if new_count > 0 else 0.0


def _build_initial_centroid(embeddings: list[list[float]]) -> list[float]:
    """Compute the centroid of a collection of embedding vectors.

    Uses Welford's online algorithm internally so the same update path is
    exercised during both initial formation and incremental updates.

    Args:
        embeddings: Non-empty list of equal-length float vectors.

    Returns:
        The centroid vector of the same dimension as the input vectors.
    """
    mean: list[float] = [0.0] * len(embeddings[0])
    for i, emb in enumerate(embeddings):
        mean = _welford_update_centroid(mean, emb, i)
    return mean


def _build_initial_variance(
    embeddings: list[list[float]],
    centroid: list[float],  # noqa: ARG001 -- kept for symmetry with caller convention
) -> float:
    """Compute initial scalar variance of cosine distances from the centroid.

    Uses Welford's online variance formula over the provided embeddings so
    the result is consistent with subsequent incremental updates via
    :func:`_welford_update_variance`.

    Args:
        embeddings: Non-empty list of equal-length float vectors.
        centroid: The pre-computed centroid of ``embeddings``. Accepted for
            caller-side symmetry but the variance is computed via the Welford
            running mean, not the final centroid, to ensure consistency with
            the incremental update path.

    Returns:
        Scalar variance. Always >= 0.0.
    """
    variance = 0.0
    running_mean = [0.0] * len(embeddings[0])
    for i, emb in enumerate(embeddings):
        new_mean = _welford_update_centroid(running_mean, emb, i)
        variance = _welford_update_variance(
            variance, running_mean, new_mean, emb, i
        )
        running_mean = new_mean
    return variance


def _expectation_id(schema_type_id: NodeId, property_key: str) -> str:
    """Derive a stable expectation identifier from type and property key.

    The identifier is deterministic so that repeated calls to
    ``form_expectations`` for the same type and property produce the same
    ``expectation_id`` and therefore hit the idempotency guard in
    ``get_property_expectations``.

    Args:
        schema_type_id: The schema type node identifier.
        property_key: The property name being tracked (e.g., ``"embedding"``).

    Returns:
        A string suitable for use as ``PropertyExpectation.expectation_id``.
    """
    return f"exp-{schema_type_id}-{property_key}"


# ---------------------------------------------------------------------------
# Configuration dataclass (T046b)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _DemotionConfig:
    """Cached configuration read from the PREDICTION_ERROR_DEMOTION rule node.

    All parameters are read once from the graph at first use and then
    cached for the lifetime of the :class:`ExpectationManager` instance.
    This satisfies D-TS-09 (cache at construction time) while keeping the
    rule source of truth in the graph (A.10 compliant).

    Attributes:
        sigma_threshold: How many sigma-units of cosine distance a new
            observation may deviate from the centroid before it is
            classified as a prediction error. Default: 2.0 (D-TS-09).
        alpha: Confirmation boost rate. Applied each time an observation
            confirms the expectation:
            ``new_conf = min(ceiling, old + alpha * (ceiling - old))``.
            Default: 0.03.
        beta: Contradiction penalty rate. Applied each time an observation
            contradicts the expectation:
            ``new_conf = max(floor, old * (1 - beta))``.
            Default: 0.15.
        ceiling: Upper bound on confidence. Confirmation never raises
            confidence above this value. Default: 0.95.
        floor: Lower bound on confidence. Contradiction never lowers
            confidence below this value. Default: 0.10.
    """

    sigma_threshold: float
    alpha: float
    beta: float
    ceiling: float
    floor: float


# ---------------------------------------------------------------------------
# PredictionCheckResult (T046b)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PredictionCheckResult:
    """Result of a single call to :meth:`ExpectationManager.check_prediction_error`.

    Exactly one of the three event/error fields will be set per call,
    depending on the outcome:

    - No expectation found or expectation inactive: all three are ``None``.
    - Confirming observation (within sigma range): ``success_event`` is set.
    - Contradicting observation (beyond sigma range): ``error`` and
      ``error_event`` are both set.

    ``updated_expectation`` is set whenever a confidence update was applied
    (i.e., for both confirming and contradicting outcomes). It is ``None``
    only when the check returned early because no active expectation existed.

    Attributes:
        error: Structured description of the expectation violation, including
            the measured sigma distance and which expectation was violated.
            Set only for contradicting observations.
        success_event: Event emitted when an observation confirms an active
            expectation. Carries the signed deviation from mean and the new
            confirmation count. Set only for confirming observations.
        error_event: Event emitted when an observation contradicts an active
            expectation. Wraps ``error`` with session and correlation context.
            Set only for contradicting observations (always paired with
            ``error``).
        updated_expectation: The :class:`PropertyExpectation` after the
            confidence update was applied and persisted. ``None`` if the
            check returned early (no active expectation).

    Example::

        result = await manager.check_prediction_error(
            schema_type_id=NodeId("type-mug"),
            instance_node_id=NodeId("inst-mug-042"),
            embedding=[0.1, 0.2, 0.3],
            session_id="session-001",
            correlation_id=CorrelationId("corr-abc"),
        )
        if result.error is not None:
            # Prediction error: confidence was lowered on the expectation.
            log.warning("prediction_error", sigma=result.error.observed_sigma_distance)
        elif result.success_event is not None:
            # Confirmation: confidence was raised on the expectation.
            log.debug("confirmed", count=result.success_event.confirmation_count)
    """

    error: PredictionError | None
    success_event: PredictionSuccessEvent | None
    error_event: PredictionErrorDetectedEvent | None
    updated_expectation: PropertyExpectation | None


# Sentinel value returned when no active expectation exists for the given
# schema type + property key combination. Avoids constructing a new dataclass
# on every early-exit call.
_EMPTY_RESULT = PredictionCheckResult(
    error=None,
    success_event=None,
    error_event=None,
    updated_expectation=None,
)


# ---------------------------------------------------------------------------
# ExpectationManager
# ---------------------------------------------------------------------------


class ExpectationManager:
    """Forms, updates, and checks PropertyExpectation records.

    Each instance wraps a single ``GraphPersistence`` backend. The manager
    is stateless beyond the cached configuration -- all graph reads and
    writes go through ``self._persistence``.

    **Thread safety:** This class is not thread-safe. It is designed for use
    inside a single async task. Do not share instances across tasks without
    external locking.

    Args:
        persistence: Graph storage backend. Must satisfy ``GraphPersistence``.
    """

    def __init__(self, persistence: GraphPersistence) -> None:
        self._persistence = persistence
        # Loaded lazily on first use and cached for the lifetime of this
        # instance (D-TS-09: cache at construction time per design decision).
        self._config: _DemotionConfig | None = None

    # ------------------------------------------------------------------
    # Configuration loading
    # ------------------------------------------------------------------

    async def _load_config(self) -> _DemotionConfig:
        """Read all PREDICTION_ERROR_DEMOTION parameters from the rule node.

        Reads from the graph on first call. If the rule node is absent or
        a property is missing, each parameter falls back to its D-TS-09 /
        D4-04 default value.

        Returns:
            A :class:`_DemotionConfig` populated from the rule node properties.
        """
        node = await self._persistence.get_node(
            NodeId("evolution-rule-prediction-error-demotion")
        )
        if node is None:
            return _DemotionConfig(
                sigma_threshold=2.0,
                alpha=0.03,
                beta=0.15,
                ceiling=0.95,
                floor=0.10,
            )
        props = node.properties
        return _DemotionConfig(
            sigma_threshold=float(props.get("outlier_sigma_threshold", 2.0)),
            alpha=float(props.get("confirmation_alpha", 0.03)),
            beta=float(props.get("demotion_factor", 0.15)),
            ceiling=float(props.get("confidence_ceiling", 0.95)),
            floor=float(props.get("min_confidence_floor", 0.10)),
        )

    async def _ensure_config(self) -> _DemotionConfig:
        """Return the cached configuration, loading from the graph if needed.

        Caches the full :class:`_DemotionConfig` after the first graph read
        so subsequent calls do not incur a round-trip (D-TS-09: cache at
        construction time).

        Returns:
            The loaded and cached :class:`_DemotionConfig`.
        """
        if self._config is None:
            self._config = await self._load_config()
        return self._config

    # ------------------------------------------------------------------
    # Instance discovery
    # ------------------------------------------------------------------

    async def _get_instance_nodes_for_type(
        self, schema_type_id: NodeId
    ) -> list[KnowledgeNode]:
        """Return all INSTANCE-level nodes linked to ``schema_type_id`` via INSTANCE_OF edges.

        Uses ``query_edges`` on the persistence backend if available (duck-type
        check with ``hasattr``). If the backend does not expose ``query_edges``,
        returns an empty list -- callers treat this as zero instances and
        decline to form an expectation.

        ``query_edges`` is not part of the ``GraphPersistence`` Protocol. It is
        a convenience method on ``InMemoryGraphPersistence`` (and any future
        production backend that chooses to expose it). The Protocol does not
        require it because efficient edge traversal is backend-specific. Using
        ``hasattr`` keeps the domain layer free from a dependency on the
        concrete backend type.

        Args:
            schema_type_id: The SCHEMA-level node whose instances to retrieve.

        Returns:
            List of instance nodes. May be empty.
        """
        # query_edges is now on the GraphPersistence Protocol (T303).
        # Filter directly for INSTANCE_OF edges pointing TO schema_type_id.
        edges = await self._persistence.query_edges(
            EdgeFilter(edge_type="INSTANCE_OF", target_node_id=str(schema_type_id))
        )

        # Edge direction: instance node -[INSTANCE_OF]-> schema type node.
        instance_node_ids: list[NodeId] = [
            edge.source_id
            for edge in edges
            if edge.target_id == schema_type_id
        ]

        nodes: list[KnowledgeNode] = []
        for node_id in instance_node_ids:
            node = await self._persistence.get_node(node_id)
            if node is not None:
                nodes.append(node)

        return nodes

    async def _count_observation_sessions(self) -> int:
        """Count distinct ObservationSession nodes currently in the graph.

        Reads from the graph (A.10 compliant: not cached, not in-memory
        state). Each call is a live graph query so the count reflects the
        actual state of the graph at the moment of the call.

        Returns:
            Number of ObservationSession nodes found. May be 0.
        """
        sessions = await self._persistence.query_nodes(
            NodeFilter(node_type="ObservationSession")
        )
        return len(sessions)

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    async def form_expectations(
        self,
        schema_type_id: NodeId,
        property_key: str = "embedding",
    ) -> PropertyExpectation | None:
        """Form a PropertyExpectation for a schema type from its instance nodes.

        Scans all instance nodes linked to ``schema_type_id`` via INSTANCE_OF
        edges. Counts those that have the requested ``property_key`` in their
        ``properties`` dict. Returns ``None`` if fewer than 3 unique instances
        have the property (CANON A.5, D-TS-15: insufficient evidence).

        When 3 or more instances are available:

        1. Computes the centroid (Welford online mean) and scalar variance
           (Welford online cosine-distance variance).
        2. Checks whether an expectation for this type+key already exists via
           the persistence layer. If it does, returns the existing record
           without creating a duplicate (idempotent).
        3. Creates a new :class:`PropertyExpectation` with
           ``confidence=0.30``, ``is_active=False``, and
           ``provenance=INFERENCE``.
        4. Saves the new expectation via ``persistence.save_property_expectation``.
        5. Checks the activation threshold: if ``sample_count >= 5`` AND the
           graph contains at least 2 ``ObservationSession`` nodes, sets
           ``is_active=True`` and saves again.
        6. Returns the final expectation.

        No LLM is called at any point (CANON A.12).

        Args:
            schema_type_id: NodeId of the SCHEMA-level node to form an
                expectation for. Must correspond to a node reachable from
                instance nodes via INSTANCE_OF edges.
            property_key: The property name to track. Defaults to
                ``"embedding"``. Only instance nodes that have a list value
                at this key contribute to the centroid.

        Returns:
            A :class:`PropertyExpectation` if at least 3 unique instances
            have the property. ``None`` if fewer than 3 instances are
            available (insufficient evidence).
        """
        # ------------------------------------------------------------------
        # Step 1: Collect instance nodes that have the property.
        # ------------------------------------------------------------------
        instance_nodes = await self._get_instance_nodes_for_type(schema_type_id)

        # Deduplicate by node_id to prevent double-counting if edges are
        # somehow duplicated, then filter to those carrying the property.
        seen_ids: set[NodeId] = set()
        unique_instances: list[KnowledgeNode] = []
        for node in instance_nodes:
            if node.node_id in seen_ids:
                continue
            seen_ids.add(node.node_id)
            value = node.properties.get(property_key)
            if isinstance(value, list) and len(value) > 0:
                unique_instances.append(node)

        # ------------------------------------------------------------------
        # Step 2: Threshold check.
        # ------------------------------------------------------------------
        if len(unique_instances) < 3:
            return None

        # ------------------------------------------------------------------
        # Step 3: Check for an existing expectation (idempotency guard).
        # ------------------------------------------------------------------
        existing_list = await self._persistence.get_property_expectations(schema_type_id)
        for exp in existing_list:
            if exp.property_key == property_key:
                # Expectation already formed for this type+key. Return as-is.
                return exp

        # ------------------------------------------------------------------
        # Step 4: Compute centroid and variance over all qualifying embeddings.
        # Properties are dict[str, Any]; we already verified these are lists
        # in step 1, so the cast is safe.
        # ------------------------------------------------------------------
        embeddings: list[list[float]] = [
            node.properties[property_key]  # already validated as list[float]
            for node in unique_instances
        ]

        centroid = _build_initial_centroid(embeddings)
        variance = _build_initial_variance(embeddings, centroid)
        sample_count = len(embeddings)

        # ------------------------------------------------------------------
        # Step 5: Create initial expectation (inactive, low confidence).
        # ------------------------------------------------------------------
        exp_id = _expectation_id(schema_type_id, property_key)
        expectation = PropertyExpectation(
            expectation_id=exp_id,
            schema_type_id=schema_type_id,
            property_key=property_key,
            mean_vector=centroid,
            variance=variance,
            sample_count=sample_count,
            confirmation_count=0,
            prediction_errors=0,
            confidence=0.30,
            provenance=ProvenanceSource.INFERENCE,
            is_active=False,
        )
        await self._persistence.save_property_expectation(expectation)

        # ------------------------------------------------------------------
        # Step 6: Activation check.
        # sample_count >= 5 AND distinct session count (from graph) >= 2.
        # Session count is read from the graph every time -- not cached.
        # ------------------------------------------------------------------
        if sample_count >= 5:
            session_count = await self._count_observation_sessions()
            if session_count >= 2:
                # Produce a new (frozen) instance with is_active=True.
                expectation = PropertyExpectation(
                    expectation_id=exp_id,
                    schema_type_id=schema_type_id,
                    property_key=property_key,
                    mean_vector=centroid,
                    variance=variance,
                    sample_count=sample_count,
                    confirmation_count=0,
                    prediction_errors=0,
                    confidence=0.30,
                    provenance=ProvenanceSource.INFERENCE,
                    is_active=True,
                )
                await self._persistence.save_property_expectation(expectation)

        return expectation

    async def update_expectations(
        self,
        schema_type_id: NodeId,
        new_embedding: list[float],
        property_key: str = "embedding",
    ) -> PropertyExpectation | None:
        """Incorporate a new embedding into an existing PropertyExpectation.

        Retrieves the current expectation for ``schema_type_id`` and
        ``property_key``, checks whether the new embedding is within the
        allowed sigma range, and applies a Welford online update to the
        centroid and variance if the embedding is not an outlier.

        **Outlier rejection:** The cosine distance from ``new_embedding`` to
        the current centroid is compared against the sigma threshold read from
        the PREDICTION_ERROR_DEMOTION rule node (D-TS-09 default: 2.0). If
        the distance exceeds the threshold, the new embedding is NOT
        incorporated and the existing expectation is returned unchanged.

        **No LLM involvement (CANON A.12):** All computation is arithmetic
        from graph data.

        Args:
            schema_type_id: NodeId of the SCHEMA-level node whose expectation
                to update.
            new_embedding: The new embedding vector to incorporate. Must be
                the same length as the existing ``mean_vector``.
            property_key: The property being updated. Defaults to
                ``"embedding"``.

        Returns:
            The updated :class:`PropertyExpectation` if the embedding was
            within range and statistics were updated. The original
            :class:`PropertyExpectation` unchanged if the embedding was an
            outlier. ``None`` if no expectation exists for this type+key.
        """
        # ------------------------------------------------------------------
        # Step 1: Retrieve existing expectation.
        # ------------------------------------------------------------------
        existing_list = await self._persistence.get_property_expectations(schema_type_id)
        existing: PropertyExpectation | None = None
        for exp in existing_list:
            if exp.property_key == property_key:
                existing = exp
                break

        if existing is None:
            return None

        # ------------------------------------------------------------------
        # Step 2: Load sigma threshold and measure cosine distance.
        # ------------------------------------------------------------------
        config = await self._ensure_config()

        if len(existing.mean_vector) == 0:
            # No centroid yet -- cannot compute distance. Accept unconditionally.
            cosine_dist = 0.0
        else:
            similarity = _cosine_similarity(new_embedding, existing.mean_vector)
            cosine_dist = 1.0 - similarity

        # ------------------------------------------------------------------
        # Step 3: Outlier rejection.
        # ------------------------------------------------------------------
        if cosine_dist > config.sigma_threshold:
            # Outlier: do not update running statistics.
            return existing

        # ------------------------------------------------------------------
        # Step 4: Welford online update of centroid and variance.
        # ------------------------------------------------------------------
        old_count = existing.sample_count
        old_mean = existing.mean_vector
        new_mean = _welford_update_centroid(old_mean, new_embedding, old_count)
        new_variance = _welford_update_variance(
            existing.variance, old_mean, new_mean, new_embedding, old_count
        )
        new_count = old_count + 1

        # ------------------------------------------------------------------
        # Step 5: Persist the updated expectation and return it.
        # PropertyExpectation is frozen, so construct a new instance.
        # ------------------------------------------------------------------
        updated = PropertyExpectation(
            expectation_id=existing.expectation_id,
            schema_type_id=existing.schema_type_id,
            property_key=existing.property_key,
            mean_vector=new_mean,
            variance=new_variance,
            sample_count=new_count,
            confirmation_count=existing.confirmation_count,
            prediction_errors=existing.prediction_errors,
            confidence=existing.confidence,
            provenance=existing.provenance,
            is_active=existing.is_active,
        )
        await self._persistence.save_property_expectation(updated)

        return updated

    async def check_prediction_error(
        self,
        schema_type_id: NodeId,
        instance_node_id: NodeId,
        embedding: list[float],
        property_key: str = "embedding",
        session_id: str = "",
        correlation_id: CorrelationId = CorrelationId(""),
    ) -> PredictionCheckResult:
        """Compare an embedding against an active PropertyExpectation.

        Retrieves the current expectation for ``schema_type_id`` and
        ``property_key``. If no expectation exists or the expectation is not
        yet active (``is_active=False``), returns an empty
        :class:`PredictionCheckResult` with all fields ``None``.

        When an active expectation is found, computes the sigma distance of the
        new embedding from the centroid and classifies the observation as either
        a confirmation (within range) or a contradiction (beyond threshold).

        **Sigma distance computation:**

            cosine_distance = 1.0 - cosine_similarity(embedding, mean_vector)
            sigma_distance  = cosine_distance / sqrt(variance)  if variance > 0
                            = cosine_distance                    if variance == 0

        **Contradiction (sigma_distance > threshold):**

        - Creates a :class:`PredictionError` and :class:`PredictionErrorDetectedEvent`.
        - Increments ``prediction_errors`` on the expectation.
        - Applies the contradiction confidence formula (D4-04):
          ``new_conf = max(floor, old * (1 - beta))``
        - Saves the updated expectation.
        - Returns a result with ``error`` and ``error_event`` set.

        **Confirmation (sigma_distance <= threshold):**

        - Creates a :class:`PredictionSuccessEvent` carrying the signed sigma
          distance as ``deviation_from_mean``.
        - Increments ``confirmation_count`` on the expectation.
        - Applies the confirmation confidence formula (D4-04):
          ``new_conf = min(ceiling, old + alpha * (ceiling - old))``
        - Saves the updated expectation.
        - Returns a result with ``success_event`` set.

        No LLM is called at any point (CANON A.12).

        Args:
            schema_type_id: NodeId of the SCHEMA-level node whose expectation
                to check against.
            instance_node_id: NodeId of the INSTANCE-level node being
                observed. Recorded on the :class:`PredictionError` or
                :class:`PredictionSuccessEvent` for traceability.
            embedding: The new embedding vector to check. Must be the same
                length as ``expectation.mean_vector``.
            property_key: The property name being checked. Defaults to
                ``"embedding"``.
            session_id: The observation session during which this check is
                occurring. Recorded on emitted events. Defaults to empty string
                if the caller does not have a session context.
            correlation_id: Traces this check to the originating observation.
                Recorded on all emitted events and error records. Defaults to
                an empty CorrelationId if not provided.

        Returns:
            A :class:`PredictionCheckResult`. All fields are ``None`` if no
            active expectation exists. Otherwise exactly one of ``error``
            (with ``error_event``) or ``success_event`` is set, along with
            ``updated_expectation``.
        """
        # ------------------------------------------------------------------
        # Step 1: Retrieve existing expectation.
        # ------------------------------------------------------------------
        existing_list = await self._persistence.get_property_expectations(schema_type_id)
        existing: PropertyExpectation | None = None
        for exp in existing_list:
            if exp.property_key == property_key:
                existing = exp
                break

        if existing is None:
            return _EMPTY_RESULT

        # ------------------------------------------------------------------
        # Step 2: Guard -- expectation must be active to be used for
        # prediction. Inactive expectations are still being formed.
        # ------------------------------------------------------------------
        if not existing.is_active:
            return _EMPTY_RESULT

        # ------------------------------------------------------------------
        # Step 3: Load configuration (cached after first call).
        # ------------------------------------------------------------------
        config = await self._ensure_config()

        # ------------------------------------------------------------------
        # Step 4: Compute cosine distance and sigma distance.
        # ------------------------------------------------------------------
        if len(existing.mean_vector) == 0:
            cosine_distance = 0.0
        else:
            cosine_distance = 1.0 - _cosine_similarity(embedding, existing.mean_vector)

        # Sigma distance: normalise by the standard deviation (sqrt of variance).
        # If variance is zero (all past observations were identical), sigma
        # distance equals cosine distance -- the embedding is either a perfect
        # match (0.0) or an outlier (> 0.0).
        if existing.variance > 0.0:
            sigma_distance = cosine_distance / math.sqrt(existing.variance)
        else:
            sigma_distance = cosine_distance

        # ------------------------------------------------------------------
        # Step 5: Classify and apply the appropriate confidence update.
        # ------------------------------------------------------------------
        exp_id = existing.expectation_id

        if sigma_distance > config.sigma_threshold:
            # ----------------------------------------------------------------
            # CONTRADICTION path: new embedding is an outlier.
            # ----------------------------------------------------------------
            prediction_error = PredictionError(
                instance_node_id=instance_node_id,
                schema_type_id=schema_type_id,
                expectation_id=exp_id,
                property_key=property_key,
                observed_sigma_distance=sigma_distance,
                expected_sigma_range=config.sigma_threshold,
                correlation_id=correlation_id,
            )

            error_event = PredictionErrorDetectedEvent(
                prediction_error=prediction_error,
                session_id=session_id,
                correlation_id=correlation_id,
            )

            # Asymmetric contradiction formula (D4-04):
            # new_conf = max(floor, old * (1 - beta))
            new_confidence = max(
                config.floor,
                existing.confidence * (1.0 - config.beta),
            )

            updated = PropertyExpectation(
                expectation_id=exp_id,
                schema_type_id=existing.schema_type_id,
                property_key=existing.property_key,
                mean_vector=existing.mean_vector,
                variance=existing.variance,
                sample_count=existing.sample_count,
                confirmation_count=existing.confirmation_count,
                prediction_errors=existing.prediction_errors + 1,
                confidence=new_confidence,
                provenance=existing.provenance,
                is_active=existing.is_active,
            )
            await self._persistence.save_property_expectation(updated)

            return PredictionCheckResult(
                error=prediction_error,
                success_event=None,
                error_event=error_event,
                updated_expectation=updated,
            )

        else:
            # ----------------------------------------------------------------
            # CONFIRMATION path: new embedding is within the expected range.
            # ----------------------------------------------------------------
            new_confirmation_count = existing.confirmation_count + 1

            success_event = PredictionSuccessEvent(
                instance_node_id=instance_node_id,
                schema_type_id=schema_type_id,
                expectation_id=exp_id,
                property_key=property_key,
                # sigma_distance is the unsigned distance from the centroid in
                # sigma units. It is always >= 0 for a confirming observation.
                # We record it here as a positive value representing "how far
                # from the mean" without a directional sign -- cosine space
                # has no natural above/below axis.
                deviation_from_mean=sigma_distance,
                confirmation_count=new_confirmation_count,
                session_id=session_id,
                correlation_id=correlation_id,
            )

            # Asymmetric confirmation formula (D4-04):
            # new_conf = min(ceiling, old + alpha * (ceiling - old))
            new_confidence = min(
                config.ceiling,
                existing.confidence + config.alpha * (config.ceiling - existing.confidence),
            )

            updated = PropertyExpectation(
                expectation_id=exp_id,
                schema_type_id=existing.schema_type_id,
                property_key=existing.property_key,
                mean_vector=existing.mean_vector,
                variance=existing.variance,
                sample_count=existing.sample_count,
                confirmation_count=new_confirmation_count,
                prediction_errors=existing.prediction_errors,
                confidence=new_confidence,
                provenance=existing.provenance,
                is_active=existing.is_active,
            )
            await self._persistence.save_property_expectation(updated)

            return PredictionCheckResult(
                error=None,
                success_event=success_event,
                error_event=None,
                updated_expectation=updated,
            )


__all__ = [
    "ExpectationManager",
    "PredictionCheckResult",
]
