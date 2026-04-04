"""Grounding maintenance -- LLM proposes MEANS edges from accumulated failures.

Runs during maintenance cycles. Examines GroundingFailureRecord nodes
accumulated since the last run, asks Claude to propose MEANS edges between
word nodes and primitive symbol nodes, validates proposals, and commits them
at low initial confidence (0.2).

**How it works:**

1. Query up to N unprocessed GroundingFailureRecord nodes.
2. Group by triggering word (deduplicate words seen multiple times).
3. Build context: word + surrounding words from all failure records.
4. Call Claude with a compact prompt requesting MEANS edge proposals.
5. Validate proposals: word nodes must exist, primitive IDs must be valid.
6. Commit valid proposals as MEANS edges at confidence=0.2,
   with weight and reliability from the proposal.
7. Mark processed failure records as processed.

**Confidence levels:**

- Proposed MEANS edges enter at confidence=0.2 (well below retrieval
  threshold of 0.50). They are placeholders pending conversational validation.
- As words with MEANS edges are encountered, ``exposure`` increments (in
  InputParser._check_word_grounding). Reliability tracks explicit validation.

**Fire-and-forget:**

If the LLM call fails, log the error and return an empty report. Never block
the consolidation cycle.

**CANON references:**

    A.12 -- No NLP in CB's cognition path. LLM runs in maintenance only.
    A.11 -- All proposed edges carry INFERENCE provenance.
    Conversation engine architecture §2.6 -- runtime decomposition is graph
    lookup; LLM operates only during maintenance to propose MEANS edges.

Debugging quick-ref:
    - If no proposals generated: check ANTHROPIC_API_KEY env var is set
    - If proposals all invalid: check word node IDs match graph state
    - If failures not accumulating: check _check_word_grounding in input_parser
    - If edges already exist: _validate deduplicates against graph state

Changed: Phase 2 (initial)
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from cobeing.layer3_knowledge.node_types import KnowledgeEdge
from cobeing.layer3_knowledge.primitive_bootstrap import PRIMITIVE_NODE_IDS
from cobeing.layer3_knowledge.query_types import EdgeFilter
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import EdgeId, NodeId

if TYPE_CHECKING:
    from cobeing.layer3_knowledge.protocols import GraphPersistence

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Primitives available for MEANS edges (bare name → node_id)
_PRIMITIVE_NAME_TO_ID: dict[str, str] = {
    p.split(":")[-1]: p for p in PRIMITIVE_NODE_IDS
}
# e.g. {"self_other": "primitive:self_other", "entity": "primitive:entity", ...}

_MAX_FAILURES_PER_CYCLE = 50
_MAX_WORDS_PER_PROMPT = 20  # keep prompts compact

_GROUNDING_PROMPT = """\
You are the maintenance system for Sylphie, a cognitive AI that learns language \
through experience. Sylphie uses 9 primitive symbols to understand words:

  self_other  - the distinction between self and other
  entity      - something exists as a discrete unit
  relation    - things connect to things
  state       - something has a current condition
  time        - the dimension along which states exist
  change      - states transition
  cause       - change is not random; something produces something
  valence     - toward-or-away quality (positive/negative polarity)
  means       - one thing represents/signifies another

A word's meaning is a WEIGHTED COMBINATION of several primitives (not just one).
For example: "hello" activates entity(0.3), relation(0.7), valence(0.6), state(0.4), change(0.4)

Here are words Sylphie has heard but cannot ground yet (no primitive mappings):

{word_contexts}

For each word, propose which primitives it maps to and the weight (0.0-1.0).
Only include primitives that genuinely apply (most words use 2-5 primitives).
Only return words you can confidently map.

Return ONLY a JSON array, no explanation:
[
  {{"word": "hello", "primitive": "relation", "weight": 0.7}},
  {{"word": "hello", "primitive": "valence", "weight": 0.6}},
  ...
]
"""

# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GroundingProposal:
    """A proposed MEANS edge from a word to a primitive symbol.

    Attributes:
        word: The normalized word text (e.g., ``"hello"``).
        word_node_id: The WordNode node_id (``"word:hello"``).
        primitive_node_id: The target primitive node_id.
        weight: Proposed weight (0.0-1.0). Represents how strongly this
            primitive contributes to the word's meaning.
    """

    word: str
    word_node_id: str
    primitive_node_id: str
    weight: float


@dataclass(frozen=True)
class GroundingMaintenanceReport:
    """Outcome of a grounding maintenance run.

    Attributes:
        failures_processed: Number of GroundingFailureRecord nodes examined.
        unique_words: Number of distinct words sent to LLM.
        proposals_raw: Raw proposals returned by LLM (before validation).
        proposals_valid: Proposals that passed validation.
        edges_committed: Number of MEANS edges written to graph.
        edges_skipped: Proposals skipped (already existed or invalid).
        failure_ids_marked: Record IDs marked as processed.
    """

    failures_processed: int
    unique_words: int
    proposals_raw: int
    proposals_valid: int
    edges_committed: int
    edges_skipped: int
    failure_ids_marked: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------


class GroundingMaintenanceEngine:
    """Proposes MEANS edges for ungrounded words during maintenance.

    Instantiate once per maintenance cycle and call ``run()``.
    The LLM client is lazily initialized and cached across cycles when
    the engine instance is reused (e.g., held by ConsolidationEngine).

    Args:
        model: Claude model ID for MEANS edge proposals.
    """

    def __init__(self, model: str = "claude-haiku-4-5-20251001") -> None:
        self._model = model
        self._llm_client: Any = None  # lazy-init AsyncAnthropic

    async def run(
        self,
        persistence: GraphPersistence,
    ) -> GroundingMaintenanceReport:
        """Run one grounding maintenance cycle.

        Loads unprocessed failures, calls LLM, commits valid proposals,
        marks failures as processed.

        Args:
            persistence: Graph persistence backend.

        Returns:
            Report summarizing what was done.
        """
        # Step 1: Load unprocessed failures
        failures = await persistence.get_unprocessed_grounding_failures(
            limit=_MAX_FAILURES_PER_CYCLE
        )
        if not failures:
            logger.debug("grounding_maintenance_no_failures")
            return GroundingMaintenanceReport(
                failures_processed=0,
                unique_words=0,
                proposals_raw=0,
                proposals_valid=0,
                edges_committed=0,
                edges_skipped=0,
                failure_ids_marked=[],
            )

        # Step 2: Group by word (deduplicate, aggregate context)
        word_contexts: dict[str, dict] = {}
        for record in failures:
            word = record["triggering_word"]
            if word not in word_contexts:
                word_contexts[word] = {
                    "word": word,
                    "word_node_id": f"word:{word}",
                    "contexts": [],
                }
            surrounding = record.get("surrounding_words", [])
            if surrounding:
                word_contexts[word]["contexts"].append(surrounding)

        # Cap words per prompt
        words_to_process = dict(
            list(word_contexts.items())[:_MAX_WORDS_PER_PROMPT]
        )

        # Step 3: Filter to words whose nodes actually exist in graph
        existing_words: dict[str, dict] = {}
        for word, ctx in words_to_process.items():
            node = await persistence.get_node(NodeId(ctx["word_node_id"]))
            if node is not None:
                existing_words[word] = ctx

        if not existing_words:
            logger.debug("grounding_maintenance_no_existing_word_nodes")
            # Still mark failures processed to avoid re-reading on next cycle
            failure_ids = [r["node_id"] for r in failures]
            await persistence.mark_grounding_failures_processed(failure_ids)
            return GroundingMaintenanceReport(
                failures_processed=len(failures),
                unique_words=0,
                proposals_raw=0,
                proposals_valid=0,
                edges_committed=0,
                edges_skipped=0,
                failure_ids_marked=failure_ids,
            )

        # Step 4: Call LLM
        try:
            raw_proposals = await self._call_llm(existing_words)
        except Exception as exc:
            logger.warning(
                "grounding_maintenance_llm_failed",
                extra={"error": str(exc)},
            )
            return GroundingMaintenanceReport(
                failures_processed=len(failures),
                unique_words=len(existing_words),
                proposals_raw=0,
                proposals_valid=0,
                edges_committed=0,
                edges_skipped=0,
                failure_ids_marked=[],
            )

        # Step 5: Validate proposals
        valid_proposals = await self._validate(raw_proposals, existing_words, persistence)

        # Step 6: Commit valid proposals
        committed = 0
        skipped = 0
        for proposal in valid_proposals:
            committed_this = await self._commit_edge(proposal, persistence)
            if committed_this:
                committed += 1
            else:
                skipped += 1

        # Step 7: Mark all loaded failures as processed
        failure_ids = [r["node_id"] for r in failures]
        await persistence.mark_grounding_failures_processed(failure_ids)

        logger.info(
            "grounding_maintenance_complete",
            extra={
                "failures_processed": len(failures),
                "unique_words": len(existing_words),
                "proposals_raw": len(raw_proposals),
                "proposals_valid": len(valid_proposals),
                "edges_committed": committed,
                "edges_skipped": skipped,
            },
        )

        return GroundingMaintenanceReport(
            failures_processed=len(failures),
            unique_words=len(existing_words),
            proposals_raw=len(raw_proposals),
            proposals_valid=len(valid_proposals),
            edges_committed=committed,
            edges_skipped=skipped,
            failure_ids_marked=failure_ids,
        )

    # ------------------------------------------------------------------
    # LLM call
    # ------------------------------------------------------------------

    async def _call_llm(
        self,
        existing_words: dict[str, dict],
    ) -> list[dict]:
        """Call Claude to propose MEANS edges for ungrounded words.

        Returns:
            List of raw proposal dicts from LLM. Each has ``word``,
            ``primitive``, ``weight`` keys. May include invalid entries
            that are filtered out in ``_validate``.

        Raises:
            Exception: If the API call fails or response cannot be parsed.
        """
        if self._llm_client is None:
            import anthropic  # noqa: PLC0415
            api_key = os.environ.get("ANTHROPIC_API_KEY", "")
            self._llm_client = anthropic.AsyncAnthropic(api_key=api_key)

        # Build compact word context lines
        context_lines: list[str] = []
        for word, ctx in existing_words.items():
            contexts = ctx.get("contexts", [])
            if contexts:
                sample = contexts[0]  # first context as example
                context_str = f'  "{word}" (seen near: {sample})'
            else:
                context_str = f'  "{word}"'
            context_lines.append(context_str)

        word_contexts_text = "\n".join(context_lines)
        prompt = _GROUNDING_PROMPT.format(word_contexts=word_contexts_text)

        response = await self._llm_client.messages.create(
            model=self._model,
            max_tokens=1024,
            messages=[{"role": "user", "content": prompt}],
        )
        text = response.content[0].text.strip()

        # Strip any markdown fencing
        if text.startswith("```"):
            first_newline = text.index("\n")
            text = text[first_newline + 1:]
        if text.endswith("```"):
            text = text[:-3].strip()

        parsed = json.loads(text)
        if not isinstance(parsed, list):
            logger.warning(
                "grounding_maintenance_response_not_list",
                extra={"type": type(parsed).__name__},
            )
            return []
        return parsed

    # ------------------------------------------------------------------
    # Validation
    # ------------------------------------------------------------------

    async def _validate(
        self,
        raw_proposals: list[dict],
        existing_words: dict[str, dict],
        persistence: GraphPersistence,
    ) -> list[GroundingProposal]:
        """Validate LLM proposals against graph state.

        Checks:
        1. Word is in the set of words we asked about.
        2. Primitive name maps to a known primitive node ID.
        3. Weight is a float in [0.0, 1.0].
        4. MEANS edge does not already exist.

        Args:
            raw_proposals: Raw list from LLM.
            existing_words: Dict of word -> context for words in this cycle.
            persistence: Graph persistence for edge existence checks.

        Returns:
            List of validated :class:`GroundingProposal` objects.
        """
        valid: list[GroundingProposal] = []

        for item in raw_proposals:
            if not isinstance(item, dict):
                continue

            word = item.get("word")
            primitive_name = item.get("primitive")
            weight = item.get("weight")

            # Check word is one we asked about
            if word not in existing_words:
                logger.debug(
                    "grounding_proposal_unknown_word word=%s", word
                )
                continue

            # Check primitive name is valid
            primitive_node_id = _PRIMITIVE_NAME_TO_ID.get(str(primitive_name).lower())
            if primitive_node_id is None:
                logger.debug(
                    "grounding_proposal_unknown_primitive prim=%s", primitive_name
                )
                continue

            # Check weight is a valid float
            try:
                weight_f = float(weight)
            except (TypeError, ValueError):
                continue
            if not (0.0 <= weight_f <= 1.0):
                continue

            word_node_id = existing_words[word]["word_node_id"]
            edge_id = f"edge:means:{word_node_id}:{primitive_node_id}"

            # Check edge doesn't already exist
            try:
                existing_edge = await persistence.get_edge(EdgeId(edge_id))
                if existing_edge is not None:
                    logger.debug(
                        "grounding_proposal_edge_exists edge_id=%s", edge_id
                    )
                    continue
            except Exception:
                pass  # If check fails, allow the edge (save_edge is idempotent)

            valid.append(GroundingProposal(
                word=word,
                word_node_id=word_node_id,
                primitive_node_id=primitive_node_id,
                weight=weight_f,
            ))

        return valid

    # ------------------------------------------------------------------
    # Commit
    # ------------------------------------------------------------------

    async def _commit_edge(
        self,
        proposal: GroundingProposal,
        persistence: GraphPersistence,
    ) -> bool:
        """Write a MEANS edge to the graph at low initial confidence.

        MEANS edges proposed by maintenance enter at confidence=0.2,
        well below the retrieval threshold of 0.50. They require
        conversational validation to rise to usable confidence.

        Properties:
            weight: From the LLM proposal (how strongly the primitive
                contributes to the word's meaning).
            exposure: 0 (incremented by InputParser on each hearing).
            reliability: 0.0 (no validation yet).

        Args:
            proposal: Validated proposal to commit.
            persistence: Graph persistence backend.

        Returns:
            True if edge was committed, False if commit failed.
        """
        edge_id = EdgeId(
            f"edge:means:{proposal.word_node_id}:{proposal.primitive_node_id}"
        )
        now = datetime.now(UTC)

        edge = KnowledgeEdge(
            edge_id=edge_id,
            source_id=NodeId(proposal.word_node_id),
            target_id=NodeId(proposal.primitive_node_id),
            edge_type="MEANS",
            properties={
                "weight": proposal.weight,
                "exposure": 0,
                "reliability": 0.0,
                "proposed_at": now.isoformat(),
                "guardian_confirmed": False,
            },
            provenance=Provenance(
                source=ProvenanceSource.INFERENCE,
                source_id="grounding_maintenance",
                confidence=0.2,
            ),
            confidence=0.2,
            valid_from=now,
            valid_to=None,
        )

        try:
            await persistence.save_edge(edge)
            logger.debug(
                "means_edge_committed word=%s primitive=%s weight=%.2f",
                proposal.word,
                proposal.primitive_node_id,
                proposal.weight,
            )
            return True
        except Exception as exc:
            logger.warning(
                "means_edge_commit_failed word=%s primitive=%s error=%s",
                proposal.word,
                proposal.primitive_node_id,
                exc,
            )
            return False


__all__ = [
    "GroundingMaintenanceEngine",
    "GroundingMaintenanceReport",
    "GroundingProposal",
]
