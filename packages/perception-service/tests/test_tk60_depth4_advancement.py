"""TK-60 acceptance tests: inference depth-4+ advancement criteria.

Verifies both acceptance criteria without requiring a live Neo4j instance:

AC-1  Given depth 3, E5 met, depth-4 success rate >= threshold,
      when advancement runs, then depth advances to 4.
      (E5 not met -> stays at 3 regardless of metrics.)

AC-2  Given depth 4, depth-5 criteria met,
      when advancement runs, then depth advances to 5.

The Neo4j session is stubbed via unittest.mock so these are pure unit tests.
InMemoryGraphPersistence provides a real persistence backend without a DB.

Run with::

    cd packages/perception-service
    python -m pytest tests/test_tk60_depth4_advancement.py -v
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from cobeing.layer3_knowledge.in_memory_persistence import InMemoryGraphPersistence
from cobeing.layer3_knowledge.inference_query import (
    DEFAULT_DEPTH4_MIN_CONFIRMED,
    DEFAULT_DEPTH4_SUCCESS_RATE,
    DEFAULT_DEPTH5_MIN_CONFIRMED,
    DEFAULT_DEPTH5_SUCCESS_RATE,
    INFERENCE_DEPTH_RULE_ID,
    _check_depth_advancement,
    bootstrap_inference_query_template,
)
from cobeing.layer3_knowledge.node_types import KnowledgeNode, NodeStatus, SchemaLevel
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import NodeId


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_depth_rule_node(
    current_depth: int,
    e5_prerequisite_met: bool,
    extra_props: dict[str, Any] | None = None,
) -> KnowledgeNode:
    """Build an in-memory EvolutionRule node matching what bootstrap creates."""
    props: dict[str, Any] = {
        "rule_name": "INFERENCE_DEPTH_CONFIG",
        "current_max_depth": current_depth,
        "e5_prerequisite_met": e5_prerequisite_met,
        # Depth 2 criteria
        "depth_2_success_rate": 0.85,
        "depth_2_min_confirmed": 20,
        "depth_2_cluster_coverage": 3,
        # Depth 3 criteria
        "depth_3_success_rate": 0.80,
        "depth_3_min_confirmed": 15,
        "depth_3_horizontal_decalage_check": True,
        # Depth 4 criteria
        "depth_4_success_rate": DEFAULT_DEPTH4_SUCCESS_RATE,
        "depth_4_min_confirmed": DEFAULT_DEPTH4_MIN_CONFIRMED,
        # Depth 5 criteria
        "depth_5_success_rate": DEFAULT_DEPTH5_SUCCESS_RATE,
        "depth_5_min_confirmed": DEFAULT_DEPTH5_MIN_CONFIRMED,
    }
    if extra_props:
        props.update(extra_props)

    return KnowledgeNode(
        node_id=INFERENCE_DEPTH_RULE_ID,
        node_type="EvolutionRule",
        schema_level=SchemaLevel.META_SCHEMA,
        properties=props,
        provenance=Provenance(
            source=ProvenanceSource.TAUGHT_PROCEDURE,
            source_id="test",
            confidence=1.0,
        ),
        confidence=1.0,
        status=NodeStatus.ACTIVE,
    )


def _make_neo4j_session(success_rate: float, confirmed_count: int) -> MagicMock:
    """Build a mock Neo4j session that returns fixed metric values.

    The session is used by ``_compute_inference_success_rate`` and
    ``_count_confirmed_inferences``. Both call ``session.execute_read`` with a
    read-transaction callback. We stub ``execute_read`` so the first call
    returns ``success_rate`` and the second returns ``confirmed_count``.
    """
    session = MagicMock()
    session.execute_read.side_effect = [success_rate, confirmed_count]
    return session


# ---------------------------------------------------------------------------
# AC-1: depth 3 -> 4 advancement
# ---------------------------------------------------------------------------


class TestDepth3To4Advancement:
    """AC-1 -- depth 3 advances to 4 when E5 is met and metrics pass."""

    @pytest.mark.asyncio
    async def test_advances_to_4_when_e5_met_and_metrics_pass(self) -> None:
        """Given depth 3, E5 met, success_rate >= threshold, confirmed >= min:
        advancement returns 4."""
        persistence = InMemoryGraphPersistence()
        rule_node = _make_depth_rule_node(
            current_depth=3,
            e5_prerequisite_met=True,
        )
        await persistence.save_node(rule_node)

        # Success rate and confirmed count both at or above threshold
        neo4j_session = _make_neo4j_session(
            success_rate=DEFAULT_DEPTH4_SUCCESS_RATE,
            confirmed_count=DEFAULT_DEPTH4_MIN_CONFIRMED,
        )

        new_depth = await _check_depth_advancement(
            persistence=persistence,
            neo4j_session=neo4j_session,
            current_depth=3,
            e5_prerequisite_met=True,
            depth_rule_node=rule_node,
        )

        assert new_depth == 4, (
            f"Expected depth 4 when E5 met and metrics pass, got {new_depth}"
        )

    @pytest.mark.asyncio
    async def test_stays_at_3_when_e5_not_met(self) -> None:
        """Given depth 3, E5 NOT met: stays at 3 regardless of success metrics."""
        persistence = InMemoryGraphPersistence()
        rule_node = _make_depth_rule_node(
            current_depth=3,
            e5_prerequisite_met=False,
        )
        await persistence.save_node(rule_node)

        # Even with perfect metrics, no advancement without E5
        neo4j_session = _make_neo4j_session(
            success_rate=1.0,
            confirmed_count=9999,
        )

        new_depth = await _check_depth_advancement(
            persistence=persistence,
            neo4j_session=neo4j_session,
            current_depth=3,
            e5_prerequisite_met=False,
            depth_rule_node=rule_node,
        )

        assert new_depth == 3, (
            f"Expected to stay at depth 3 when E5 not met, got {new_depth}"
        )
        # Neo4j session should NOT have been called (early return before metrics)
        neo4j_session.execute_read.assert_not_called()

    @pytest.mark.asyncio
    async def test_stays_at_3_when_success_rate_below_threshold(self) -> None:
        """Given depth 3, E5 met, success_rate < threshold: stays at 3."""
        persistence = InMemoryGraphPersistence()
        rule_node = _make_depth_rule_node(
            current_depth=3,
            e5_prerequisite_met=True,
        )
        await persistence.save_node(rule_node)

        below_threshold = DEFAULT_DEPTH4_SUCCESS_RATE - 0.01
        neo4j_session = _make_neo4j_session(
            success_rate=below_threshold,
            confirmed_count=DEFAULT_DEPTH4_MIN_CONFIRMED,
        )

        new_depth = await _check_depth_advancement(
            persistence=persistence,
            neo4j_session=neo4j_session,
            current_depth=3,
            e5_prerequisite_met=True,
            depth_rule_node=rule_node,
        )

        assert new_depth == 3, (
            f"Expected to stay at depth 3 when success rate {below_threshold:.2f} "
            f"< threshold {DEFAULT_DEPTH4_SUCCESS_RATE:.2f}, got {new_depth}"
        )

    @pytest.mark.asyncio
    async def test_stays_at_3_when_confirmed_below_minimum(self) -> None:
        """Given depth 3, E5 met, confirmed_count < min: stays at 3."""
        persistence = InMemoryGraphPersistence()
        rule_node = _make_depth_rule_node(
            current_depth=3,
            e5_prerequisite_met=True,
        )
        await persistence.save_node(rule_node)

        neo4j_session = _make_neo4j_session(
            success_rate=DEFAULT_DEPTH4_SUCCESS_RATE,
            confirmed_count=DEFAULT_DEPTH4_MIN_CONFIRMED - 1,
        )

        new_depth = await _check_depth_advancement(
            persistence=persistence,
            neo4j_session=neo4j_session,
            current_depth=3,
            e5_prerequisite_met=True,
            depth_rule_node=rule_node,
        )

        assert new_depth == 3, (
            f"Expected to stay at depth 3 when confirmed count too low, got {new_depth}"
        )

    @pytest.mark.asyncio
    async def test_depth_rule_node_updated_in_persistence_on_advancement(
        self,
    ) -> None:
        """When depth advances 3->4, the EvolutionRule node is persisted."""
        persistence = InMemoryGraphPersistence()
        rule_node = _make_depth_rule_node(
            current_depth=3,
            e5_prerequisite_met=True,
        )
        await persistence.save_node(rule_node)

        neo4j_session = _make_neo4j_session(
            success_rate=DEFAULT_DEPTH4_SUCCESS_RATE,
            confirmed_count=DEFAULT_DEPTH4_MIN_CONFIRMED,
        )

        await _check_depth_advancement(
            persistence=persistence,
            neo4j_session=neo4j_session,
            current_depth=3,
            e5_prerequisite_met=True,
            depth_rule_node=rule_node,
        )

        # Reload from persistence and verify the update was saved
        updated_node = await persistence.get_node(INFERENCE_DEPTH_RULE_ID)
        assert updated_node is not None
        assert updated_node.properties["current_max_depth"] == 4, (
            "EvolutionRule node should have current_max_depth=4 after advancement"
        )


# ---------------------------------------------------------------------------
# AC-2: depth 4 -> 5 advancement
# ---------------------------------------------------------------------------


class TestDepth4To5Advancement:
    """AC-2 -- depth 4 advances to 5 when metrics pass."""

    @pytest.mark.asyncio
    async def test_advances_to_5_when_metrics_pass(self) -> None:
        """Given depth 4, success_rate >= threshold, confirmed >= min:
        advancement returns 5."""
        persistence = InMemoryGraphPersistence()
        rule_node = _make_depth_rule_node(
            current_depth=4,
            # E5 is implied at depth 4 (would not have advanced without it)
            e5_prerequisite_met=True,
        )
        await persistence.save_node(rule_node)

        neo4j_session = _make_neo4j_session(
            success_rate=DEFAULT_DEPTH5_SUCCESS_RATE,
            confirmed_count=DEFAULT_DEPTH5_MIN_CONFIRMED,
        )

        new_depth = await _check_depth_advancement(
            persistence=persistence,
            neo4j_session=neo4j_session,
            current_depth=4,
            e5_prerequisite_met=True,
            depth_rule_node=rule_node,
        )

        assert new_depth == 5, (
            f"Expected depth 5 when metrics pass at depth 4, got {new_depth}"
        )

    @pytest.mark.asyncio
    async def test_stays_at_4_when_success_rate_below_threshold(self) -> None:
        """Given depth 4, success_rate < threshold: stays at 4."""
        persistence = InMemoryGraphPersistence()
        rule_node = _make_depth_rule_node(
            current_depth=4,
            e5_prerequisite_met=True,
        )
        await persistence.save_node(rule_node)

        below_threshold = DEFAULT_DEPTH5_SUCCESS_RATE - 0.01
        neo4j_session = _make_neo4j_session(
            success_rate=below_threshold,
            confirmed_count=DEFAULT_DEPTH5_MIN_CONFIRMED,
        )

        new_depth = await _check_depth_advancement(
            persistence=persistence,
            neo4j_session=neo4j_session,
            current_depth=4,
            e5_prerequisite_met=True,
            depth_rule_node=rule_node,
        )

        assert new_depth == 4, (
            f"Expected to stay at depth 4 when success rate {below_threshold:.2f} "
            f"< threshold {DEFAULT_DEPTH5_SUCCESS_RATE:.2f}, got {new_depth}"
        )

    @pytest.mark.asyncio
    async def test_stays_at_4_when_confirmed_below_minimum(self) -> None:
        """Given depth 4, confirmed_count < min: stays at 4."""
        persistence = InMemoryGraphPersistence()
        rule_node = _make_depth_rule_node(
            current_depth=4,
            e5_prerequisite_met=True,
        )
        await persistence.save_node(rule_node)

        neo4j_session = _make_neo4j_session(
            success_rate=DEFAULT_DEPTH5_SUCCESS_RATE,
            confirmed_count=DEFAULT_DEPTH5_MIN_CONFIRMED - 1,
        )

        new_depth = await _check_depth_advancement(
            persistence=persistence,
            neo4j_session=neo4j_session,
            current_depth=4,
            e5_prerequisite_met=True,
            depth_rule_node=rule_node,
        )

        assert new_depth == 4, (
            f"Expected to stay at depth 4 when confirmed count too low, got {new_depth}"
        )

    @pytest.mark.asyncio
    async def test_depth_rule_node_updated_in_persistence_on_advancement(
        self,
    ) -> None:
        """When depth advances 4->5, the EvolutionRule node is persisted."""
        persistence = InMemoryGraphPersistence()
        rule_node = _make_depth_rule_node(
            current_depth=4,
            e5_prerequisite_met=True,
        )
        await persistence.save_node(rule_node)

        neo4j_session = _make_neo4j_session(
            success_rate=DEFAULT_DEPTH5_SUCCESS_RATE,
            confirmed_count=DEFAULT_DEPTH5_MIN_CONFIRMED,
        )

        await _check_depth_advancement(
            persistence=persistence,
            neo4j_session=neo4j_session,
            current_depth=4,
            e5_prerequisite_met=True,
            depth_rule_node=rule_node,
        )

        updated_node = await persistence.get_node(INFERENCE_DEPTH_RULE_ID)
        assert updated_node is not None
        assert updated_node.properties["current_max_depth"] == 5, (
            "EvolutionRule node should have current_max_depth=5 after advancement"
        )


# ---------------------------------------------------------------------------
# Bootstrap smoke: no LOCKED_UNTIL_E5 sentinel in new bootstrap output
# ---------------------------------------------------------------------------


class TestBootstrapNoLocked:
    """Verify bootstrap writes real predicate properties, not LOCKED_UNTIL_E5."""

    @pytest.mark.asyncio
    async def test_bootstrap_depth4_criteria_are_numeric_not_sentinel(
        self,
    ) -> None:
        """bootstrap_inference_query_template must not write LOCKED_UNTIL_E5."""
        persistence = InMemoryGraphPersistence()
        await bootstrap_inference_query_template(persistence)

        rule = await persistence.get_node(INFERENCE_DEPTH_RULE_ID)
        assert rule is not None

        depth_4_rate = rule.properties.get("depth_4_success_rate")
        depth_4_min = rule.properties.get("depth_4_min_confirmed")
        depth_5_rate = rule.properties.get("depth_5_success_rate")
        depth_5_min = rule.properties.get("depth_5_min_confirmed")

        # Must be numeric, never the LOCKED_UNTIL_E5 string sentinel
        assert isinstance(depth_4_rate, float), (
            f"depth_4_success_rate must be float, got {depth_4_rate!r}"
        )
        assert isinstance(depth_4_min, int), (
            f"depth_4_min_confirmed must be int, got {depth_4_min!r}"
        )
        assert isinstance(depth_5_rate, float), (
            f"depth_5_success_rate must be float, got {depth_5_rate!r}"
        )
        assert isinstance(depth_5_min, int), (
            f"depth_5_min_confirmed must be int, got {depth_5_min!r}"
        )

        # Sentinel string must be absent
        for key, val in rule.properties.items():
            assert val != "LOCKED_UNTIL_E5", (
                f"Property {key!r} still has LOCKED_UNTIL_E5 sentinel"
            )
