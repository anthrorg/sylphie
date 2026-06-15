"""Unit tests for the CANON A.5 persistence-check multi-modal scorer.

Covers the pure scoring functions, the dynamic weight-interpolation profile,
the ``compute_match_score`` weighted sum, the ``PersistenceCheckService``
classification (known / ambiguous / new), and the Piaget R2 ``surprise_flag``.

These tests are pure Python: no model weights, no camera, no network. Every
"golden" number below was produced by running the real code in this module
(not hand-fabricated). The scorer is deterministic, so the values are stable.

The OPEN-9 cross-session renormalization case is documented at the bottom:
at commit fefdc4d ``compute_match_score`` does NOT renormalize the remaining
weights when the spatial signal is absent, so a strong embedding/color/label
match on a node with no stored bounding box is *capped* at 0.75 rather than
renormalized to ~0.88. That gap is asserted explicitly (the renorm target is
captured as an xfail so the missing mechanism stays loud).

Run with::

    cd packages/perception-service
    .venv/Scripts/python.exe -m pytest tests/test_persistence_scorer.py -q
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from cobeing.layer2_perception.config import PersistenceCheckConfig
from cobeing.layer2_perception.persistence_check_service import (
    PersistenceCheckService,
    _KNOWN_WEIGHTS,
    _NEW_WEIGHTS,
    _interpolate_weights,
    _score_color,
    _score_embedding,
    _score_label_raw,
    _score_size,
    _score_spatial,
    compute_match_score,
)
from cobeing.layer3_knowledge.node_types import KnowledgeNode, SchemaLevel
from cobeing.shared.observation import BoundingBox, Observation
from cobeing.shared.provenance import Provenance, ProvenanceSource

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_PROVENANCE = Provenance(
    source=ProvenanceSource.SENSOR,
    source_id="test-frame-001",
    confidence=0.90,
)

# A fixed embedding used as both the observation embedding and the "perfect"
# node embedding so cosine similarity is exactly 1.0 for an identity match.
_EMB: list[float] = [1.0, 2.0, 3.0, 4.0]

# Bounding box reused across observation/node so spatial IoU == 1.0.
_NODE_BBOX: dict[str, float] = {
    "x_min": 100.0,
    "y_min": 100.0,
    "x_max": 300.0,
    "y_max": 400.0,
}


def _make_bbox(
    *,
    x_min: float = 100.0,
    y_min: float = 100.0,
    x_max: float = 300.0,
    y_max: float = 400.0,
    frame_width: int = 1280,
    frame_height: int = 720,
) -> BoundingBox:
    return BoundingBox(
        x_min=x_min,
        y_min=y_min,
        x_max=x_max,
        y_max=y_max,
        frame_width=frame_width,
        frame_height=frame_height,
    )


def _make_obs(
    *,
    embedding: list[float] | None = None,
    dominant_colors: list[tuple[int, int, int]] | None = None,
    label: str = "cup",
    bbox: BoundingBox | None = None,
) -> Observation:
    """Build a minimal Observation for scoring tests."""
    return Observation(
        observation_id="obs-test-001",
        session_id="session-test-001",
        label_raw=label,
        confidence=0.90,
        bounding_box=bbox if bbox is not None else _make_bbox(),
        embedding=embedding if embedding is not None else list(_EMB),
        dominant_colors=dominant_colors
        if dominant_colors is not None
        else [(200, 50, 50)],
        provenance=_PROVENANCE,
    )


def _make_node(
    node_id: str,
    properties: dict[str, Any],
    confirmation_count: int,
) -> KnowledgeNode:
    """Build a candidate KnowledgeNode the service can score."""
    return KnowledgeNode(
        node_id=node_id,
        node_type="ObjectInstance",
        schema_level=SchemaLevel.INSTANCE,
        properties=properties,
        provenance=_PROVENANCE,
        confidence=0.50,
        confirmation_count=confirmation_count,
    )


class _FakeGraph:
    """Minimal GraphPersistence stub returning a fixed candidate list.

    Only ``find_nodes_by_embedding`` is exercised -- that is the entire CANON
    A.5 boundary the service is allowed to touch.
    """

    def __init__(self, candidates: list[tuple[KnowledgeNode, float]]) -> None:
        self._candidates = candidates

    async def find_nodes_by_embedding(
        self,
        embedding: list[float],
        embedding_key: str = "embedding",
        min_similarity: float = 0.7,
        limit: int = 10,
        schema_level: Any = None,
    ) -> list[tuple[KnowledgeNode, float]]:
        return list(self._candidates)


def _run(coro: Any) -> Any:
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# _score_embedding
# ---------------------------------------------------------------------------


class TestScoreEmbedding:
    def test_identical_vectors_score_one(self) -> None:
        assert _score_embedding([1.0, 2.0, 3.0], [1.0, 2.0, 3.0]) == 1.0

    def test_orthogonal_vectors_score_zero(self) -> None:
        assert _score_embedding([1.0, 0.0], [0.0, 1.0]) == 0.0

    def test_mismatched_length_scores_zero(self) -> None:
        assert _score_embedding([1.0, 2.0], [1.0, 2.0, 3.0]) == 0.0

    def test_none_embedding_scores_zero(self) -> None:
        assert _score_embedding(None, [1.0, 2.0]) == 0.0
        assert _score_embedding([1.0, 2.0], None) == 0.0

    def test_empty_embedding_scores_zero(self) -> None:
        assert _score_embedding([], [1.0, 2.0]) == 0.0

    def test_zero_magnitude_scores_zero(self) -> None:
        assert _score_embedding([0.0, 0.0], [1.0, 1.0]) == 0.0


# ---------------------------------------------------------------------------
# The other four pure scorers -- one clear case each
# ---------------------------------------------------------------------------


class TestOtherScorers:
    def test_spatial_identical_box_is_full_iou(self) -> None:
        bbox = _make_bbox(x_min=0, y_min=0, x_max=100, y_max=100,
                          frame_width=200, frame_height=200)
        same = {"x_min": 0.0, "y_min": 0.0, "x_max": 100.0, "y_max": 100.0}
        assert _score_spatial(bbox, same) == 1.0

    def test_spatial_disjoint_box_is_zero(self) -> None:
        bbox = _make_bbox(x_min=0, y_min=0, x_max=100, y_max=100,
                          frame_width=800, frame_height=800)
        disjoint = {"x_min": 500.0, "y_min": 500.0, "x_max": 600.0, "y_max": 600.0}
        assert _score_spatial(bbox, disjoint) == 0.0

    def test_spatial_missing_box_is_zero(self) -> None:
        assert _score_spatial(None, _NODE_BBOX) == 0.0
        assert _score_spatial(_make_bbox(), None) == 0.0

    def test_color_shared_bin_scores_one(self) -> None:
        # (200,50,50) and (210,40,40) both quantize to bin (3,0,0).
        assert _score_color([(200, 50, 50)], [(210, 40, 40)]) == 1.0

    def test_color_disjoint_bins_score_zero(self) -> None:
        assert _score_color([(200, 50, 50)], [(10, 200, 10)]) == 0.0

    def test_color_missing_list_is_zero(self) -> None:
        assert _score_color(None, [(1, 1, 1)]) == 0.0

    def test_size_identical_area_is_one(self) -> None:
        bbox = _make_bbox(x_min=0, y_min=0, x_max=100, y_max=100,
                          frame_width=200, frame_height=200)
        same = {"x_min": 0.0, "y_min": 0.0, "x_max": 100.0, "y_max": 100.0}
        assert _score_size(bbox, same) == 1.0

    def test_size_quarter_area_is_point_two_five(self) -> None:
        bbox = _make_bbox(x_min=0, y_min=0, x_max=100, y_max=100,
                          frame_width=200, frame_height=200)
        quarter = {"x_min": 0.0, "y_min": 0.0, "x_max": 50.0, "y_max": 50.0}
        assert _score_size(bbox, quarter) == 0.25

    def test_label_exact_match_is_one(self) -> None:
        assert _score_label_raw("cup", "cup") == 1.0

    def test_label_mismatch_is_zero(self) -> None:
        assert _score_label_raw("cup", "dog") == 0.0

    def test_label_missing_is_zero(self) -> None:
        assert _score_label_raw(None, "cup") == 0.0
        assert _score_label_raw("cup", "") == 0.0


# ---------------------------------------------------------------------------
# Weight interpolation
# ---------------------------------------------------------------------------


class TestWeightInterpolation:
    def test_new_object_is_spatial_dominant(self) -> None:
        weights = _interpolate_weights(0)
        assert weights["spatial"] == 0.50
        assert weights == _NEW_WEIGHTS

    def test_well_known_object_is_embedding_dominant(self) -> None:
        weights = _interpolate_weights(10)
        assert weights["embedding"] == 0.45
        assert weights == _KNOWN_WEIGHTS

    def test_above_known_threshold_stays_known(self) -> None:
        assert _interpolate_weights(50)["embedding"] == 0.45

    def test_midpoint_weights_sum_to_one(self) -> None:
        weights = _interpolate_weights(7)
        assert weights == pytest.approx({
            "spatial": 0.36,
            "embedding": 0.33,
            "color": 0.19,
            "size": 0.07,
            "label_raw": 0.05,
        })
        assert sum(weights.values()) == pytest.approx(1.0)

    def test_all_profiles_sum_to_one(self) -> None:
        for count in (0, 4, 5, 6, 7, 9, 10, 20):
            assert sum(_interpolate_weights(count).values()) == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# compute_match_score
# ---------------------------------------------------------------------------


class TestComputeMatchScore:
    def test_perfect_known_match_scores_one(self) -> None:
        obs = _make_obs()
        props = {
            "embedding": list(_EMB),
            "bounding_box": dict(_NODE_BBOX),
            "dominant_colors": [(200, 50, 50)],
            "label_raw": "cup",
        }
        # All five signals == 1.0, weights sum to 1.0 -> total 1.0.
        assert compute_match_score(obs, props, confirmation_count=10) == pytest.approx(1.0)

    def test_new_object_weak_match_scores_low(self) -> None:
        # Orthogonal-ish embedding, no bbox, disjoint color, label mismatch.
        # Only the embedding contributes: cos([1,2,3,4],[0,0,0,1]) = 4/sqrt(30)
        # = 0.7303; at count=0 embedding weight is 0.25 -> ~0.1826.
        obs = _make_obs()
        props = {
            "embedding": [0.0, 0.0, 0.0, 1.0],
            "dominant_colors": [(10, 250, 10)],
            "label_raw": "dog",
        }
        assert compute_match_score(obs, props, confirmation_count=0) == pytest.approx(
            0.18257, abs=1e-4
        )


# ---------------------------------------------------------------------------
# PersistenceCheckService.find_match classification
# ---------------------------------------------------------------------------


class TestFindMatchClassification:
    def test_known_object_is_matched(self) -> None:
        props = {
            "embedding": list(_EMB),
            "bounding_box": dict(_NODE_BBOX),
            "dominant_colors": [(200, 50, 50)],
            "label_raw": "cup",
        }
        svc = PersistenceCheckService(
            _FakeGraph([(_make_node("n-known", props, 10), 1.0)]),
            PersistenceCheckConfig(),
        )
        result = _run(svc.find_match(_make_obs()))
        assert result is not None
        assert result.matched_node_id == "n-known"
        assert result.match_type == "embedding"
        assert result.confidence == pytest.approx(1.0)
        assert result.ambiguous_candidates == []

    def test_ambiguous_object_reports_candidate_without_match(self) -> None:
        # New node (count=0) with strong embedding/color/label but NO bbox.
        # Score = 0.25 + 0.15 + 0.05 = 0.45 -> in [ambiguity, match) band.
        props = {
            "embedding": list(_EMB),
            "dominant_colors": [(200, 50, 50)],
            "label_raw": "cup",
        }
        svc = PersistenceCheckService(
            _FakeGraph([(_make_node("n-amb", props, 0), 0.9)]),
            PersistenceCheckConfig(),
        )
        result = _run(svc.find_match(_make_obs()))
        assert result is not None
        assert result.matched_node_id is None
        assert result.confidence == pytest.approx(0.45)
        assert result.ambiguous_candidates == ["n-amb"]

    def test_new_object_below_ambiguity_is_unmatched(self) -> None:
        # Weak embedding only -> ~0.18, below ambiguity_threshold (0.45).
        props = {
            "embedding": [0.0, 0.0, 0.0, 1.0],
            "dominant_colors": [(10, 250, 10)],
            "label_raw": "dog",
        }
        svc = PersistenceCheckService(
            _FakeGraph([(_make_node("n-new", props, 0), 0.8)]),
            PersistenceCheckConfig(),
        )
        result = _run(svc.find_match(_make_obs()))
        assert result is not None
        assert result.matched_node_id is None
        assert result.match_type == "none"
        assert result.ambiguous_candidates == []
        assert result.confidence == pytest.approx(0.18257, abs=1e-4)

    def test_no_embedding_returns_none(self) -> None:
        svc = PersistenceCheckService(_FakeGraph([]), PersistenceCheckConfig())
        obs = _make_obs(embedding=[])
        assert _run(svc.find_match(obs)) is None

    def test_no_candidates_returns_none_match(self) -> None:
        svc = PersistenceCheckService(_FakeGraph([]), PersistenceCheckConfig())
        result = _run(svc.find_match(_make_obs()))
        assert result is not None
        assert result.matched_node_id is None
        assert result.match_type == "none"
        assert result.surprise_flag is False


# ---------------------------------------------------------------------------
# surprise_flag (Piaget R2)
# ---------------------------------------------------------------------------


class TestSurpriseFlag:
    # A node whose embedding is orthogonal to the observation embedding
    # (cos == 0 -> distance 1.0 > surprise_threshold 0.3), but whose spatial /
    # color / label signals still pull the overall score into the ambiguous
    # band so the candidate survives to be flagged.
    _SURPRISE_PROPS = {
        "embedding": [-2.0, 1.0, 0.0, 0.0],  # dot with [1,2,3,4] = 0 -> cos 0
        "bounding_box": dict(_NODE_BBOX),
        "dominant_colors": [(200, 50, 50)],
        "label_raw": "cup",
    }

    def test_fires_for_well_known_object_with_far_embedding(self) -> None:
        svc = PersistenceCheckService(
            _FakeGraph([(_make_node("n-surp", dict(self._SURPRISE_PROPS), 8), 0.8)]),
            PersistenceCheckConfig(),
        )
        result = _run(svc.find_match(_make_obs()))
        assert result is not None
        assert result.surprise_flag is True
        # Confirmed it lands in the ambiguous band (not a confident match).
        assert result.matched_node_id is None
        assert result.confidence == pytest.approx(0.63)

    def test_does_not_fire_below_confirmation_floor(self) -> None:
        # Same far-embedding candidate but confirmation_count=4 (< 5):
        # surprise detection is gated off entirely.
        svc = PersistenceCheckService(
            _FakeGraph([(_make_node("n-surp", dict(self._SURPRISE_PROPS), 4), 0.8)]),
            PersistenceCheckConfig(),
        )
        result = _run(svc.find_match(_make_obs()))
        assert result is not None
        assert result.surprise_flag is False

    def test_does_not_fire_when_embedding_close(self) -> None:
        # Well-known object (count=10) whose embedding matches perfectly:
        # distance 0.0 is not > threshold, so no surprise.
        props = {
            "embedding": list(_EMB),
            "bounding_box": dict(_NODE_BBOX),
            "dominant_colors": [(200, 50, 50)],
            "label_raw": "cup",
        }
        svc = PersistenceCheckService(
            _FakeGraph([(_make_node("n-close", props, 10), 1.0)]),
            PersistenceCheckConfig(),
        )
        result = _run(svc.find_match(_make_obs()))
        assert result is not None
        assert result.surprise_flag is False


# ---------------------------------------------------------------------------
# OPEN-9: cross-session candidate that drops the spatial signal
# ---------------------------------------------------------------------------


class TestOpen9SpatialDropRenorm:
    """A cross-session re-identification has no reliable in-frame location.

    When the candidate node has no stored bounding box, the spatial scorer
    returns 0.0. The question OPEN-9 raises: does ``compute_match_score``
    renormalize the *remaining* weights so a strong embedding/color/label
    match scores on its own merits (~0.88), or does the absent-spatial weight
    silently drag the score down (capped at 0.75)?

    At commit fefdc4d the answer is: NO renormalization. The spatial weight
    (0.15 in the well-known profile) is multiplied by a spatial score of 0.0
    and simply lost, so a node that is a *perfect* embedding+color+label match
    is capped at exactly 0.75 -- right on the match threshold, with no margin.
    """

    _CROSS_SESSION_PROPS = {
        "embedding": list(_EMB),          # perfect -> 1.0
        "dominant_colors": [(200, 50, 50)],  # perfect -> 1.0
        "label_raw": "cup",                # perfect -> 1.0
        # NOTE: no "bounding_box" -> spatial 0.0 AND size 0.0
    }

    def test_dropped_spatial_is_capped_not_renormalized(self) -> None:
        obs = _make_obs()
        score = compute_match_score(
            obs, dict(self._CROSS_SESSION_PROPS), confirmation_count=10
        )
        # embedding 0.45 + color 0.25 + label 0.05 = 0.75; spatial & size lost.
        assert score == pytest.approx(0.75)

    def test_renorm_target_would_be_higher(self) -> None:
        """Document the renorm math the OPEN-9 fix would implement."""
        weights = _interpolate_weights(10)
        # Drop the two box-derived signals (spatial, size) that are absent on
        # a cross-session candidate, then renormalize the remainder.
        remaining = {
            k: v for k, v in weights.items() if k not in ("spatial", "size")
        }
        total = sum(remaining.values())
        renormalized = {k: v / total for k, v in remaining.items()}
        # embedding, color, label all perfect (1.0) -> renorm score == 1.0
        # if ONLY embedding+color+label survive. Drop just spatial (keep size,
        # which is also 0 here) to get the ~0.88 figure from the OPEN-9 note.
        drop_spatial_only = {
            k: v for k, v in weights.items() if k != "spatial"
        }
        t2 = sum(drop_spatial_only.values())
        renorm_drop_spatial = {k: v / t2 for k, v in drop_spatial_only.items()}
        # embedding(1)+color(1)+label(1), size(0):
        renorm_score = (
            renorm_drop_spatial["embedding"]
            + renorm_drop_spatial["color"]
            + renorm_drop_spatial["label_raw"]
        )
        assert renorm_score == pytest.approx(0.88235, abs=1e-4)
        assert sum(renormalized.values()) == pytest.approx(1.0)

    @pytest.mark.xfail(
        reason="OPEN-9: compute_match_score does not renormalize dropped "
        "spatial weight at commit fefdc4d; cross-session match is capped at "
        "0.75 instead of ~0.88. Remove this xfail when the renorm fix lands.",
        strict=True,
    )
    def test_open9_renorm_not_yet_implemented(self) -> None:
        obs = _make_obs()
        score = compute_match_score(
            obs, dict(self._CROSS_SESSION_PROPS), confirmation_count=10
        )
        # The OPEN-9 fix target: a strong embedding match should renormalize
        # past the cap, landing around 0.88. Until implemented, this xfails.
        assert score > 0.80
