"""Sentence assembly engine for graph-driven speech (Tier 2).

Constructs novel sentences from knowledge graph data without any LLM
involvement. This is "Tier 2" speech -- Co-Being builds sentences from
what it knows, using pattern templates filled with graph-resolved slots.

The engine works in three stages:

1. **Pattern selection** -- Choose a ConversationPattern (format string
   with named slots like ``{subject}`` and ``{predicate}``).
2. **Slot resolution** -- For each slot, look up the bound node_id in the
   graph, extract the spelling or name, and apply basic English grammar
   (articles, capitalization).
3. **Assembly** -- Interpolate resolved slots into the template and apply
   sentence-level formatting.

Patterns are stored as a module-level dict for fast lookup. They will also
exist as ProceduralTemplate nodes in the graph, but the executor needs them
locally to avoid a graph round-trip on every utterance.

Layer: 3 (Knowledge Graph).
Phase: 2-E6 (Conversation Procedures).

Usage::

    from cobeing.layer3_knowledge.conversation_procedures import (
        SentenceAssembler,
        CONVERSATION_PATTERNS,
    )

    assembler = SentenceAssembler(persistence=graph)
    sentence = await assembler.assemble(
        pattern_id="state_fact_copular",
        bindings={"subject": "word:cat:default", "predicate": "word:animal:default"},
    )
    # sentence == "A cat is an animal."
"""

from __future__ import annotations

import dataclasses
import logging
from typing import TYPE_CHECKING

from cobeing.layer3_knowledge.language_types import (
    WORD_FORM_NODE,
    WORD_SENSE_NODE,
)
from cobeing.layer3_knowledge.query_types import EdgeFilter, NodeFilter
from cobeing.layer3_knowledge.semantic_types import HAS_PROPERTY, IS_A

if TYPE_CHECKING:
    from cobeing.layer3_knowledge.protocols import GraphPersistence

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Vowel set for article selection
# ---------------------------------------------------------------------------

_VOWELS = frozenset("aeiouAEIOU")


# ---------------------------------------------------------------------------
# ConversationPattern dataclass
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class ConversationPattern:
    """A sentence template with named slots resolved from graph data.

    Attributes:
        pattern_id: Unique identifier for this pattern.
        template: Python format string with ``{slot}`` placeholders.
        slot_roles: Maps each slot name to the expected grammatical role.
            Supported roles: ``"noun"``, ``"adjective"``, ``"noun_or_adj"``,
            ``"number"``, ``"any"``.
        drives_served: Which drive categories this pattern serves (for
            the Executor Engine to select patterns based on pressure).
        description: Human-readable description of when to use this pattern.
    """

    pattern_id: str
    template: str
    slot_roles: dict[str, str]
    drives_served: list[str]
    description: str


# ---------------------------------------------------------------------------
# Built-in conversation patterns
# ---------------------------------------------------------------------------

CONVERSATION_PATTERNS: dict[str, ConversationPattern] = {
    "state_fact_copular": ConversationPattern(
        pattern_id="state_fact_copular",
        template="{subject} is {predicate}.",
        slot_roles={"subject": "noun", "predicate": "noun_or_adj"},
        drives_served=["relieve_curiosity", "relieve_boredom"],
        description="State a known fact: X is Y",
    ),
    "ask_what_is": ConversationPattern(
        pattern_id="ask_what_is",
        template="What is {object}?",
        slot_roles={"object": "noun"},
        drives_served=["relieve_curiosity"],
        description="Ask about an unknown concept",
    ),
    "state_has_property": ConversationPattern(
        pattern_id="state_has_property",
        template="{subject} is {property}.",
        slot_roles={"subject": "noun", "property": "adjective"},
        drives_served=["relieve_curiosity", "relieve_boredom"],
        description="State a property: X is [adjective]",
    ),
    "confirm_understanding": ConversationPattern(
        pattern_id="confirm_understanding",
        template="I understand. {subject} is {predicate}.",
        slot_roles={"subject": "noun", "predicate": "noun_or_adj"},
        drives_served=["relieve_integrity"],
        description="Confirm understanding of a taught fact",
    ),
    "admit_ignorance": ConversationPattern(
        pattern_id="admit_ignorance",
        template="I don't know about {topic}.",
        slot_roles={"topic": "noun"},
        drives_served=["relieve_integrity", "relieve_information_integrity"],
        description="Admit lack of knowledge about a topic",
    ),
    "describe_count": ConversationPattern(
        pattern_id="describe_count",
        template="I know {count} things about {topic}.",
        slot_roles={"count": "number", "topic": "noun"},
        drives_served=["relieve_cognitive_awareness"],
        description="Describe how much is known about a topic",
    ),
    "greet_response": ConversationPattern(
        pattern_id="greet_response",
        template="Hello! I am Co-Being.",
        slot_roles={},
        drives_served=["relieve_boredom"],
        description="Respond to a greeting",
    ),
    "ask_to_teach": ConversationPattern(
        pattern_id="ask_to_teach",
        template="Can you teach me about {topic}?",
        slot_roles={"topic": "noun"},
        drives_served=["relieve_curiosity"],
        description="Ask the guardian to teach about a topic",
    ),
}


# ---------------------------------------------------------------------------
# SentenceAssembler
# ---------------------------------------------------------------------------


class SentenceAssembler:
    """Constructs sentences from graph data using pattern templates.

    Each pattern is a format string with named slots. Slots are resolved
    to word spellings from the knowledge graph. Basic English grammar
    rules are applied (articles, capitalization, punctuation).

    This class never raises exceptions from ``assemble()``. If any slot
    cannot be resolved, it returns ``None`` so the caller can fall back
    to Tier 1 (LLM-generated) speech.

    Args:
        persistence: Graph storage backend satisfying the GraphPersistence
            protocol. Used to look up node properties for slot resolution.

    Usage::

        assembler = SentenceAssembler(persistence=graph)

        sentence = await assembler.assemble(
            pattern_id="state_fact_copular",
            bindings={"subject": "word:cat:default", "predicate": "word:animal:default"},
        )
        # Returns: "A cat is an animal."
    """

    def __init__(self, persistence: GraphPersistence) -> None:
        self._persistence = persistence

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def assemble(
        self,
        pattern_id: str,
        bindings: dict[str, str],
    ) -> str | None:
        """Assemble a sentence from a pattern and graph bindings.

        Args:
            pattern_id: Key into ``CONVERSATION_PATTERNS``.
            bindings: Maps slot names to node IDs (WordSenseNode,
                WordFormNode, ConceptPrimitive, or raw strings for
                the ``"number"`` role).

        Returns:
            The constructed sentence with proper capitalization and
            punctuation, or ``None`` if the pattern is unknown or any
            required slot cannot be resolved.
        """
        try:
            return await self._assemble_inner(pattern_id, bindings)
        except Exception:
            logger.warning(
                "Sentence assembly failed for pattern '%s' with bindings %s",
                pattern_id,
                bindings,
                exc_info=True,
            )
            return None

    async def find_speakable_facts(self, limit: int = 5) -> list[dict[str, object]]:
        """Query the graph for facts Co-Being can speak about.

        Returns a list of dicts, each containing:

        - ``pattern_id``: which pattern to use.
        - ``bindings``: slot bindings for the pattern.
        - ``confidence``: how confident Co-Being is in this fact.

        Queries for:

        1. IS_A edges (X is a Y) -- ``state_fact_copular`` pattern.
        2. HAS_PROPERTY edges (X is [adj]) -- ``state_has_property`` pattern.
        3. WordSenseNode nodes with few edges -- ``ask_to_teach`` pattern.

        Args:
            limit: Maximum number of speakable facts to return.

        Returns:
            A list of speakable fact dicts, sorted by confidence
            descending. May be empty if the graph has no speakable facts.
        """
        facts: list[dict[str, object]] = []

        try:
            facts.extend(await self._find_is_a_facts(limit))
            facts.extend(await self._find_has_property_facts(limit))
            facts.extend(await self._find_teachable_topics(limit))
        except Exception:
            logger.warning(
                "Error querying speakable facts", exc_info=True,
            )

        # Sort by confidence descending, take top N.
        facts.sort(key=lambda f: float(f.get("confidence", 0.0)), reverse=True)
        return facts[:limit]

    # ------------------------------------------------------------------
    # Internal assembly pipeline
    # ------------------------------------------------------------------

    async def _assemble_inner(
        self,
        pattern_id: str,
        bindings: dict[str, str],
    ) -> str | None:
        """Core assembly logic, separated so ``assemble`` can catch all errors."""
        pattern = CONVERSATION_PATTERNS.get(pattern_id)
        if pattern is None:
            logger.warning("Unknown conversation pattern: '%s'", pattern_id)
            return None

        # For patterns with no slots (e.g., greet_response), return directly.
        if not pattern.slot_roles:
            sentence = _capitalize_first(pattern.template)
            logger.info(
                "Assembled sentence (no slots): pattern='%s' result='%s'",
                pattern_id,
                sentence,
            )
            return sentence

        # Check that all required slots have bindings.
        missing = set(pattern.slot_roles.keys()) - set(bindings.keys())
        if missing:
            logger.warning(
                "Missing bindings for pattern '%s': %s",
                pattern_id,
                missing,
            )
            return None

        # Resolve each slot to a display string.
        resolved: dict[str, str] = {}
        for slot_name, node_id in bindings.items():
            role = pattern.slot_roles.get(slot_name, "any")
            display = await self._resolve_slot(node_id, role)
            if display is None:
                logger.warning(
                    "Could not resolve slot '%s' (node_id='%s', role='%s') "
                    "for pattern '%s'",
                    slot_name,
                    node_id,
                    role,
                    pattern_id,
                )
                return None
            resolved[slot_name] = display

        # Interpolate into the template.
        sentence = pattern.template.format(**resolved)
        sentence = _capitalize_first(sentence)

        logger.info(
            "Assembled sentence: pattern='%s' result='%s'",
            pattern_id,
            sentence,
        )
        return sentence

    # ------------------------------------------------------------------
    # Slot resolution
    # ------------------------------------------------------------------

    async def _resolve_slot(self, node_id: str, role: str) -> str | None:
        """Resolve a node_id to a displayable string for the given role.

        Args:
            node_id: Graph node identifier, or a raw string for numbers.
            role: Expected grammatical role from the pattern's slot_roles.

        Returns:
            A display string suitable for insertion into a sentence
            template, or ``None`` if the node cannot be found.
        """
        if role == "number":
            # Numbers are passed as raw strings, no graph lookup needed.
            return node_id

        if role == "adjective":
            return await self._resolve_adjective(node_id)

        if role in ("noun", "noun_or_adj"):
            return await self._resolve_noun(node_id, add_article=(role == "noun"))

        # Fallback for "any" or unknown roles: try noun without article.
        return await self._resolve_noun(node_id, add_article=False)

    async def _resolve_noun(
        self,
        node_id: str,
        add_article: bool = True,
    ) -> str | None:
        """Look up a WordSense, WordForm, or Concept node and return its spelling.

        For nouns, optionally prepends "a" or "an" based on the first letter.

        Args:
            node_id: The graph node identifier to look up.
            add_article: Whether to prepend an indefinite article.

        Returns:
            The spelling string (with optional article), or ``None`` if
            the node cannot be found or has no spelling.
        """
        spelling = await self._get_spelling(node_id)
        if spelling is None:
            return None

        if add_article:
            return _add_article(spelling)
        return spelling

    async def _resolve_adjective(self, node_id: str) -> str | None:
        """Look up a WordSense node and return its spelling (no article).

        Args:
            node_id: The graph node identifier to look up.

        Returns:
            The spelling string, or ``None`` if the node cannot be found.
        """
        return await self._get_spelling(node_id)

    async def _get_spelling(self, node_id: str) -> str | None:
        """Extract a display spelling from a graph node.

        Checks, in order:
        1. ``properties["spelling"]`` -- used by WordSenseNode and WordFormNode.
        2. ``properties["name"]`` -- used by ConceptPrimitive and SchemaType nodes.
        3. ``properties["label_raw"]`` -- used by ObjectInstance nodes.

        Args:
            node_id: The node to look up in the graph.

        Returns:
            The spelling/name string, or ``None`` if the node does not
            exist or has no usable display property.
        """
        from cobeing.shared.types import NodeId as _NodeId

        node = await self._persistence.get_node(_NodeId(node_id))
        if node is None:
            return None

        props = node.properties
        for key in ("spelling", "name", "label_raw"):
            value = props.get(key)
            if isinstance(value, str) and value:
                return value

        return None

    # ------------------------------------------------------------------
    # Speakable fact queries
    # ------------------------------------------------------------------

    async def _find_is_a_facts(
        self, limit: int,
    ) -> list[dict[str, object]]:
        """Find IS_A edges and produce state_fact_copular bindings.

        Example: cat IS_A animal -> "A cat is an animal."
        """
        edges = await self._persistence.query_edges(
            EdgeFilter(edge_type=IS_A, min_confidence=0.5),
        )

        facts: list[dict[str, object]] = []
        for edge in edges[:limit * 2]:
            facts.append({
                "pattern_id": "state_fact_copular",
                "bindings": {
                    "subject": str(edge.source_id),
                    "predicate": str(edge.target_id),
                },
                "confidence": edge.confidence,
            })

        return facts[:limit]

    async def _find_has_property_facts(
        self, limit: int,
    ) -> list[dict[str, object]]:
        """Find HAS_PROPERTY edges and produce state_has_property bindings.

        Example: apple HAS_PROPERTY red -> "An apple is red."
        """
        edges = await self._persistence.query_edges(
            EdgeFilter(edge_type=HAS_PROPERTY, min_confidence=0.5),
        )

        facts: list[dict[str, object]] = []
        for edge in edges[:limit * 2]:
            facts.append({
                "pattern_id": "state_has_property",
                "bindings": {
                    "subject": str(edge.source_id),
                    "property": str(edge.target_id),
                },
                "confidence": edge.confidence,
            })

        return facts[:limit]

    async def _find_teachable_topics(
        self, limit: int,
    ) -> list[dict[str, object]]:
        """Find WordSenseNode nodes that have few edges -- things to ask about.

        These become ask_to_teach patterns: "Can you teach me about X?"
        """
        nodes = await self._persistence.query_nodes(
            NodeFilter(node_type=WORD_SENSE_NODE),
        )

        # Count outgoing edges per node to find "thin" nodes.
        facts: list[dict[str, object]] = []
        for node in nodes:
            outgoing = await self._persistence.query_edges(
                EdgeFilter(source_node_id=str(node.node_id)),
            )
            if len(outgoing) <= 1:
                facts.append({
                    "pattern_id": "ask_to_teach",
                    "bindings": {"topic": str(node.node_id)},
                    "confidence": 0.3,
                })
            if len(facts) >= limit:
                break

        return facts


# ---------------------------------------------------------------------------
# Module-level helper functions
# ---------------------------------------------------------------------------


def _capitalize_first(sentence: str) -> str:
    """Capitalize the first letter of a sentence, preserving the rest.

    Args:
        sentence: The sentence to capitalize.

    Returns:
        The sentence with its first character uppercased. Returns the
        original string unchanged if it is empty.
    """
    if not sentence:
        return sentence
    return sentence[0].upper() + sentence[1:]


def _add_article(spelling: str) -> str:
    """Prepend 'a' or 'an' before a noun based on its first letter.

    Uses a simple vowel-initial heuristic. This does not handle all
    English edge cases (e.g., "a unicorn", "an hour"), but is sufficient
    for the current vocabulary. More sophisticated article selection can
    be added as the language layer matures.

    Args:
        spelling: The noun spelling to prepend an article to.

    Returns:
        The spelling with "a " or "an " prepended.
    """
    if not spelling:
        return spelling

    if spelling[0] in _VOWELS:
        return f"an {spelling}"
    return f"a {spelling}"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

__all__ = [
    "CONVERSATION_PATTERNS",
    "ConversationPattern",
    "SentenceAssembler",
]
