"""Morphological transformation executor -- FST Priority Union.

Implements the Finite State Transducer priority union pattern from the
language comprehension prior art (Koskenniemi 1983, WordNet morphy):

  1. Check for direct-recall TRANSFORMS_TO edge (irregular/guardian-confirmed)
  2. Execute regular morphological ProceduralTemplate via string AST traversal
  3. Return result with strategy and confidence

Unlike ProcedureExecutor (which works over ValueNodes), MorphologyExecutor
works over Python strings directly. The AST traversal resolves $WORD to the
input string, not to a ValueNode ID. Results are stored as TRANSFORMS_TO edges.

Usage::

    from cobeing.layer3_knowledge.morphology_executor import MorphologyExecutor

    executor = MorphologyExecutor(persistence=graph)
    result = await executor.transform("cat", "plural")
    # result.result_spelling == "cats"
    # result.strategy == "procedural"

Phase 1.7 (P1.7-E2). CANON A.18 (TAUGHT_PROCEDURE provenance).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from cobeing.layer3_knowledge.language_types import (
    TRANSFORMS_TO,
    WORD_FORM_NODE,
)
from cobeing.layer3_knowledge.node_types import (
    KnowledgeEdge,
    KnowledgeNode,
    NodeStatus,
    SchemaLevel,
)
from cobeing.layer3_knowledge.procedure_types import (
    HAS_OPERAND,
    HAS_PROCEDURE_BODY,
    OPERATIONS,
    PROCEDURE_STEP,
)
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.query_types import EdgeFilter
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import EdgeId, NodeId

_logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MorphologyResult:
    """Outcome of a morphological transformation.

    Attributes:
        result_spelling: The computed inflected form, or None if the
            transformation could not be performed (unknown procedure,
            execution error).
        strategy: How the result was obtained. One of:
            ``'direct_recall'`` -- retrieved from an existing TRANSFORMS_TO
            edge (irregular form or previously computed regular form).
            ``'procedural'`` -- computed by traversing the morphological
            procedure AST.
            ``'unknown'`` -- no procedure exists for this transform_type
            and no direct-recall edge was found.
        confidence: Confidence of the result. 1.0 for irregular direct
            recall, 0.15 for newly computed procedural results, or the
            stored edge confidence for previously computed direct recall.
        base_spelling: The input word spelling.
        transform_type: The morphological transformation requested
            (e.g., ``'plural'``, ``'past_tense'``).
    """

    result_spelling: str | None
    strategy: str
    confidence: float
    base_spelling: str
    transform_type: str


# ---------------------------------------------------------------------------
# Procedure-to-transform mapping
# ---------------------------------------------------------------------------

_PROCEDURE_FOR_TRANSFORM: dict[str, str] = {
    "plural": "proc:pluralize",
    "past_tense": "proc:past_tense",
    "present_participle": "proc:present_participle",
    "comparative": "proc:comparative",
    "superlative": "proc:superlative",
    "third_person_singular": "proc:third_person",
}
"""Maps TRANSFORMS_TO transform_type values to ProceduralTemplate node IDs."""


# ---------------------------------------------------------------------------
# MorphologyExecutor
# ---------------------------------------------------------------------------


class MorphologyExecutor:
    """Morphological transformation engine using FST priority union.

    Executes the three-step priority union for morphological transformations:

    1. **Direct recall**: Look for an existing TRANSFORMS_TO edge from
       the base WordFormNode. If found with sufficient confidence, return
       immediately. Irregular forms (is_regular=False) always win.

    2. **Procedural execution**: If no direct recall found, execute the
       appropriate morphological ProceduralTemplate by traversing its AST
       with $WORD bound to the input string. Unlike ProcedureExecutor,
       variable resolution returns the Python string directly -- not a
       ValueNode value.

    3. **Result storage**: If procedural execution succeeds, create a
       TRANSFORMS_TO edge for the computed result (is_regular=True,
       confidence=0.15) so future lookups find it via direct recall.

    Args:
        persistence: The graph persistence backend.
    """

    def __init__(self, persistence: GraphPersistence) -> None:
        self._persistence = persistence

    async def transform(
        self,
        base_spelling: str,
        transform_type: str,
    ) -> MorphologyResult:
        """Execute FST priority union: irregular check -> procedure -> unknown.

        Args:
            base_spelling: The base word form (e.g., ``"cat"``).
            transform_type: The transformation to apply. One of:
                ``'plural'``, ``'past_tense'``, ``'present_participle'``,
                ``'comparative'``, ``'superlative'``,
                ``'third_person_singular'``.

        Returns:
            A :class:`MorphologyResult` with the computed spelling and
            strategy used.
        """
        # Step 1: Direct recall (irregulars + previously computed regulars)
        recall = await self._find_direct_recall(base_spelling, transform_type)
        if recall is not None:
            spelling, confidence = recall
            _logger.info(
                "morph_direct_recall word=%s transform=%s result=%s confidence=%.2f",
                base_spelling,
                transform_type,
                spelling,
                confidence,
            )
            return MorphologyResult(
                result_spelling=spelling,
                strategy="direct_recall",
                confidence=confidence,
                base_spelling=base_spelling,
                transform_type=transform_type,
            )

        # Step 1b: Check for defective edge — if the guardian has already
        # corrected a computed form for this word/transform, we know the
        # regular procedure is wrong here. Return unknown to escalate.
        if await self._has_defective_edge(base_spelling, transform_type):
            _logger.info(
                "morph_defective_skip word=%s transform=%s -- escalating to guardian",
                base_spelling,
                transform_type,
            )
            return MorphologyResult(
                result_spelling=None,
                strategy="unknown",
                confidence=0.0,
                base_spelling=base_spelling,
                transform_type=transform_type,
            )

        # Step 2: Procedural execution
        procedure_id = _PROCEDURE_FOR_TRANSFORM.get(transform_type)
        if procedure_id is None:
            _logger.warning(
                "morph_unknown_transform word=%s transform=%s",
                base_spelling,
                transform_type,
            )
            return MorphologyResult(
                result_spelling=None,
                strategy="unknown",
                confidence=0.0,
                base_spelling=base_spelling,
                transform_type=transform_type,
            )

        result_spelling = await self._execute_string_procedure(
            procedure_id, base_spelling
        )
        if result_spelling is None:
            _logger.warning(
                "morph_procedural_failed word=%s transform=%s procedure=%s",
                base_spelling,
                transform_type,
                procedure_id,
            )
            return MorphologyResult(
                result_spelling=None,
                strategy="unknown",
                confidence=0.0,
                base_spelling=base_spelling,
                transform_type=transform_type,
            )

        _logger.info(
            "morph_procedural_ok word=%s transform=%s result=%s procedure=%s",
            base_spelling,
            transform_type,
            result_spelling,
            procedure_id,
        )

        # Step 3: Store result as TRANSFORMS_TO edge
        try:
            await self._store_result(
                base_spelling, result_spelling, transform_type, procedure_id
            )
        except Exception as exc:
            _logger.warning(
                "morph_store_result_failed word=%s result=%s error=%s",
                base_spelling,
                result_spelling,
                exc,
            )

        return MorphologyResult(
            result_spelling=result_spelling,
            strategy="procedural",
            confidence=0.15,
            base_spelling=base_spelling,
            transform_type=transform_type,
        )

    # ------------------------------------------------------------------
    # Step 1: Direct recall
    # ------------------------------------------------------------------

    async def _find_direct_recall(
        self,
        base_spelling: str,
        transform_type: str,
    ) -> tuple[str, float] | None:
        """Look up TRANSFORMS_TO edge from base WordFormNode for this transform_type.

        Returns (target_spelling, confidence) if a suitable edge is found,
        or None if no direct recall exists.

        Priority: irregular forms (is_regular=False) always win. Regular
        forms with confidence >= 0.7 are also returned.
        """
        base_form_id = NodeId(f"form:{base_spelling}:base")
        base_node = await self._persistence.get_node(base_form_id)
        if base_node is None:
            return None

        edges = await self._persistence.query_edges(
            EdgeFilter(
                edge_type=TRANSFORMS_TO,
                source_node_id=base_form_id,
            )
        )

        for edge in edges:
            edge_transform = edge.properties.get("transform_type", "")
            if edge_transform != transform_type:
                continue

            # Skip defective edges (guardian-corrected errors).
            if edge.properties.get("is_defective", False):
                continue

            is_regular = edge.properties.get("is_regular", True)
            edge_confidence = edge.properties.get("confidence", 0.0)

            # Irregular forms always win (FST priority union)
            if not is_regular:
                target_node = await self._persistence.get_node(edge.target_id)
                if target_node is not None:
                    spelling = target_node.properties.get("spelling", "")
                    return (spelling, edge_confidence)

            # Regular forms need confidence >= 0.7
            if edge_confidence >= 0.7:
                target_node = await self._persistence.get_node(edge.target_id)
                if target_node is not None:
                    spelling = target_node.properties.get("spelling", "")
                    return (spelling, edge_confidence)

        return None

    # ------------------------------------------------------------------
    # Step 2: Procedural execution
    # ------------------------------------------------------------------

    async def _execute_string_procedure(
        self,
        procedure_id: str,
        word: str,
    ) -> str | None:
        """Execute a morphological ProceduralTemplate with $WORD = word string.

        Unlike ProcedureExecutor, resolves variables to Python strings directly.
        Traverses the AST using _execute_string_ast.

        Args:
            procedure_id: Node ID of the ProceduralTemplate to execute.
            word: The input word string to transform.

        Returns:
            The computed string result, or None if execution fails.
        """
        # Load procedure template
        proc_node = await self._persistence.get_node(NodeId(procedure_id))
        if proc_node is None:
            _logger.warning(
                "morph_procedure_not_found procedure=%s", procedure_id
            )
            return None

        # Find root step via HAS_PROCEDURE_BODY edge
        body_edges = await self._persistence.query_edges(
            EdgeFilter(
                edge_type=HAS_PROCEDURE_BODY,
                source_node_id=NodeId(procedure_id),
            )
        )
        if not body_edges:
            _logger.warning(
                "morph_procedure_no_body procedure=%s", procedure_id
            )
            return None

        root_step_id = body_edges[0].target_id

        try:
            result = await self._execute_string_ast(root_step_id, word)
            return str(result) if result is not None else None
        except Exception as exc:
            _logger.warning(
                "morph_ast_execution_failed procedure=%s word=%s error=%s",
                procedure_id,
                word,
                exc,
            )
            return None

    async def _execute_string_ast(
        self,
        step_id: NodeId,
        word: str,
    ) -> Any:
        """Traverse AST step, resolving $WORD to the word string directly.

        Handles:
        - ``literal``: return literal_value
        - ``variable``: return word (the input string) -- only $WORD is valid
        - ``operation``: dispatch to OPERATIONS[operation_name](*evaluated_children)
        - ``conditional``: evaluate condition, branch accordingly
        - ``call``: raises NotImplementedError (executor unification required)

        This is the key difference from ProcedureExecutor: variable resolution
        returns the Python string directly, not a ValueNode value.

        Args:
            step_id: NodeId of the ProcedureStep to evaluate.
            word: The input word string bound to $WORD.

        Returns:
            The evaluated Python value (string, bool, int, etc.).

        Raises:
            ValueError: If a step node is missing or has unknown step_type.
            NotImplementedError: If step_type is ``'call'`` (requires
                executor unification, planned for a future epic).
        """
        step_node = await self._persistence.get_node(step_id)
        if step_node is None:
            raise ValueError(f"ProcedureStep '{step_id}' not found in graph.")

        step_type = step_node.properties.get("step_type")

        if step_type == "literal":
            return step_node.properties.get("literal_value")

        if step_type == "variable":
            # Only $WORD is valid for morphological procedures
            return word

        if step_type == "operation":
            operation_name = step_node.properties.get("operation", "")
            if operation_name not in OPERATIONS:
                raise ValueError(
                    f"Unknown operation '{operation_name}' in morphological AST."
                )

            # Get child operand steps, sorted by position
            operand_edges = await self._persistence.query_edges(
                EdgeFilter(
                    edge_type=HAS_OPERAND,
                    source_node_id=step_id,
                )
            )
            operand_edges.sort(key=lambda e: e.properties.get("position", 0))

            # Recursively evaluate each operand
            operand_values = []
            for edge in operand_edges:
                value = await self._execute_string_ast(edge.target_id, word)
                operand_values.append(value)

            return OPERATIONS[operation_name](*operand_values)

        if step_type == "conditional":
            operand_edges = await self._persistence.query_edges(
                EdgeFilter(
                    edge_type=HAS_OPERAND,
                    source_node_id=step_id,
                )
            )
            operand_edges.sort(key=lambda e: e.properties.get("position", 0))
            if len(operand_edges) != 3:
                raise ValueError(
                    f"conditional step requires exactly 3 operands "
                    f"(condition, then, else), got {len(operand_edges)} "
                    f"on step {step_id}"
                )
            condition_value = await self._execute_string_ast(
                operand_edges[0].target_id, word
            )
            if condition_value:
                return await self._execute_string_ast(
                    operand_edges[1].target_id, word
                )
            else:
                return await self._execute_string_ast(
                    operand_edges[2].target_id, word
                )

        if step_type == "call":
            raise NotImplementedError(
                f"step_type 'call' is not supported by MorphologyExecutor. "
                f"Morphological procedure composition requires executor unification "
                f"(planned for a future epic). Step: '{step_id}'."
            )
        raise ValueError(f"Unknown step_type '{step_type}' on step '{step_id}'.")

    # ------------------------------------------------------------------
    # Step 3: Result storage
    # ------------------------------------------------------------------

    async def _store_result(
        self,
        base_spelling: str,
        result_spelling: str,
        transform_type: str,
        procedure_id: str,
    ) -> None:
        """Create TRANSFORMS_TO edge for the computed result.

        Creates target WordFormNode if needed, then TRANSFORMS_TO edge with:
        is_regular=True, confidence=0.15, encounter_count=1,
        source_procedure_id=procedure_id, guardian_confirmed=False.

        Args:
            base_spelling: The base word form.
            result_spelling: The computed inflected form.
            transform_type: The transformation type (e.g., ``'plural'``).
            procedure_id: The ProceduralTemplate that produced the result.
        """
        # Ensure base WordFormNode exists
        base_form_id = NodeId(f"form:{base_spelling}:base")
        if await self._persistence.get_node(base_form_id) is None:
            base_node = KnowledgeNode(
                node_id=base_form_id,
                node_type=WORD_FORM_NODE,
                schema_level=SchemaLevel.INSTANCE,
                properties={
                    "spelling": base_spelling,
                    "inflection_type": "base",
                },
                provenance=Provenance(
                    source=ProvenanceSource.INFERENCE,
                    source_id="morphology-executor",
                    confidence=1.0,
                ),
                confidence=1.0,
                status=NodeStatus.ACTIVE,
            )
            await self._persistence.save_node(base_node)

        # Ensure target WordFormNode exists
        target_form_id = NodeId(f"form:{result_spelling}:{transform_type}")
        if await self._persistence.get_node(target_form_id) is None:
            target_node = KnowledgeNode(
                node_id=target_form_id,
                node_type=WORD_FORM_NODE,
                schema_level=SchemaLevel.INSTANCE,
                properties={
                    "spelling": result_spelling,
                    "inflection_type": transform_type,
                },
                provenance=Provenance(
                    source=ProvenanceSource.INFERENCE,
                    source_id="morphology-executor",
                    confidence=0.15,
                ),
                confidence=0.15,
                status=NodeStatus.ACTIVE,
            )
            await self._persistence.save_node(target_node)

        # Create TRANSFORMS_TO edge
        edge_id = EdgeId(
            f"edge:transforms_to:regular:{base_spelling}:{transform_type}"
        )
        if await self._persistence.get_edge(edge_id) is None:
            edge = KnowledgeEdge(
                edge_id=edge_id,
                source_id=base_form_id,
                target_id=target_form_id,
                edge_type=TRANSFORMS_TO,
                properties={
                    "transform_type": transform_type,
                    "is_regular": True,
                    "confidence": 0.15,
                    "encounter_count": 1,
                    "guardian_confirmed": False,
                    "source_procedure_id": procedure_id,
                    "deprecated": False,
                    "error_count": 0,
                },
                provenance=Provenance(
                    source=ProvenanceSource.INFERENCE,
                    source_id="morphology-executor",
                    confidence=0.15,
                ),
                confidence=0.15,
            )
            await self._persistence.save_edge(edge)


    # ------------------------------------------------------------------
    # Correction support
    # ------------------------------------------------------------------

    async def _has_defective_edge(
        self,
        base_spelling: str,
        transform_type: str,
    ) -> bool:
        """Return True if any defective TRANSFORMS_TO edge exists for this word/transform."""
        base_form_id = NodeId(f"form:{base_spelling}:base")
        edges = await self._persistence.query_edges(
            EdgeFilter(
                edge_type=TRANSFORMS_TO,
                source_node_id=base_form_id,
            )
        )
        for edge in edges:
            if edge.properties.get("transform_type", "") != transform_type:
                continue
            if edge.properties.get("is_defective", False):
                return True
        return False

    async def mark_defective(
        self,
        base_spelling: str,
        transform_type: str,
    ) -> None:
        """Mark computed TRANSFORMS_TO edges for this word/transform as defective.

        Called when the guardian corrects a morphological error on the turn
        immediately following a morphology bypass. Sets ``is_defective=True``
        and ``deprecated=True`` on all *regular* TRANSFORMS_TO edges for the
        given base spelling and transform type. Irregular edges
        (``is_regular=False``) are never touched -- they come from bootstrap
        data and are presumed correct.

        After this call, ``_find_direct_recall`` will skip the defective edges
        so the next morphology query re-runs the procedure (and the guardian
        can confirm or supply the correct form).

        Args:
            base_spelling: The base word form (e.g., ``"beautiful"``).
            transform_type: The transformation type (e.g., ``"past_tense"``).
        """
        base_form_id = NodeId(f"form:{base_spelling}:base")
        edges = await self._persistence.query_edges(
            EdgeFilter(
                edge_type=TRANSFORMS_TO,
                source_node_id=base_form_id,
            )
        )

        defective_count = 0
        for edge in edges:
            if edge.properties.get("transform_type", "") != transform_type:
                continue
            if not edge.properties.get("is_regular", True):
                continue  # Leave irregular (bootstrap) edges alone
            if edge.properties.get("is_defective", False):
                continue  # Already defective

            updated_props = dict(edge.properties)
            updated_props["is_defective"] = True
            updated_props["deprecated"] = True

            updated_edge = KnowledgeEdge(
                edge_id=edge.edge_id,
                source_id=edge.source_id,
                target_id=edge.target_id,
                edge_type=edge.edge_type,
                properties=updated_props,
                provenance=edge.provenance,
                confidence=edge.confidence,
            )
            await self._persistence.save_edge(updated_edge)
            defective_count += 1

        _logger.info(
            "morph_mark_defective word=%s transform=%s edges_marked=%d",
            base_spelling,
            transform_type,
            defective_count,
        )


__all__ = [
    "MorphologyExecutor",
    "MorphologyResult",
]
