"""Unified spreading activation system for semantic queries (P1.8-E3/T006).

Implements a four-layer neurologically-motivated spreading activation system
that enhances semantic queries by priming related concepts before controlled
traversal. The system mirrors the biological dual-route model of semantic
access (Luria analysis, Section 1.1):

  Route 1 (automatic): Spreading activation propagates through the graph
    from a queried concept, priming neighbors with decaying boosts.
  Route 2 (controlled): SemanticQueryHandler executes parameterized
    traversal using the activation map to score relevance.

Four-layer design (from T2.1 agent integration):

  Layer 1 -- Propagation Physics (Atlas):
    BFS propagation from source node through semantic edges. Each hop
    attenuates the boost by hop_decay_factor (0.60). Initial boost at
    source is 0.20. Maximum propagation depth starts at 2 (developmental),
    advances to 3 after the system demonstrates stable activation patterns.
    Edges below confidence 0.3 are not traversed (matching MIN_CONFIDENCE_FLOOR).

  Layer 2 -- Accumulation Strategy (Ashby):
    When multiple queries activate overlapping neighborhoods within the TTL
    window, overlapping boosts use the MAX strategy (not additive). If a new
    activation value exceeds the existing one, the entry is replaced and the
    TTL resets. If the new value is lower, the existing entry is unchanged
    (TTL also unchanged). This prevents positive-feedback accumulation that
    could distort query results at hub nodes.

  Layer 3 -- Post-Traversal Inhibition (Luria):
    After a query traversal completes, nodes that were activated but NOT
    traversed by the controlled query receive an inhibition modifier of
    -0.05. This models the biological lateral inhibition mechanism:
    irrelevant neighbors are suppressed after the task selects relevant
    ones. The inhibition prevents previously-activated irrelevant nodes
    from contaminating the next query.

  Layer 4 -- Developmental Budget Scaling (Piaget):
    The activation budget (maximum number of nodes that can hold activation
    simultaneously) scales with the system's developmental maturity,
    measured by total semantic edge count. Budget starts at base=10 and
    scales as min(ceiling, base + scale_factor * ln(edge_count + 1)).
    Ceiling is 30. This prevents the activation system from consuming
    excessive memory in early stages when the graph is sparse (sparse
    graphs do not benefit from wide activation). Cross-domain activation
    has a separate budget of 5 nodes to prevent one domain from flooding
    another (A.20 domain boundary respect).

All parameters are stored in a single EvolutionRule meta-schema node
(``meta:spreading_activation_params``) so the guardian can tune them and
the system can adapt them through developmental progression.

Activation spread ratio monitoring:
  Each session tracks the ratio of activated_nodes / total_nodes_traversed.
  The p50 and p95 of this ratio across queries in the session are written
  back to the EvolutionRule node at session end. The target range is
  0.05-0.30 (Ashby operational metric). Outside this range signals either
  underactivation (system is ignoring priming) or overactivation (hub
  nodes are dominating).

CANON compliance:
  A.1   -- activation is derived from graph structure, not pre-populated
  A.10  -- bounded propagation (max_depth, budget ceiling)
  A.11  -- activation is ephemeral (in-memory, not persisted as edges)
  A.20  -- cross-domain budget enforces domain boundary respect

Phase 1.8 (P1.8-E3/T006).
"""

from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

import neo4j

from cobeing.layer3_knowledge.node_types import (
    KnowledgeNode,
    NodeStatus,
    SchemaLevel,
)
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.semantic_query import MIN_CONFIDENCE_FLOOR
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import NodeId

_log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants: EvolutionRule node identifiers and defaults
# ---------------------------------------------------------------------------

SPREADING_ACTIVATION_RULE_ID = NodeId("meta:spreading_activation_params")
"""NodeId of the EvolutionRule node storing all spreading activation parameters."""

# Layer 1 defaults (Propagation Physics)
DEFAULT_HOP_DECAY_FACTOR: float = 0.60
DEFAULT_INITIAL_BOOST: float = 0.20
DEFAULT_MAX_PROPAGATION_DEPTH: int = 2
DEVELOPMENTAL_MAX_PROPAGATION_DEPTH: int = 3
DEFAULT_MIN_ACTIVATION_THRESHOLD: float = 0.01
DEFAULT_ACTIVATION_TTL_SECONDS: float = 30.0

# Layer 2 defaults (Accumulation Strategy)
# max-boost is the strategy: True means use max(), False means additive
DEFAULT_MAX_BOOST_STRATEGY: bool = True

# Layer 3 defaults (Inhibition)
DEFAULT_INHIBITION_MODIFIER: float = -0.05

# Layer 4 defaults (Developmental Budget)
DEFAULT_BUDGET_BASE: int = 10
DEFAULT_BUDGET_SCALE: float = 5.0
DEFAULT_BUDGET_CEILING: int = 30
DEFAULT_CROSS_DOMAIN_BUDGET: int = 5

# Activation spread ratio monitoring target range (Ashby operational)
SPREAD_RATIO_MIN: float = 0.05
SPREAD_RATIO_MAX: float = 0.30

# Depth advancement criteria
DEPTH_ADVANCE_MIN_QUERIES: int = 50
DEPTH_ADVANCE_MAX_P95_RATIO: float = 0.35


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class ActivationEntry:
    """One entry in the session activation map.

    Attributes:
        node_id: The activated node's identifier.
        boost: Current activation boost value (0.0-1.0).
        timestamp: When this entry was created or last replaced.
        domain: Which knowledge domain this node belongs to.
        source_query_id: The query that produced this activation.
        depth_from_source: How many hops from the original query source.
    """

    node_id: str
    boost: float
    timestamp: float
    domain: str
    source_query_id: str
    depth_from_source: int


class PropagationDepthStage(StrEnum):
    """Developmental stage for propagation depth."""

    INITIAL = "initial"
    ADVANCED = "advanced"


@dataclass(frozen=True)
class SpreadingActivationParams:
    """Complete parameter set read from the EvolutionRule node.

    All fields have defaults matching the module-level constants. The
    ``from_evolution_rule`` classmethod reads from a KnowledgeNode and
    fills in defaults for any missing properties.
    """

    # Layer 1: Propagation Physics
    hop_decay_factor: float = DEFAULT_HOP_DECAY_FACTOR
    initial_boost: float = DEFAULT_INITIAL_BOOST
    max_propagation_depth: int = DEFAULT_MAX_PROPAGATION_DEPTH
    min_activation_threshold: float = DEFAULT_MIN_ACTIVATION_THRESHOLD
    activation_ttl_seconds: float = DEFAULT_ACTIVATION_TTL_SECONDS

    # Layer 2: Accumulation Strategy
    max_boost_strategy: bool = DEFAULT_MAX_BOOST_STRATEGY

    # Layer 3: Inhibition
    inhibition_modifier: float = DEFAULT_INHIBITION_MODIFIER

    # Layer 4: Developmental Budget
    budget_base: int = DEFAULT_BUDGET_BASE
    budget_scale: float = DEFAULT_BUDGET_SCALE
    budget_ceiling: int = DEFAULT_BUDGET_CEILING
    cross_domain_budget: int = DEFAULT_CROSS_DOMAIN_BUDGET

    # Monitoring
    session_spread_ratio_p50: float = 0.0
    session_spread_ratio_p95: float = 0.0

    # Depth advancement
    depth_stage: str = PropagationDepthStage.INITIAL
    depth_advance_min_queries: int = DEPTH_ADVANCE_MIN_QUERIES
    depth_advance_max_p95_ratio: float = DEPTH_ADVANCE_MAX_P95_RATIO

    @classmethod
    def from_evolution_rule(cls, node: KnowledgeNode | None) -> SpreadingActivationParams:
        """Read parameters from an EvolutionRule node, with defaults for missing.

        Args:
            node: The EvolutionRule KnowledgeNode, or None if not yet created.

        Returns:
            A SpreadingActivationParams with all fields populated.
        """
        if node is None:
            return cls()

        props = node.properties

        # Determine effective max_propagation_depth from depth_stage
        depth_stage_val = str(props.get("depth_stage", PropagationDepthStage.INITIAL))
        if depth_stage_val == PropagationDepthStage.ADVANCED:
            effective_depth = DEVELOPMENTAL_MAX_PROPAGATION_DEPTH
        else:
            effective_depth = int(props.get("max_propagation_depth", DEFAULT_MAX_PROPAGATION_DEPTH))

        return cls(
            hop_decay_factor=float(props.get("hop_decay_factor", DEFAULT_HOP_DECAY_FACTOR)),
            initial_boost=float(props.get("initial_boost", DEFAULT_INITIAL_BOOST)),
            max_propagation_depth=effective_depth,
            min_activation_threshold=float(
                props.get("min_activation_threshold", DEFAULT_MIN_ACTIVATION_THRESHOLD)
            ),
            activation_ttl_seconds=float(
                props.get("activation_ttl_seconds", DEFAULT_ACTIVATION_TTL_SECONDS)
            ),
            max_boost_strategy=bool(props.get("max_boost_strategy", DEFAULT_MAX_BOOST_STRATEGY)),
            inhibition_modifier=float(
                props.get("inhibition_modifier", DEFAULT_INHIBITION_MODIFIER)
            ),
            budget_base=int(props.get("budget_base", DEFAULT_BUDGET_BASE)),
            budget_scale=float(props.get("budget_scale", DEFAULT_BUDGET_SCALE)),
            budget_ceiling=int(props.get("budget_ceiling", DEFAULT_BUDGET_CEILING)),
            cross_domain_budget=int(
                props.get("cross_domain_budget", DEFAULT_CROSS_DOMAIN_BUDGET)
            ),
            session_spread_ratio_p50=float(
                props.get("session_spread_ratio_p50", 0.0)
            ),
            session_spread_ratio_p95=float(
                props.get("session_spread_ratio_p95", 0.0)
            ),
            depth_stage=depth_stage_val,
            depth_advance_min_queries=int(
                props.get("depth_advance_min_queries", DEPTH_ADVANCE_MIN_QUERIES)
            ),
            depth_advance_max_p95_ratio=float(
                props.get("depth_advance_max_p95_ratio", DEPTH_ADVANCE_MAX_P95_RATIO)
            ),
        )


@dataclass(frozen=True)
class SpreadResult:
    """Result of a single spread_from() call.

    Attributes:
        source_node_id: The node that activation was spread from.
        nodes_activated: Number of new or updated activation entries.
        nodes_skipped_budget: Number of nodes not activated due to budget limits.
        nodes_skipped_threshold: Number of nodes whose boost fell below threshold.
        total_nodes_touched: Total neighbor nodes visited during BFS.
        max_depth_reached: The deepest hop level that produced above-threshold activation.
        spread_ratio: nodes_activated / total_nodes_touched (0 if no nodes touched).
        elapsed_ms: Wall-clock time for the spread operation.
    """

    source_node_id: str
    nodes_activated: int
    nodes_skipped_budget: int
    nodes_skipped_threshold: int
    total_nodes_touched: int
    max_depth_reached: int
    spread_ratio: float
    elapsed_ms: float


@dataclass(frozen=True)
class InhibitionResult:
    """Result of a post-traversal inhibition pass.

    Attributes:
        nodes_inhibited: Number of activated nodes that received the inhibition modifier.
        nodes_removed: Number of nodes whose boost fell to zero or below after inhibition.
        nodes_preserved: Number of nodes that were traversed and thus preserved.
    """

    nodes_inhibited: int
    nodes_removed: int
    nodes_preserved: int


# ---------------------------------------------------------------------------
# Bootstrap: ensure the EvolutionRule node exists
# ---------------------------------------------------------------------------


async def ensure_spreading_activation_rule(persistence: GraphPersistence) -> KnowledgeNode:
    """Ensure the meta:spreading_activation_params EvolutionRule node exists.

    Idempotent: if the node already exists, returns it as-is. Creates it
    with all default parameters if absent.

    Args:
        persistence: Graph persistence backend.

    Returns:
        The EvolutionRule KnowledgeNode (existing or newly created).
    """
    existing = await persistence.get_node(SPREADING_ACTIVATION_RULE_ID)
    if existing is not None:
        return existing

    rule_node = KnowledgeNode(
        node_id=SPREADING_ACTIVATION_RULE_ID,
        node_type="EvolutionRule",
        schema_level=SchemaLevel.META_SCHEMA,
        properties={
            "rule_name": "SPREADING_ACTIVATION_PARAMS",
            "description": (
                "Unified spreading activation parameters for semantic queries. "
                "Four-layer design: propagation physics (Layer 1), accumulation "
                "strategy (Layer 2), post-traversal inhibition (Layer 3), "
                "developmental budget scaling (Layer 4). All parameters are "
                "guardian-tunable. Session monitoring tracks spread ratio p50/p95."
            ),
            # Layer 1: Propagation Physics
            "hop_decay_factor": DEFAULT_HOP_DECAY_FACTOR,
            "initial_boost": DEFAULT_INITIAL_BOOST,
            "max_propagation_depth": DEFAULT_MAX_PROPAGATION_DEPTH,
            "min_activation_threshold": DEFAULT_MIN_ACTIVATION_THRESHOLD,
            "activation_ttl_seconds": DEFAULT_ACTIVATION_TTL_SECONDS,
            # Layer 2: Accumulation Strategy
            "max_boost_strategy": DEFAULT_MAX_BOOST_STRATEGY,
            # Layer 3: Inhibition
            "inhibition_modifier": DEFAULT_INHIBITION_MODIFIER,
            # Layer 4: Developmental Budget
            "budget_base": DEFAULT_BUDGET_BASE,
            "budget_scale": DEFAULT_BUDGET_SCALE,
            "budget_ceiling": DEFAULT_BUDGET_CEILING,
            "cross_domain_budget": DEFAULT_CROSS_DOMAIN_BUDGET,
            # Monitoring
            "session_spread_ratio_p50": 0.0,
            "session_spread_ratio_p95": 0.0,
            # Depth advancement
            "depth_stage": PropagationDepthStage.INITIAL,
            "depth_advance_min_queries": DEPTH_ADVANCE_MIN_QUERIES,
            "depth_advance_max_p95_ratio": DEPTH_ADVANCE_MAX_P95_RATIO,
            # Metadata
            "tunable_by_guardian": True,
        },
        provenance=Provenance(
            source=ProvenanceSource.INFERENCE,
            source_id="spreading-activation-bootstrap",
            confidence=1.0,
        ),
        confidence=1.0,
        status=NodeStatus.ACTIVE,
    )
    await persistence.save_node(rule_node)
    _log.info(
        "SpreadingActivation: created EvolutionRule node %s "
        "(hop_decay=%.2f, initial_boost=%.2f, max_depth=%d, budget_base=%d)",
        SPREADING_ACTIVATION_RULE_ID,
        DEFAULT_HOP_DECAY_FACTOR,
        DEFAULT_INITIAL_BOOST,
        DEFAULT_MAX_PROPAGATION_DEPTH,
        DEFAULT_BUDGET_BASE,
    )
    return rule_node


# ---------------------------------------------------------------------------
# Core: SessionActivationMap
# ---------------------------------------------------------------------------


class SessionActivationMap:
    """Session-scoped spreading activation map.

    Manages the in-memory activation state for a single conversation session.
    The map holds ActivationEntry objects keyed by node_id, with TTL expiry,
    budget enforcement, and domain-separated budgets.

    This class is NOT thread-safe. It is designed to be owned by a single
    SemanticQueryHandler instance per session.

    Constructor:
        params: SpreadingActivationParams read from the EvolutionRule node.
        semantic_edge_count: Total semantic edge count in the graph at session
            start, used for Layer 4 budget computation.
    """

    def __init__(
        self,
        params: SpreadingActivationParams,
        semantic_edge_count: int = 0,
    ) -> None:
        self._params = params
        self._entries: dict[str, ActivationEntry] = {}
        self._spread_ratios: list[float] = []

        # Compute effective budget from developmental scaling (Layer 4)
        self._main_budget = self._compute_budget(semantic_edge_count)
        self._cross_domain_budget = params.cross_domain_budget
        self._main_domain_count = 0
        self._cross_domain_count = 0

        _log.debug(
            "SessionActivationMap: initialized (budget=%d, cross_domain=%d, "
            "max_depth=%d, decay=%.2f)",
            self._main_budget,
            self._cross_domain_budget,
            params.max_propagation_depth,
            params.hop_decay_factor,
        )

    def _compute_budget(self, semantic_edge_count: int) -> int:
        """Compute the developmental activation budget (Layer 4).

        Formula: min(ceiling, base + scale * ln(edge_count + 1))

        At edge_count=0: budget = base (10)
        At edge_count=50: budget = 10 + 5.0 * ln(51) = 10 + 19.6 = 29
        At edge_count=100: budget = 10 + 5.0 * ln(101) = 10 + 23.1 = 30 (ceiling)
        """
        raw = self._params.budget_base + self._params.budget_scale * math.log(
            semantic_edge_count + 1
        )
        return min(self._params.budget_ceiling, max(self._params.budget_base, int(raw)))

    @property
    def budget(self) -> int:
        """Current main-domain activation budget."""
        return self._main_budget

    @property
    def cross_domain_budget_remaining(self) -> int:
        """Remaining cross-domain activation slots."""
        return max(0, self._cross_domain_budget - self._cross_domain_count)

    @property
    def main_budget_remaining(self) -> int:
        """Remaining main-domain activation slots."""
        return max(0, self._main_budget - self._main_domain_count)

    def get_activation_map(self) -> dict[str, float]:
        """Return the current activation map as dict[node_id, boost].

        Entries that have expired (past TTL) are pruned before returning.
        This is the map passed to DefinitionQueryRequest.activation_map.
        """
        now = time.monotonic()
        self._prune_expired(now)
        return {
            entry.node_id: entry.boost
            for entry in self._entries.values()
            if entry.boost > 0.0
        }

    def _prune_expired(self, now: float) -> None:
        """Remove entries whose TTL has expired."""
        ttl = self._params.activation_ttl_seconds
        expired = [
            nid
            for nid, entry in self._entries.items()
            if (now - entry.timestamp) > ttl
        ]
        for nid in expired:
            entry = self._entries.pop(nid)
            # Decrement domain counters
            if entry.domain != "semantic":
                self._cross_domain_count = max(0, self._cross_domain_count - 1)
            else:
                self._main_domain_count = max(0, self._main_domain_count - 1)

    def _is_cross_domain(self, domain: str) -> bool:
        """Check if a domain is cross-domain relative to the semantic domain."""
        return domain not in ("semantic", "")

    def activate_node(
        self,
        node_id: str,
        boost: float,
        domain: str,
        source_query_id: str,
        depth_from_source: int,
    ) -> bool:
        """Attempt to activate a single node in the map.

        Implements Layer 2 accumulation strategy (max-boost):
        - If node is not in map and budget allows: add it, return True.
        - If node is already in map:
          - If new boost > existing boost: replace entry, reset TTL. Return True.
          - If new boost <= existing boost: keep existing, TTL unchanged. Return False.
        - If budget exhausted: return False.

        Args:
            node_id: The node to activate.
            boost: The activation boost value (before any threshold check).
            domain: The domain of this node ("semantic", "language", "math", etc.).
            source_query_id: Which query produced this activation.
            depth_from_source: Number of hops from the query origin.

        Returns:
            True if the node was added or updated, False if skipped.
        """
        if boost < self._params.min_activation_threshold:
            return False

        now = time.monotonic()
        cross = self._is_cross_domain(domain)

        # Check if already activated
        existing = self._entries.get(node_id)
        if existing is not None:
            if self._params.max_boost_strategy:
                # Max-boost: replace only if new boost is higher
                if boost > existing.boost:
                    self._entries[node_id] = ActivationEntry(
                        node_id=node_id,
                        boost=boost,
                        timestamp=now,  # TTL resets on replacement
                        domain=domain,
                        source_query_id=source_query_id,
                        depth_from_source=depth_from_source,
                    )
                    return True
                # New boost <= existing: keep existing, TTL unchanged
                return False
            else:
                # Additive strategy (not default, but supported)
                new_boost = min(1.0, existing.boost + boost)
                self._entries[node_id] = ActivationEntry(
                    node_id=node_id,
                    boost=new_boost,
                    timestamp=now,
                    domain=domain,
                    source_query_id=source_query_id,
                    depth_from_source=depth_from_source,
                )
                return True

        # New entry: check budget
        if cross:
            if self._cross_domain_count >= self._cross_domain_budget:
                return False
            self._cross_domain_count += 1
        else:
            if self._main_domain_count >= self._main_budget:
                return False
            self._main_domain_count += 1

        self._entries[node_id] = ActivationEntry(
            node_id=node_id,
            boost=boost,
            timestamp=now,
            domain=domain,
            source_query_id=source_query_id,
            depth_from_source=depth_from_source,
        )
        return True

    def apply_inhibition(self, traversed_node_ids: set[str]) -> InhibitionResult:
        """Apply post-traversal inhibition (Layer 3).

        After a query traversal completes, nodes that were activated but NOT
        in the traversed set receive the inhibition modifier. Nodes whose
        boost drops to zero or below are removed from the map.

        Args:
            traversed_node_ids: Set of node_ids that were actually visited
                by the controlled query traversal.

        Returns:
            InhibitionResult with counts of inhibited, removed, and preserved nodes.
        """
        inhibited = 0
        removed = 0
        preserved = 0

        to_remove: list[str] = []

        for nid, entry in self._entries.items():
            if nid in traversed_node_ids:
                preserved += 1
                continue

            # Apply inhibition modifier
            new_boost = entry.boost + self._params.inhibition_modifier
            if new_boost <= 0.0:
                to_remove.append(nid)
                removed += 1
            else:
                # Update boost in place (create new entry since frozen-ish)
                self._entries[nid] = ActivationEntry(
                    node_id=entry.node_id,
                    boost=new_boost,
                    timestamp=entry.timestamp,  # TTL does not reset on inhibition
                    domain=entry.domain,
                    source_query_id=entry.source_query_id,
                    depth_from_source=entry.depth_from_source,
                )
                inhibited += 1

        for nid in to_remove:
            entry = self._entries.pop(nid)
            if self._is_cross_domain(entry.domain):
                self._cross_domain_count = max(0, self._cross_domain_count - 1)
            else:
                self._main_domain_count = max(0, self._main_domain_count - 1)

        _log.debug(
            "SpreadingActivation: inhibition applied (inhibited=%d, removed=%d, "
            "preserved=%d)",
            inhibited,
            removed,
            preserved,
        )
        return InhibitionResult(
            nodes_inhibited=inhibited,
            nodes_removed=removed,
            nodes_preserved=preserved,
        )

    def record_spread_ratio(self, ratio: float) -> None:
        """Record a spread ratio from a single spread operation for session monitoring."""
        self._spread_ratios.append(ratio)

    def compute_session_spread_stats(self) -> tuple[float, float]:
        """Compute session-level p50 and p95 spread ratios.

        Returns:
            (p50, p95) tuple. Both are 0.0 if no spread operations recorded.
        """
        if not self._spread_ratios:
            return (0.0, 0.0)

        sorted_ratios = sorted(self._spread_ratios)
        n = len(sorted_ratios)
        p50_idx = max(0, int(n * 0.50) - 1)
        p95_idx = max(0, int(n * 0.95) - 1)

        return (sorted_ratios[p50_idx], sorted_ratios[p95_idx])

    def active_count(self) -> int:
        """Number of currently active (non-expired) entries."""
        now = time.monotonic()
        self._prune_expired(now)
        return len(self._entries)

    def clear(self) -> None:
        """Remove all activation entries. Used at session end."""
        self._entries.clear()
        self._main_domain_count = 0
        self._cross_domain_count = 0


# ---------------------------------------------------------------------------
# Core: SpreadingActivationEngine
# ---------------------------------------------------------------------------


class SpreadingActivationEngine:
    """Executes spreading activation propagation through the semantic graph.

    This engine performs the BFS propagation (Layer 1), delegates accumulation
    to the SessionActivationMap (Layer 2), and exposes inhibition (Layer 3).
    Budget enforcement is handled by the SessionActivationMap (Layer 4).

    The engine uses a Neo4j session for neighbor lookups during BFS. Each
    call to ``spread_from()`` executes one BFS propagation from a source
    node, writing activations into the provided SessionActivationMap.

    Constructor:
        neo4j_session: Open Neo4j session for neighbor queries.
        params: SpreadingActivationParams from the EvolutionRule node.
    """

    def __init__(
        self,
        neo4j_session: neo4j.Session,
        params: SpreadingActivationParams,
    ) -> None:
        self._session = neo4j_session
        self._params = params

    def spread_from(
        self,
        source_node_id: str,
        activation_map: SessionActivationMap,
        query_id: str,
        source_domain: str = "semantic",
    ) -> SpreadResult:
        """Propagate activation from a source node through semantic edges.

        BFS traversal from the source node. At each hop, the boost is
        attenuated by hop_decay_factor. Propagation stops when:
        - max_propagation_depth is reached
        - boost falls below min_activation_threshold
        - budget is exhausted
        - no more unvisited neighbors exist

        Args:
            source_node_id: The node to start activation from.
            activation_map: The session activation map to write into.
            query_id: Identifier for this query (for provenance).
            source_domain: Domain of the source node. Default "semantic".

        Returns:
            SpreadResult with activation statistics.
        """
        start_time = time.perf_counter()

        nodes_activated = 0
        nodes_skipped_budget = 0
        nodes_skipped_threshold = 0
        total_nodes_touched = 0
        max_depth_reached = 0

        # Activate the source node itself
        activated = activation_map.activate_node(
            node_id=source_node_id,
            boost=self._params.initial_boost,
            domain=source_domain,
            source_query_id=query_id,
            depth_from_source=0,
        )
        if activated:
            nodes_activated += 1

        # BFS queue: (node_id, current_depth, current_boost)
        frontier: list[tuple[str, int, float]] = [
            (source_node_id, 0, self._params.initial_boost)
        ]
        visited: set[str] = {source_node_id}

        while frontier:
            next_frontier: list[tuple[str, int, float]] = []

            for current_node_id, current_depth, current_boost in frontier:
                if current_depth >= self._params.max_propagation_depth:
                    continue

                # Query neighbors via semantic edges
                neighbors = self._get_semantic_neighbors(current_node_id)

                for neighbor_id, neighbor_domain, edge_confidence in neighbors:
                    total_nodes_touched += 1

                    if neighbor_id in visited:
                        continue
                    visited.add(neighbor_id)

                    # Compute attenuated boost for this hop
                    next_boost = current_boost * self._params.hop_decay_factor
                    # Scale by edge confidence (lower-confidence edges propagate less)
                    next_boost *= edge_confidence

                    if next_boost < self._params.min_activation_threshold:
                        nodes_skipped_threshold += 1
                        continue

                    next_depth = current_depth + 1
                    effective_domain = neighbor_domain if neighbor_domain else source_domain

                    activated = activation_map.activate_node(
                        node_id=neighbor_id,
                        boost=next_boost,
                        domain=effective_domain,
                        source_query_id=query_id,
                        depth_from_source=next_depth,
                    )

                    if activated:
                        nodes_activated += 1
                        max_depth_reached = max(max_depth_reached, next_depth)
                        # Continue BFS from this node
                        next_frontier.append((neighbor_id, next_depth, next_boost))
                    else:
                        nodes_skipped_budget += 1

            frontier = next_frontier

        elapsed_ms = (time.perf_counter() - start_time) * 1000.0

        # Compute spread ratio for monitoring
        spread_ratio = (
            nodes_activated / total_nodes_touched
            if total_nodes_touched > 0
            else 0.0
        )
        activation_map.record_spread_ratio(spread_ratio)

        result = SpreadResult(
            source_node_id=source_node_id,
            nodes_activated=nodes_activated,
            nodes_skipped_budget=nodes_skipped_budget,
            nodes_skipped_threshold=nodes_skipped_threshold,
            total_nodes_touched=total_nodes_touched,
            max_depth_reached=max_depth_reached,
            spread_ratio=spread_ratio,
            elapsed_ms=elapsed_ms,
        )

        _log.debug(
            "SpreadingActivation: spread from %s -- activated=%d, "
            "skipped_budget=%d, skipped_threshold=%d, touched=%d, "
            "max_depth=%d, ratio=%.3f, elapsed=%.1fms",
            source_node_id,
            nodes_activated,
            nodes_skipped_budget,
            nodes_skipped_threshold,
            total_nodes_touched,
            max_depth_reached,
            spread_ratio,
            elapsed_ms,
        )

        return result

    def _get_semantic_neighbors(
        self, node_id: str
    ) -> list[tuple[str, str, float]]:
        """Query semantic neighbors of a node via Neo4j.

        Returns a list of (neighbor_node_id, domain, edge_confidence) tuples.
        Only follows active semantic edges (valid_to IS NULL) with confidence
        above MIN_CONFIDENCE_FLOOR. Both outgoing and incoming edges are
        followed (semantic relationships are directional but activation
        spreads bidirectionally, matching biological spreading activation
        in Collins & Loftus 1975).
        """
        # Cypher query: find all semantic edge neighbors in both directions.
        # We query both outgoing and incoming because activation is bidirectional.
        cypher = """
            MATCH (n {node_id: $node_id})-[r]-(neighbor)
            WHERE r.confidence >= $min_confidence
              AND (r.valid_to IS NULL)
              AND r.edge_type IN $semantic_edge_types
            RETURN DISTINCT
                neighbor.node_id AS neighbor_id,
                COALESCE(neighbor.prop_domain, '') AS domain,
                r.confidence AS edge_confidence
            LIMIT 50
        """
        # The LIMIT 50 per node prevents hub-node explosion. At E3 scale this
        # is generous; at larger scale, the budget-based cutoff in
        # SessionActivationMap handles the overflow.

        semantic_edge_types = [
            "IS_A",
            "HAS_PROPERTY",
            "LACKS_PROPERTY",
            "PART_OF",
            "LOCATED_IN",
            "USED_FOR",
            "CAUSES",
            "ENABLES",
            "PREVENTS",
            "REQUIRES",
            "ACHIEVES",
            "PRODUCES",
            "CONSUMES",
            "SIMILAR_TO",
            "OPPOSITE_OF",
            "DENOTES",
        ]

        try:
            result = self._session.run(
                cypher,
                node_id=node_id,
                min_confidence=MIN_CONFIDENCE_FLOOR,
                semantic_edge_types=semantic_edge_types,
            )

            neighbors: list[tuple[str, str, float]] = []
            for record in result:
                nid = record["neighbor_id"]
                domain = record["domain"] or "semantic"
                conf = float(record["edge_confidence"])
                if nid is not None:
                    neighbors.append((nid, domain, conf))
            return neighbors

        except Exception as exc:
            _log.warning(
                "SpreadingActivation: neighbor query failed for %s: %s",
                node_id,
                exc,
            )
            return []


# ---------------------------------------------------------------------------
# Session monitoring: write spread ratio stats back to EvolutionRule
# ---------------------------------------------------------------------------


async def update_spread_ratio_stats(
    persistence: GraphPersistence,
    p50: float,
    p95: float,
) -> None:
    """Write session spread ratio p50/p95 back to the EvolutionRule node.

    Called at session end by the SemanticQueryHandler to persist monitoring
    metrics. These values are used by the operational metrics tier (T015)
    to detect underactivation or overactivation trends.

    Args:
        persistence: Graph persistence backend.
        p50: 50th percentile spread ratio for this session.
        p95: 95th percentile spread ratio for this session.
    """
    node = await persistence.get_node(SPREADING_ACTIVATION_RULE_ID)
    if node is None:
        _log.warning(
            "SpreadingActivation: cannot update spread ratio stats -- "
            "EvolutionRule node %s not found",
            SPREADING_ACTIVATION_RULE_ID,
        )
        return

    node.properties["session_spread_ratio_p50"] = round(p50, 4)
    node.properties["session_spread_ratio_p95"] = round(p95, 4)
    node.properties["last_spread_ratio_update"] = datetime.now(UTC).isoformat()

    await persistence.save_node(node)
    _log.info(
        "SpreadingActivation: updated spread ratio stats (p50=%.4f, p95=%.4f)",
        p50,
        p95,
    )


# ---------------------------------------------------------------------------
# Depth advancement check
# ---------------------------------------------------------------------------


async def check_depth_advancement(
    persistence: GraphPersistence,
    total_queries_this_session: int,
    session_p95: float,
) -> bool:
    """Check whether propagation depth should advance from 2 to 3.

    Called at session end. Advancement criteria:
    - Current stage is INITIAL (depth=2)
    - At least depth_advance_min_queries queries have been processed
    - Session p95 spread ratio is below depth_advance_max_p95_ratio
      (indicates activation is not over-spreading)

    If criteria are met, the EvolutionRule node is updated to ADVANCED stage
    and max_propagation_depth becomes 3.

    Args:
        persistence: Graph persistence backend.
        total_queries_this_session: Total semantic queries this session.
        session_p95: 95th percentile spread ratio this session.

    Returns:
        True if advancement was applied, False otherwise.
    """
    node = await persistence.get_node(SPREADING_ACTIVATION_RULE_ID)
    if node is None:
        return False

    params = SpreadingActivationParams.from_evolution_rule(node)

    if params.depth_stage != PropagationDepthStage.INITIAL:
        return False  # Already advanced

    if total_queries_this_session < params.depth_advance_min_queries:
        _log.debug(
            "SpreadingActivation: depth advancement not ready -- "
            "queries=%d < min=%d",
            total_queries_this_session,
            params.depth_advance_min_queries,
        )
        return False

    if session_p95 > params.depth_advance_max_p95_ratio:
        _log.debug(
            "SpreadingActivation: depth advancement blocked -- "
            "p95=%.4f > max=%.4f",
            session_p95,
            params.depth_advance_max_p95_ratio,
        )
        return False

    # Advance to depth 3
    node.properties["depth_stage"] = PropagationDepthStage.ADVANCED
    node.properties["max_propagation_depth"] = DEVELOPMENTAL_MAX_PROPAGATION_DEPTH
    node.properties["depth_advanced_at"] = datetime.now(UTC).isoformat()
    await persistence.save_node(node)

    _log.info(
        "SpreadingActivation: DEPTH ADVANCED from %d to %d "
        "(queries=%d, p95=%.4f)",
        DEFAULT_MAX_PROPAGATION_DEPTH,
        DEVELOPMENTAL_MAX_PROPAGATION_DEPTH,
        total_queries_this_session,
        session_p95,
    )
    return True


# ---------------------------------------------------------------------------
# Convenience: create engine and map for a session
# ---------------------------------------------------------------------------


async def create_session_activation(
    persistence: GraphPersistence,
    neo4j_session: neo4j.Session,
    semantic_edge_count: int = 0,
) -> tuple[SpreadingActivationEngine, SessionActivationMap]:
    """Create a paired engine and activation map for a session.

    Reads parameters from the EvolutionRule node (or uses defaults if absent),
    creates the SessionActivationMap with developmental budget scaling, and
    creates the SpreadingActivationEngine with the Neo4j session.

    Args:
        persistence: Graph persistence backend.
        neo4j_session: Open Neo4j session for neighbor queries.
        semantic_edge_count: Total semantic edge count for budget computation.

    Returns:
        (engine, activation_map) tuple ready for use.
    """
    rule_node = await persistence.get_node(SPREADING_ACTIVATION_RULE_ID)
    params = SpreadingActivationParams.from_evolution_rule(rule_node)

    activation_map = SessionActivationMap(
        params=params,
        semantic_edge_count=semantic_edge_count,
    )
    engine = SpreadingActivationEngine(
        neo4j_session=neo4j_session,
        params=params,
    )

    return engine, activation_map


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

__all__ = [
    # Constants
    "SPREADING_ACTIVATION_RULE_ID",
    "DEFAULT_HOP_DECAY_FACTOR",
    "DEFAULT_INITIAL_BOOST",
    "DEFAULT_MAX_PROPAGATION_DEPTH",
    "DEVELOPMENTAL_MAX_PROPAGATION_DEPTH",
    "DEFAULT_BUDGET_BASE",
    "DEFAULT_BUDGET_SCALE",
    "DEFAULT_BUDGET_CEILING",
    "DEFAULT_CROSS_DOMAIN_BUDGET",
    "DEFAULT_INHIBITION_MODIFIER",
    "SPREAD_RATIO_MIN",
    "SPREAD_RATIO_MAX",
    # Data structures
    "ActivationEntry",
    "SpreadingActivationParams",
    "SpreadResult",
    "InhibitionResult",
    "PropagationDepthStage",
    # Session map
    "SessionActivationMap",
    # Engine
    "SpreadingActivationEngine",
    # Bootstrap
    "ensure_spreading_activation_rule",
    # Session lifecycle
    "create_session_activation",
    "update_spread_ratio_stats",
    "check_depth_advancement",
]
