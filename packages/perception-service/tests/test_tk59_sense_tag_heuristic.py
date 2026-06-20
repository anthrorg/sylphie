"""TK-59 acceptance tests: coarse POS heuristic for default sense_tag.

Verifies all three acceptance criteria:

  AC-1  A novel '-ing' word is resolved with sense_tag='verb_1' and
        node_id 'word:<lemma>:verb_1'.
        An unrecognised form is resolved with sense_tag='unknown_1' and
        node_id 'word:<lemma>:unknown_1'.

  AC-2  An explicit sense_tag='adj_1' passed to _resolve_or_create_word_sense
        is used verbatim -- the heuristic is NOT applied.

Also covers the pure helper ``_infer_sense_tag`` and ``_pos_from_sense_tag``
directly (fast, no I/O).

These tests are pure Python: no model weights, no Neo4j, no network.

Run with::

    cd packages/perception-service
    python -m pytest tests/test_tk59_sense_tag_heuristic.py -v
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio

from cobeing.layer3_knowledge.semantic_teaching_handler import (
    _infer_sense_tag,
    _pos_from_sense_tag,
    _resolve_or_create_word_sense,
)
from cobeing.layer3_knowledge.node_types import KnowledgeNode, SchemaLevel, NodeStatus
from cobeing.layer3_knowledge.query_types import NodeFilter
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import NodeId


# ---------------------------------------------------------------------------
# Helpers -- lightweight in-memory GraphPersistence stub
# ---------------------------------------------------------------------------


class _InMemoryPersistence:
    """Minimal in-memory stand-in for GraphPersistence (no Neo4j required).

    Only implements save_node and query_nodes -- the two methods called by
    _resolve_or_create_word_sense.
    """

    def __init__(self) -> None:
        self._nodes: dict[str, KnowledgeNode] = {}

    async def save_node(self, node: KnowledgeNode) -> None:
        self._nodes[str(node.node_id)] = node

    async def query_nodes(self, filter: NodeFilter) -> list[KnowledgeNode]:
        # Return all stored nodes; _resolve_or_create_word_sense filters by spelling.
        return list(self._nodes.values())

    # Unused by the function under test; present so the object passes a
    # runtime isinstance check against Protocol if needed.
    async def get_node(self, node_id: NodeId) -> KnowledgeNode | None:
        return self._nodes.get(str(node_id))


# ---------------------------------------------------------------------------
# Pure unit tests for the helper functions (no I/O)
# ---------------------------------------------------------------------------


class TestInferSenseTag:
    """_infer_sense_tag applies the three-way suffix heuristic."""

    @pytest.mark.parametrize("lemma, expected", [
        # '-ing' words → verb_1
        ("running", "verb_1"),
        ("swimming", "verb_1"),
        ("ing", "verb_1"),          # edge: the suffix *is* the whole word
        # '-ly' words → adv_1
        ("quickly", "adv_1"),
        ("slowly", "adv_1"),
        ("ly", "adv_1"),            # edge: the suffix is the whole word
        # everything else → unknown_1
        ("cat", "unknown_1"),
        ("animal", "unknown_1"),
        ("red", "unknown_1"),
        ("", "unknown_1"),          # empty string hits the else branch
    ])
    def test_infer_sense_tag(self, lemma: str, expected: str) -> None:
        assert _infer_sense_tag(lemma) == expected


class TestPosFromSenseTag:
    """_pos_from_sense_tag derives part_of_speech from a sense_tag string."""

    @pytest.mark.parametrize("sense_tag, expected_pos", [
        ("verb_1", "verb"),
        ("adv_1", "adverb"),
        ("adj_1", "adjective"),
        ("noun_1", "noun"),
        ("unknown_1", "unknown"),
        ("anything_else_99", "unknown"),   # unrecognised prefix → unknown
    ])
    def test_pos_from_sense_tag(self, sense_tag: str, expected_pos: str) -> None:
        assert _pos_from_sense_tag(sense_tag) == expected_pos


# ---------------------------------------------------------------------------
# AC-1: heuristic applied when no explicit sense_tag is supplied
# ---------------------------------------------------------------------------


class TestHeuristicSenseTag:
    """AC-1 -- heuristic selects the correct sense_tag for novel lemmas."""

    @pytest.mark.asyncio
    async def test_ing_word_gets_verb_1(self) -> None:
        """A novel '-ing' word is resolved with sense_tag='verb_1'."""
        persistence = _InMemoryPersistence()
        node_id, lemma = await _resolve_or_create_word_sense(
            lemma="swimming",
            persistence=persistence,
            session_id="sess-test",
            correlation_id="corr-001",
        )

        assert node_id == NodeId("word:swimming:verb_1"), (
            f"Expected node_id 'word:swimming:verb_1', got {node_id!r}"
        )
        assert lemma == "swimming"

        saved = persistence._nodes.get("word:swimming:verb_1")
        assert saved is not None, "WordSenseNode should have been persisted"
        assert saved.properties["sense_tag"] == "verb_1"
        assert saved.properties["part_of_speech"] == "verb"

    @pytest.mark.asyncio
    async def test_unrecognised_form_gets_unknown_1(self) -> None:
        """An unrecognised lemma form is resolved with sense_tag='unknown_1'."""
        persistence = _InMemoryPersistence()
        node_id, lemma = await _resolve_or_create_word_sense(
            lemma="cat",
            persistence=persistence,
            session_id="sess-test",
            correlation_id="corr-002",
        )

        assert node_id == NodeId("word:cat:unknown_1")
        assert lemma == "cat"

        saved = persistence._nodes.get("word:cat:unknown_1")
        assert saved is not None
        assert saved.properties["sense_tag"] == "unknown_1"
        assert saved.properties["part_of_speech"] == "unknown"

    @pytest.mark.asyncio
    async def test_ly_word_gets_adv_1(self) -> None:
        """A '-ly' word is resolved with sense_tag='adv_1'."""
        persistence = _InMemoryPersistence()
        node_id, lemma = await _resolve_or_create_word_sense(
            lemma="quickly",
            persistence=persistence,
            session_id="sess-test",
            correlation_id="corr-003",
        )

        assert node_id == NodeId("word:quickly:adv_1")
        assert lemma == "quickly"
        saved = persistence._nodes.get("word:quickly:adv_1")
        assert saved is not None
        assert saved.properties["sense_tag"] == "adv_1"
        assert saved.properties["part_of_speech"] == "adverb"


# ---------------------------------------------------------------------------
# AC-2: explicit sense_tag is honoured; heuristic is skipped
# ---------------------------------------------------------------------------


class TestExplicitSenseTag:
    """AC-2 -- an explicit sense_tag bypasses the heuristic entirely."""

    @pytest.mark.asyncio
    async def test_explicit_adj_1_used_verbatim(self) -> None:
        """Given sense_tag='adj_1', the node is created with that tag, not 'unknown_1'."""
        persistence = _InMemoryPersistence()
        node_id, lemma = await _resolve_or_create_word_sense(
            lemma="red",
            persistence=persistence,
            session_id="sess-test",
            correlation_id="corr-004",
            sense_tag="adj_1",
        )

        # 'red' would normally get 'unknown_1' from the heuristic
        assert node_id == NodeId("word:red:adj_1"), (
            f"Explicit sense_tag='adj_1' must be used; got node_id {node_id!r}"
        )
        assert lemma == "red"

        saved = persistence._nodes.get("word:red:adj_1")
        assert saved is not None, "WordSenseNode for adj_1 must be persisted"
        assert saved.properties["sense_tag"] == "adj_1"
        assert saved.properties["part_of_speech"] == "adjective"

    @pytest.mark.asyncio
    async def test_explicit_noun_1_used_for_ing_word(self) -> None:
        """An '-ing' word given explicit sense_tag='noun_1' is stored as noun_1, not verb_1.

        This verifies that the heuristic is NOT applied when an explicit tag is
        supplied -- even when the suffix would normally trigger a different tag.
        """
        persistence = _InMemoryPersistence()
        node_id, _ = await _resolve_or_create_word_sense(
            lemma="running",
            persistence=persistence,
            session_id="sess-test",
            correlation_id="corr-005",
            sense_tag="noun_1",
        )

        assert node_id == NodeId("word:running:noun_1")
        saved = persistence._nodes.get("word:running:noun_1")
        assert saved is not None
        assert saved.properties["sense_tag"] == "noun_1"
        # Heuristic would have set 'verb'; explicit override must set 'noun'
        assert saved.properties["part_of_speech"] == "noun"

    @pytest.mark.asyncio
    async def test_existing_node_returned_regardless_of_sense_tag(self) -> None:
        """If a node already exists in the graph, it is returned as-is.

        The sense_tag parameter only affects creation of *novel* nodes.
        """
        persistence = _InMemoryPersistence()

        # Pre-seed a node for 'cat'
        existing_id = NodeId("word:cat:noun_1")
        existing_node = KnowledgeNode(
            node_id=existing_id,
            node_type="WordSenseNode",
            schema_level=SchemaLevel.SCHEMA,
            properties={
                "word": "cat",
                "spelling": "cat",
                "part_of_speech": "noun",
                "sense_tag": "noun_1",
                "frequency_rank": 0,
                "scope_contexts": 0,
            },
            provenance=Provenance(
                source=ProvenanceSource.GUARDIAN,
                source_id="sess-seed",
                confidence=1.0,
            ),
            confidence=1.0,
            status=NodeStatus.ACTIVE,
        )
        await persistence.save_node(existing_node)

        # Request with a different explicit sense_tag -- should still return existing
        node_id, lemma = await _resolve_or_create_word_sense(
            lemma="cat",
            persistence=persistence,
            session_id="sess-test",
            correlation_id="corr-006",
            sense_tag="adj_1",   # would differ from stored node
        )

        assert node_id == existing_id, (
            "Existing node must be returned; sense_tag is only for new node creation"
        )
        assert lemma == "cat"
        # Only the one node should be in persistence (no new one created)
        assert len(persistence._nodes) == 1
