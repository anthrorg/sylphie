"""SyntacticTemplateMatcher -- match tokenized input against graph-stored templates.

Matches a natural-language utterance against ProceduralTemplate nodes whose
``domain`` property is ``"syntax"``.  Each template encodes a tree-shaped
pattern of dependency relations, POS filters, and lemma filters as
ProcedureStep nodes linked by HAS_OPERAND edges.

The matcher:

1. Tokenizes the utterance with simple whitespace splitting.
2. Queries the graph for all ``domain="syntax"`` ProceduralTemplate nodes.
3. Attempts to unify the token list against each template's step tree.
4. Returns the highest-confidence match, or ``None``.

Note: spaCy was removed from CB's cognition path per the Observatory
Architecture decision (CANON A.12, A.27). Templates that relied on
dependency labels (copular, transitive) will degrade. This is acceptable
because OLA is the active developmental path. Templates were Phase 1
scaffolding.

Result type: :class:`MatchResult` -- a frozen dataclass carrying the
template ID, role bindings (role_name -> token lemma), confidence, and
the raw token list for downstream handler use.

Phase 1.7-E4 (P1.7-E4-T01). CANON A.18 (TAUGHT_PROCEDURE provenance).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from cobeing.layer3_knowledge.procedure_types import (
    HAS_OPERAND,
    HAS_PROCEDURE_BODY,
    PROCEDURAL_TEMPLATE,
)
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.query_types import EdgeFilter, NodeFilter
from cobeing.shared.types import NodeId

_logger = logging.getLogger(__name__)


def _whitespace_tokenize(text: str) -> list[dict]:
    """Tokenize text using simple whitespace splitting.

    Produces token dicts compatible with the template matching pipeline.
    Without spaCy, we lose POS tags and dependency labels. Tokens get
    placeholder values that allow lemma-based matching to still work.

    Args:
        text: Raw input text.

    Returns:
        List of token dicts with idx, text, lemma, pos, dep, head_idx, is_root.
    """
    words = text.strip().split()
    tokens = []
    for i, word in enumerate(words):
        # Strip common punctuation for lemma
        lemma = word.lower().strip(".,!?;:\"'()[]")
        tokens.append({
            "idx": i,
            "text": word,
            "lemma": lemma,
            "pos": "X",       # Unknown POS (no spaCy)
            "dep": "ROOT" if i == 0 else "dep",  # First word is root
            "head_idx": 0 if i != 0 else i,       # All children of first word
            "is_root": i == 0,
        })
    return tokens


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MatchResult:
    """Outcome of matching an utterance against syntactic templates.

    Attributes:
        template_id: NodeId of the ProceduralTemplate that matched.
        template_name: Human-readable name of the template (from its
            ``name`` property).
        role_bindings: Mapping from role names declared in the template
            (e.g. ``"subject"``, ``"object"``) to the lemma of the
            token that filled that role.
        confidence: Match confidence. Currently 1.0 for any successful
            match; future extensions may incorporate partial matches.
        tokens: The token dict list produced by whitespace tokenization.
            Passed through so downstream handlers can inspect the tokens
            without re-parsing.
    """

    template_id: str
    template_name: str
    role_bindings: dict[str, str]
    confidence: float
    tokens: list[dict]


# ---------------------------------------------------------------------------
# SyntacticTemplateMatcher
# ---------------------------------------------------------------------------


class SyntacticTemplateMatcher:
    """Match tokenized input against graph-stored syntactic templates.

    Each syntactic template is a ProceduralTemplate node with
    ``properties["domain"] == "syntax"`` and an AST of ProcedureStep
    nodes linked by HAS_OPERAND edges.  The root step has
    ``step_type == "match_root"`` and optional ``lemma_filter`` /
    ``pos_filter`` properties that constrain which ROOT token it accepts.

    Child steps are linked via HAS_OPERAND edges (sorted by position)
    and may have step_type ``"match_edge"``, ``"match_optional"``,
    ``"extract_role"``, or ``"match_property"``.

    Note: Without spaCy, POS-based and dependency-based matching will
    degrade. Lemma-based matching still works via whitespace tokenization.

    Args:
        persistence: The graph persistence backend.
    """

    def __init__(
        self,
        persistence: GraphPersistence,
    ) -> None:
        self._persistence = persistence

    async def match(self, text: str) -> MatchResult | None:
        """Tokenize *text* and match against all syntactic templates.

        Args:
            text: Natural-language utterance to match.

        Returns:
            The highest-confidence :class:`MatchResult` if any template
            matched, or ``None`` if no template matched the token list.
        """
        tokens = _whitespace_tokenize(text)
        if not tokens:
            return None

        # Query all ProceduralTemplate nodes
        proc_nodes = await self._persistence.query_nodes(
            NodeFilter(node_type=PROCEDURAL_TEMPLATE)
        )

        # Filter to syntactic templates
        syntax_templates = [
            n for n in proc_nodes
            if n.properties.get("domain") == "syntax"
        ]

        if not syntax_templates:
            _logger.debug(
                "template_matcher_no_syntax_templates -- no syntactic templates in graph"
            )
            return None

        # Try each template; collect successful matches
        matches: list[MatchResult] = []
        for proc_node in syntax_templates:
            try:
                result = await self._try_match_template(tokens, proc_node)
                if result is not None:
                    matches.append(result)
            except Exception as exc:
                _logger.warning(
                    "template_match_error template=%s error=%s",
                    proc_node.node_id,
                    exc,
                )

        if not matches:
            return None

        # Return highest confidence match.
        # Tiebreaker: when confidence is equal, prefer the template that
        # filled more role bindings -- a more specific match is better.
        best = max(
            matches,
            key=lambda m: (m.confidence, len(m.role_bindings)),
        )
        _logger.info(
            "template_matched template=%s name=%s bindings=%s confidence=%.2f",
            best.template_id,
            best.template_name,
            best.role_bindings,
            best.confidence,
        )
        return best

    # ------------------------------------------------------------------
    # Template matching
    # ------------------------------------------------------------------

    async def _try_match_template(
        self,
        tokens: list[dict],
        proc_node: object,
    ) -> MatchResult | None:
        """Attempt to match *tokens* against a single syntactic template.

        Args:
            tokens: Token dicts from whitespace tokenization.
            proc_node: A KnowledgeNode of type ProceduralTemplate.

        Returns:
            A :class:`MatchResult` if the template matched, else ``None``.
        """
        # Load body via HAS_PROCEDURE_BODY edge
        body_edges = await self._persistence.query_edges(
            EdgeFilter(
                edge_type=HAS_PROCEDURE_BODY,
                source_node_id=proc_node.node_id,  # type: ignore[union-attr]
            )
        )
        if not body_edges:
            return None

        root_step_id = body_edges[0].target_id
        root_step = await self._persistence.get_node(NodeId(root_step_id))
        if root_step is None:
            return None

        # Root step must be match_root
        if root_step.properties.get("step_type") != "match_root":
            _logger.debug(
                "template_root_not_match_root template=%s step_type=%s",
                proc_node.node_id,  # type: ignore[union-attr]
                root_step.properties.get("step_type"),
            )
            return None

        # Find ROOT token in the parse
        root_token = next((t for t in tokens if t["is_root"]), None)
        if root_token is None:
            return None

        # Check root token filters
        lemma_filter = root_step.properties.get("lemma_filter")
        if lemma_filter is not None:
            if isinstance(lemma_filter, list):
                if root_token["lemma"] not in lemma_filter:
                    return None
            elif isinstance(lemma_filter, str):
                if root_token["lemma"] != lemma_filter:
                    return None

        pos_filter = root_step.properties.get("pos_filter")
        if pos_filter is not None:
            # With whitespace tokenization, all POS are "X".
            # Skip POS filtering to avoid breaking all templates.
            pass

        # Root passes -- start building bindings
        bindings: dict[str, str] = {}
        specificity: list[int] = [0]

        # Extract role from root if specified
        root_role = root_step.properties.get("role_name")
        if root_role:
            bindings[root_role] = root_token["lemma"]

        # Recurse on children: load HAS_OPERAND edges of root step, sorted
        child_edges = await self._persistence.query_edges(
            EdgeFilter(
                edge_type=HAS_OPERAND,
                source_node_id=root_step_id,
            )
        )
        child_edges.sort(key=lambda e: e.properties.get("position", 0))

        for child_edge in child_edges:
            child_step_id = child_edge.target_id

            # Load the child step to check its type before calling _match_step
            child_step = await self._persistence.get_node(NodeId(child_step_id))
            if child_step is None:
                return None

            is_optional = child_step.properties.get("step_type") == "match_optional"
            if not is_optional and child_step.properties.get("lemma_filter"):
                specificity[0] += 1
            success = await self._match_step(
                tokens, NodeId(child_step_id), root_token, bindings
            )
            if not success and not is_optional:
                return None

        confidence = 1.0 + 0.01 * specificity[0]

        return MatchResult(
            template_id=proc_node.node_id,  # type: ignore[union-attr]
            template_name=(proc_node.properties.get("name") or proc_node.properties.get("procedure_name", "")),  # type: ignore[union-attr]
            role_bindings=dict(bindings),
            confidence=confidence,
            tokens=tokens,
        )

    # ------------------------------------------------------------------
    # Step matching (recursive)
    # ------------------------------------------------------------------

    async def _match_step(
        self,
        tokens: list[dict],
        step_id: NodeId,
        current_token: dict,
        bindings: dict[str, str],
    ) -> bool:
        """Match a single ProcedureStep against the token tree.

        Dispatches on ``step_type``:

        - ``"match_edge"``: Find a child token of *current_token* whose
          ``dep`` matches ``dep_filter``. Optionally check ``pos_filter``
          and ``lemma_filter``. Bind role if ``role_name`` is set.
          Recurse on HAS_OPERAND children.

        - ``"match_optional"``: Same as ``match_edge``, but return True
          even if the child token is not found.

        - ``"extract_role"``: Bind *current_token*'s lemma to
          ``role_name``.

        - ``"match_property"``: Check that a named property of
          *current_token* equals ``expected_value``.

        Args:
            tokens: Full token list from the parse.
            step_id: NodeId of the ProcedureStep to evaluate.
            current_token: The token dict that this step operates on.
            bindings: Mutable dict accumulating role bindings.

        Returns:
            True if the step matched, False otherwise.
        """
        try:
            step_node = await self._persistence.get_node(step_id)
            if step_node is None:
                _logger.warning("template_step_not_found step_id=%s", step_id)
                return False

            step_type = step_node.properties.get("step_type", "")

            if step_type == "match_edge":
                return await self._match_edge_step(
                    tokens, step_node, current_token, bindings, required=True
                )

            if step_type == "match_optional":
                return await self._match_edge_step(
                    tokens, step_node, current_token, bindings, required=False
                )

            if step_type == "extract_role":
                role_name = step_node.properties.get("role_name", "")
                if role_name:
                    bindings[role_name] = current_token["lemma"]
                return True

            if step_type == "match_property":
                expected_value = step_node.properties.get("expected_value", "")
                prop_name = step_node.properties.get("property_name", "lemma")
                return current_token.get(prop_name, "") == expected_value

            # Unknown step_type: permissive for forward compatibility
            _logger.warning(
                "template_unknown_step_type step_id=%s step_type=%s",
                step_id,
                step_type,
            )
            return True

        except Exception as exc:
            _logger.warning(
                "template_step_match_error step_id=%s error=%s",
                step_id,
                exc,
            )
            return False

    async def _match_edge_step(
        self,
        tokens: list[dict],
        step_node: object,
        current_token: dict,
        bindings: dict[str, str],
        *,
        required: bool,
    ) -> bool:
        """Match a match_edge or match_optional step.

        Finds a child token of *current_token* whose ``dep`` matches
        the step's ``dep_filter``.  Optionally checks ``pos_filter``
        and ``lemma_filter`` on the child.  Binds ``role_name`` if
        present.  Recurses on HAS_OPERAND children of this step.

        Args:
            tokens: Full token list from the parse.
            step_node: The ProcedureStep KnowledgeNode.
            current_token: The token dict whose children to search.
            bindings: Mutable dict accumulating role bindings.
            required: If True (match_edge), return False when child not
                found. If False (match_optional), return True when
                child not found.

        Returns:
            True if the step matched (or was optional and not found).
        """
        dep_filter = step_node.properties.get("dep_filter", "")  # type: ignore[union-attr]

        # Find child token with matching dep relation
        child = None
        for t in tokens:
            if t["head_idx"] == current_token["idx"] and t["dep"] == dep_filter:
                child = t
                break

        if child is None:
            # match_optional returns True even if not found
            return not required

        # Skip POS filtering -- with whitespace tokenization all POS are "X"
        # Optionally check lemma_filter on child
        lemma_filter = step_node.properties.get("lemma_filter")  # type: ignore[union-attr]
        if lemma_filter is not None:
            if isinstance(lemma_filter, list):
                if child["lemma"] not in lemma_filter:
                    return not required
            elif isinstance(lemma_filter, str):
                if child["lemma"] != lemma_filter:
                    return not required

        # Bind role if specified
        role_name = step_node.properties.get("role_name", "")  # type: ignore[union-attr]
        if role_name:
            bindings[role_name] = child["lemma"]

        # Recurse on HAS_OPERAND children of this step
        child_edges = await self._persistence.query_edges(
            EdgeFilter(
                edge_type=HAS_OPERAND,
                source_node_id=step_node.node_id,  # type: ignore[union-attr]
            )
        )
        child_edges.sort(key=lambda e: e.properties.get("position", 0))

        for child_edge in child_edges:
            sub_step_id = child_edge.target_id
            sub_step = await self._persistence.get_node(NodeId(sub_step_id))
            if sub_step is None:
                continue

            is_optional = sub_step.properties.get("step_type") == "match_optional"
            success = await self._match_step(
                tokens, NodeId(sub_step_id), child, bindings
            )
            if not success and not is_optional:
                return False

        return True


__all__ = [
    "MatchResult",
    "SyntacticTemplateMatcher",
]
