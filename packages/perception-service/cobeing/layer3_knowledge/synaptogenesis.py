"""Synaptogenesis -- LLM-driven connection formation during consolidation.

Runs AFTER phrase consolidation during maintenance idle periods. Examines
new graph nodes since the last run, expands 2 hops for context, asks Claude
to propose new edges and ConceptPrimitive nodes, validates proposals, and
commits them at low confidence.

Supports three proposal types:
- Edges between existing nodes (confidence 0.15)
- ConceptPrimitive nodes (confidence 0.20) with IS_A edges
- Composite ActionProcedure nodes (confidence 0.20) with HAS_SUB_PROCEDURE
  and RELIEVES edges

**How it works:**

1. Load differential: query nodes where created_at > last_run_at (capped
   at 50 per cycle). A meta-schema node ``meta:synaptogenesis_state``
   stores the watermark timestamp.
2. Expand 2 hops outward from new nodes to collect neighborhood context.
3. Serialize the subgraph into a compact token-efficient format.
4. Call Claude with a structured prompt requesting up to N proposals.
5. Validate proposals: referenced nodes must exist, edges must not
   already exist, ConceptPrimitives must have 2+ members.
6. Commit valid proposals at low confidence (edges: 0.15, concepts: 0.20).

**Confidence levels (ACT-R):**

- Proposed edges enter at 0.15 (below retrieval threshold of 0.50).
- ConceptPrimitive nodes enter at 0.20.
- IS_A edges to ConceptPrimitives enter at 0.15.

All proposals carry INFERENCE provenance with source_id="synaptogenesis".

**Fire-and-forget:** If the LLM call fails, log the error and return an
empty report. Never block the consolidation cycle.

CANON references:
    A.12 -- No NLP in CB's cognition path. This uses LLM for graph analysis
            only, not for runtime cognition.
    A.11 -- All proposals carry INFERENCE provenance.
    A.20 -- ConceptPrimitive nodes belong to AbstractDomain.

Debugging quick-ref:
    - If no proposals generated: check ANTHROPIC_API_KEY env var is set
    - If all proposals invalid: check node IDs in LLM response match graph
    - If meta state not found: first run uses None watermark (grabs recent)
    - If edges already exist: validation deduplicates against graph state
    - If procedure rejected: sub_procedure_ids must be in 2-hop neighborhood,
      expected_relief must use valid drive names, preconditions must be non-empty
    - Procedure nodes use node_id format action:syn:{name} to distinguish
      from genome-bootstrapped action: nodes

Changed: Phase 2 (initial), Phase 2 PR2 (procedure proposals)
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any

from cobeing.layer3_knowledge.node_types import (
    KnowledgeEdge,
    KnowledgeNode,
    SchemaLevel,
)
from cobeing.layer3_knowledge.query_types import (
    EdgeFilter,
    NodeFilter,
    TemporalWindow,
)
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.time_utils import utc_now
from cobeing.shared.types import EdgeId, NodeId

if TYPE_CHECKING:
    from cobeing.layer3_knowledge.protocols import GraphPersistence

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_META_STATE_NODE_ID = NodeId("meta:synaptogenesis_state")
"""Node ID for the meta-schema node that stores the last-run watermark."""

_ALLOWED_EDGE_TYPES = frozenset({
    "SIMILAR_TO",
    "IS_A",
    "DENOTES",
    "RELATED_TO",
    "FOLLOWS_PATTERN",
    "USED_DURING",
    "OPPOSITE_OF",
})
"""Edge types the LLM is allowed to propose."""

_EDGE_CONFIDENCE = 0.15
"""ACT-R confidence for proposed edges (below retrieval threshold)."""

_CONCEPT_CONFIDENCE = 0.20
"""ACT-R confidence for proposed ConceptPrimitive nodes."""

_PROCEDURE_CONFIDENCE = 0.20
"""ACT-R confidence for proposed composite ActionProcedure nodes."""

_VALID_RELIEF_DRIVES = frozenset({
    "system_health",
    "moral_valence",
    "integrity",
    "cognitive_awareness",
    "guilt",
    "curiosity",
    "boredom",
    "anxiety",
    "satisfaction",
    "sadness",
    "information_integrity",
})
"""Drive names valid in expected_relief for procedure proposals."""

_PROMPT_TEMPLATE = """\
You are analyzing a knowledge subgraph from a learning system that learns \
through experience. The graph contains words, phrases, concepts, and \
procedures. Your job is to propose new connections that the system hasn't \
discovered yet. All proposals will enter the graph at low confidence and \
must prove useful through experience to survive.

Propose up to {max_proposals} new connections.

=== EDGE TYPES YOU CAN USE ===

Linguistic relationships:
- SIMILAR_TO: words that can substitute for each other
  e.g., "are" <-> "is" (both copula verbs), "big" <-> "large" (synonyms)
- IS_A: word or concept belongs to a category
  e.g., "how" -> question_word, "red" -> color, "run" -> action_verb
- FOLLOWS_PATTERN: word tends to appear in a positional pattern
  e.g., "the" -> position_0_determiner (always appears at start of phrases)

Grounding relationships:
- DENOTES: phrase or word refers to a perceived object or property
  e.g., PhraseNode "the red ball" -> ObjectInstance red_ball_01
  e.g., WordNode "red" -> property:color:red
- USED_DURING: phrase is typically heard during a specific drive state
  e.g., "it's ok" -> high_anxiety_context, "good job" -> satisfaction_context

Structural relationships:
- RELATED_TO: abstract relationship between concepts
  e.g., greeting -> social_interaction, question -> information_seeking
- OPPOSITE_OF: concepts or words with opposing meaning
  e.g., "big" <-> "small", "happy" <-> "sad", greeting <-> farewell

=== CONCEPT PRIMITIVES YOU CAN CREATE ===

Abstract categories that group related nodes. Examples:
- question_word: groups "how", "what", "where", "when", "why", "who"
- greeting: groups phrases like "hello", "hi", "hey there", "howdy"
- color: groups "red", "blue", "green"
- action_verb: groups "run", "go", "look", "eat", "play"

Only create categories when you see 2+ members in the graph. Do NOT \
create a category for a single word.

=== COMPOSITE PROCEDURES YOU CAN CREATE ===

Higher-order behaviors combining existing actions. Each MUST have \
preconditions and reference existing action node IDs as sub-procedures.

Examples:
- greeting_sequence: speak "hello" then speak "how are you?" when \
guardian is present. Relieves boredom and anxiety.
- comfort_response: speak a comfort phrase when guardian is speaking \
comfort words. Relieves anxiety and sadness.
- echo_back: repeat a well-known phrase when guardian just spoke and \
phrase has been heard 3+ times. Relieves boredom and curiosity.

Only propose procedures when you see action nodes in the graph that \
could be chained into meaningful behavioral sequences.

=== RULES ===

You may:
- Create edges between existing nodes using the types above
- Create ConceptPrimitive nodes with IS_A edges from 2+ existing members
- Create composite procedures with preconditions and existing sub-procedures

You may NOT:
- Create WordNodes, PhraseNodes, ObjectInstances, or ActionProcedures
- Reference node IDs that don't appear in the graph below
- Propose edges that already exist in the graph below
- Create a ConceptPrimitive with fewer than 2 members
- Propose procedures without preconditions

=== RESPONSE FORMAT ===

Respond with a JSON array. No preamble. No markdown backticks.

For edges:
{{"type":"edge","source_id":"...","target_id":"...","edge_type":"...","rationale":"..."}}

For concepts:
{{"type":"concept","name":"...","member_ids":["...","..."],"rationale":"..."}}

For procedures:
{{"type":"procedure","name":"...","preconditions":{{...}},"sub_procedure_ids":["..."],"expected_relief":["..."],"rationale":"..."}}

If you see no meaningful connections to propose, respond with [].

=== GRAPH ===

{serialized_subgraph}"""


# ---------------------------------------------------------------------------
# Report dataclass
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SynaptogenesisReport:
    """Results from a single synaptogenesis cycle.

    Attributes:
        proposals_received: Total proposals returned by the LLM.
        proposals_valid: Proposals that passed validation.
        edges_created: Number of new edges committed to the graph.
        concepts_created: Number of new ConceptPrimitive nodes created.
        procedures_created: Number of new composite ActionProcedure nodes created.
        skipped_reason: If the cycle was skipped entirely, the reason why.
            None means the cycle ran normally. Possible values:
            "no_new_nodes", "api_key_missing", "llm_error", "disabled".
    """

    proposals_received: int
    proposals_valid: int
    edges_created: int
    concepts_created: int
    procedures_created: int
    skipped_reason: str | None


# ---------------------------------------------------------------------------
# Main class
# ---------------------------------------------------------------------------


class Synaptogenesis:
    """LLM-driven connection formation for the knowledge graph.

    Examines new nodes added since the last run, gathers 2-hop neighborhood
    context, asks Claude to propose edges and ConceptPrimitive nodes, then
    validates and commits accepted proposals at low confidence.

    Args:
        graph: Graph storage backend satisfying the GraphPersistence protocol.
        model: Anthropic model ID for the LLM call.
        max_proposals_per_cycle: Maximum proposals the LLM may return per run.
        max_new_nodes_per_cycle: Maximum new nodes to process per run. Excess
            nodes are deferred to the next cycle (oldest first).
        enabled: Whether synaptogenesis is active. When False, run() returns
            immediately with a skip report.
    """

    def __init__(
        self,
        graph: GraphPersistence,
        model: str = "claude-sonnet-4-5",
        max_proposals_per_cycle: int = 3,
        max_new_nodes_per_cycle: int = 50,
        enabled: bool = True,
    ) -> None:
        self._graph = graph
        self._model = model
        self._max_proposals = max_proposals_per_cycle
        self._max_new_nodes = max_new_nodes_per_cycle
        self._enabled = enabled
        self._last_run_at: datetime | None = None
        self._state_loaded: bool = False
        self._llm_client: Any = None  # lazy-init AsyncAnthropic

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def run(self) -> SynaptogenesisReport:
        """Execute one synaptogenesis cycle.

        Steps:
            1. Check if enabled and API key is available.
            2. Load watermark state from meta-schema node.
            3. Query differential (new nodes since last run).
            4. Expand 2-hop neighborhood for context.
            5. Serialize subgraph for the LLM prompt.
            6. Call Claude for proposals.
            7. Validate proposals against graph state.
            8. Commit valid proposals.
            9. Update watermark.

        Returns:
            SynaptogenesisReport with counts of proposals and outcomes.
        """
        if not self._enabled:
            return SynaptogenesisReport(
                proposals_received=0,
                proposals_valid=0,
                edges_created=0,
                concepts_created=0,
                procedures_created=0,
                skipped_reason="disabled",
            )

        api_key = os.environ.get("ANTHROPIC_API_KEY", "")
        if not api_key:
            logger.warning("synaptogenesis_skipped: ANTHROPIC_API_KEY not set")
            return SynaptogenesisReport(
                proposals_received=0,
                proposals_valid=0,
                edges_created=0,
                concepts_created=0,
                procedures_created=0,
                skipped_reason="api_key_missing",
            )

        # Step 2: Load watermark
        await self._load_state()

        # Step 3: Get differential
        new_nodes = await self._get_differential()
        if not new_nodes:
            logger.info("synaptogenesis_skipped: no new nodes since last run")
            return SynaptogenesisReport(
                proposals_received=0,
                proposals_valid=0,
                edges_created=0,
                concepts_created=0,
                procedures_created=0,
                skipped_reason="no_new_nodes",
            )

        logger.info(
            "synaptogenesis_started",
            extra={"new_node_count": len(new_nodes)},
        )

        # Step 4: Expand neighborhood
        context_nodes, context_edges = await self._expand_neighborhood(
            new_nodes, hops=2
        )

        # Step 5: Serialize
        serialized = self._serialize(new_nodes, context_nodes, context_edges)

        # Step 6: Call LLM
        try:
            proposals = await self._call_llm(serialized)
        except Exception:
            logger.exception("synaptogenesis_llm_error")
            return SynaptogenesisReport(
                proposals_received=0,
                proposals_valid=0,
                edges_created=0,
                concepts_created=0,
                procedures_created=0,
                skipped_reason="llm_error",
            )

        proposals_received = len(proposals)

        # Step 7: Validate
        # Build the full set of known node IDs (new + context)
        known_ids: set[str] = set()
        for n in new_nodes:
            known_ids.add(str(n.node_id))
        for nid in context_nodes:
            known_ids.add(nid)

        valid_proposals = await self._validate(proposals, known_ids)
        proposals_valid = len(valid_proposals)

        # Step 8: Commit
        edges_created, concepts_created, procedures_created = await self._commit(
            valid_proposals
        )

        # Step 9: Update watermark
        self._last_run_at = utc_now()
        await self._save_state()

        logger.info(
            "synaptogenesis_complete",
            extra={
                "proposals_received": proposals_received,
                "proposals_valid": proposals_valid,
                "edges_created": edges_created,
                "concepts_created": concepts_created,
                "procedures_created": procedures_created,
            },
        )

        return SynaptogenesisReport(
            proposals_received=proposals_received,
            proposals_valid=proposals_valid,
            edges_created=edges_created,
            concepts_created=concepts_created,
            procedures_created=procedures_created,
            skipped_reason=None,
        )

    # ------------------------------------------------------------------
    # State management
    # ------------------------------------------------------------------

    async def _load_state(self) -> None:
        """Load the last-run watermark from the meta-schema state node.

        If the state node does not exist (first run), last_run_at stays
        None, which causes _get_differential to grab the 50 most recent
        nodes regardless of age.
        """
        if self._state_loaded:
            return

        node = await self._graph.get_node(_META_STATE_NODE_ID)
        if node is not None:
            iso_str = node.properties.get("last_run_at")
            if iso_str and isinstance(iso_str, str):
                try:
                    self._last_run_at = datetime.fromisoformat(iso_str)
                except ValueError:
                    logger.warning(
                        "synaptogenesis_state_invalid_timestamp",
                        extra={"last_run_at": iso_str},
                    )
                    self._last_run_at = None

        self._state_loaded = True

    async def _save_state(self) -> None:
        """Persist the last-run watermark to the meta-schema state node.

        Creates or updates the meta:synaptogenesis_state node with the
        current last_run_at timestamp as an ISO 8601 string.
        """
        if self._last_run_at is None:
            return

        node = KnowledgeNode(
            node_id=_META_STATE_NODE_ID,
            node_type="SynaptogenesisState",
            schema_level=SchemaLevel.META_SCHEMA,
            properties={
                "last_run_at": self._last_run_at.isoformat(),
            },
            provenance=Provenance(
                source=ProvenanceSource.INFERENCE,
                source_id="synaptogenesis",
                confidence=1.0,
            ),
            confidence=1.0,
        )
        await self._graph.save_node(node)

    # ------------------------------------------------------------------
    # Differential query
    # ------------------------------------------------------------------

    async def _get_differential(self) -> list[KnowledgeNode]:
        """Get nodes created since the last run, capped at max_new_nodes.

        On first run (last_run_at is None), queries all nodes and returns
        the most recent max_new_nodes by created_at. On subsequent runs,
        queries nodes with created_at > last_run_at using TemporalWindow.

        Oldest nodes are returned first so that if the cap is hit, newer
        nodes are deferred to the next cycle.

        Returns:
            List of new KnowledgeNode objects sorted by created_at ascending
            (oldest first), capped at max_new_nodes_per_cycle.
        """
        if self._last_run_at is not None:
            # Query nodes created after the watermark
            node_filter = NodeFilter(
                temporal_window=TemporalWindow(start=self._last_run_at),
            )
            nodes = await self._graph.query_nodes(node_filter)
        else:
            # First run: grab all nodes
            nodes = await self._graph.query_nodes(NodeFilter())

        if not nodes:
            return []

        # Sort by created_at ascending (oldest first)
        nodes.sort(key=lambda n: n.created_at if n.created_at else utc_now())

        if self._last_run_at is None:
            # First run: take the most recent N nodes
            nodes = nodes[-self._max_new_nodes:]
        else:
            # Cap at max_new_nodes (oldest first, so excess deferred)
            nodes = nodes[: self._max_new_nodes]

        # Exclude the meta state node itself from the differential
        nodes = [n for n in nodes if n.node_id != _META_STATE_NODE_ID]

        return nodes

    # ------------------------------------------------------------------
    # 2-hop neighborhood expansion
    # ------------------------------------------------------------------

    async def _expand_neighborhood(
        self,
        nodes: list[KnowledgeNode],
        hops: int = 2,
    ) -> tuple[dict[str, KnowledgeNode], list[KnowledgeEdge]]:
        """Expand outward from the given nodes by the specified number of hops.

        For each hop, queries edges where the node is either source or target,
        then loads the neighbor nodes. Repeats for the specified number of hops.

        Args:
            nodes: Seed nodes to expand from.
            hops: Number of hops to expand (default 2).

        Returns:
            Tuple of (context_nodes, context_edges) where context_nodes is a
            dict mapping node_id string to KnowledgeNode (includes the seed
            nodes), and context_edges is a deduplicated list of all edges
            encountered during expansion.
        """
        # Initialize with seed nodes
        all_nodes: dict[str, KnowledgeNode] = {}
        for n in nodes:
            all_nodes[str(n.node_id)] = n

        all_edges: dict[str, KnowledgeEdge] = {}
        frontier_ids: set[str] = {str(n.node_id) for n in nodes}

        for _hop in range(hops):
            # Query edges for each frontier node (outgoing + incoming)
            neighbor_ids: set[str] = set()
            for nid in frontier_ids:
                typed_nid = NodeId(nid)

                # Outgoing edges
                outgoing = await self._graph.query_edges(
                    EdgeFilter(source_node_id=typed_nid)
                )
                for edge in outgoing:
                    eid = str(edge.edge_id)
                    if eid not in all_edges:
                        all_edges[eid] = edge
                    tid = str(edge.target_id)
                    if tid not in all_nodes:
                        neighbor_ids.add(tid)

                # Incoming edges
                incoming = await self._graph.query_edges(
                    EdgeFilter(target_node_id=typed_nid)
                )
                for edge in incoming:
                    eid = str(edge.edge_id)
                    if eid not in all_edges:
                        all_edges[eid] = edge
                    sid = str(edge.source_id)
                    if sid not in all_nodes:
                        neighbor_ids.add(sid)

            # Load neighbor nodes
            for nid in neighbor_ids:
                if nid not in all_nodes:
                    node = await self._graph.get_node(NodeId(nid))
                    if node is not None:
                        all_nodes[nid] = node

            # Next hop starts from the newly discovered neighbors
            frontier_ids = neighbor_ids - set(all_nodes.keys() - neighbor_ids)
            # Actually, frontier should be the newly added neighbors
            frontier_ids = neighbor_ids

        return all_nodes, list(all_edges.values())

    # ------------------------------------------------------------------
    # Serialization
    # ------------------------------------------------------------------

    def _serialize(
        self,
        new_nodes: list[KnowledgeNode],
        context_nodes: dict[str, KnowledgeNode],
        context_edges: list[KnowledgeEdge],
    ) -> str:
        """Serialize the subgraph into a compact token-efficient format.

        Format:
            === NEW NODES (just added) ===
            NodeType:node_id (key=val, key=val)

            === CONTEXT NODES ===
            NodeType:node_id (key=val, key=val)

            === EDGES ===
            EDGE_TYPE: source_id -> target_id (key=val)

        Args:
            new_nodes: The newly created nodes that triggered this cycle.
            context_nodes: All nodes in the 2-hop neighborhood (includes
                new_nodes).
            context_edges: All edges in the 2-hop neighborhood.

        Returns:
            A string representation of the subgraph suitable for the LLM prompt.
        """
        new_node_ids = {str(n.node_id) for n in new_nodes}
        lines: list[str] = []

        # New nodes section
        lines.append("=== NEW NODES (just added) ===")
        for node in new_nodes:
            lines.append(self._format_node(node))

        # Context nodes section (neighbors, not the new ones)
        lines.append("")
        lines.append("=== CONTEXT NODES ===")
        for nid, node in sorted(context_nodes.items()):
            if nid not in new_node_ids:
                lines.append(self._format_node(node))

        # Edges section
        lines.append("")
        lines.append("=== EDGES ===")
        for edge in context_edges:
            lines.append(self._format_edge(edge))

        return "\n".join(lines)

    @staticmethod
    def _format_node(node: KnowledgeNode) -> str:
        """Format a single node for serialization.

        Produces: NodeType:node_id "display_text" (key=val, key=val)

        Args:
            node: The node to format.

        Returns:
            A single-line string representation.
        """
        props = node.properties
        parts: list[str] = []

        # Include select properties that are informative
        text = props.get("text") or props.get("canonical_form") or props.get("name")
        if text:
            display = f' "{text}"'
        else:
            display = ""

        # Gather numeric/simple properties
        for key in ("confidence", "encounters", "encounter_count", "positions",
                     "prod_count", "production_count"):
            val = props.get(key)
            if val is not None:
                parts.append(f"{key}={val}")

        # Add node confidence
        parts.append(f"conf={node.confidence:.2f}")

        prop_str = f" ({', '.join(parts)})" if parts else ""
        return f"{node.node_type}:{node.node_id}{display}{prop_str}"

    @staticmethod
    def _format_edge(edge: KnowledgeEdge) -> str:
        """Format a single edge for serialization.

        Produces: EDGE_TYPE: source_id -> target_id (key=val)

        Args:
            edge: The edge to format.

        Returns:
            A single-line string representation.
        """
        props_parts: list[str] = []
        props_parts.append(f"conf={edge.confidence:.2f}")

        for key in ("position", "pos", "prod_count", "production_count",
                     "weight"):
            val = edge.properties.get(key)
            if val is not None:
                props_parts.append(f"{key}={val}")

        prop_str = f" ({', '.join(props_parts)})" if props_parts else ""
        return f"{edge.edge_type}: {edge.source_id} -> {edge.target_id}{prop_str}"

    # ------------------------------------------------------------------
    # LLM call
    # ------------------------------------------------------------------

    async def _call_llm(self, serialized: str) -> list[dict[str, Any]]:
        """Call Claude with the serialized subgraph and parse proposals.

        Args:
            serialized: The serialized subgraph string from _serialize().

        Returns:
            A list of proposal dicts parsed from the LLM's JSON response.
            Each dict has at minimum a "type" key ("edge", "concept", or
            "procedure").

        Raises:
            Exception: If the API call fails or the response cannot be parsed.
        """
        if self._llm_client is None:
            import anthropic
            api_key = os.environ.get("ANTHROPIC_API_KEY", "")
            self._llm_client = anthropic.AsyncAnthropic(api_key=api_key)

        client = self._llm_client

        prompt = _PROMPT_TEMPLATE.format(
            max_proposals=self._max_proposals,
            serialized_subgraph=serialized,
        )

        response = await client.messages.create(
            model=self._model,
            max_tokens=1024,
            messages=[{"role": "user", "content": prompt}],
        )
        text = response.content[0].text

        # Strip any markdown fencing the LLM might add despite instructions
        text = text.strip()
        if text.startswith("```"):
            # Remove opening fence (possibly with language hint)
            first_newline = text.index("\n")
            text = text[first_newline + 1:]
        if text.endswith("```"):
            text = text[:-3].strip()

        parsed = json.loads(text)
        if not isinstance(parsed, list):
            logger.warning(
                "synaptogenesis_llm_response_not_list",
                extra={"response_type": type(parsed).__name__},
            )
            return []

        return parsed

    # ------------------------------------------------------------------
    # Validation
    # ------------------------------------------------------------------

    async def _validate(
        self,
        proposals: list[dict[str, Any]],
        known_node_ids: set[str],
    ) -> list[dict[str, Any]]:
        """Validate LLM proposals against graph state.

        Validation rules:
        - All referenced node IDs must exist in the provided subgraph.
        - Proposed edge types must be from the allowed set.
        - Proposed edges must not already exist in the graph.
        - ConceptPrimitive proposals must have 2+ member_ids.
        - All member_ids must exist in the known node set.

        Args:
            proposals: Raw proposal dicts from the LLM.
            known_node_ids: Set of node ID strings present in the subgraph.

        Returns:
            A filtered list containing only valid proposals.
        """
        valid: list[dict[str, Any]] = []

        for proposal in proposals:
            p_type = proposal.get("type")

            if p_type == "edge":
                if not self._validate_edge_proposal(proposal, known_node_ids):
                    continue
                # Check edge does not already exist
                source_id = proposal.get("source_id", "")
                target_id = proposal.get("target_id", "")
                edge_type = proposal.get("edge_type", "")
                edge_id = EdgeId(
                    f"edge:syn:{edge_type.lower()}:{source_id}:{target_id}"
                )
                existing = await self._graph.get_edge(edge_id)
                if existing is not None:
                    logger.debug(
                        "synaptogenesis_edge_already_exists",
                        extra={"edge_id": str(edge_id)},
                    )
                    continue

                # Also check if an edge of this type between these nodes
                # exists under a different ID convention
                existing_edges = await self._graph.query_edges(
                    EdgeFilter(
                        edge_type=edge_type,
                        source_node_id=NodeId(source_id),
                        target_node_id=NodeId(target_id),
                    )
                )
                if existing_edges:
                    logger.debug(
                        "synaptogenesis_edge_duplicate",
                        extra={
                            "edge_type": edge_type,
                            "source": source_id,
                            "target": target_id,
                        },
                    )
                    continue

                valid.append(proposal)

            elif p_type == "concept":
                if not self._validate_concept_proposal(proposal, known_node_ids):
                    continue

                # Check concept does not already exist
                name = proposal.get("name", "")
                concept_id = f"concept:{name.lower().replace(' ', '_')}"
                existing_node = await self._graph.get_node(NodeId(concept_id))
                if existing_node is not None:
                    logger.debug(
                        "synaptogenesis_concept_already_exists",
                        extra={"concept_id": concept_id},
                    )
                    continue

                valid.append(proposal)

            elif p_type == "procedure":
                if not self._validate_procedure_proposal(
                    proposal, known_node_ids
                ):
                    continue

                # Check procedure does not already exist
                name = proposal.get("name", "")
                proc_id = f"action:syn:{name.lower().replace(' ', '_')}"
                existing_node = await self._graph.get_node(NodeId(proc_id))
                if existing_node is not None:
                    logger.debug(
                        "synaptogenesis_procedure_already_exists",
                        extra={"proc_id": proc_id},
                    )
                    continue

                valid.append(proposal)

            else:
                logger.warning(
                    "synaptogenesis_unknown_proposal_type",
                    extra={"type": p_type},
                )

        logger.info(
            "synaptogenesis_validation_complete",
            extra={
                "total_proposals": len(proposals),
                "valid_proposals": len(valid),
                "rejected": len(proposals) - len(valid),
            },
        )

        return valid

    @staticmethod
    def _validate_edge_proposal(
        proposal: dict[str, Any],
        known_node_ids: set[str],
    ) -> bool:
        """Validate a single edge proposal.

        Args:
            proposal: The edge proposal dict.
            known_node_ids: Set of known node ID strings.

        Returns:
            True if the proposal passes structural validation.
        """
        source_id = proposal.get("source_id")
        target_id = proposal.get("target_id")
        edge_type = proposal.get("edge_type")

        if not source_id or not target_id or not edge_type:
            logger.debug(
                "synaptogenesis_edge_missing_fields",
                extra={"proposal": proposal},
            )
            return False

        if edge_type not in _ALLOWED_EDGE_TYPES:
            logger.debug(
                "synaptogenesis_edge_invalid_type",
                extra={"edge_type": edge_type},
            )
            return False

        if source_id not in known_node_ids:
            logger.debug(
                "synaptogenesis_edge_unknown_source",
                extra={"source_id": source_id},
            )
            return False

        if target_id not in known_node_ids:
            logger.debug(
                "synaptogenesis_edge_unknown_target",
                extra={"target_id": target_id},
            )
            return False

        return True

    @staticmethod
    def _validate_concept_proposal(
        proposal: dict[str, Any],
        known_node_ids: set[str],
    ) -> bool:
        """Validate a single ConceptPrimitive proposal.

        Args:
            proposal: The concept proposal dict.
            known_node_ids: Set of known node ID strings.

        Returns:
            True if the proposal passes structural validation.
        """
        name = proposal.get("name")
        member_ids = proposal.get("member_ids")

        if not name:
            logger.debug("synaptogenesis_concept_missing_name")
            return False

        if not isinstance(member_ids, list) or len(member_ids) < 2:
            logger.debug(
                "synaptogenesis_concept_too_few_members",
                extra={"name": name, "member_count": len(member_ids) if isinstance(member_ids, list) else 0},
            )
            return False

        for mid in member_ids:
            if mid not in known_node_ids:
                logger.debug(
                    "synaptogenesis_concept_unknown_member",
                    extra={"name": name, "member_id": mid},
                )
                return False

        return True

    @staticmethod
    def _validate_procedure_proposal(
        proposal: dict[str, Any],
        known_node_ids: set[str],
    ) -> bool:
        """Validate a single composite ActionProcedure proposal.

        Args:
            proposal: The procedure proposal dict.
            known_node_ids: Set of known node ID strings.

        Returns:
            True if the proposal passes structural validation.
        """
        name = proposal.get("name")
        preconditions = proposal.get("preconditions")
        sub_procedure_ids = proposal.get("sub_procedure_ids")
        expected_relief = proposal.get("expected_relief")

        if not name:
            logger.debug("synaptogenesis_procedure_missing_name")
            return False

        if not isinstance(preconditions, dict) or not preconditions:
            logger.debug(
                "synaptogenesis_procedure_missing_preconditions",
                extra={"name": name},
            )
            return False

        if not isinstance(sub_procedure_ids, list) or not sub_procedure_ids:
            logger.debug(
                "synaptogenesis_procedure_missing_sub_procedures",
                extra={"name": name},
            )
            return False

        # All sub-procedure IDs must reference existing nodes in the graph
        for sp_id in sub_procedure_ids:
            if sp_id not in known_node_ids:
                logger.debug(
                    "synaptogenesis_procedure_unknown_sub_procedure",
                    extra={"name": name, "sub_procedure_id": sp_id},
                )
                return False

        if not isinstance(expected_relief, list) or not expected_relief:
            logger.debug(
                "synaptogenesis_procedure_missing_expected_relief",
                extra={"name": name},
            )
            return False

        # All expected_relief values must be valid drive names
        for drive in expected_relief:
            if drive not in _VALID_RELIEF_DRIVES:
                logger.debug(
                    "synaptogenesis_procedure_invalid_drive",
                    extra={"name": name, "drive": drive},
                )
                return False

        return True

    # ------------------------------------------------------------------
    # Commit
    # ------------------------------------------------------------------

    async def _commit(
        self,
        proposals: list[dict[str, Any]],
    ) -> tuple[int, int, int]:
        """Commit validated proposals to the graph.

        Edge proposals become KnowledgeEdge objects at confidence 0.15.
        Concept proposals become ConceptPrimitive KnowledgeNode objects at
        confidence 0.20 with IS_A edges from each member at confidence 0.15.
        Procedure proposals become composite ActionProcedure KnowledgeNode
        objects at confidence 0.20 with HAS_SUB_PROCEDURE and RELIEVES edges.

        Args:
            proposals: Validated proposal dicts.

        Returns:
            Tuple of (edges_created, concepts_created, procedures_created).
        """
        edges_created = 0
        concepts_created = 0
        procedures_created = 0
        now = utc_now()

        for proposal in proposals:
            p_type = proposal["type"]

            if p_type == "edge":
                source_id = proposal["source_id"]
                target_id = proposal["target_id"]
                edge_type = proposal["edge_type"]
                rationale = proposal.get("rationale", "")

                edge_id = EdgeId(
                    f"edge:syn:{edge_type.lower()}:{source_id}:{target_id}"
                )

                edge = KnowledgeEdge(
                    edge_id=edge_id,
                    source_id=NodeId(source_id),
                    target_id=NodeId(target_id),
                    edge_type=edge_type,
                    properties={
                        "rationale": rationale,
                        "source_process": "synaptogenesis",
                    },
                    provenance=Provenance(
                        source=ProvenanceSource.INFERENCE,
                        source_id="synaptogenesis",
                        confidence=_EDGE_CONFIDENCE,
                    ),
                    confidence=_EDGE_CONFIDENCE,
                    valid_from=now,
                )
                await self._graph.save_edge(edge)
                edges_created += 1

                logger.info(
                    "synaptogenesis_edge_created",
                    extra={
                        "edge_id": str(edge_id),
                        "edge_type": edge_type,
                        "source": source_id,
                        "target": target_id,
                    },
                )

            elif p_type == "concept":
                name = proposal["name"]
                member_ids: list[str] = proposal["member_ids"]
                rationale = proposal.get("rationale", "")

                concept_node_id = NodeId(
                    f"concept:{name.lower().replace(' ', '_')}"
                )

                concept_node = KnowledgeNode(
                    node_id=concept_node_id,
                    node_type="ConceptPrimitive",
                    schema_level=SchemaLevel.SCHEMA,
                    properties={
                        "name": name,
                        "rationale": rationale,
                        "source_process": "synaptogenesis",
                        "member_count": len(member_ids),
                    },
                    provenance=Provenance(
                        source=ProvenanceSource.INFERENCE,
                        source_id="synaptogenesis",
                        confidence=_CONCEPT_CONFIDENCE,
                    ),
                    confidence=_CONCEPT_CONFIDENCE,
                    created_at=now,
                    valid_from=now,
                )
                await self._graph.save_node(concept_node)
                concepts_created += 1

                logger.info(
                    "synaptogenesis_concept_created",
                    extra={
                        "concept_id": str(concept_node_id),
                        "name": name,
                        "member_count": len(member_ids),
                    },
                )

                # Create IS_A edges from each member to the concept
                for mid in member_ids:
                    is_a_edge_id = EdgeId(
                        f"edge:syn:is_a:{mid}:{concept_node_id}"
                    )
                    is_a_edge = KnowledgeEdge(
                        edge_id=is_a_edge_id,
                        source_id=NodeId(mid),
                        target_id=concept_node_id,
                        edge_type="IS_A",
                        properties={
                            "source_process": "synaptogenesis",
                        },
                        provenance=Provenance(
                            source=ProvenanceSource.INFERENCE,
                            source_id="synaptogenesis",
                            confidence=_EDGE_CONFIDENCE,
                        ),
                        confidence=_EDGE_CONFIDENCE,
                        valid_from=now,
                    )
                    await self._graph.save_edge(is_a_edge)
                    edges_created += 1

            elif p_type == "procedure":
                name = proposal["name"]
                preconditions: dict[str, Any] = proposal["preconditions"]
                sub_procedure_ids: list[str] = proposal["sub_procedure_ids"]
                expected_relief: list[str] = proposal["expected_relief"]
                rationale = proposal.get("rationale", "")

                proc_node_id = NodeId(
                    f"action:syn:{name.lower().replace(' ', '_')}"
                )

                proc_node = KnowledgeNode(
                    node_id=proc_node_id,
                    node_type="ActionProcedure",
                    schema_level=SchemaLevel.SCHEMA,
                    properties={
                        "name": name,
                        "action_type": "composite",
                        "handler_key": "composite_sequence",
                        "is_composite": True,
                        "source": "extracted_from_llm",
                        "preconditions": json.dumps(preconditions),
                        "rationale": rationale,
                        "source_process": "synaptogenesis",
                        "encounter_count": 0,
                        "observation_count": 0,
                    },
                    provenance=Provenance(
                        source=ProvenanceSource.INFERENCE,
                        source_id="synaptogenesis",
                        confidence=_PROCEDURE_CONFIDENCE,
                    ),
                    confidence=_PROCEDURE_CONFIDENCE,
                    created_at=now,
                    valid_from=now,
                )
                await self._graph.save_node(proc_node)
                procedures_created += 1

                logger.info(
                    "synaptogenesis_procedure_created",
                    extra={
                        "proc_id": str(proc_node_id),
                        "name": name,
                        "sub_count": len(sub_procedure_ids),
                        "relief_drives": expected_relief,
                    },
                )

                # Create HAS_SUB_PROCEDURE edges to each sub-procedure
                for idx, sp_id in enumerate(sub_procedure_ids):
                    sub_edge_id = EdgeId(
                        f"edge:syn:has_sub_procedure:{proc_node_id}:{sp_id}"
                    )
                    sub_edge = KnowledgeEdge(
                        edge_id=sub_edge_id,
                        source_id=proc_node_id,
                        target_id=NodeId(sp_id),
                        edge_type="HAS_SUB_PROCEDURE",
                        properties={
                            "position": idx,
                            "source_process": "synaptogenesis",
                        },
                        provenance=Provenance(
                            source=ProvenanceSource.INFERENCE,
                            source_id="synaptogenesis",
                            confidence=_EDGE_CONFIDENCE,
                        ),
                        confidence=_EDGE_CONFIDENCE,
                        valid_from=now,
                    )
                    await self._graph.save_edge(sub_edge)
                    edges_created += 1

                # Create RELIEVES edges to each expected drive category
                for drive in expected_relief:
                    drive_node_id = NodeId(f"drive-category:{drive}")
                    relieves_edge_id = EdgeId(
                        f"edge:syn:relieves:{proc_node_id}:{drive_node_id}"
                    )
                    relieves_edge = KnowledgeEdge(
                        edge_id=relieves_edge_id,
                        source_id=proc_node_id,
                        target_id=drive_node_id,
                        edge_type="RELIEVES",
                        properties={
                            "source_process": "synaptogenesis",
                        },
                        provenance=Provenance(
                            source=ProvenanceSource.INFERENCE,
                            source_id="synaptogenesis",
                            confidence=_EDGE_CONFIDENCE,
                        ),
                        confidence=_EDGE_CONFIDENCE,
                        valid_from=now,
                    )
                    await self._graph.save_edge(relieves_edge)
                    edges_created += 1

        return edges_created, concepts_created, procedures_created


__all__ = [
    "Synaptogenesis",
    "SynaptogenesisReport",
]
