"""Definition query executor for the Co-Being knowledge graph (P1.8-E3/T003).

Implements the ``proc:definition_query`` ProceduralTemplate that answers
"what is X?" questions through semantic graph traversal. This is the first
query type in the developmental sequence (D4: definition -> classification ->
inference), enabled at bootstrap with no gating prerequisites.

Architecture:

  1. Resolve the query subject to a WordSenseNode via DENOTES bridge if needed.
  2. Collect all semantic edges radiating from the subject node, organized
     by edge type (IS_A, HAS_PROPERTY, PART_OF, USED_FOR, etc.).
  3. Score each fact for typicality -- how central it is to defining the
     concept -- using a principled ranking algorithm.
  4. Apply spreading activation boost if an activation map is provided.
  5. Record a SemanticInferenceTrace (A.19 compliance).
  6. Return a DefinitionQueryResult with ranked facts.

Typicality scoring algorithm (Rosch, 1975; Smith & Medin, 1981):

  The typicality score ranks facts by their definitional centrality:
  how useful each fact is for answering "what is X?" A fact with high
  typicality is one that most people would mention first when describing
  the concept.

  Four factors contribute to typicality:

  1. Edge type weight (0.0-1.0):
     IS_A edges carry the highest weight (0.40) because taxonomic
     membership is the most defining attribute of a concept. HAS_PROPERTY
     is next (0.25), then PART_OF (0.20), then functional/causal types
     (0.15 each), then symmetric types (0.10 each).

  2. Scope context count factor (0.0-1.0):
     Facts confirmed across more conversational contexts are more likely
     to be defining properties. Capped at the categorical threshold.
     Computed as min(scope_context_count, threshold) / threshold.

  3. Confidence factor (0.0-1.0):
     Higher-confidence facts rank higher. Direct value from edge.

  4. Activation boost (0.0-0.2):
     When spreading activation is enabled, recently-activated facts
     get a small boost reflecting conversational relevance.

  Final typicality = (edge_weight * 0.35) + (scope_factor * 0.30)
                   + (confidence * 0.25) + (activation_boost * 0.10)

Cross-domain DENOTES traversal (selective, not unconditional):

  The definition query follows DENOTES edges to resolve a WordSenseNode
  to its SemanticDomain concept IF AND ONLY IF the WordSenseNode itself
  has zero semantic edges. This prevents unconditional DENOTES traversal
  which would double every query's fan-out. When semantic edges exist
  directly on the WordSenseNode, they are used without DENOTES indirection.

Depth governance (from discussion-resolutions-final.md T1.2):

  definition_query gets depth=5 from launch because its working memory
  load is independent-per-level, not cumulative. The actual safety
  constraint is the token budget (600 tokens), not depth. Definition
  traversal stops when output reaches the budget.

  The rule:definition_depth_config EvolutionRule node carries:
    current_max_depth: 5
    token_budget_tokens: 600
    auto_truncate_at_budget: true

CANON compliance:
  A.1   -- all facts come from guardian teaching or sensor observation
  A.10  -- bounded traversal (max_depth from EvolutionRule, token budget)
  A.11  -- provenance on every node and edge
  A.12  -- LLM never sees raw graph; receives only the result object
  A.19  -- SemanticInferenceTrace recorded per query
  A.20  -- cross-domain DENOTES traversal respects domain boundaries

Usage::

    from cobeing.layer3_knowledge.definition_query import (
        DefinitionQueryExecutor,
        DefinitionQueryRequest,
        DefinitionQueryResult,
        DefinitionFact,
    )

    executor = DefinitionQueryExecutor(
        persistence=graph,
        neo4j_session=session,
        trace_writer=trace_writer,
    )

    result = await executor.execute(
        DefinitionQueryRequest(
            subject_node_id="word:cat:1",
            session_id="session-001",
            correlation_id="q-001",
        )
    )

    for fact in result.facts:
        print(f"{fact.edge_type}: {fact.object_spelling} "
              f"(typicality={fact.typicality_score:.2f})")
"""

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import neo4j

from cobeing.layer3_knowledge.constants import MAX_TRAVERSAL_DEPTH
from cobeing.layer3_knowledge.exceptions import KnowledgeGraphError
from cobeing.layer3_knowledge.inference_trace import (
    InferenceTraceWriter,
    ReasoningStep,
    TerminationReason,
)
from cobeing.layer3_knowledge.language_types import DENOTES, WORD_SENSE_NODE
from cobeing.layer3_knowledge.node_types import (
    KnowledgeNode,
    NodeStatus,
    SchemaLevel,
)
from cobeing.layer3_knowledge.procedure_types import PROCEDURAL_TEMPLATE
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.query_types import EdgeFilter, NodeFilter
from cobeing.layer3_knowledge.semantic_query import (
    MIN_CONFIDENCE_FLOOR,
    SemanticQueryConstraints,
    SemanticQueryResult,
    SemanticTraversalRow,
    query_active_semantic_edges,
    query_is_a_ancestors,
    query_has_property_edges,
    query_by_edge_type,
)
from cobeing.layer3_knowledge.semantic_types import (
    CAUSES,
    CONSUMES,
    ENABLES,
    HAS_PROPERTY,
    IS_A,
    LACKS_PROPERTY,
    LOCATED_IN,
    OPPOSITE_OF,
    PART_OF,
    PREVENTS,
    PRODUCES,
    REQUIRES,
    ACHIEVES,
    SIMILAR_TO,
    USED_FOR,
)
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import EdgeId, NodeId

_log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFINITION_QUERY_TEMPLATE_ID = NodeId("proc:definition_query")
"""NodeId of the definition_query ProceduralTemplate in the graph."""

DEFINITION_QUERY_TEMPLATE_NAME = "definition_query"
"""Human-readable template name for the definition query procedure."""

DEFINITION_DEPTH_RULE_ID = NodeId("rule:definition_depth_config")
"""NodeId of the EvolutionRule governing definition query depth."""

# Default depth config (from discussion-resolutions-final.md T1.2)
DEFAULT_DEFINITION_MAX_DEPTH: int = 5
DEFAULT_TOKEN_BUDGET: int = 600

# Edge type weights for typicality scoring (Rosch, 1975)
# Higher weight = more definitionally central
_EDGE_TYPE_WEIGHTS: dict[str, float] = {
    IS_A: 0.40,           # Taxonomic membership is most defining
    HAS_PROPERTY: 0.25,   # Properties are next
    PART_OF: 0.20,        # Structural composition
    USED_FOR: 0.15,       # Functional purpose
    LOCATED_IN: 0.15,     # Spatial context
    CAUSES: 0.12,         # Causal relationships
    ENABLES: 0.12,
    PREVENTS: 0.12,
    REQUIRES: 0.12,
    ACHIEVES: 0.12,
    PRODUCES: 0.12,
    CONSUMES: 0.12,
    LACKS_PROPERTY: 0.10, # Explicit negations
    SIMILAR_TO: 0.10,     # Analogical
    OPPOSITE_OF: 0.10,    # Antonymy
}

# Typicality scoring component weights
_WEIGHT_EDGE_TYPE = 0.35
_WEIGHT_SCOPE = 0.30
_WEIGHT_CONFIDENCE = 0.25
_WEIGHT_ACTIVATION = 0.10

# Default categorical threshold for scope_context_count scoring
_DEFAULT_CATEGORICAL_THRESHOLD = 3

# All semantic edge types to query in the definition traversal
_DEFINITION_EDGE_TYPES: list[str] = [
    IS_A,
    HAS_PROPERTY,
    LACKS_PROPERTY,
    PART_OF,
    LOCATED_IN,
    USED_FOR,
    CAUSES,
    ENABLES,
    PREVENTS,
    REQUIRES,
    ACHIEVES,
    PRODUCES,
    CONSUMES,
    SIMILAR_TO,
    OPPOSITE_OF,
]


# ---------------------------------------------------------------------------
# Request / Result data structures
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DefinitionQueryRequest:
    """Input to DefinitionQueryExecutor.execute().

    Attributes:
        subject_node_id: The node_id of the WordSenseNode to define.
        session_id: Current conversation session identifier.
        correlation_id: Traces this request through logs and provenance.
        activation_map: Optional spreading activation map. Keys are node_ids,
            values are activation boost values (0.0-1.0). When provided,
            facts touching activated nodes receive a typicality boost.
        max_facts: Maximum number of facts to return. Default 20.
            Prevents overwhelming PT-11 with too many facts.
        include_ancestors: If True, traverse IS_A ancestors and include
            inherited properties. Default True for definitions.
    """

    subject_node_id: str
    session_id: str
    correlation_id: str
    activation_map: dict[str, float] = field(default_factory=dict)
    max_facts: int = 20
    include_ancestors: bool = True


@dataclass(frozen=True)
class DefinitionFact:
    """One fact contributing to the definition of a concept.

    Represents a single semantic edge radiating from the subject node,
    scored for typicality and annotated with provenance metadata.

    Attributes:
        source_node_id: The node_id of the subject (or ancestor) that
            this fact radiates from.
        source_spelling: Human-readable spelling of the source.
        edge_type: Semantic relationship type (IS_A, HAS_PROPERTY, etc.).
        edge_id: Identifier of the semantic edge.
        edge_confidence: Confidence value on the edge.
        target_node_id: The node_id of the fact's object.
        target_spelling: Human-readable spelling of the object.
        scope_context_count: How many distinct contexts confirm this fact.
        property_type: Sub-classification for HAS_PROPERTY edges
            ('sensory', 'functional', 'categorical'). Empty otherwise.
        typicality_score: Composite score ranking this fact's centrality
            to the concept's definition (0.0-1.0).
        depth_from_subject: How many IS_A hops from the query subject.
            0 = directly on the subject node.
        activation_contributed: Whether spreading activation boosted this
            fact's score. True if the activation_map contained a matching
            node_id with a non-zero boost.
        base_confidence: Edge confidence before any activation boost.
            Equal to edge_confidence when activation_contributed is False.
        domain: Which knowledge domain this fact belongs to.
        cross_domain: True if this fact was reached via DENOTES bridge.
    """

    source_node_id: str
    source_spelling: str
    edge_type: str
    edge_id: str
    edge_confidence: float
    target_node_id: str
    target_spelling: str
    scope_context_count: int
    property_type: str
    typicality_score: float
    depth_from_subject: int
    activation_contributed: bool
    base_confidence: float
    domain: str
    cross_domain: bool


@dataclass(frozen=True)
class DefinitionQueryResult:
    """Result of a definition_query execution.

    Attributes:
        facts: Ranked list of DefinitionFact objects, sorted by
            typicality_score descending. Limited to max_facts.
        subject_node_id: The node_id that was queried.
        subject_spelling: Human-readable spelling of the queried concept.
        termination_reason: Why the traversal stopped.
        depth_reached: Maximum IS_A depth reached during traversal.
        total_facts_found: Total facts before truncation to max_facts.
        execution_time_ms: Wall-clock time for the query.
        trace_node_id: NodeId of the SemanticInferenceTrace created.
        denotes_traversed: True if DENOTES bridge was used.
        token_budget_exhausted: True if output was truncated at
            the token budget rather than the depth limit.
        confidence_floor_hits: Number of edges pruned by the confidence
            floor. High values indicate many uncertain facts.
    """

    facts: list[DefinitionFact]
    subject_node_id: str
    subject_spelling: str
    termination_reason: str
    depth_reached: int
    total_facts_found: int
    execution_time_ms: float
    trace_node_id: str
    denotes_traversed: bool
    token_budget_exhausted: bool
    confidence_floor_hits: int


# ---------------------------------------------------------------------------
# Typicality scoring
# ---------------------------------------------------------------------------


def compute_typicality_score(
    edge_type: str,
    scope_context_count: int,
    edge_confidence: float,
    activation_boost: float = 0.0,
    categorical_threshold: int = _DEFAULT_CATEGORICAL_THRESHOLD,
) -> float:
    """Compute the typicality score for a semantic fact.

    The typicality score ranks how central a fact is to the definition
    of a concept. It combines four factors with empirically motivated
    weights (Rosch, 1975; Smith & Medin, 1981).

    Args:
        edge_type: Semantic relationship type (IS_A, HAS_PROPERTY, etc.).
        scope_context_count: Number of distinct contexts confirming this fact.
        edge_confidence: Confidence value on the edge (0.0-1.0).
        activation_boost: Spreading activation boost (0.0-1.0). Default 0.0.
        categorical_threshold: Scope count at which a fact is categorical.

    Returns:
        A float in [0.0, 1.0] representing the fact's typicality.
    """
    # Factor 1: Edge type weight
    edge_weight = _EDGE_TYPE_WEIGHTS.get(edge_type, 0.10)

    # Factor 2: Scope context factor
    # Capped at threshold to prevent runaway scoring from high-count edges
    effective_scope = min(scope_context_count, categorical_threshold)
    if categorical_threshold > 0:
        scope_factor = effective_scope / categorical_threshold
    else:
        scope_factor = 1.0

    # Factor 3: Confidence factor (direct from edge)
    confidence_factor = max(0.0, min(1.0, edge_confidence))

    # Factor 4: Activation boost (capped at 0.2 to prevent domination)
    capped_activation = max(0.0, min(0.2, activation_boost))

    # Weighted sum
    typicality = (
        edge_weight * _WEIGHT_EDGE_TYPE
        + scope_factor * _WEIGHT_SCOPE
        + confidence_factor * _WEIGHT_CONFIDENCE
        + capped_activation * _WEIGHT_ACTIVATION
    )

    # Clamp to [0.0, 1.0]
    return max(0.0, min(1.0, typicality))


# ---------------------------------------------------------------------------
# DefinitionQueryExecutor
# ---------------------------------------------------------------------------


class DefinitionQueryExecutor:
    """Executes definition_query procedures through semantic graph traversal.

    This executor is Layer 3 infrastructure. It never calls the LLM.
    It traverses the semantic graph, scores facts for typicality, and
    returns a structured result that PT-11 can narrate.

    The executor reads its depth configuration from the
    ``rule:definition_depth_config`` EvolutionRule node in the graph.
    If the node does not exist, it falls back to the default (depth=5,
    budget=600).

    Attributes:
        persistence: GraphPersistence backend for node/edge reads.
        neo4j_session: Direct Neo4j session for optimized Cypher queries.
        trace_writer: InferenceTraceWriter for A.19 compliance.
        max_depth: Maximum traversal depth (from EvolutionRule or default).
        token_budget: Maximum token budget for output (from EvolutionRule).
    """

    def __init__(
        self,
        persistence: GraphPersistence,
        neo4j_session: neo4j.Session,
        trace_writer: InferenceTraceWriter | None = None,
        max_depth: int = DEFAULT_DEFINITION_MAX_DEPTH,
        token_budget: int = DEFAULT_TOKEN_BUDGET,
        categorical_threshold: int = _DEFAULT_CATEGORICAL_THRESHOLD,
    ) -> None:
        self._persistence = persistence
        self._session = neo4j_session
        self._trace_writer = trace_writer
        self.max_depth = max_depth
        self.token_budget = token_budget
        self._categorical_threshold = categorical_threshold

    @classmethod
    async def from_graph(
        cls,
        persistence: GraphPersistence,
        neo4j_session: neo4j.Session,
        trace_writer: InferenceTraceWriter | None = None,
    ) -> "DefinitionQueryExecutor":
        """Create a DefinitionQueryExecutor with config read from the graph.

        Reads the ``rule:definition_depth_config`` EvolutionRule node to
        obtain the current max_depth and token_budget. Falls back to
        defaults if the node does not exist.

        Also reads the ``rule:categorical_knowledge_threshold`` node for
        the categorical threshold used in typicality scoring.

        Args:
            persistence: GraphPersistence backend.
            neo4j_session: Direct Neo4j session.
            trace_writer: Optional InferenceTraceWriter.

        Returns:
            A configured DefinitionQueryExecutor.
        """
        max_depth = DEFAULT_DEFINITION_MAX_DEPTH
        token_budget = DEFAULT_TOKEN_BUDGET
        categorical_threshold = _DEFAULT_CATEGORICAL_THRESHOLD

        # Read definition depth config
        depth_rule = await persistence.get_node(DEFINITION_DEPTH_RULE_ID)
        if depth_rule is not None:
            max_depth = int(
                depth_rule.properties.get(
                    "current_max_depth", DEFAULT_DEFINITION_MAX_DEPTH
                )
            )
            token_budget = int(
                depth_rule.properties.get(
                    "token_budget_tokens", DEFAULT_TOKEN_BUDGET
                )
            )

        # Read categorical threshold
        cat_rule = await persistence.get_node(
            NodeId("rule:categorical_knowledge_threshold")
        )
        if cat_rule is not None:
            categorical_threshold = int(
                cat_rule.properties.get(
                    "current_value", _DEFAULT_CATEGORICAL_THRESHOLD
                )
            )

        return cls(
            persistence=persistence,
            neo4j_session=neo4j_session,
            trace_writer=trace_writer,
            max_depth=min(max_depth, MAX_TRAVERSAL_DEPTH),
            token_budget=token_budget,
            categorical_threshold=categorical_threshold,
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def execute(
        self,
        request: DefinitionQueryRequest,
    ) -> DefinitionQueryResult:
        """Execute a definition query for the given subject node.

        Performs semantic graph traversal to collect all facts that
        define the queried concept, scores them for typicality, and
        returns a ranked result set.

        Steps:
          1. Resolve subject node and get its spelling.
          2. Check for DENOTES bridge if subject has no direct semantic edges.
          3. Collect direct semantic edges from subject.
          4. Optionally collect inherited facts via IS_A ancestors.
          5. Score all facts for typicality.
          6. Apply activation boosts if provided.
          7. Sort by typicality, truncate to max_facts.
          8. Record SemanticInferenceTrace.
          9. Return DefinitionQueryResult.

        Args:
            request: The definition query parameters.

        Returns:
            DefinitionQueryResult with ranked facts.

        Raises:
            KnowledgeGraphError: If graph queries fail.
        """
        start_time = time.monotonic()
        query_id = f"def-{request.correlation_id}-{uuid.uuid4().hex[:8]}"

        # Step 1: Resolve subject node
        subject_node = await self._persistence.get_node(
            NodeId(request.subject_node_id)
        )
        if subject_node is None:
            elapsed = (time.monotonic() - start_time) * 1000
            return self._empty_result(
                request=request,
                termination_reason=TerminationReason.NO_EVIDENCE,
                execution_time_ms=elapsed,
                trace_node_id="",
            )

        subject_spelling = str(
            subject_node.properties.get(
                "spelling",
                subject_node.properties.get("label", request.subject_node_id),
            )
        )

        # Step 2: Collect direct semantic edges from subject
        denotes_traversed = False
        effective_subject_id = request.subject_node_id
        reasoning_steps: list[ReasoningStep] = []
        confidence_floor_hits = 0

        direct_result = self._query_direct_edges(effective_subject_id)

        # If no direct semantic edges, try DENOTES bridge
        if len(direct_result.rows) == 0:
            denotes_target = self._resolve_denotes_target(
                effective_subject_id
            )
            if denotes_target is not None:
                denotes_traversed = True
                effective_subject_id = denotes_target
                direct_result = self._query_direct_edges(
                    effective_subject_id
                )
                _log.debug(
                    "definition_query: followed DENOTES bridge from %s "
                    "to %s (%d edges found)",
                    request.subject_node_id,
                    effective_subject_id,
                    len(direct_result.rows),
                )

        # Step 3: Collect ancestor facts if requested
        ancestor_facts: list[SemanticTraversalRow] = []
        max_depth_reached = 0

        if request.include_ancestors:
            ancestor_result = self._query_ancestors(effective_subject_id)
            if isinstance(ancestor_result.rows, list) and ancestor_result.rows:
                max_depth_reached = max(
                    (row.hop_depth for row in ancestor_result.rows),
                    default=0,
                )
                # For each ancestor, collect its HAS_PROPERTY edges
                seen_ancestors: set[str] = set()
                for anc_row in ancestor_result.rows:
                    anc_id = anc_row.object_node_id
                    if anc_id in seen_ancestors:
                        continue
                    seen_ancestors.add(anc_id)

                    # Record the IS_A traversal step
                    reasoning_steps.append(
                        ReasoningStep(
                            hop=anc_row.hop_depth,
                            source_node_id=anc_row.subject_node_id,
                            edge_type=IS_A,
                            edge_id=anc_row.edge_id,
                            target_node_id=anc_id,
                            edge_confidence=anc_row.edge_confidence,
                            scope_context_count=anc_row.scope_context_count,
                        )
                    )

                    # Get properties of the ancestor
                    anc_props = self._query_direct_edges(anc_id)
                    for prop_row in anc_props.rows:
                        # Adjust hop_depth to reflect distance from subject
                        adjusted_row = SemanticTraversalRow(
                            subject_node_id=prop_row.subject_node_id,
                            subject_spelling=prop_row.subject_spelling,
                            edge_id=prop_row.edge_id,
                            edge_type=prop_row.edge_type,
                            edge_confidence=prop_row.edge_confidence,
                            scope_context_count=prop_row.scope_context_count,
                            valid_from=prop_row.valid_from,
                            valid_to=prop_row.valid_to,
                            property_type=prop_row.property_type,
                            asserted_text=prop_row.asserted_text,
                            object_node_id=prop_row.object_node_id,
                            object_spelling=prop_row.object_spelling,
                            hop_depth=anc_row.hop_depth,
                        )
                        ancestor_facts.append(adjusted_row)

        # Step 4: Combine direct and ancestor facts, deduplicating
        all_rows = list(direct_result.rows) + ancestor_facts
        seen_edge_ids: set[str] = set()
        unique_rows: list[SemanticTraversalRow] = []
        for row in all_rows:
            if row.edge_id and row.edge_id in seen_edge_ids:
                continue
            if row.edge_id:
                seen_edge_ids.add(row.edge_id)
            unique_rows.append(row)

        # Record reasoning steps for direct edges
        for row in direct_result.rows:
            reasoning_steps.append(
                ReasoningStep(
                    hop=0,
                    source_node_id=row.subject_node_id,
                    edge_type=row.edge_type,
                    edge_id=row.edge_id,
                    target_node_id=row.object_node_id,
                    edge_confidence=row.edge_confidence,
                    scope_context_count=row.scope_context_count,
                )
            )

        # Step 5: Score each fact for typicality
        scored_facts: list[DefinitionFact] = []
        estimated_tokens = 0
        token_budget_exhausted = False

        for row in unique_rows:
            # Compute activation boost from the activation map
            activation_boost = 0.0
            activation_contributed = False
            if request.activation_map:
                # Check both subject and object node for activation
                subj_boost = request.activation_map.get(
                    row.subject_node_id, 0.0
                )
                obj_boost = request.activation_map.get(
                    row.object_node_id, 0.0
                )
                activation_boost = max(subj_boost, obj_boost)
                activation_contributed = activation_boost > 0.0

            typicality = compute_typicality_score(
                edge_type=row.edge_type,
                scope_context_count=row.scope_context_count,
                edge_confidence=row.edge_confidence,
                activation_boost=activation_boost,
                categorical_threshold=self._categorical_threshold,
            )

            # Determine domain
            domain = "semantic"
            cross_domain = denotes_traversed and row.hop_depth == 0

            fact = DefinitionFact(
                source_node_id=row.subject_node_id,
                source_spelling=row.subject_spelling,
                edge_type=row.edge_type,
                edge_id=row.edge_id,
                edge_confidence=row.edge_confidence,
                target_node_id=row.object_node_id,
                target_spelling=row.object_spelling,
                scope_context_count=row.scope_context_count,
                property_type=row.property_type,
                typicality_score=typicality,
                depth_from_subject=row.hop_depth,
                activation_contributed=activation_contributed,
                base_confidence=row.edge_confidence,
                domain=domain,
                cross_domain=cross_domain,
            )
            scored_facts.append(fact)

            # Token budget estimation: ~30 tokens per fact
            estimated_tokens += 30
            if estimated_tokens >= self.token_budget:
                token_budget_exhausted = True
                _log.debug(
                    "definition_query: token budget exhausted at %d facts "
                    "(%d estimated tokens >= %d budget)",
                    len(scored_facts),
                    estimated_tokens,
                    self.token_budget,
                )
                break

        total_facts_found = len(unique_rows)

        # Step 6: Sort by typicality descending, truncate
        scored_facts.sort(key=lambda f: f.typicality_score, reverse=True)
        truncated_facts = scored_facts[: request.max_facts]

        # Step 7: Determine termination reason
        if not truncated_facts:
            termination = TerminationReason.NO_EVIDENCE
        elif token_budget_exhausted:
            termination = TerminationReason.DEPTH_LIMIT_REACHED
        else:
            termination = TerminationReason.ANSWER_FOUND

        elapsed_ms = (time.monotonic() - start_time) * 1000

        # Compute overall confidence as mean of top facts' confidence
        if truncated_facts:
            overall_confidence = sum(
                f.edge_confidence for f in truncated_facts
            ) / len(truncated_facts)
        else:
            overall_confidence = 0.0

        # Step 8: Record SemanticInferenceTrace (A.19)
        trace_node_id = ""
        if self._trace_writer is not None:
            try:
                concluded_id = (
                    truncated_facts[0].target_node_id
                    if truncated_facts
                    else None
                )
                trace_result = await self._trace_writer.record_trace(
                    query_id=query_id,
                    query_type="definition_query",
                    subject_node_id=request.subject_node_id,
                    reasoning_steps=reasoning_steps,
                    termination_reason=termination,
                    confidence=overall_confidence,
                    depth_reached=max_depth_reached,
                    execution_time_ms=elapsed_ms,
                    session_id=request.session_id,
                    target_node_id=None,
                    path_found_but_truncated=token_budget_exhausted,
                    truncation_depth=(
                        max_depth_reached if token_budget_exhausted else None
                    ),
                    concluded_node_id=concluded_id,
                    conclusion_confidence=overall_confidence,
                )
                trace_node_id = trace_result.trace_node_id
            except Exception as exc:
                _log.warning(
                    "definition_query: failed to record inference trace "
                    "for query_id=%s: %s",
                    query_id,
                    exc,
                )

        _log.info(
            "definition_query: subject=%r spelling=%r facts=%d/%d "
            "depth=%d denotes=%s termination=%s elapsed=%.1fms",
            request.subject_node_id,
            subject_spelling,
            len(truncated_facts),
            total_facts_found,
            max_depth_reached,
            denotes_traversed,
            termination,
            elapsed_ms,
        )

        return DefinitionQueryResult(
            facts=truncated_facts,
            subject_node_id=request.subject_node_id,
            subject_spelling=subject_spelling,
            termination_reason=str(termination),
            depth_reached=max_depth_reached,
            total_facts_found=total_facts_found,
            execution_time_ms=elapsed_ms,
            trace_node_id=trace_node_id,
            denotes_traversed=denotes_traversed,
            token_budget_exhausted=token_budget_exhausted,
            confidence_floor_hits=confidence_floor_hits,
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _query_direct_edges(
        self,
        node_id: str,
    ) -> SemanticQueryResult:
        """Query all semantic edges directly radiating from a node.

        Uses the query_active_semantic_edges function from semantic_query.py
        which executes optimized Cypher with proper indexing.

        Returns:
            SemanticQueryResult with all direct semantic edges.
        """
        constraints = SemanticQueryConstraints(
            max_depth=1,
            confidence_floor=MIN_CONFIDENCE_FLOOR,
            scope_threshold=None,
            include_retracted=False,
            result_limit=200,
        )

        try:
            return query_active_semantic_edges(
                session=self._session,
                node_id=node_id,
                edge_types=_DEFINITION_EDGE_TYPES,
                constraints=constraints,
            )
        except Exception as exc:
            _log.warning(
                "definition_query: query_active_semantic_edges failed "
                "for node_id=%r: %s",
                node_id,
                exc,
            )
            return SemanticQueryResult(
                rows=[],
                query_node_id=node_id,
                edge_types_queried=_DEFINITION_EDGE_TYPES,
                max_depth_used=1,
                min_confidence_used=MIN_CONFIDENCE_FLOOR,
                scope_threshold_used=None,
                execution_time_ms=0.0,
                truncated=False,
            )

    def _query_ancestors(
        self,
        node_id: str,
    ) -> SemanticQueryResult:
        """Query IS_A ancestors up to the configured max_depth.

        Uses the query_is_a_ancestors function from semantic_query.py
        which handles variable-length path matching with bounded depth.

        Returns:
            SemanticQueryResult with ancestor traversal rows.
        """
        constraints = SemanticQueryConstraints(
            max_depth=min(self.max_depth, MAX_TRAVERSAL_DEPTH),
            confidence_floor=MIN_CONFIDENCE_FLOOR,
            scope_threshold=None,
            include_retracted=False,
            result_limit=50,  # Limit ancestor count to prevent hub explosion
        )

        try:
            return query_is_a_ancestors(
                session=self._session,
                node_id=node_id,
                constraints=constraints,
            )
        except Exception as exc:
            _log.warning(
                "definition_query: query_is_a_ancestors failed "
                "for node_id=%r: %s",
                node_id,
                exc,
            )
            return SemanticQueryResult(
                rows=[],
                query_node_id=node_id,
                edge_types_queried=[IS_A],
                max_depth_used=self.max_depth,
                min_confidence_used=MIN_CONFIDENCE_FLOOR,
                scope_threshold_used=None,
                execution_time_ms=0.0,
                truncated=False,
            )

    def _resolve_denotes_target(
        self,
        word_sense_node_id: str,
    ) -> str | None:
        """Follow DENOTES bridge from a WordSenseNode to its semantic target.

        Only follows the bridge if the WordSenseNode has zero direct semantic
        edges. This is the selective DENOTES traversal -- not unconditional.

        Returns:
            The node_id of the DENOTES target, or None if no bridge exists.
        """
        cypher = (
            "MATCH (ws:WordSenseNode {node_id: $node_id})"
            "-[d:DENOTES]->(target) "
            "WHERE d.valid_to IS NULL "
            "RETURN target.node_id AS target_id "
            "LIMIT 1"
        )

        try:
            def _read(
                tx: neo4j.ManagedTransaction,
            ) -> str | None:
                result = tx.run(cypher, node_id=word_sense_node_id)
                record = result.single()
                if record is None:
                    return None
                tid = record.get("target_id")
                return str(tid) if tid else None

            return self._session.execute_read(_read)
        except Exception as exc:
            _log.warning(
                "definition_query: DENOTES resolution failed for %r: %s",
                word_sense_node_id,
                exc,
            )
            return None

    def _empty_result(
        self,
        request: DefinitionQueryRequest,
        termination_reason: TerminationReason | str,
        execution_time_ms: float,
        trace_node_id: str,
    ) -> DefinitionQueryResult:
        """Build an empty DefinitionQueryResult for cases with no facts."""
        return DefinitionQueryResult(
            facts=[],
            subject_node_id=request.subject_node_id,
            subject_spelling="",
            termination_reason=str(termination_reason),
            depth_reached=0,
            total_facts_found=0,
            execution_time_ms=execution_time_ms,
            trace_node_id=trace_node_id,
            denotes_traversed=False,
            token_budget_exhausted=False,
            confidence_floor_hits=0,
        )


# ---------------------------------------------------------------------------
# Bootstrap functions
# ---------------------------------------------------------------------------


async def bootstrap_definition_query_template(
    persistence: GraphPersistence,
) -> dict[str, int]:
    """Bootstrap the proc:definition_query ProceduralTemplate and its depth config.

    Creates:
      1. The ``proc:definition_query`` ProceduralTemplate node (SCHEMA level).
      2. The ``rule:definition_depth_config`` EvolutionRule node (META_SCHEMA).
      3. A DEPENDS_ON edge from the template to the EvolutionRule.
      4. A DEPENDS_ON edge from the template to domain:semantic.

    All nodes use TAUGHT_PROCEDURE provenance. This function is idempotent.

    Args:
        persistence: The graph persistence backend.

    Returns:
        Dict with creation counts: template_created, rule_created,
        edges_created, template_existing, rule_existing, edges_existing.
    """
    counts: dict[str, int] = {
        "template_created": 0,
        "rule_created": 0,
        "edges_created": 0,
        "template_existing": 0,
        "rule_existing": 0,
        "edges_existing": 0,
    }

    taught = Provenance(
        source=ProvenanceSource.TAUGHT_PROCEDURE,
        source_id="definition-query-bootstrap",
        confidence=1.0,
    )

    # 1. Create the ProceduralTemplate node
    template_id = DEFINITION_QUERY_TEMPLATE_ID
    existing_template = await persistence.get_node(template_id)

    if existing_template is not None:
        counts["template_existing"] += 1
    else:
        template_node = KnowledgeNode(
            node_id=template_id,
            node_type=PROCEDURAL_TEMPLATE,
            schema_level=SchemaLevel.SCHEMA,
            properties={
                "name": DEFINITION_QUERY_TEMPLATE_NAME,
                "display_name": "Definition Query",
                "domain": "semantic",
                "description": (
                    "Answers 'what is X?' questions by traversing semantic "
                    "edges radiating from the subject concept. Collects IS_A "
                    "ancestors, properties, parts, functions, and causal "
                    "relationships. Ranks facts by typicality score."
                ),
                "parameters": ["$subject"],
                "query_type": "definition_query",
                "depth_config_rule": str(DEFINITION_DEPTH_RULE_ID),
                "prompt_description": (
                    "definition_query: answers 'what is X?' by traversing "
                    "semantic graph edges from the subject concept"
                ),
                "installed_by_skill": "semantic-ontology",
            },
            provenance=taught,
            confidence=1.0,
            status=NodeStatus.ACTIVE,
        )
        await persistence.save_node(template_node)
        counts["template_created"] += 1
        _log.info(
            "definition_query_bootstrap: created ProceduralTemplate %s",
            template_id,
        )

    # 2. Create the EvolutionRule depth config node
    rule_id = DEFINITION_DEPTH_RULE_ID
    existing_rule = await persistence.get_node(rule_id)

    if existing_rule is not None:
        counts["rule_existing"] += 1
    else:
        rule_node = KnowledgeNode(
            node_id=rule_id,
            node_type="EvolutionRule",
            schema_level=SchemaLevel.META_SCHEMA,
            properties={
                "rule_name": "DEFINITION_DEPTH_CONFIG",
                "current_max_depth": DEFAULT_DEFINITION_MAX_DEPTH,
                "token_budget_tokens": DEFAULT_TOKEN_BUDGET,
                "auto_truncate_at_budget": True,
                "description": (
                    "Governs definition_query traversal depth. Depth=5 from "
                    "launch because definition working memory load is "
                    "independent-per-level, not cumulative (Luria, T1.2). "
                    "Token budget (600) is the actual safety constraint."
                ),
                "tunable_by_guardian": True,
                "installed_by_skill": "semantic-ontology",
            },
            provenance=Provenance(
                source=ProvenanceSource.INFERENCE,
                source_id="definition-query-bootstrap",
                confidence=1.0,
            ),
            confidence=1.0,
            status=NodeStatus.ACTIVE,
        )
        await persistence.save_node(rule_node)
        counts["rule_created"] += 1
        _log.info(
            "definition_query_bootstrap: created EvolutionRule %s", rule_id
        )

    # 3. Create DEPENDS_ON edges
    dep_edges = [
        (
            EdgeId("dep:def_query:depth_config"),
            template_id,
            rule_id,
            "depth_config",
        ),
        (
            EdgeId("dep:def_query:semantic_domain"),
            template_id,
            NodeId("domain:semantic"),
            "semantic_domain",
        ),
    ]

    for edge_id, source_id, target_id, dep_type in dep_edges:
        existing_edge = await persistence.get_edge(edge_id)
        if existing_edge is not None:
            counts["edges_existing"] += 1
            continue

        # Verify target exists before creating edge
        target_node = await persistence.get_node(target_id)
        if target_node is None:
            _log.warning(
                "definition_query_bootstrap: skipping DEPENDS_ON edge %s "
                "because target %s does not exist",
                edge_id,
                target_id,
            )
            continue

        from cobeing.layer3_knowledge.node_types import KnowledgeEdge

        dep_edge = KnowledgeEdge(
            edge_id=edge_id,
            source_id=source_id,
            target_id=target_id,
            edge_type="DEPENDS_ON",
            properties={
                "dependency_type": dep_type,
                "installed_by_skill": "semantic-ontology",
            },
            provenance=taught,
            confidence=1.0,
        )
        await persistence.save_edge(dep_edge)
        counts["edges_created"] += 1

    _log.info(
        "definition_query_bootstrap: complete -- "
        "template=%s rule=%s edges=%d",
        "created" if counts["template_created"] else "existing",
        "created" if counts["rule_created"] else "existing",
        counts["edges_created"],
    )

    return counts


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

__all__ = [
    # Constants
    "DEFINITION_QUERY_TEMPLATE_ID",
    "DEFINITION_QUERY_TEMPLATE_NAME",
    "DEFINITION_DEPTH_RULE_ID",
    "DEFAULT_DEFINITION_MAX_DEPTH",
    "DEFAULT_TOKEN_BUDGET",
    # Data structures
    "DefinitionQueryRequest",
    "DefinitionFact",
    "DefinitionQueryResult",
    # Scoring
    "compute_typicality_score",
    # Executor
    "DefinitionQueryExecutor",
    # Bootstrap
    "bootstrap_definition_query_template",
]
