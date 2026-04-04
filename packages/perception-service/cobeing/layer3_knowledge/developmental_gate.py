"""Developmental query gating -- Piaget developmental progression (P1.8-E3/T012).

Implements a developmental progression where query capabilities unlock through
demonstrated competence, following Piaget constructivist principle that each
cognitive capability builds on mastery of prerequisite capabilities.

Developmental sequence:
  1. definition_query -- available at bootstrap (no gate).
  2. classification_query -- unlocks after 25 definitions, 3 concept clusters,
     15 guardian confirmations.
  3. inference_query -- unlocks after 20 classifications, 5 semantic edge types,
     3 cross-domain facts.

Phase 1.8 (Comprehension Layer, P1.8-E3/T012).
CANON A.1 (experience-first), A.2 (LLM as tool), A.19 (inference traces).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime

from cobeing.layer3_knowledge.node_types import (
    KnowledgeNode,
    NodeStatus,
    SchemaLevel,
)
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import NodeId

_logger = logging.getLogger(__name__)

QUERY_CAPABILITIES_NODE_ID = NodeId("evolution:query_capabilities")
QUERY_CAPABILITIES_RULE_NAME = "QUERY_CAPABILITIES"
PROC_DEFINITION = "proc:definition_query"
PROC_CLASSIFICATION = "proc:classification_query"
PROC_INFERENCE = "proc:inference_query"
CLASSIFICATION_MIN_DEFINITIONS: int = 25
CLASSIFICATION_MIN_CONCEPT_CLUSTERS: int = 3
CLASSIFICATION_MIN_GUARDIAN_CONFIRMATIONS: int = 15
INFERENCE_MIN_CLASSIFICATIONS: int = 20
INFERENCE_MIN_SEMANTIC_EDGE_TYPES: int = 5
INFERENCE_MIN_CROSS_DOMAIN_FACTS: int = 3
_FALLBACK_CHAIN: dict[str, str] = {
    PROC_INFERENCE: PROC_CLASSIFICATION,
    PROC_CLASSIFICATION: PROC_DEFINITION,
}


@dataclass(frozen=True)
class DevelopmentalState:
    """Snapshot of the developmental gating state."""
    definition_enabled: bool
    classification_enabled: bool
    inference_enabled: bool
    successful_definitions: int
    successful_classifications: int
    concept_cluster_count: int
    guardian_confirmations: int
    semantic_edge_type_count: int
    cross_domain_fact_count: int
    classification_guardian_override: bool
    inference_guardian_override: bool
    evaluation_timestamp: datetime


@dataclass(frozen=True)
class GateEvaluationResult:
    """Result of evaluating whether a specific query type is enabled."""
    procedure_id: str
    enabled: bool
    reason: str
    fallback_procedure_id: str | None
    state: DevelopmentalState


def _build_query_capabilities_node() -> KnowledgeNode:
    """Build the evolution:query_capabilities EvolutionRule node."""
    return KnowledgeNode(
        node_id=QUERY_CAPABILITIES_NODE_ID,
        node_type="EvolutionRule",
        schema_level=SchemaLevel.META_SCHEMA,
        properties={
            "rule_name": QUERY_CAPABILITIES_RULE_NAME,
            "definition_query_enabled": True,
            "classification_query_enabled": False,
            "inference_query_enabled": False,
            "classification_guardian_override": False,
            "inference_guardian_override": False,
            "successful_definitions": 0,
            "successful_classifications": 0,
            "concept_cluster_count": 0,
            "guardian_confirmations": 0,
            "semantic_edge_type_count": 0,
            "cross_domain_fact_count": 0,
            "last_evaluation_timestamp": datetime.now(UTC).isoformat(),
            "description": "Tracks developmental progression of semantic query capabilities.",
        },
        provenance=Provenance(
            source=ProvenanceSource.INFERENCE,
            source_id="developmental-gate-bootstrap",
            confidence=1.0,
        ),
        confidence=1.0,
        status=NodeStatus.ACTIVE,
    )


async def bootstrap_query_capabilities(persistence: GraphPersistence) -> bool:
    """Create the evolution:query_capabilities node if absent. Idempotent."""
    existing = await persistence.get_node(QUERY_CAPABILITIES_NODE_ID)
    if existing is not None:
        _logger.debug("developmental_gate_bootstrap: already exists")
        return False
    node = _build_query_capabilities_node()
    await persistence.save_node(node)
    _logger.info(
        "developmental_gate_bootstrap: created evolution:query_capabilities "
        "(definition=enabled, classification=locked, inference=locked)"
    )
    return True


class DevelopmentalGate:
    """Developmental query gating engine implementing Piaget progression."""

    def __init__(
        self,
        persistence: GraphPersistence,
        neo4j_driver: object | None = None,
    ) -> None:
        self._persistence = persistence
        self._neo4j_driver = neo4j_driver
        self._cached_state: DevelopmentalState | None = None
        self._cache_session_id: str | None = None

    async def evaluate(self, session_id: str | None = None) -> DevelopmentalState:
        """Evaluate current developmental state by querying the graph."""
        if (
            self._cached_state is not None
            and session_id is not None
            and self._cache_session_id == session_id
        ):
            return self._cached_state

        rule_node = await self._persistence.get_node(QUERY_CAPABILITIES_NODE_ID)
        if rule_node is None:
            await bootstrap_query_capabilities(self._persistence)
            rule_node = await self._persistence.get_node(QUERY_CAPABILITIES_NODE_ID)
            if rule_node is None:
                _logger.error(
                    "developmental_gate: cannot create or read "
                    "evolution:query_capabilities -- defaulting to definition-only"
                )
                return self._default_state()

        props = rule_node.properties
        successful_defs = int(props.get("successful_definitions", 0))
        successful_class = int(props.get("successful_classifications", 0))
        class_override = bool(props.get("classification_guardian_override", False))
        infer_override = bool(props.get("inference_guardian_override", False))

        concept_clusters = await self._count_concept_clusters()
        guardian_confirmations = await self._count_guardian_confirmations()
        semantic_edge_types = await self._count_semantic_edge_types()
        cross_domain_facts = await self._count_cross_domain_facts()

        classification_criteria_met = (
            successful_defs >= CLASSIFICATION_MIN_DEFINITIONS
            and concept_clusters >= CLASSIFICATION_MIN_CONCEPT_CLUSTERS
            and guardian_confirmations >= CLASSIFICATION_MIN_GUARDIAN_CONFIRMATIONS
        )
        classification_enabled = classification_criteria_met or class_override

        inference_criteria_met = (
            successful_class >= INFERENCE_MIN_CLASSIFICATIONS
            and semantic_edge_types >= INFERENCE_MIN_SEMANTIC_EDGE_TYPES
            and cross_domain_facts >= INFERENCE_MIN_CROSS_DOMAIN_FACTS
        )
        inference_enabled = inference_criteria_met or infer_override

        now = datetime.now(UTC)
        state = DevelopmentalState(
            definition_enabled=True,
            classification_enabled=classification_enabled,
            inference_enabled=inference_enabled,
            successful_definitions=successful_defs,
            successful_classifications=successful_class,
            concept_cluster_count=concept_clusters,
            guardian_confirmations=guardian_confirmations,
            semantic_edge_type_count=semantic_edge_types,
            cross_domain_fact_count=cross_domain_facts,
            classification_guardian_override=class_override,
            inference_guardian_override=infer_override,
            evaluation_timestamp=now,
        )

        await self._update_rule_node(rule_node=rule_node, state=state)

        _logger.info(
            "developmental_gate_evaluation "
            "definition_enabled=%s classification_enabled=%s inference_enabled=%s "
            "successful_definitions=%d/%d concept_clusters=%d/%d "
            "guardian_confirmations=%d/%d successful_classifications=%d/%d "
            "semantic_edge_types=%d/%d cross_domain_facts=%d/%d "
            "classification_override=%s inference_override=%s",
            True, classification_enabled, inference_enabled,
            successful_defs, CLASSIFICATION_MIN_DEFINITIONS,
            concept_clusters, CLASSIFICATION_MIN_CONCEPT_CLUSTERS,
            guardian_confirmations, CLASSIFICATION_MIN_GUARDIAN_CONFIRMATIONS,
            successful_class, INFERENCE_MIN_CLASSIFICATIONS,
            semantic_edge_types, INFERENCE_MIN_SEMANTIC_EDGE_TYPES,
            cross_domain_facts, INFERENCE_MIN_CROSS_DOMAIN_FACTS,
            class_override, infer_override,
        )

        self._cached_state = state
        self._cache_session_id = session_id
        return state

    async def get_enabled_procedures(self, session_id: str | None = None) -> frozenset[str]:
        """Return the set of currently enabled procedure IDs for PT-9 filtering."""
        state = await self.evaluate(session_id=session_id)
        enabled: set[str] = {PROC_DEFINITION}
        if state.classification_enabled:
            enabled.add(PROC_CLASSIFICATION)
        if state.inference_enabled:
            enabled.add(PROC_INFERENCE)
        return frozenset(enabled)

    async def check_procedure(
        self, procedure_id: str, session_id: str | None = None,
    ) -> GateEvaluationResult:
        """Check whether a procedure is enabled and provide Cortex fallback."""
        state = await self.evaluate(session_id=session_id)
        enabled = False
        reason = ""
        fallback_id: str | None = None

        if procedure_id == PROC_DEFINITION:
            enabled = True
            reason = "definition_query is always enabled at bootstrap"
        elif procedure_id == PROC_CLASSIFICATION:
            enabled = state.classification_enabled
            if enabled:
                if state.classification_guardian_override:
                    reason = "classification_query enabled by guardian override"
                else:
                    reason = (
                        f"classification_query unlocked: "
                        f"{state.successful_definitions} defs >= {CLASSIFICATION_MIN_DEFINITIONS}, "
                        f"{state.concept_cluster_count} clusters >= {CLASSIFICATION_MIN_CONCEPT_CLUSTERS}, "
                        f"{state.guardian_confirmations} confirms >= {CLASSIFICATION_MIN_GUARDIAN_CONFIRMATIONS}"
                    )
            else:
                reason = (
                    f"classification_query locked: need "
                    f"{max(0, CLASSIFICATION_MIN_DEFINITIONS - state.successful_definitions)} more definitions, "
                    f"{max(0, CLASSIFICATION_MIN_CONCEPT_CLUSTERS - state.concept_cluster_count)} more clusters, "
                    f"{max(0, CLASSIFICATION_MIN_GUARDIAN_CONFIRMATIONS - state.guardian_confirmations)} more confirmations"
                )
                fallback_id = _FALLBACK_CHAIN.get(PROC_CLASSIFICATION)
        elif procedure_id == PROC_INFERENCE:
            enabled = state.inference_enabled
            if enabled:
                if state.inference_guardian_override:
                    reason = "inference_query enabled by guardian override"
                else:
                    reason = (
                        f"inference_query unlocked: "
                        f"{state.successful_classifications} classifications >= {INFERENCE_MIN_CLASSIFICATIONS}, "
                        f"{state.semantic_edge_type_count} edge types >= {INFERENCE_MIN_SEMANTIC_EDGE_TYPES}, "
                        f"{state.cross_domain_fact_count} cross-domain >= {INFERENCE_MIN_CROSS_DOMAIN_FACTS}"
                    )
            else:
                reason = (
                    f"inference_query locked: need "
                    f"{max(0, INFERENCE_MIN_CLASSIFICATIONS - state.successful_classifications)} more classifications, "
                    f"{max(0, INFERENCE_MIN_SEMANTIC_EDGE_TYPES - state.semantic_edge_type_count)} more edge types, "
                    f"{max(0, INFERENCE_MIN_CROSS_DOMAIN_FACTS - state.cross_domain_fact_count)} more cross-domain facts"
                )
                fallback_id = _FALLBACK_CHAIN.get(PROC_INFERENCE)
                if fallback_id == PROC_CLASSIFICATION and not state.classification_enabled:
                    fallback_id = PROC_DEFINITION
        else:
            reason = f"unknown procedure_id: {procedure_id}"

        _logger.info(
            "developmental_gate_check procedure=%s enabled=%s reason=%s fallback=%s",
            procedure_id, enabled, reason, fallback_id,
        )
        return GateEvaluationResult(
            procedure_id=procedure_id, enabled=enabled, reason=reason,
            fallback_procedure_id=fallback_id, state=state,
        )

    async def record_successful_query(self, query_type: str) -> None:
        """Record a successful query for developmental tracking."""
        rule_node = await self._persistence.get_node(QUERY_CAPABILITIES_NODE_ID)
        if rule_node is None:
            _logger.warning("developmental_gate_record: node not found")
            return
        counter_key: str | None = None
        if query_type == "definition":
            counter_key = "successful_definitions"
        elif query_type == "classification":
            counter_key = "successful_classifications"
        else:
            _logger.debug("developmental_gate_record: query_type=%s has no counter", query_type)
            return
        current = int(rule_node.properties.get(counter_key, 0))
        rule_node.properties[counter_key] = current + 1
        rule_node.properties["last_evaluation_timestamp"] = datetime.now(UTC).isoformat()
        await self._persistence.save_node(rule_node)
        _logger.info(
            "developmental_gate_record query_type=%s counter=%s new_value=%d",
            query_type, counter_key, current + 1,
        )
        self._cached_state = None

    async def set_guardian_override(self, query_type: str, enabled: bool = True) -> bool:
        """Set or clear a guardian override for a query type (ZPD bypass)."""
        rule_node = await self._persistence.get_node(QUERY_CAPABILITIES_NODE_ID)
        if rule_node is None:
            _logger.warning("developmental_gate_override: node not found")
            return False
        override_key: str | None = None
        if query_type == "classification":
            override_key = "classification_guardian_override"
        elif query_type == "inference":
            override_key = "inference_guardian_override"
        else:
            _logger.warning("developmental_gate_override: invalid query_type=%s", query_type)
            return False
        rule_node.properties[override_key] = enabled
        rule_node.properties["last_evaluation_timestamp"] = datetime.now(UTC).isoformat()
        await self._persistence.save_node(rule_node)
        self._cached_state = None
        _logger.info(
            "developmental_gate_override query_type=%s enabled=%s (guardian ZPD bypass)",
            query_type, enabled,
        )
        return True

    def invalidate_cache(self) -> None:
        """Force re-evaluation on next access."""
        self._cached_state = None
        self._cache_session_id = None

    async def _count_concept_clusters(self) -> int:
        if self._neo4j_driver is not None:
            try:
                return await self._count_concept_clusters_neo4j()
            except Exception as exc:
                _logger.warning("developmental_gate: neo4j concept cluster query failed: %s", exc)
        return await self._count_concept_clusters_persistence()

    async def _count_concept_clusters_neo4j(self) -> int:
        query = (
            "MATCH ()-[r:IS_A]->() "
            "WHERE r.valid_to IS NULL AND r.prop_confidence >= 0.3 "
            "RETURN count(DISTINCT endNode(r)) AS cluster_count"
        )
        driver = self._neo4j_driver
        if hasattr(driver, "session"):
            session = driver.session(database="neo4j")  # type: ignore[union-attr]
            try:
                result = session.run(query)
                record = result.single()
                return int(record["cluster_count"]) if record else 0
            finally:
                session.close()
        return 0

    async def _count_concept_clusters_persistence(self) -> int:
        from cobeing.layer3_knowledge.query_types import EdgeFilter
        edges = await self._persistence.query_edges(EdgeFilter(edge_type="IS_A"))
        targets = {e.target_id for e in edges if e.valid_to is None and e.confidence >= 0.3}
        return len(targets)
    async def _count_guardian_confirmations(self) -> int:
        if self._neo4j_driver is not None:
            try:
                return await self._count_guardian_confirmations_neo4j()
            except Exception as exc:
                _logger.warning("developmental_gate: neo4j guardian confirm failed: %s", exc)
        return await self._count_guardian_confirmations_persistence()

    async def _count_guardian_confirmations_neo4j(self) -> int:
        query = (
            "MATCH ()-[r]->() "
            "WHERE r.prop_guardian_confirmed = true AND r.valid_to IS NULL "
            "RETURN count(r) AS confirmed_count"
        )
        driver = self._neo4j_driver
        if hasattr(driver, "session"):
            session = driver.session(database="neo4j")  # type: ignore[union-attr]
            try:
                result = session.run(query)
                record = result.single()
                return int(record["confirmed_count"]) if record else 0
            finally:
                session.close()
        return 0

    async def _count_guardian_confirmations_persistence(self) -> int:
        from cobeing.layer3_knowledge.query_types import EdgeFilter
        confirmed = 0
        sem_types = ("IS_A", "HAS_PROPERTY", "PART_OF", "CAUSES", "ENABLES",
                     "PREVENTS", "USED_FOR", "LOCATED_IN", "REQUIRES", "ACHIEVES",
                     "PRODUCES", "CONSUMES", "LACKS_PROPERTY", "SIMILAR_TO",
                     "OPPOSITE_OF", "CONTRADICTS")
        for et in sem_types:
            try:
                edges = await self._persistence.query_edges(EdgeFilter(edge_type=et))
                for e in edges:
                    if e.valid_to is None and e.properties.get("guardian_confirmed") is True:
                        confirmed += 1
            except Exception:
                continue
        return confirmed
    async def _count_semantic_edge_types(self) -> int:
        if self._neo4j_driver is not None:
            try:
                return await self._count_semantic_edge_types_neo4j()
            except Exception as exc:
                _logger.warning("developmental_gate: neo4j edge type count failed: %s", exc)
        return await self._count_semantic_edge_types_persistence()

    async def _count_semantic_edge_types_neo4j(self) -> int:
        semantic_types = [
            "IS_A", "HAS_PROPERTY", "LACKS_PROPERTY", "PART_OF", "LOCATED_IN",
            "USED_FOR", "CAUSES", "ENABLES", "PREVENTS", "REQUIRES", "ACHIEVES",
            "PRODUCES", "CONSUMES", "CONTRADICTS", "SIMILAR_TO", "OPPOSITE_OF",
        ]
        query = (
            "UNWIND $types AS t "
            "OPTIONAL MATCH ()-[r]->() "
            "WHERE type(r) = t AND r.valid_to IS NULL "
            "WITH t, count(r) AS cnt WHERE cnt > 0 "
            "RETURN count(t) AS type_count"
        )
        driver = self._neo4j_driver
        if hasattr(driver, "session"):
            session = driver.session(database="neo4j")  # type: ignore[union-attr]
            try:
                result = session.run(query, types=semantic_types)
                record = result.single()
                return int(record["type_count"]) if record else 0
            finally:
                session.close()
        return 0

    async def _count_semantic_edge_types_persistence(self) -> int:
        from cobeing.layer3_knowledge.query_types import EdgeFilter
        semantic_types = (
            "IS_A", "HAS_PROPERTY", "LACKS_PROPERTY", "PART_OF", "LOCATED_IN",
            "USED_FOR", "CAUSES", "ENABLES", "PREVENTS", "REQUIRES", "ACHIEVES",
            "PRODUCES", "CONSUMES", "CONTRADICTS", "SIMILAR_TO", "OPPOSITE_OF",
        )
        found: set[str] = set()
        for et in semantic_types:
            try:
                edges = await self._persistence.query_edges(EdgeFilter(edge_type=et))
                if any(e.valid_to is None for e in edges):
                    found.add(et)
            except Exception:
                continue
        return len(found)
    async def _count_cross_domain_facts(self) -> int:
        if self._neo4j_driver is not None:
            try:
                return await self._count_cross_domain_facts_neo4j()
            except Exception as exc:
                _logger.warning("developmental_gate: neo4j DENOTES count failed: %s", exc)
        return await self._count_cross_domain_facts_persistence()

    async def _count_cross_domain_facts_neo4j(self) -> int:
        query = (
            "MATCH ()-[r:DENOTES]->() "
            "WHERE r.valid_to IS NULL "
            "RETURN count(r) AS denotes_count"
        )
        driver = self._neo4j_driver
        if hasattr(driver, "session"):
            session = driver.session(database="neo4j")  # type: ignore[union-attr]
            try:
                result = session.run(query)
                record = result.single()
                return int(record["denotes_count"]) if record else 0
            finally:
                session.close()
        return 0

    async def _count_cross_domain_facts_persistence(self) -> int:
        from cobeing.layer3_knowledge.query_types import EdgeFilter
        try:
            edges = await self._persistence.query_edges(EdgeFilter(edge_type="DENOTES"))
            return sum(1 for e in edges if e.valid_to is None)
        except Exception:
            return 0

    async def _update_rule_node(
        self, rule_node: KnowledgeNode, state: DevelopmentalState,
    ) -> None:
        props = rule_node.properties
        changed = False
        update_map: dict[str, object] = {
            "classification_query_enabled": state.classification_enabled,
            "inference_query_enabled": state.inference_enabled,
            "concept_cluster_count": state.concept_cluster_count,
            "guardian_confirmations": state.guardian_confirmations,
            "semantic_edge_type_count": state.semantic_edge_type_count,
            "cross_domain_fact_count": state.cross_domain_fact_count,
            "last_evaluation_timestamp": state.evaluation_timestamp.isoformat(),
        }
        for key, value in update_map.items():
            if props.get(key) != value:
                props[key] = value
                changed = True
        if changed:
            await self._persistence.save_node(rule_node)

    def _default_state(self) -> DevelopmentalState:
        return DevelopmentalState(
            definition_enabled=True, classification_enabled=False,
            inference_enabled=False, successful_definitions=0,
            successful_classifications=0, concept_cluster_count=0,
            guardian_confirmations=0, semantic_edge_type_count=0,
            cross_domain_fact_count=0, classification_guardian_override=False,
            inference_guardian_override=False, evaluation_timestamp=datetime.now(UTC),
        )


__all__ = [
    "CLASSIFICATION_MIN_CONCEPT_CLUSTERS",
    "CLASSIFICATION_MIN_DEFINITIONS",
    "CLASSIFICATION_MIN_GUARDIAN_CONFIRMATIONS",
    "DevelopmentalGate",
    "DevelopmentalState",
    "GateEvaluationResult",
    "INFERENCE_MIN_CLASSIFICATIONS",
    "INFERENCE_MIN_CROSS_DOMAIN_FACTS",
    "INFERENCE_MIN_SEMANTIC_EDGE_TYPES",
    "PROC_CLASSIFICATION",
    "PROC_DEFINITION",
    "PROC_INFERENCE",
    "QUERY_CAPABILITIES_NODE_ID",
    "QUERY_CAPABILITIES_RULE_NAME",
    "bootstrap_query_capabilities",
]
