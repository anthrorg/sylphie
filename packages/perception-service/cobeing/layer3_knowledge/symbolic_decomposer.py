"""Symbolic decomposer -- converts utterances to primitive activation vectors.

Phase 3 of the conversation engine (docs/decisions/cobeing-foundational-architecture_3.md §2.6).

At runtime, decomposition does NOT require the LLM. When a word arrives, its
MEANS edges are traversed and the connected primitive activations are collected
with their confidence weights. Decomposition becomes graph lookup, not inference.

For each word in the utterance:
  1. Strip punctuation (same normalization as InputParser).
  2. Query MEANS edges from the WordNode to PrimitiveSymbolNodes.
  3. Compute activation: confidence * weight for each MEANS edge.
  4. A word with no MEANS edges is an epistemic gap.

Aggregate across words:
  - For each primitive, take the maximum activation across all words that
    activate it. Words that know nothing about a primitive leave it at 0.0.
  - comprehension_ratio = grounded_word_count / total_word_count.

Cold-start behaviour: Before grounding_maintenance.py has proposed any MEANS
edges, every word will be an epistemic gap. This is expected -- it is the
infant state by design. The decomposer reports gaps honestly.

CANON references:
    A.12 -- No NLP in CB's cognition path. Pure graph traversal only.
    Conversation engine §2.6 -- runtime decomposition is graph lookup.
    Conversation engine §3 -- partial comprehension is explicit.

Debugging quick-ref:
    - If all words are gaps: check grounding_maintenance ran and MEANS edges exist
    - If activation is all 0.0: check edge.properties has 'weight' key
    - If word not found in graph: WordNode may not exist yet (new word)

Changed: Phase 3 (initial)
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from cobeing.layer3_knowledge.primitive_bootstrap import PRIMITIVE_NODE_IDS
from cobeing.layer3_knowledge.query_types import EdgeFilter
from cobeing.shared.types import NodeId

if TYPE_CHECKING:
    from cobeing.layer3_knowledge.protocols import GraphPersistence

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Minimum edge confidence for a primitive activation to count as grounded.
GROUNDING_CONFIDENCE_THRESHOLD: float = 0.15

#: Primitive names for human-readable gap reporting (bare name, not full ID).
_PRIMITIVE_ID_TO_NAME: dict[str, str] = {
    pid: pid.split(":")[-1].replace("_", " ").title()
    for pid in PRIMITIVE_NODE_IDS
}
# e.g. "primitive:self_other" → "Self Other"


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class WordActivation:
    """Primitive activation pattern for a single word.

    Attributes:
        word: Normalized word text (e.g., ``"hello"``).
        word_node_id: Graph node ID (e.g., ``"word:hello"``).
        activation: Map of primitive node ID → activation score (0.0-1.0).
            Activation = edge.confidence * edge.properties["weight"].
            Empty dict if the word has no MEANS edges (epistemic gap).
        is_grounded: True if at least one primitive activation exceeds
            :data:`GROUNDING_CONFIDENCE_THRESHOLD`.
    """

    word: str
    word_node_id: str
    activation: dict[str, float] = field(default_factory=dict)
    is_grounded: bool = False


@dataclass(frozen=True)
class DecompositionResult:
    """Primitive activation result for a full utterance.

    Attributes:
        utterance: The original input text.
        tokens: Normalized tokens extracted from the utterance.
        word_activations: Per-word activation records (one per non-empty token).
        aggregate_activation: Utterance-level primitive map. For each primitive,
            the maximum activation across all words in the utterance.
        epistemic_gaps: Words that have no MEANS edges or all activations
            below threshold. These are the unknowns driving clarifying questions.
        grounded_words: Words with at least one confident MEANS edge.
        comprehension_ratio: Fraction of words that are grounded (0.0-1.0).
            0.0 = complete ignorance (cold start). 1.0 = full comprehension.
        dominant_primitives: Primitives with aggregate activation >= 0.3,
            sorted by activation descending. These characterise the utterance.
        missing_primitives: Primitives that appear in the expected set for
            this utterance type but have 0.0 activation. Used to formulate
            precise clarifying questions.
    """

    utterance: str
    tokens: list[str] = field(default_factory=list)
    word_activations: list[WordActivation] = field(default_factory=list)
    aggregate_activation: dict[str, float] = field(default_factory=dict)
    epistemic_gaps: list[str] = field(default_factory=list)
    grounded_words: list[str] = field(default_factory=list)
    comprehension_ratio: float = 0.0
    dominant_primitives: list[str] = field(default_factory=list)
    missing_primitives: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Decomposer
# ---------------------------------------------------------------------------


class SymbolicDecomposer:
    """Converts text utterances to primitive activation patterns.

    Instantiate once and reuse across multiple calls. The persistence
    backend is queried via EdgeFilter for MEANS edges -- no new persistence
    methods required.

    Args:
        persistence: Graph persistence backend. Must have MEANS edges seeded
            by ``grounding_maintenance.py`` for words to activate primitives.
    """

    def __init__(self, persistence: GraphPersistence) -> None:
        self._persistence = persistence

    async def decompose(self, utterance: str) -> DecompositionResult:
        """Decompose an utterance into a primitive activation pattern.

        Args:
            utterance: The raw input text (guardian utterance or trigger).

        Returns:
            :class:`DecompositionResult` with per-word activations and
            the aggregate utterance activation pattern.
        """
        # Tokenise identically to InputParser (no NLP, CANON A.12)
        raw_tokens = utterance.lower().split()
        tokens = [
            t.strip(".,!?;:'\"()[]{}").strip()
            for t in raw_tokens
        ]
        tokens = [t for t in tokens if t]

        if not tokens:
            return DecompositionResult(utterance=utterance)

        # Per-word activation
        word_activations: list[WordActivation] = []
        for word in tokens:
            activation = await self._compute_word_activation(word)
            is_grounded = any(
                v >= GROUNDING_CONFIDENCE_THRESHOLD
                for v in activation.values()
            )
            word_activations.append(WordActivation(
                word=word,
                word_node_id=f"word:{word}",
                activation=activation,
                is_grounded=is_grounded,
            ))

        # Aggregate: max activation per primitive across all words
        aggregate: dict[str, float] = {pid: 0.0 for pid in PRIMITIVE_NODE_IDS}
        for wa in word_activations:
            for primitive_id, score in wa.activation.items():
                if score > aggregate.get(primitive_id, 0.0):
                    aggregate[primitive_id] = score

        # Epistemic gaps and grounded words
        gaps = [wa.word for wa in word_activations if not wa.is_grounded]
        grounded = [wa.word for wa in word_activations if wa.is_grounded]

        total = len(word_activations)
        comprehension_ratio = len(grounded) / total if total > 0 else 0.0

        # Dominant primitives (activation >= 0.3)
        dominant = [
            pid for pid, score in sorted(
                aggregate.items(), key=lambda x: x[1], reverse=True
            )
            if score >= 0.3
        ]

        # Missing primitives: expected but 0.0 activation
        missing = [
            pid for pid, score in aggregate.items()
            if score == 0.0
        ]

        logger.debug(
            "symbolic_decompose utterance_len=%d tokens=%d grounded=%d gaps=%d "
            "comprehension=%.2f dominant=%s",
            len(utterance),
            total,
            len(grounded),
            len(gaps),
            comprehension_ratio,
            [_PRIMITIVE_ID_TO_NAME.get(p, p) for p in dominant[:3]],
        )

        return DecompositionResult(
            utterance=utterance,
            tokens=tokens,
            word_activations=word_activations,
            aggregate_activation=aggregate,
            epistemic_gaps=gaps,
            grounded_words=grounded,
            comprehension_ratio=comprehension_ratio,
            dominant_primitives=dominant,
            missing_primitives=missing,
        )

    async def _compute_word_activation(self, word: str) -> dict[str, float]:
        """Compute primitive activation for a single word via MEANS edges.

        Args:
            word: Normalized word text.

        Returns:
            Dict of ``{primitive_node_id: activation_score}``.
            Empty dict if no MEANS edges exist (epistemic gap).
        """
        word_node_id = f"word:{word}"
        activation: dict[str, float] = {}

        try:
            means_edges = await self._persistence.query_edges(
                EdgeFilter(
                    edge_type="MEANS",
                    source_node_id=word_node_id,
                )
            )
        except Exception as exc:
            logger.debug(
                "decompose_means_query_failed word=%s error=%s", word, exc
            )
            return activation

        for edge in means_edges:
            primitive_id = str(edge.target_id)
            weight = float(edge.properties.get("weight", 0.5))
            confidence = float(edge.confidence)
            score = confidence * weight
            if score > activation.get(primitive_id, 0.0):
                activation[primitive_id] = score

        return activation


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def primitive_name(node_id: str) -> str:
    """Return a human-readable name for a primitive node ID.

    Args:
        node_id: Full primitive node ID (e.g., ``"primitive:self_other"``).

    Returns:
        Display name (e.g., ``"Self Other"``).
    """
    return _PRIMITIVE_ID_TO_NAME.get(node_id, node_id)


def format_activation_summary(
    aggregate: dict[str, float],
    gaps: list[str],
) -> str:
    """Format a compact private-register summary of the activation state.

    Args:
        aggregate: Aggregate activation per primitive.
        gaps: Ungrounded words.

    Returns:
        Compressed inner-register string (not for guardian display).
    """
    active = [
        f"{primitive_name(pid)}={score:.2f}"
        for pid, score in sorted(
            aggregate.items(), key=lambda x: x[1], reverse=True
        )
        if score >= 0.1
    ]
    gap_str = f" gaps=[{', '.join(gaps[:5])}]" if gaps else ""
    active_str = f"active=[{', '.join(active[:5])}]" if active else "active=[]"
    return f"{active_str}{gap_str}"


__all__ = [
    "GROUNDING_CONFIDENCE_THRESHOLD",
    "DecompositionResult",
    "SymbolicDecomposer",
    "WordActivation",
    "format_activation_summary",
    "primitive_name",
]
