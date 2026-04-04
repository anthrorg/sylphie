"""Consolidated SemanticFact dataclass for semantic query procedures (P1.8-E3/T007).

Defines the unified fact representation consumed by all three semantic query
procedures (definition_query, classification_query, inference_query) and by
PT-11 for narration. Every fact retrieved from a semantic graph traversal is
wrapped in a SemanticFact before being passed to downstream consumers.

Design decisions from agent discussion T2.2 (discussion-resolutions-final.md):

  Included fields (7 beyond core identity):
    - confidence, base_confidence (confidence layer)
    - scope_context_count, depth_from_subject (traversal metadata)
    - activation_contributed (retrieval flag for PT-11 Rule 4 hedging)
    - domain, cross_domain (domain provenance per A.20)
    - inference_chain_confirmed (chain status)

  Excluded fields (belong elsewhere):
    - centrality_score: stored on graph nodes, not on individual facts
    - error_count: tracked by circuit breaker, not per-fact
    - node IDs of inference chain: stored in SemanticInferenceTrace (T001)

The hedging_level property implements Meridian's PT-11 deterministic hedging
ladder. PT-11 uses this to select hedging language without LLM judgment.
The ladder is fully deterministic: the same field combination always produces
the same hedging level. This prevents the LLM from over- or under-hedging.

Hedging ladder (4 levels, most confident to least):

  Level 0 -- DEFINITE:
    scope_context_count >= 3 AND NOT activation_contributed AND confidence >= 0.7
    Language: direct assertion ("A cat is a mammal.")

  Level 1 -- CONFIDENT:
    confidence >= 0.7 AND NOT activation_contributed
    (scope_context_count < 3 -- situated knowledge, not yet categorical)
    Language: mild qualification ("A cat is a mammal, as far as I've learned.")

  Level 2 -- HEDGED:
    confidence >= 0.5 AND (activation_contributed OR depth_from_subject >= 2)
    Language: explicit uncertainty ("I think cats might be mammals...")

  Level 3 -- SPECULATIVE:
    confidence < 0.5, OR (activation_contributed AND depth_from_subject >= 2)
    Language: strong hedging ("I'm not very confident, but...")

Phase 1.8 (Comprehension Layer, P1.8-E3/T007).
CANON A.1 (experience-first), A.12 (grounding), A.20 (domain structure).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import IntEnum
from typing import Literal


# ---------------------------------------------------------------------------
# Hedging level enum
# ---------------------------------------------------------------------------


class HedgingLevel(IntEnum):
    """Deterministic hedging level for PT-11 narration.

    The integer value is ordered from most confident (0) to least (3).
    PT-11 uses this to select appropriate hedging language without relying
    on the LLM's own judgment about when to hedge.

    The levels correspond to specific field combinations on SemanticFact.
    See the module docstring for the full ladder specification.
    """

    DEFINITE = 0
    """Direct assertion. No hedging language required.

    Conditions: scope_context_count >= 3 AND NOT activation_contributed
    AND confidence >= 0.7.

    This is categorical knowledge confirmed across multiple contexts.
    PT-11 presents it as established fact.
    """

    CONFIDENT = 1
    """Mild qualification. Fact is reliable but not fully categorical.

    Conditions: confidence >= 0.7 AND NOT activation_contributed.
    (Reached when scope_context_count < 3.)

    PT-11 adds a light qualifier: "as far as I've learned", "from what
    I know". Does not use "I think" or "maybe".
    """

    HEDGED = 2
    """Explicit uncertainty. Fact may be unreliable.

    Conditions: confidence >= 0.5 AND (activation_contributed OR
    depth_from_subject >= 2).

    PT-11 uses hedging phrases: "I think", "I believe", "I'm not
    entirely certain but". Signals to the guardian that the system is
    less sure.
    """

    SPECULATIVE = 3
    """Strong hedging. Fact is near the confidence floor.

    Conditions: confidence < 0.5, OR (activation_contributed AND
    depth_from_subject >= 2).

    PT-11 uses strong disclaimers: "I'm not very confident about this",
    "this might not be right". Actively invites guardian correction.
    """


# ---------------------------------------------------------------------------
# Domain type literal
# ---------------------------------------------------------------------------

DomainName = Literal["language", "math", "abstract", "semantic"]
"""Valid domain names per CANON A.20.

'language' -- LanguageDomain (morphology, syntax, word forms).
'math'     -- MathDomain (arithmetic, value nodes, computations).
'abstract' -- AbstractDomain (convergence zone: integer, set, operation).
'semantic' -- SemanticDomain (declarative semantic knowledge: IS_A, HAS_PROPERTY, etc.).
"""

# Default categorical threshold matching scope_context_mechanics.py.
# Used only as the default for the hedging ladder computation.
# The authoritative threshold lives in the EvolutionRule graph node.
_DEFAULT_CATEGORICAL_THRESHOLD: int = 3


# ---------------------------------------------------------------------------
# SemanticFact dataclass
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SemanticFact:
    """A single semantic fact retrieved by a query procedure.

    This is the canonical representation of one (subject, edge, object) triple
    enriched with confidence, traversal, activation, and domain metadata. It is
    the unit of exchange between:

      - Semantic query procedures (definition, classification, inference) which
        produce lists of SemanticFact instances.
      - PT-11 narration prompt which consumes SemanticFact instances and uses
        the hedging_level property to control language certainty.
      - SemanticQueryHandler which aggregates facts into SemanticQueryResult.

    All fields are immutable (frozen=True). SemanticFact instances are created
    by the query procedures during graph traversal and are never modified after
    creation.

    Core identity (the triple):
        source_node_id: NodeId of the subject WordSenseNode.
        edge_type: Semantic edge type string (one of VALID_SEMANTIC_EDGE_TYPES).
        target_node_id: NodeId of the object WordSenseNode.

    Confidence layer:
        confidence: Effective confidence at retrieval time. This may include
            activation boost if spreading activation was applied. Range [0.0, 1.0].
        base_confidence: The stored confidence on the graph edge BEFORE any
            activation boost was applied. Used by PT-11 to distinguish between
            intrinsic confidence and activation-inflated confidence. When no
            activation boost was applied, base_confidence == confidence.

    Traversal metadata:
        scope_context_count: How many distinct conversational contexts have
            referenced this fact. Implements the Piagetian situated-to-categorical
            progression. 1 = situated (single context), >= threshold = categorical.
        depth_from_subject: Number of hops from the query origin node to this
            fact. 0 = directly connected to the subject. >= 1 = inherited through
            IS_A or PART_OF chain traversal.

    Retrieval flag:
        activation_contributed: True when spreading activation boosted this
            fact's effective confidence above the confidence floor (i.e., the
            fact would NOT have been retrieved without the activation boost).
            PT-11 Rule 4 requires hedging language for these facts.

    Domain provenance (CANON A.20):
        domain: Which knowledge domain this fact belongs to.
        cross_domain: True when the fact crosses a domain boundary (e.g.,
            a DENOTES edge between LanguageDomain and SemanticDomain).

    Chain status:
        inference_chain_confirmed: True when every edge in the inference chain
            leading to this fact has been individually confirmed by the guardian.
            False when any edge in the chain is unconfirmed. Only meaningful for
            facts at depth_from_subject >= 1 (inherited facts). For directly
            asserted facts (depth 0), this reflects the guardian_confirmed
            property on the edge itself.

    Human-readable labels (for PT-11 serialization):
        source_label: Human-readable label for the source node (typically the
            spelling property of the WordSenseNode).
        target_label: Human-readable label for the target node.
        property_type: Sub-classification for HAS_PROPERTY edges ('sensory',
            'functional', 'categorical'). Empty string for other edge types.

    Attributes:
        categorical_threshold: The scope_context_count threshold used when
            computing the hedging level. Defaults to 3 (the system default).
            Callers should pass the current value from the EvolutionRule node
            when constructing facts so the hedging ladder uses the guardian-tuned
            threshold.
    """

    # --- Core identity ---
    source_node_id: str
    edge_type: str
    target_node_id: str

    # --- Confidence layer ---
    confidence: float
    base_confidence: float

    # --- Traversal metadata ---
    scope_context_count: int
    depth_from_subject: int

    # --- Retrieval flag ---
    activation_contributed: bool

    # --- Domain provenance (A.20) ---
    domain: DomainName
    cross_domain: bool

    # --- Chain status ---
    inference_chain_confirmed: bool

    # --- Human-readable labels ---
    source_label: str = field(default="")
    target_label: str = field(default="")
    property_type: str = field(default="")

    # --- Hedging computation parameter ---
    categorical_threshold: int = field(default=_DEFAULT_CATEGORICAL_THRESHOLD)

    # ------------------------------------------------------------------
    # Hedging ladder
    # ------------------------------------------------------------------

    @property
    def hedging_level(self) -> HedgingLevel:
        """Compute the deterministic hedging level for PT-11 narration.

        The ladder evaluates field combinations in order from most confident
        to least. The first matching level is returned. This is a pure
        function of the fact's fields -- no LLM judgment, no randomness.

        Returns:
            HedgingLevel enum value (DEFINITE, CONFIDENT, HEDGED, or SPECULATIVE).
        """
        # Level 3 (SPECULATIVE): low confidence or deep + activation-boosted
        if self.confidence < 0.5:
            return HedgingLevel.SPECULATIVE
        if self.activation_contributed and self.depth_from_subject >= 2:
            return HedgingLevel.SPECULATIVE

        # Level 2 (HEDGED): moderate confidence with activation or depth
        if self.activation_contributed or self.depth_from_subject >= 2:
            # confidence >= 0.5 guaranteed by the Level 3 checks above
            return HedgingLevel.HEDGED

        # Level 0 (DEFINITE): high confidence, categorical, no activation
        if (
            self.confidence >= 0.7
            and not self.activation_contributed
            and self.scope_context_count >= self.categorical_threshold
        ):
            return HedgingLevel.DEFINITE

        # Level 1 (CONFIDENT): high confidence but not yet categorical
        if self.confidence >= 0.7 and not self.activation_contributed:
            return HedgingLevel.CONFIDENT

        # Fallback: confidence in [0.5, 0.7), no activation, shallow depth
        # This is a legitimate intermediate state -- the fact is above the
        # confidence floor but below the "confident" threshold. Treat as HEDGED.
        return HedgingLevel.HEDGED

    # ------------------------------------------------------------------
    # Serialization for PT-11
    # ------------------------------------------------------------------

    def serialize_for_pt11(self) -> str:
        """Serialize this fact into the compact format PT-11 expects.

        The format matches Section 3.2 of Meridian's E3 analysis:
        one line per fact with inline metadata. PT-11 is instructed to
        present only what appears in this serialization.

        Returns:
            A single-line string representation of this fact suitable for
            inclusion in a PT-11 prompt's <query_result> block.

        Example output::

            - IS_A mammal [confidence: 0.88, direct assertion, context_count: 3]
            - HAS_PROPERTY(sensory) red [confidence: 0.79, inherited, depth: 2, activation_contributed: true]
        """
        parts: list[str] = []

        # Edge type with optional property_type qualifier
        if self.property_type:
            parts.append(f"{self.edge_type}({self.property_type})")
        else:
            parts.append(self.edge_type)

        # Target label
        parts.append(self.target_label or self.target_node_id)

        # Metadata bracket
        meta: list[str] = []
        meta.append(f"confidence: {self.confidence:.2f}")

        # Assertion type: direct vs inherited
        if self.depth_from_subject == 0:
            meta.append("direct assertion")
        else:
            meta.append(f"inherited, depth: {self.depth_from_subject}")

        meta.append(f"context_count: {self.scope_context_count}")

        if self.activation_contributed:
            meta.append("activation_contributed: true")

        if self.cross_domain:
            meta.append("cross_domain: true")

        if not self.inference_chain_confirmed and self.depth_from_subject >= 1:
            meta.append("chain_unconfirmed")

        parts.append(f"[{', '.join(meta)}]")

        return "- " + " ".join(parts)

    # ------------------------------------------------------------------
    # Factory from SemanticTraversalRow
    # ------------------------------------------------------------------

    @classmethod
    def from_traversal_row(
        cls,
        row: object,
        *,
        domain: DomainName = "semantic",
        cross_domain: bool = False,
        activation_contributed: bool = False,
        activation_boost: float = 0.0,
        inference_chain_confirmed: bool = True,
        categorical_threshold: int = _DEFAULT_CATEGORICAL_THRESHOLD,
    ) -> SemanticFact:
        """Create a SemanticFact from a SemanticTraversalRow.

        This factory method bridges the existing query infrastructure
        (SemanticTraversalRow from semantic_query.py) to the consolidated
        SemanticFact format. Query procedures call this after retrieving
        rows from the graph.

        The ``row`` parameter is typed as ``object`` to avoid a circular import
        with semantic_query.py. At runtime it must be a SemanticTraversalRow
        instance with the expected attributes. Accessing attributes via getattr
        keeps the import boundary clean.

        Args:
            row: A SemanticTraversalRow instance from a graph traversal.
            domain: Knowledge domain this fact belongs to.
            cross_domain: Whether this fact crosses a domain boundary.
            activation_contributed: Whether spreading activation boosted this
                fact above the confidence floor.
            activation_boost: The activation boost amount applied to the
                base confidence. base_confidence = edge_confidence - activation_boost.
            inference_chain_confirmed: Whether every edge in the chain to this
                fact has been guardian-confirmed.
            categorical_threshold: Current categorical knowledge threshold from
                the EvolutionRule node.

        Returns:
            A new SemanticFact instance.

        Raises:
            AttributeError: If ``row`` does not have the expected attributes
                of a SemanticTraversalRow.
        """
        edge_confidence: float = getattr(row, "edge_confidence")
        base_confidence = max(0.0, edge_confidence - activation_boost)

        return cls(
            source_node_id=getattr(row, "subject_node_id"),
            edge_type=getattr(row, "edge_type"),
            target_node_id=getattr(row, "object_node_id"),
            confidence=edge_confidence,
            base_confidence=base_confidence,
            scope_context_count=getattr(row, "scope_context_count"),
            depth_from_subject=getattr(row, "hop_depth"),
            activation_contributed=activation_contributed,
            domain=domain,
            cross_domain=cross_domain,
            inference_chain_confirmed=inference_chain_confirmed,
            source_label=getattr(row, "subject_spelling", ""),
            target_label=getattr(row, "object_spelling", ""),
            property_type=getattr(row, "property_type", ""),
            categorical_threshold=categorical_threshold,
        )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

__all__ = [
    "DomainName",
    "HedgingLevel",
    "SemanticFact",
]
