"""ReasoningEpisode node types for inner monologue infrastructure (P1.8-E5).

Implements first-class graph artifacts for inner monologue reasoning sessions
as required by CANON A.19: "problem-solving traces are first-class graph
artifacts, not ephemeral LLM chain-of-thought."

The inner monologue mediates between incoming triggers (guardian questions,
knowledge gaps, contradictions) and external responses. Each reasoning session
is recorded as a ReasoningEpisode containing ordered ReasoningStep nodes and
a ReasoningConclusion node.

Node schema:

  ReasoningEpisode -- top-level container for a private reasoning session.
    Properties: trigger, trigger_type, step_count, conclusion_reached,
    termination_reason, session_id.
    Schema level: INSTANCE.
    Provenance: INFERENCE (A.19.1).

  ReasoningStep -- one step in the reasoning chain (a graph query + result).
    Properties: step_number, query_type, query_subject, query_result_summary,
    confidence_delta, inner_speech, execution_time_ms.
    Schema level: INSTANCE.
    Provenance: INFERENCE (A.19.1).

  ReasoningConclusion -- the final conclusion of an episode.
    Properties: conclusion_text (inner register), external_text (outer register),
    confidence, grounded, referenced_node_count, reasoning_path_summary.
    Schema level: INSTANCE.
    Provenance: INFERENCE (A.19.1).

Edge types:

  HAS_REASONING_STEP: ReasoningEpisode -> ReasoningStep (ordered by step_number)
  HAS_CONCLUSION: ReasoningEpisode -> ReasoningConclusion
  TRIGGERED_BY: ReasoningEpisode -> ConversationTurnNode (what triggered reasoning)
  REFERENCES: ReasoningStep -> KnowledgeNode (nodes consulted during reasoning)

Register separation (CANON A.19.2):

  inner_speech on ReasoningStep is PRIVATE. It uses compressed, predicate-dominant
  language referencing graph nodes. It is never shown to the guardian directly.

  external_text on ReasoningConclusion is the guardian-facing translation produced
  by PT-11. The inner monologue's private reasoning is translated, not summarized.

  PT-12 (retrospective transparency) can reconstruct a guardian-readable explanation
  from the episode's steps on explicit request. This is auditing, not live output.

CANON compliance:
  A.19   -- reasoning episodes as first-class graph artifacts
  A.19.1 -- INFERRED provenance for all inner monologue nodes
  A.19.2 -- inner monologue is private; external speech is a different register
  A.11   -- provenance on every node and edge

Usage::

    from cobeing.layer3_knowledge.reasoning_episode import (
        create_reasoning_episode,
        create_reasoning_step,
        create_reasoning_conclusion,
        create_has_reasoning_step_edge,
        create_has_conclusion_edge,
        create_triggered_by_edge,
        create_references_edge,
        REASONING_EPISODE,
        REASONING_STEP,
        REASONING_CONCLUSION,
    )

    episode_node = create_reasoning_episode(
        trigger="What is a mammal?",
        trigger_type="question",
        session_id="session-abc",
    )

    step_node = create_reasoning_step(
        episode_id=episode_node.node_id,
        step_number=0,
        query_type="definition",
        query_subject="ws:mammal",
        query_result_summary="IS_A(mammal, animal), HAS_PROPERTY(mammal, warm_blooded)",
        confidence_delta=0.0,
        inner_speech="mammal -> animal via IS_A(0.92); has warm_blooded(0.88)",
        execution_time_ms=15.3,
    )
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

from cobeing.layer3_knowledge.node_types import (
    KnowledgeEdge,
    KnowledgeNode,
    NodeStatus,
    SchemaLevel,
)
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import EdgeId, NodeId

_log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Node type constants
# ---------------------------------------------------------------------------

REASONING_EPISODE = "ReasoningEpisode"
"""INSTANCE-level node: a first-class container for one inner monologue session.

node_id format: episode:{uuid4}.
Provenance: INFERENCE (A.19.1).
Properties: trigger, trigger_type, step_count, conclusion_reached,
termination_reason, session_id."""

REASONING_STEP = "ReasoningStep"
"""INSTANCE-level node: one step in a reasoning chain within an episode.

node_id format: rstep:{uuid4}.
Provenance: INFERENCE (A.19.1).
Properties: step_number, query_type, query_subject, query_result_summary,
confidence_delta, inner_speech, execution_time_ms."""

REASONING_CONCLUSION = "ReasoningConclusion"
"""INSTANCE-level node: the final conclusion of a reasoning episode.

node_id format: rconc:{uuid4}.
Provenance: INFERENCE (A.19.1).
Properties: conclusion_text (inner register), external_text (outer register),
confidence, grounded, referenced_node_count, reasoning_path_summary."""

# ---------------------------------------------------------------------------
# Edge type constants
# ---------------------------------------------------------------------------

HAS_REASONING_STEP = "HAS_REASONING_STEP"
"""Edge from ReasoningEpisode to ReasoningStep.

One per step, ordered by step_number property on the step node.
Properties: none beyond standard provenance."""

HAS_CONCLUSION = "HAS_CONCLUSION"
"""Edge from ReasoningEpisode to ReasoningConclusion.

At most one per episode. Absent if the episode terminated without a conclusion
(e.g., no_evidence on the very first step)."""

TRIGGERED_BY = "TRIGGERED_BY"
"""Edge from ReasoningEpisode to the ConversationTurnNode that prompted reasoning.

At most one per episode. Absent if the episode was triggered by something other
than a conversation turn (e.g., a scheduled consolidation pass)."""

REFERENCES = "REFERENCES"
"""Edge from ReasoningStep to a KnowledgeNode that was consulted during that step.

Multiple REFERENCES edges per step are expected. These form the audit trail of
which graph nodes the inner monologue actually looked at during reasoning.
Properties: reference_type (str, e.g. 'query_subject', 'query_result')."""

# ---------------------------------------------------------------------------
# Provenance helper
# ---------------------------------------------------------------------------


def _inference_provenance(
    confidence: float,
    source_id: str,
) -> Provenance:
    """Build INFERENCE provenance for inner monologue nodes (A.19.1).

    Args:
        confidence: Confidence value for the provenance record.
        source_id: Identifier linking this provenance to the reasoning episode.

    Returns:
        A frozen Provenance instance with INFERENCE source.
    """
    return Provenance(
        source=ProvenanceSource.INFERENCE,
        source_id=source_id,
        confidence=min(max(confidence, 0.0), 1.0),
    )


# ---------------------------------------------------------------------------
# Node factory functions
# ---------------------------------------------------------------------------


def create_reasoning_episode(
    *,
    trigger: str,
    trigger_type: str,
    session_id: str,
) -> KnowledgeNode:
    """Create a ReasoningEpisode node for a new inner monologue session.

    The episode starts with step_count=0 and conclusion_reached=False. These
    are updated as the episode progresses via the InnerMonologueExecutor.

    Args:
        trigger: What prompted the reasoning episode. For question triggers,
            this is the guardian's question text. For gap triggers, this is
            a description of the detected gap.
        trigger_type: Category of trigger. One of: "question", "gap",
            "contradiction", "prediction_error".
        session_id: The conversation session this episode belongs to.

    Returns:
        A KnowledgeNode of type ReasoningEpisode with INFERENCE provenance.
    """
    episode_uuid = str(uuid.uuid4())
    episode_id = NodeId(f"episode:{episode_uuid}")
    source_id = f"inner-monologue-{episode_uuid}"

    return KnowledgeNode(
        node_id=episode_id,
        node_type=REASONING_EPISODE,
        schema_level=SchemaLevel.INSTANCE,
        properties={
            "trigger": trigger,
            "trigger_type": trigger_type,
            "step_count": 0,
            "conclusion_reached": False,
            "termination_reason": "",
            "session_id": session_id,
        },
        provenance=_inference_provenance(0.0, source_id),
        confidence=0.0,
        status=NodeStatus.ACTIVE,
    )


def create_reasoning_step(
    *,
    episode_id: str,
    step_number: int,
    query_type: str,
    query_subject: str,
    query_result_summary: str,
    confidence_delta: float,
    inner_speech: str,
    execution_time_ms: float,
) -> KnowledgeNode:
    """Create a ReasoningStep node for one step in a reasoning chain.

    The inner_speech field uses the PRIVATE register (A.19.2): compressed,
    predicate-dominant, referencing graph node IDs. It is never shown to the
    guardian directly. PT-12 can translate it on explicit request.

    Args:
        episode_id: The node_id of the parent ReasoningEpisode.
        step_number: Position in the reasoning chain (0-indexed).
        query_type: What kind of graph query this step performed. One of:
            "definition", "inference", "classification", "decomposition".
        query_subject: The node_id or label of the entity queried about.
        query_result_summary: Compact summary of what the query returned.
            May reference graph node IDs and edge types.
        confidence_delta: How much this step changed the episode's overall
            confidence. Positive means confidence increased, negative means
            it decreased. Used by convergence detection.
        inner_speech: The private thought text in inner register. Compressed,
            predicate-dominant, contextually saturated with graph references.
        execution_time_ms: Wall-clock time to execute the graph query.

    Returns:
        A KnowledgeNode of type ReasoningStep with INFERENCE provenance.
    """
    step_uuid = str(uuid.uuid4())
    step_id = NodeId(f"rstep:{step_uuid}")
    source_id = f"inner-monologue-step-{episode_id}-{step_number}"

    return KnowledgeNode(
        node_id=step_id,
        node_type=REASONING_STEP,
        schema_level=SchemaLevel.INSTANCE,
        properties={
            "episode_id": episode_id,
            "step_number": step_number,
            "query_type": query_type,
            "query_subject": query_subject,
            "query_result_summary": query_result_summary,
            "confidence_delta": confidence_delta,
            "inner_speech": inner_speech,
            "execution_time_ms": execution_time_ms,
        },
        provenance=_inference_provenance(
            max(confidence_delta, 0.0), source_id
        ),
        confidence=max(confidence_delta, 0.0),
        status=NodeStatus.ACTIVE,
    )


def create_reasoning_conclusion(
    *,
    episode_id: str,
    conclusion_text: str,
    external_text: str,
    confidence: float,
    grounded: bool,
    referenced_node_count: int,
    reasoning_path_summary: str,
) -> KnowledgeNode:
    """Create a ReasoningConclusion node for the final result of an episode.

    The conclusion has two text fields reflecting the register separation
    (CANON A.19.2):

    - conclusion_text: Inner register. Analytical, graph-referencing,
      not guardian-facing. This is what the system actually concluded.
    - external_text: Outer register. Conversational, guardian-appropriate.
      Produced by PT-11 translation of the inner conclusion.

    Args:
        episode_id: The node_id of the parent ReasoningEpisode.
        conclusion_text: The conclusion in inner register (PRIVATE).
        external_text: The conclusion in outer register (for guardian).
            Produced by PT-11.
        confidence: Overall confidence in the conclusion (0.0-1.0).
        grounded: Whether the conclusion is grounded in graph evidence.
            False if the reasoning found no supporting evidence.
        referenced_node_count: How many distinct graph nodes were consulted
            across all reasoning steps in the episode.
        reasoning_path_summary: Compact summary of the reasoning path
            (e.g., "definition(cat) -> IS_A(cat,animal) -> converged").

    Returns:
        A KnowledgeNode of type ReasoningConclusion with INFERENCE provenance.
    """
    conc_uuid = str(uuid.uuid4())
    conc_id = NodeId(f"rconc:{conc_uuid}")
    source_id = f"inner-monologue-conclusion-{episode_id}"

    return KnowledgeNode(
        node_id=conc_id,
        node_type=REASONING_CONCLUSION,
        schema_level=SchemaLevel.INSTANCE,
        properties={
            "episode_id": episode_id,
            "conclusion_text": conclusion_text,
            "external_text": external_text,
            "grounded": grounded,
            "referenced_node_count": referenced_node_count,
            "reasoning_path_summary": reasoning_path_summary,
        },
        provenance=_inference_provenance(confidence, source_id),
        confidence=confidence,
        status=NodeStatus.ACTIVE,
    )


# ---------------------------------------------------------------------------
# Edge factory functions
# ---------------------------------------------------------------------------


def create_has_reasoning_step_edge(
    *,
    episode_id: str,
    step_id: str,
    step_number: int,
    confidence: float = 1.0,
) -> KnowledgeEdge:
    """Create a HAS_REASONING_STEP edge from episode to step.

    Args:
        episode_id: node_id of the ReasoningEpisode.
        step_id: node_id of the ReasoningStep.
        step_number: Step position, stored as edge property for ordering.
        confidence: Edge confidence. Defaults to 1.0 (structural edge).

    Returns:
        A KnowledgeEdge of type HAS_REASONING_STEP.
    """
    edge_uuid = str(uuid.uuid4())
    return KnowledgeEdge(
        edge_id=EdgeId(f"edge:has_rstep:{edge_uuid}"),
        source_id=NodeId(episode_id),
        target_id=NodeId(step_id),
        edge_type=HAS_REASONING_STEP,
        properties={"step_number": step_number},
        provenance=_inference_provenance(confidence, f"rstep-edge-{edge_uuid}"),
        confidence=confidence,
    )


def create_has_conclusion_edge(
    *,
    episode_id: str,
    conclusion_id: str,
    confidence: float = 1.0,
) -> KnowledgeEdge:
    """Create a HAS_CONCLUSION edge from episode to conclusion.

    Args:
        episode_id: node_id of the ReasoningEpisode.
        conclusion_id: node_id of the ReasoningConclusion.
        confidence: Edge confidence. Defaults to 1.0 (structural edge).

    Returns:
        A KnowledgeEdge of type HAS_CONCLUSION.
    """
    edge_uuid = str(uuid.uuid4())
    return KnowledgeEdge(
        edge_id=EdgeId(f"edge:has_rconc:{edge_uuid}"),
        source_id=NodeId(episode_id),
        target_id=NodeId(conclusion_id),
        edge_type=HAS_CONCLUSION,
        properties={},
        provenance=_inference_provenance(confidence, f"rconc-edge-{edge_uuid}"),
        confidence=confidence,
    )


def create_triggered_by_edge(
    *,
    episode_id: str,
    turn_node_id: str,
    confidence: float = 1.0,
) -> KnowledgeEdge:
    """Create a TRIGGERED_BY edge from episode to conversation turn.

    Args:
        episode_id: node_id of the ReasoningEpisode.
        turn_node_id: node_id of the ConversationTurnNode that triggered reasoning.
        confidence: Edge confidence. Defaults to 1.0 (structural edge).

    Returns:
        A KnowledgeEdge of type TRIGGERED_BY.
    """
    edge_uuid = str(uuid.uuid4())
    return KnowledgeEdge(
        edge_id=EdgeId(f"edge:triggered_by:{edge_uuid}"),
        source_id=NodeId(episode_id),
        target_id=NodeId(turn_node_id),
        edge_type=TRIGGERED_BY,
        properties={},
        provenance=_inference_provenance(confidence, f"trigger-edge-{edge_uuid}"),
        confidence=confidence,
    )


def create_references_edge(
    *,
    step_id: str,
    referenced_node_id: str,
    reference_type: str = "query_result",
    confidence: float = 1.0,
) -> KnowledgeEdge:
    """Create a REFERENCES edge from a reasoning step to a consulted node.

    Args:
        step_id: node_id of the ReasoningStep.
        referenced_node_id: node_id of the KnowledgeNode that was consulted.
        reference_type: How this node was referenced. One of:
            "query_subject", "query_result", "context".
        confidence: Edge confidence. Defaults to 1.0 (structural edge).

    Returns:
        A KnowledgeEdge of type REFERENCES.
    """
    edge_uuid = str(uuid.uuid4())
    return KnowledgeEdge(
        edge_id=EdgeId(f"edge:references:{edge_uuid}"),
        source_id=NodeId(step_id),
        target_id=NodeId(referenced_node_id),
        edge_type=REFERENCES,
        properties={"reference_type": reference_type},
        provenance=_inference_provenance(confidence, f"ref-edge-{edge_uuid}"),
        confidence=confidence,
    )


__all__ = [
    # Node type constants
    "REASONING_EPISODE",
    "REASONING_STEP",
    "REASONING_CONCLUSION",
    # Edge type constants
    "HAS_REASONING_STEP",
    "HAS_CONCLUSION",
    "TRIGGERED_BY",
    "REFERENCES",
    # Node factory functions
    "create_reasoning_episode",
    "create_reasoning_step",
    "create_reasoning_conclusion",
    # Edge factory functions
    "create_has_reasoning_step_edge",
    "create_has_conclusion_edge",
    "create_triggered_by_edge",
    "create_references_edge",
]
