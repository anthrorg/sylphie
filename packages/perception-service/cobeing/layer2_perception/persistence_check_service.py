"""CANON A.5 persistence-check service: Layer 2 -> Layer 3 boundary enforcement.

This module contains the single concrete implementation of the
:class:`~cobeing.layer2_perception.protocols.PersistenceCheck` protocol.
``PersistenceCheckService`` is the *only* place in Layer 2 that communicates
with Layer 3 about object identity.

**CANON A.5 enforcement contract:**

    The narrow read interface from Layer 2 to Layer 3 is the call to
    ``find_nodes_by_embedding()``. That is the boundary. Nothing else.

This service calls **exactly one** method on ``GraphPersistence``:
``find_nodes_by_embedding()``. It does not call ``get_node``,
``query_nodes``, ``save_node``, or any other method. If a future developer
needs to call additional graph methods from the perception layer, they must
first update the CANON and add a new, separately reviewed boundary.

**Multi-modal scoring (Piaget R1 -- dynamic weights):**

The match score combines five signals:

1. Embedding cosine similarity (visual identity).
2. Spatial IoU (location in the frame).
3. Color histogram similarity (dominant color overlap).
4. Size ratio (bounding-box proportionality).
5. Label raw match (soft bonus -- not a hard filter, per Piaget R3).

Weights shift dynamically based on how many times the candidate node has
been confirmed. New objects (few confirmations) rely heavily on spatial
position because that is the most reliable short-range signal. Well-known
objects (many confirmations) rely on the embedding because the model has
had enough evidence to make it trustworthy.

**Surprise detection (Piaget R2):**

A ``surprise_flag`` is set when a well-known object (confirmation_count >= 5)
produces an embedding distance greater than the configured
``surprise_threshold``. "I expected one thing here and found something
significantly different" is the novelty signal.

**POSSIBLE_DUPLICATE_OF edges:**

This service does NOT create POSSIBLE_DUPLICATE_OF edges. Per decision
D-TS-01, that is Layer 3's responsibility. The service reports
``ambiguous_candidates`` (node IDs that scored above the ambiguity threshold
but below the match threshold); what Layer 3 does with those is its concern.

Usage::

    from cobeing.layer2_perception.persistence_check_service import (
        PersistenceCheckService,
        compute_match_score,
    )
    from cobeing.layer2_perception.config import PersistenceCheckConfig
    from cobeing.layer3_knowledge.protocols import GraphPersistence

    service = PersistenceCheckService(
        persistence=my_graph_persistence,
        config=PersistenceCheckConfig(),
    )

    result = await service.find_match(observation)
    if result is not None and result.matched_node_id is not None:
        # Known object re-identified.
        ...
"""

from __future__ import annotations

import math
from typing import Any

from cobeing.layer2_perception.config import PersistenceCheckConfig
from cobeing.layer2_perception.types import PersistenceResult
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.shared.observation import BoundingBox, Observation


# ---------------------------------------------------------------------------
# Weight profiles
# ---------------------------------------------------------------------------

_NEW_WEIGHTS: dict[str, float] = {
    "spatial": 0.50,
    "embedding": 0.25,
    "color": 0.15,
    "size": 0.05,
    "label_raw": 0.05,
}

_KNOWN_WEIGHTS: dict[str, float] = {
    "embedding": 0.45,
    "color": 0.25,
    "spatial": 0.15,
    "size": 0.10,
    "label_raw": 0.05,
}

# Confirmation count thresholds that define the weight profile transition.
_NEW_THRESHOLD: int = 5
_KNOWN_THRESHOLD: int = 10


# ---------------------------------------------------------------------------
# Weight interpolation
# ---------------------------------------------------------------------------


def _interpolate_weights(confirmation_count: int) -> dict[str, float]:
    """Return dynamic scoring weights based on how well-known an object is.

    Weight profiles:

    - New objects (``confirmation_count < 5``): spatial-dominant.
      Spatial position is the most reliable signal for an object we have
      barely seen -- we know where it is but not much else.
    - Well-known objects (``confirmation_count >= 10``): embedding-dominant.
      The embedding has been confirmed many times; it is the highest-fidelity
      signal for re-identification.
    - In-between (``5 <= confirmation_count < 10``): linear interpolation
      between the two profiles.

    The returned weights always sum to exactly 1.0.

    Args:
        confirmation_count: The ``confirmation_count`` from the candidate
            ``KnowledgeNode``. Must be >= 0.

    Returns:
        A dict mapping the five signal names (``"spatial"``, ``"embedding"``,
        ``"color"``, ``"size"``, ``"label_raw"``) to their weights. Weights
        are non-negative and sum to 1.0.

    Example::

        weights = _interpolate_weights(0)
        assert weights["spatial"] == 0.50  # spatial-dominant for new object

        weights = _interpolate_weights(10)
        assert weights["embedding"] == 0.45  # embedding-dominant for known object
    """
    if confirmation_count < _NEW_THRESHOLD:
        return _NEW_WEIGHTS.copy()
    if confirmation_count >= _KNOWN_THRESHOLD:
        return _KNOWN_WEIGHTS.copy()

    # Linear interpolation: t=0.0 at count=5, t=1.0 at count=10.
    t = (confirmation_count - _NEW_THRESHOLD) / float(_KNOWN_THRESHOLD - _NEW_THRESHOLD)
    return {
        k: _NEW_WEIGHTS[k] * (1.0 - t) + _KNOWN_WEIGHTS[k] * t
        for k in _NEW_WEIGHTS
    }


# ---------------------------------------------------------------------------
# Individual scorers (pure functions)
# ---------------------------------------------------------------------------


def _score_embedding(
    obs_embedding: list[float] | None,
    node_embedding: list[float] | None,
) -> float:
    """Cosine similarity between two embedding vectors.

    Cosine similarity measures the angle between two vectors, ignoring
    magnitude. A value of 1.0 means the vectors are identical in direction
    (identical visual identity); 0.0 means orthogonal (unrelated).

    Returns 0.0 if either embedding is absent (None or empty), or if the
    vectors are zero-magnitude (preventing division by zero).

    Args:
        obs_embedding: Embedding vector from the current Observation.
            None means embedding was not extracted.
        node_embedding: Embedding vector stored on the candidate node.
            None means the node has no embedding.

    Returns:
        Cosine similarity in [0.0, 1.0]. 0.0 if either embedding is missing.
    """
    if not obs_embedding or not node_embedding:
        return 0.0
    if len(obs_embedding) != len(node_embedding):
        return 0.0

    dot = sum(a * b for a, b in zip(obs_embedding, node_embedding))
    mag_obs = math.sqrt(sum(a * a for a in obs_embedding))
    mag_node = math.sqrt(sum(b * b for b in node_embedding))

    if mag_obs == 0.0 or mag_node == 0.0:
        return 0.0

    # Clamp to [0.0, 1.0] to handle floating-point overshoot near 1.0.
    return max(0.0, min(1.0, dot / (mag_obs * mag_node)))


def _score_spatial(
    obs_bbox: BoundingBox | None,
    node_bbox: dict[str, float] | None,
) -> float:
    """Intersection-over-Union (IoU) between observation and node bounding boxes.

    IoU = area_of_intersection / area_of_union. A value of 1.0 means the
    boxes are identical; 0.0 means no overlap (or a box is missing).

    The node bounding box is read from a dict with keys ``x_min``, ``y_min``,
    ``x_max``, ``y_max`` because it comes from ``KnowledgeNode.properties``.

    Args:
        obs_bbox: Bounding box from the current Observation.
            None means spatial data is not available.
        node_bbox: Dict of bounding-box coordinates from
            ``KnowledgeNode.properties["bounding_box"]``.
            None means the node has no stored bounding box.

    Returns:
        IoU in [0.0, 1.0]. 0.0 if either box is missing or boxes do not overlap.
    """
    if obs_bbox is None or not node_bbox:
        return 0.0

    try:
        nx_min = float(node_bbox["x_min"])
        ny_min = float(node_bbox["y_min"])
        nx_max = float(node_bbox["x_max"])
        ny_max = float(node_bbox["y_max"])
    except (KeyError, TypeError, ValueError):
        return 0.0

    # Intersection rectangle.
    inter_x_min = max(obs_bbox.x_min, nx_min)
    inter_y_min = max(obs_bbox.y_min, ny_min)
    inter_x_max = min(obs_bbox.x_max, nx_max)
    inter_y_max = min(obs_bbox.y_max, ny_max)

    inter_w = inter_x_max - inter_x_min
    inter_h = inter_y_max - inter_y_min

    if inter_w <= 0.0 or inter_h <= 0.0:
        return 0.0

    inter_area = inter_w * inter_h
    obs_area = obs_bbox.width * obs_bbox.height
    node_w = nx_max - nx_min
    node_h = ny_max - ny_min
    node_area = node_w * node_h

    union_area = obs_area + node_area - inter_area
    if union_area <= 0.0:
        return 0.0

    return max(0.0, min(1.0, inter_area / union_area))


def _score_color(
    obs_colors: list[tuple[int, int, int]] | None,
    node_colors: list[Any] | None,
) -> float:
    """Color histogram similarity using bin-overlap counting.

    Each (R, G, B) tuple is quantized into a coarse bin by dividing each
    channel by 64 (giving 4^3 = 64 possible bins). The score is the
    Jaccard index (shared bins / total bins) between the observation and
    the node.

    This is a fast approximation of histogram intersection that does not
    require sorting or distance metrics.

    Returns 0.0 if either color list is absent or empty.

    Args:
        obs_colors: List of dominant RGB color tuples from the observation.
            Each tuple is (R, G, B) with values in [0, 255].
        node_colors: List of dominant RGB color tuples from the node's
            ``properties["dominant_colors"]``. May be a list of lists or
            tuples; each inner item should have 3 integer-like elements.

    Returns:
        Color similarity in [0.0, 1.0]. 0.0 if either list is missing.
    """
    if not obs_colors or not node_colors:
        return 0.0

    def _to_bin(color: Any) -> tuple[int, int, int]:
        """Quantize an RGB-like value to a coarse 4x4x4 bin."""
        try:
            r, g, b = int(color[0]), int(color[1]), int(color[2])
            return (r // 64, g // 64, b // 64)
        except (IndexError, TypeError, ValueError):
            return (-1, -1, -1)

    obs_bins = {_to_bin(c) for c in obs_colors}
    node_bins = {_to_bin(c) for c in node_colors}

    # Remove sentinel bins from failed conversions.
    obs_bins.discard((-1, -1, -1))
    node_bins.discard((-1, -1, -1))

    if not obs_bins or not node_bins:
        return 0.0

    shared = len(obs_bins & node_bins)
    total = len(obs_bins | node_bins)

    return shared / total if total > 0 else 0.0


def _score_size(
    obs_bbox: BoundingBox | None,
    node_bbox: dict[str, float] | None,
) -> float:
    """Ratio of the smaller bounding-box area to the larger (scale similarity).

    A value of 1.0 means the two boxes are the same size. A value approaching
    0.0 means one box is much larger than the other. This catches cases where
    an embedding match is spurious because the object appears at very different
    scales (likely a false positive).

    Args:
        obs_bbox: Bounding box from the current Observation.
        node_bbox: Dict of bounding-box coordinates from
            ``KnowledgeNode.properties["bounding_box"]``.

    Returns:
        Size similarity in [0.0, 1.0]. 0.0 if either box is missing or has zero area.
    """
    if obs_bbox is None or not node_bbox:
        return 0.0

    try:
        nx_min = float(node_bbox["x_min"])
        ny_min = float(node_bbox["y_min"])
        nx_max = float(node_bbox["x_max"])
        ny_max = float(node_bbox["y_max"])
    except (KeyError, TypeError, ValueError):
        return 0.0

    obs_area = obs_bbox.width * obs_bbox.height
    node_w = nx_max - nx_min
    node_h = ny_max - ny_min
    node_area = node_w * node_h

    if obs_area <= 0.0 or node_area <= 0.0:
        return 0.0

    return min(obs_area, node_area) / max(obs_area, node_area)


def _score_label_raw(
    obs_label: str | None,
    node_label: str | None,
) -> float:
    """Soft label-match bonus: 1.0 if labels match exactly, 0.0 otherwise.

    This is intentionally a *soft bonus*, not a hard filter (Piaget R3).
    A label mismatch does not disqualify a candidate -- the system may
    have mis-detected the label. The other signals (embedding, spatial,
    color, size) carry the identity decision; this adds a small boost
    when the label also agrees.

    Args:
        obs_label: Raw label from the current Observation (e.g., ``"cup"``).
        node_label: Raw label stored on the node's properties
            (``properties["label_raw"]``). None if absent.

    Returns:
        1.0 if both labels are non-empty strings and match exactly
        (case-sensitive), 0.0 otherwise.
    """
    if not obs_label or not node_label:
        return 0.0
    return 1.0 if obs_label == node_label else 0.0


# ---------------------------------------------------------------------------
# Multi-modal scoring
# ---------------------------------------------------------------------------


def compute_match_score(
    observation: Observation,
    candidate_node_properties: dict[str, Any],
    confirmation_count: int,
) -> float:
    """Compute a weighted multi-modal match score for a candidate node.

    Combines five independent scoring signals with dynamic weights that
    shift based on how many times the candidate node has been confirmed
    (Piaget R1). The final score is a weighted sum in [0.0, 1.0].

    Weight profiles:

    - New objects (``confirmation_count < 5``):
      ``spatial=0.50, embedding=0.25, color=0.15, size=0.05, label_raw=0.05``
    - Well-known objects (``confirmation_count >= 10``):
      ``embedding=0.45, color=0.25, spatial=0.15, size=0.10, label_raw=0.05``
    - Between 5 and 10: linear interpolation.

    Args:
        observation: The current structured observation from the perception
            pipeline. Contains the bounding box, embedding, colors, and label.
        candidate_node_properties: The ``properties`` dict from a
            ``KnowledgeNode`` returned by ``find_nodes_by_embedding()``.
            Expected keys: ``"embedding"``, ``"bounding_box"``,
            ``"dominant_colors"``, ``"label_raw"``.
        confirmation_count: The ``confirmation_count`` from the candidate
            ``KnowledgeNode``. Controls which weight profile is applied.

    Returns:
        A weighted match score in [0.0, 1.0]. Higher values indicate
        a closer match. Does not cross any threshold internally --
        thresholding is done by the caller.
    """
    weights = _interpolate_weights(confirmation_count)

    node_embedding: list[float] | None = candidate_node_properties.get("embedding")
    node_bbox: dict[str, float] | None = candidate_node_properties.get("bounding_box")
    node_colors: list[Any] | None = candidate_node_properties.get("dominant_colors")
    node_label: str | None = candidate_node_properties.get("label_raw")

    scores: dict[str, float] = {
        "embedding": _score_embedding(observation.embedding, node_embedding),
        "spatial": _score_spatial(observation.bounding_box, node_bbox),
        "color": _score_color(observation.dominant_colors, node_colors),
        "size": _score_size(observation.bounding_box, node_bbox),
        "label_raw": _score_label_raw(observation.label_raw, node_label),
    }

    return sum(weights[k] * scores[k] for k in weights)


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class PersistenceCheckService:
    """CANON A.5 boundary enforcement: narrow Layer 2 -> Layer 3 read interface.

    This service implements the :class:`~cobeing.layer2_perception.protocols.PersistenceCheck`
    protocol. It is the sole point where Layer 2 communicates with Layer 3
    for object identity resolution.

    **Boundary contract:** This service calls ONLY ``find_nodes_by_embedding()``
    on the injected ``GraphPersistence``. It does not call ``get_node``,
    ``query_nodes``, ``save_node``, or any other method. This IS the A.5
    boundary -- no other Layer 3 method may be added here without a CANON
    amendment.

    **POSSIBLE_DUPLICATE_OF edges:** This service does NOT create these edges
    (D-TS-01). When multiple candidates score above the ambiguity threshold,
    this service reports them in ``ambiguous_candidates`` and lets Layer 3
    decide what to do.

    Attributes:
        _persistence: The injected ``GraphPersistence`` backend. Only
            ``find_nodes_by_embedding()`` is ever called on it.
        _config: Threshold configuration controlling match, ambiguity, and
            surprise decisions.

    Args:
        persistence: Any object satisfying the ``GraphPersistence`` protocol.
            Only ``find_nodes_by_embedding()`` will be called.
        config: Thresholds and parameters for the persistence check.

    Example::

        from cobeing.layer2_perception.persistence_check_service import (
            PersistenceCheckService,
        )
        from cobeing.layer2_perception.config import PersistenceCheckConfig
        from my_app.graph import InMemoryGraphPersistence

        service = PersistenceCheckService(
            persistence=InMemoryGraphPersistence(),
            config=PersistenceCheckConfig(),
        )

        result = await service.find_match(observation)
        if result is not None and result.matched_node_id is not None:
            # Known object: enrich observation with graph identity.
            ...
        elif result is not None and result.ambiguous_candidates:
            # Ambiguous: multiple candidates, Layer 3 must clarify.
            ...
        else:
            # Novel object: no match found, create a new node.
            ...
    """

    def __init__(
        self,
        persistence: GraphPersistence,
        config: PersistenceCheckConfig,
    ) -> None:
        self._persistence = persistence
        self._config = config

    async def find_match(
        self,
        observation: Observation,
    ) -> PersistenceResult | None:
        """Find a matching knowledge graph node for a perception observation.

        Queries Layer 3 for candidate nodes via ``find_nodes_by_embedding()``,
        scores each candidate using multi-modal dynamic weights (Piaget R1),
        and classifies the result as:

        - **Confirmed match** (score >= ``match_threshold``): returns a
          ``PersistenceResult`` with ``matched_node_id`` set.
        - **Ambiguous** (``ambiguity_threshold`` <= score < ``match_threshold``):
          returns a ``PersistenceResult`` with ``ambiguous_candidates`` populated
          and ``matched_node_id = None``.
        - **New object** (best score < ``ambiguity_threshold``): returns a
          ``PersistenceResult`` with ``matched_node_id = None`` and empty
          ``ambiguous_candidates``.

        The ``surprise_flag`` is set when a well-known object
        (``confirmation_count >= 5``) produces an embedding distance above
        ``surprise_threshold`` (Piaget R2 novelty signal).

        If the observation has no embedding, ``find_nodes_by_embedding()``
        cannot be called. In that case the service returns ``None`` to signal
        that the check could not be performed, which the caller treats the same
        as a cache miss (novel object).

        Args:
            observation: Structured observation from the perception pipeline.
                Requires ``observation.embedding`` to be non-None for a
                meaningful persistence check.

        Returns:
            A :class:`~cobeing.layer2_perception.types.PersistenceResult`
            describing the match outcome, or ``None`` if the check could not
            be performed (no embedding available).

        Raises:
            PersistenceCheckError: If ``find_nodes_by_embedding()`` raises
                an unhandled exception from the storage backend.
        """
        if not observation.embedding:
            # Without an embedding we cannot query the graph. Return None to
            # signal "check not performed" -- caller treats this as novel.
            return None

        # CANON A.5 boundary: the ONLY call to the persistence backend.
        candidates = await self._persistence.find_nodes_by_embedding(
            embedding=observation.embedding,
            min_similarity=self._config.similarity_threshold,
        )

        if not candidates:
            return PersistenceResult(
                matched_node_id=None,
                confidence=0.0,
                match_type="none",
                surprise_flag=False,
                ambiguous_candidates=[],
            )

        # Score all candidates with multi-modal weights.
        # tuple: (node_id, score, confirmation_count, node_embedding)
        scored: list[tuple[str, float, int, list[float] | None]] = []
        for node, _embedding_similarity in candidates:
            score = compute_match_score(
                observation=observation,
                candidate_node_properties=node.properties,
                confirmation_count=node.confirmation_count,
            )
            node_emb: list[float] | None = node.properties.get("embedding")
            scored.append((str(node.node_id), score, node.confirmation_count, node_emb))

        # Sort descending by score so the best match is first.
        scored.sort(key=lambda t: t[1], reverse=True)

        best_node_id, best_score, best_confirmation_count, best_node_emb = scored[0]

        # Collect ambiguous candidates: scored above ambiguity_threshold
        # but below match_threshold (from positions 1+ in the sorted list).
        ambiguous: list[str] = [
            nid
            for nid, score, _, _emb in scored[1:]
            if score >= self._config.ambiguity_threshold
        ]

        # Surprise detection (Piaget R2): a well-known object produced
        # an unexpected embedding -- something changed or is different here.
        surprise_flag = False
        if best_confirmation_count >= 5:
            embedding_similarity = _score_embedding(
                observation.embedding, best_node_emb
            )
            embedding_distance = 1.0 - embedding_similarity
            if embedding_distance > self._config.surprise_threshold:
                surprise_flag = True

        # Classify result.
        if best_score >= self._config.match_threshold:
            return PersistenceResult(
                matched_node_id=best_node_id,
                confidence=best_score,
                match_type="embedding",
                surprise_flag=surprise_flag,
                ambiguous_candidates=ambiguous,
            )

        if best_score >= self._config.ambiguity_threshold:
            # Best candidate is ambiguous -- include it in ambiguous_candidates
            # along with any other above-threshold candidates.
            all_ambiguous = [best_node_id] + ambiguous
            return PersistenceResult(
                matched_node_id=None,
                confidence=best_score,
                match_type="none",
                surprise_flag=surprise_flag,
                ambiguous_candidates=all_ambiguous,
            )

        return PersistenceResult(
            matched_node_id=None,
            confidence=best_score,
            match_type="none",
            surprise_flag=False,
            ambiguous_candidates=[],
        )


__all__ = [
    "PersistenceCheckService",
    "compute_match_score",
]
