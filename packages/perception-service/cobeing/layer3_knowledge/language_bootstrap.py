"""Language ontology bootstrap for Co-Being (Phase 1.7, P1.7-E1/E2/E4).

Implements the TAUGHT_PROCEDURE bootstrap for language knowledge in six
dependency-ordered layers:

  Layer 0 -- Linguistic ConceptPrimitive nodes:
    - 10 SCHEMA-level ConceptPrimitive nodes representing foundational
      linguistic categories (word, morpheme, phoneme, clause, noun, verb,
      adjective, adverb, preposition, sentence).

  Layer 1 -- Core word senses and base forms:
    - 8 WordSenseNode SCHEMA-level nodes for high-frequency English words
      (cat, dog, run, big, the, a, is, what).
    - 8 WordFormNode INSTANCE-level nodes (one base form per word sense).
    - 8 INSTANCE_OF_WORD edges linking each base form to its word sense.

  Layer 2 -- Irregular morphological forms:
    - ~287 WordFormNode pairs (base + target) from the English irregular
      forms table (language_irregular_forms.py).
    - ~287 TRANSFORMS_TO edges encoding irregular transformations
      (plural, past_tense, past_participle, comparative, superlative)
      with is_regular=False.

  Layer 3 -- Morphological procedures (P1.7-E2):
    - 6 ProceduralTemplate nodes for regular English morphology:
      proc:pluralize, proc:past_tense, proc:present_participle,
      proc:comparative, proc:superlative, proc:third_person.
    - Each template has a full AST body (ProcedureStep tree) and
      worked examples (WorkedExample nodes).
    - Procedures operate on strings via the MorphologyExecutor, NOT
      via ProcedureExecutor (which works on ValueNodes).

  Layer 4 -- Syntactic parse templates (P1.7-E4):
    - 5 ProceduralTemplate nodes for syntactic pattern matching:
      proc:parse_transitive, proc:parse_intransitive, proc:parse_copular,
      proc:parse_question_what, proc:parse_question_math.
    - Each template has an AST body of ProcedureStep nodes with step_types
      match_root, match_edge, match_optional, extract_role, match_property.
    - Templates carry domain="syntax" for SyntacticTemplateMatcher lookup.

  Layer 5 -- Disambiguation placeholder (P1.7-E4):
    - 1 ProceduralTemplate node (proc:disambiguate) for lexical-chain WSD.
    - Placeholder body: single ProcedureStep with step_type
      "disambiguation_engine" and no children.

All nodes use TAUGHT_PROCEDURE provenance (CANON A.18). This function is
called once per startup, after ``bootstrap_procedural_ontology()``. It is
idempotent: a node that already exists is counted as existing and not
recreated.

Usage::

    from cobeing.layer3_knowledge.language_bootstrap import (
        bootstrap_language_ontology,
    )

    result = await bootstrap_language_ontology(persistence)
    # result.concepts_created, result.words_created, result.forms_created
    # result.procedures_created, result.procedures_existing
"""

from __future__ import annotations

from dataclasses import dataclass
import logging

from cobeing.layer3_knowledge.exceptions import BootstrapError
from cobeing.layer3_knowledge.language_irregular_forms import IRREGULAR_FORMS
from cobeing.layer3_knowledge.language_types import (
    INSTANCE_OF_WORD,
    TRANSFORMS_TO,
    WORD_FORM_NODE,
    WORD_SENSE_NODE,
)
from cobeing.layer3_knowledge.node_types import (
    KnowledgeEdge,
    KnowledgeNode,
    NodeStatus,
    SchemaLevel,
)
from cobeing.layer3_knowledge.procedure_types import (
    CONCEPT_PRIMITIVE,
    DEPENDS_ON,
    HAS_OPERAND,
    HAS_PROCEDURE_BODY,
    HAS_WORKED_EXAMPLE,
    PROCEDURAL_TEMPLATE,
    PROCEDURE_STEP,
    WORKED_EXAMPLE,
)
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import EdgeId, NodeId


# ---------------------------------------------------------------------------
# Provenance helper
# ---------------------------------------------------------------------------


def _taught() -> Provenance:
    """Return the canonical TAUGHT_PROCEDURE provenance for all bootstrap nodes."""
    return Provenance(
        source=ProvenanceSource.TAUGHT_PROCEDURE,
        source_id="language-bootstrap",
        confidence=1.0,
    )


# ===========================================================================
# Layer 0: Linguistic ConceptPrimitive definitions
# ===========================================================================

_LANG_CONCEPTS: list[dict] = [
    {
        "node_id": "concept:word",
        "name": "word",
        "description": (
            "A unit of language that carries meaning. The basic building "
            "block of utterances."
        ),
        "domain": "language",
    },
    {
        "node_id": "concept:morpheme",
        "name": "morpheme",
        "description": (
            "The smallest meaningful unit of language. A word may contain "
            "one or more morphemes."
        ),
        "domain": "language",
    },
    {
        "node_id": "concept:phoneme",
        "name": "phoneme",
        "description": (
            "A minimal unit of sound that distinguishes meaning. Reserved "
            "for future audio processing."
        ),
        "domain": "language",
    },
    {
        "node_id": "concept:clause",
        "name": "clause",
        "description": (
            "A unit of grammatical organization containing a subject and "
            "a predicate."
        ),
        "domain": "language",
    },
    {
        "node_id": "concept:noun",
        "name": "noun",
        "description": "A word that names a person, place, thing, or idea.",
        "domain": "language",
    },
    {
        "node_id": "concept:verb",
        "name": "verb",
        "description": (
            "A word that expresses an action, event, or state of being."
        ),
        "domain": "language",
    },
    {
        "node_id": "concept:adjective",
        "name": "adjective",
        "description": (
            "A word that modifies a noun, describing a quality or property."
        ),
        "domain": "language",
    },
    {
        "node_id": "concept:adverb",
        "name": "adverb",
        "description": (
            "A word that modifies a verb, adjective, or other adverb."
        ),
        "domain": "language",
    },
    {
        "node_id": "concept:preposition",
        "name": "preposition",
        "description": (
            "A word that relates a noun to another element in the sentence."
        ),
        "domain": "language",
    },
    {
        "node_id": "concept:sentence",
        "name": "sentence",
        "description": (
            "A complete unit of expression containing at least one clause."
        ),
        "domain": "language",
    },
]


async def _bootstrap_lang_layer0(
    persistence: GraphPersistence,
) -> dict[str, int]:
    """Create Layer 0: Linguistic ConceptPrimitive SCHEMA nodes.

    Returns a dict with keys: concepts_created, concepts_existing.
    """
    counts: dict[str, int] = {
        "concepts_created": 0,
        "concepts_existing": 0,
    }

    for defn in _LANG_CONCEPTS:
        node_id = NodeId(defn["node_id"])
        if await persistence.get_node(node_id) is not None:
            counts["concepts_existing"] += 1
            continue

        node = KnowledgeNode(
            node_id=node_id,
            node_type=CONCEPT_PRIMITIVE,
            schema_level=SchemaLevel.SCHEMA,
            properties={
                "name": defn["name"],
                "description": defn["description"],
                "domain": defn["domain"],
            },
            provenance=_taught(),
            confidence=1.0,
            status=NodeStatus.ACTIVE,
        )
        try:
            await persistence.save_node(node)
        except Exception as exc:
            raise BootstrapError(
                f"Failed to create linguistic ConceptPrimitive "
                f"'{node_id}': {exc}"
            ) from exc
        counts["concepts_created"] += 1

    return counts


# ===========================================================================
# Layer 1: Core WordSenseNodes and base WordFormNodes
# ===========================================================================

_CORE_WORD_SENSES: list[dict] = [
    {
        "node_id": "word:cat:animal",
        "spelling": "cat",
        "part_of_speech": "noun",
        "sense_tag": "animal",
        "frequency_rank": 1,
    },
    {
        "node_id": "word:dog:animal",
        "spelling": "dog",
        "part_of_speech": "noun",
        "sense_tag": "animal",
        "frequency_rank": 2,
    },
    {
        "node_id": "word:run:locomotion",
        "spelling": "run",
        "part_of_speech": "verb",
        "sense_tag": "locomotion",
        "frequency_rank": 3,
    },
    {
        "node_id": "word:big:size",
        "spelling": "big",
        "part_of_speech": "adjective",
        "sense_tag": "size",
        "frequency_rank": 4,
    },
    {
        "node_id": "word:the:definite",
        "spelling": "the",
        "part_of_speech": "determiner",
        "sense_tag": "definite",
        "frequency_rank": 5,
    },
    {
        "node_id": "word:a:indefinite",
        "spelling": "a",
        "part_of_speech": "determiner",
        "sense_tag": "indefinite",
        "frequency_rank": 6,
    },
    {
        "node_id": "word:is:copula",
        "spelling": "is",
        "part_of_speech": "verb",
        "sense_tag": "copula",
        "frequency_rank": 7,
    },
    {
        "node_id": "word:what:interrogative",
        "spelling": "what",
        "part_of_speech": "pronoun",
        "sense_tag": "interrogative",
        "frequency_rank": 8,
    },
]


async def _bootstrap_lang_layer1(
    persistence: GraphPersistence,
) -> dict[str, int]:
    """Create Layer 1: Core WordSenseNodes and their base WordFormNodes.

    For each word sense, creates:
      1. A WordSenseNode (SCHEMA level) with spelling, part_of_speech,
         sense_tag, frequency_rank, and scope_contexts properties.
      2. A WordFormNode (INSTANCE level) for the base form.
      3. An INSTANCE_OF_WORD edge from the WordFormNode to the WordSenseNode.

    Returns a dict with keys:
        words_created, words_existing,
        forms_created, forms_existing,
        edges_created, edges_existing.
    """
    counts: dict[str, int] = {
        "words_created": 0,
        "words_existing": 0,
        "forms_created": 0,
        "forms_existing": 0,
        "edges_created": 0,
        "edges_existing": 0,
    }

    for defn in _CORE_WORD_SENSES:
        word_node_id = NodeId(defn["node_id"])
        spelling = defn["spelling"]

        # ---- WordSenseNode ----
        if await persistence.get_node(word_node_id) is not None:
            counts["words_existing"] += 1
        else:
            word_node = KnowledgeNode(
                node_id=word_node_id,
                node_type=WORD_SENSE_NODE,
                schema_level=SchemaLevel.SCHEMA,
                properties={
                    "spelling": spelling,
                    "part_of_speech": defn["part_of_speech"],
                    "sense_tag": defn["sense_tag"],
                    "frequency_rank": defn["frequency_rank"],
                    "scope_contexts": [],
                },
                provenance=_taught(),
                confidence=1.0,
                status=NodeStatus.ACTIVE,
            )
            try:
                await persistence.save_node(word_node)
            except Exception as exc:
                raise BootstrapError(
                    f"Failed to create WordSenseNode "
                    f"'{word_node_id}': {exc}"
                ) from exc
            counts["words_created"] += 1

        # ---- WordFormNode (base form) ----
        form_node_id = NodeId(f"form:{spelling}:base")
        if await persistence.get_node(form_node_id) is not None:
            counts["forms_existing"] += 1
        else:
            form_node = KnowledgeNode(
                node_id=form_node_id,
                node_type=WORD_FORM_NODE,
                schema_level=SchemaLevel.INSTANCE,
                properties={
                    "spelling": spelling,
                    "inflection_type": "base",
                },
                provenance=_taught(),
                confidence=1.0,
                status=NodeStatus.ACTIVE,
            )
            try:
                await persistence.save_node(form_node)
            except Exception as exc:
                raise BootstrapError(
                    f"Failed to create WordFormNode "
                    f"'{form_node_id}': {exc}"
                ) from exc
            counts["forms_created"] += 1

        # ---- INSTANCE_OF_WORD edge ----
        edge_id = EdgeId(f"edge:instance_of_word:{spelling}:base")
        if await persistence.get_edge(edge_id) is not None:
            counts["edges_existing"] += 1
        else:
            edge = KnowledgeEdge(
                edge_id=edge_id,
                source_id=form_node_id,
                target_id=word_node_id,
                edge_type=INSTANCE_OF_WORD,
                properties={},
                provenance=_taught(),
                confidence=1.0,
            )
            try:
                await persistence.save_edge(edge)
            except Exception as exc:
                raise BootstrapError(
                    f"Failed to create INSTANCE_OF_WORD edge "
                    f"'{edge_id}': {exc}"
                ) from exc
            counts["edges_created"] += 1

    return counts


# ===========================================================================
# Layer 2: Irregular morphological forms
# ===========================================================================


async def _bootstrap_lang_layer2(
    persistence: GraphPersistence,
) -> dict[str, int]:
    """Create Layer 2: Irregular form WordFormNodes and TRANSFORMS_TO edges.

    For each entry in IRREGULAR_FORMS:
      1. Creates a WordFormNode for the base form (if not exists).
      2. Creates a WordFormNode for the target form (if not exists).
      3. Creates a TRANSFORMS_TO edge from base to target with
         is_regular=False.

    Returns a dict with keys:
        forms_created, forms_existing,
        irregular_edges_created, irregular_edges_existing.
    """
    counts: dict[str, int] = {
        "forms_created": 0,
        "forms_existing": 0,
        "irregular_edges_created": 0,
        "irregular_edges_existing": 0,
    }

    for entry in IRREGULAR_FORMS:
        base_spelling = entry["base"]
        target_spelling = entry["target"]
        transform_type = entry["type"]

        # ---- Base WordFormNode ----
        base_form_id = NodeId(f"form:{base_spelling}:base")
        if await persistence.get_node(base_form_id) is None:
            base_node = KnowledgeNode(
                node_id=base_form_id,
                node_type=WORD_FORM_NODE,
                schema_level=SchemaLevel.INSTANCE,
                properties={
                    "spelling": base_spelling,
                    "inflection_type": "base",
                },
                provenance=_taught(),
                confidence=1.0,
                status=NodeStatus.ACTIVE,
            )
            try:
                await persistence.save_node(base_node)
            except Exception as exc:
                raise BootstrapError(
                    f"Failed to create base WordFormNode "
                    f"'{base_form_id}': {exc}"
                ) from exc
            counts["forms_created"] += 1
        else:
            counts["forms_existing"] += 1

        # ---- Target WordFormNode ----
        target_form_id = NodeId(f"form:{target_spelling}:{transform_type}")
        if await persistence.get_node(target_form_id) is None:
            target_node = KnowledgeNode(
                node_id=target_form_id,
                node_type=WORD_FORM_NODE,
                schema_level=SchemaLevel.INSTANCE,
                properties={
                    "spelling": target_spelling,
                    "inflection_type": transform_type,
                },
                provenance=_taught(),
                confidence=1.0,
                status=NodeStatus.ACTIVE,
            )
            try:
                await persistence.save_node(target_node)
            except Exception as exc:
                raise BootstrapError(
                    f"Failed to create target WordFormNode "
                    f"'{target_form_id}': {exc}"
                ) from exc
            counts["forms_created"] += 1
        else:
            counts["forms_existing"] += 1

        # ---- TRANSFORMS_TO edge ----
        edge_id = EdgeId(
            f"edge:transforms_to:irregular:{base_spelling}:{transform_type}"
        )
        if await persistence.get_edge(edge_id) is not None:
            counts["irregular_edges_existing"] += 1
        else:
            edge = KnowledgeEdge(
                edge_id=edge_id,
                source_id=base_form_id,
                target_id=target_form_id,
                edge_type=TRANSFORMS_TO,
                properties={
                    "transform_type": transform_type,
                    "is_regular": False,
                    "confidence": 1.0,
                    "encounter_count": 0,
                    "guardian_confirmed": False,
                    "source_procedure_id": None,
                    "deprecated": False,
                    "error_count": 0,
                },
                provenance=_taught(),
                confidence=1.0,
            )
            try:
                await persistence.save_edge(edge)
            except Exception as exc:
                raise BootstrapError(
                    f"Failed to create TRANSFORMS_TO edge "
                    f"'{edge_id}': {exc}"
                ) from exc
            counts["irregular_edges_created"] += 1

    return counts


# ===========================================================================
# Layer 3: Morphological procedures (P1.7-E2)
# ===========================================================================
#
# Uses the same dict-based AST pattern as procedure_bootstrap.py. Each
# procedure is described as a plain dict with:
#   id, name, description, parameters, depends_on, body (AST), examples.
#
# The body is a recursive dict of ProcedureStep definitions using the same
# "operands" nesting pattern. The _collect_procedure_nodes_and_edges helper
# (copied from procedure_bootstrap.py) flattens these into graph nodes and
# edges.
#
# CRITICAL: These procedures operate on strings via MorphologyExecutor, NOT
# via ProcedureExecutor. The AST is the same structure, but execution
# resolves $WORD to a Python string directly, not to a ValueNode ID.
# ===========================================================================


def _build_procedure_template(proc_def: dict) -> KnowledgeNode:
    """Build a ProceduralTemplate node from a procedure definition dict."""
    props: dict = {
        "name": proc_def["name"],
        "description": proc_def["description"],
        "parameters": proc_def["parameters"],
        "arity": len(proc_def["parameters"]),
    }
    if "domain" in proc_def:
        props["domain"] = proc_def["domain"]
    return KnowledgeNode(
        node_id=NodeId(proc_def["id"]),
        node_type=PROCEDURAL_TEMPLATE,
        schema_level=SchemaLevel.SCHEMA,
        properties=props,
        provenance=_taught(),
        confidence=1.0,
        status=NodeStatus.ACTIVE,
    )


def _build_procedure_step(step_def: dict) -> KnowledgeNode:
    """Build a ProcedureStep node from a step definition dict."""
    props: dict = {"step_type": step_def["step_type"]}
    if step_def["step_type"] == "operation":
        props["operation"] = step_def["operation"]
    elif step_def["step_type"] == "variable":
        props["variable"] = step_def["variable"]
    elif step_def["step_type"] == "literal":
        props["literal_value"] = step_def["literal_value"]
        props["literal_type"] = step_def.get("literal_type", "integer")
    # Syntactic template step types (Layer 4): match_root, match_edge,
    # match_optional, extract_role, match_property, disambiguation_engine.
    # Copy optional filter/role properties when present.
    for _optional_key in ("dep_filter", "role_name", "lemma_filter", "pos_filter", "expected_value", "property_name"):
        if _optional_key in step_def:
            props[_optional_key] = step_def[_optional_key]
    return KnowledgeNode(
        node_id=NodeId(step_def["id"]),
        node_type=PROCEDURE_STEP,
        schema_level=SchemaLevel.SCHEMA,
        properties=props,
        provenance=_taught(),
        confidence=1.0,
        status=NodeStatus.ACTIVE,
    )


def _collect_procedure_nodes_and_edges(
    proc_def: dict,
) -> tuple[list[KnowledgeNode], list[KnowledgeEdge]]:
    """Build all nodes and edges for one morphological procedure definition.

    Returns (nodes, edges) covering:
    - The ProceduralTemplate node
    - All ProcedureStep nodes (recursively from the body AST)
    - All WorkedExample nodes
    - HAS_PROCEDURE_BODY, HAS_OPERAND, DEPENDS_ON, HAS_WORKED_EXAMPLE edges
    """
    nodes: list[KnowledgeNode] = []
    edges: list[KnowledgeEdge] = []

    proc_node_id = NodeId(proc_def["id"])
    nodes.append(_build_procedure_template(proc_def))

    # --- Recursively traverse the AST body ---
    def _traverse(step_def: dict, parent_id: NodeId | None, position: int) -> None:
        step_node = _build_procedure_step(step_def)
        nodes.append(step_node)
        step_id = NodeId(step_def["id"])

        if parent_id is None:
            # Root step: ProceduralTemplate --HAS_PROCEDURE_BODY--> root ProcedureStep
            edges.append(
                KnowledgeEdge(
                    edge_id=EdgeId(f"edge:has_body:{proc_def['id']}"),
                    source_id=proc_node_id,
                    target_id=step_id,
                    edge_type=HAS_PROCEDURE_BODY,
                    properties={},
                    provenance=_taught(),
                    confidence=1.0,
                )
            )
        else:
            # Child step: parent ProcedureStep --HAS_OPERAND--> child ProcedureStep
            edges.append(
                KnowledgeEdge(
                    edge_id=EdgeId(f"edge:has_operand:{parent_id}:{position}"),
                    source_id=parent_id,
                    target_id=step_id,
                    edge_type=HAS_OPERAND,
                    properties={"position": position},
                    provenance=_taught(),
                    confidence=1.0,
                )
            )

        for pos, operand_def in enumerate(step_def.get("operands", [])):
            _traverse(operand_def, step_id, pos)

    _traverse(proc_def["body"], None, 0)

    # --- DEPENDS_ON edges ---
    for dep_id in proc_def.get("depends_on", []):
        edges.append(
            KnowledgeEdge(
                edge_id=EdgeId(f"edge:depends_on:{proc_def['id']}:{dep_id}"),
                source_id=proc_node_id,
                target_id=NodeId(dep_id),
                edge_type=DEPENDS_ON,
                properties={},
                provenance=_taught(),
                confidence=1.0,
            )
        )

    # --- WorkedExample nodes and HAS_WORKED_EXAMPLE edges ---
    for ex in proc_def.get("examples", []):
        example_node = KnowledgeNode(
            node_id=NodeId(ex["id"]),
            node_type=WORKED_EXAMPLE,
            schema_level=SchemaLevel.SCHEMA,
            properties={
                "input_node_ids": ex["input_node_ids"],
                "output_node_id": ex.get("output_node_id", ""),
                "description": ex["description"],
                "step_trace": ex.get("step_trace", []),
            },
            provenance=_taught(),
            confidence=1.0,
            status=NodeStatus.ACTIVE,
        )
        nodes.append(example_node)
        edges.append(
            KnowledgeEdge(
                edge_id=EdgeId(f"edge:has_example:{proc_def['id']}:{ex['id']}"),
                source_id=proc_node_id,
                target_id=NodeId(ex["id"]),
                edge_type=HAS_WORKED_EXAMPLE,
                properties={},
                provenance=_taught(),
                confidence=1.0,
            )
        )

    return nodes, edges


async def _bootstrap_single_procedure(
    persistence: GraphPersistence,
    proc_def: dict,
) -> bool:
    """Bootstrap one procedure. Returns True if created, False if already existed.

    Idempotency key: the ProceduralTemplate node_id. If that node exists,
    the entire procedure (steps, examples, edges) is assumed to exist.
    """
    proc_node_id = NodeId(proc_def["id"])
    if await persistence.get_node(proc_node_id) is not None:
        return False

    nodes, edges = _collect_procedure_nodes_and_edges(proc_def)

    for node in nodes:
        try:
            await persistence.save_node(node)
        except Exception as exc:
            raise BootstrapError(
                f"Failed to save node '{node.node_id}' for procedure "
                f"'{proc_def['id']}': {exc}"
            ) from exc

    for edge in edges:
        try:
            await persistence.save_edge(edge)
        except Exception as exc:
            raise BootstrapError(
                f"Failed to save edge '{edge.edge_id}' for procedure "
                f"'{proc_def['id']}': {exc}"
            ) from exc

    return True


# ---------------------------------------------------------------------------
# Morphological procedure definitions (T02-T07)
# ---------------------------------------------------------------------------

_MORPHOLOGICAL_PROCEDURE_DEFS: list[dict] = [
    # ------------------------------------------------------------------
    # proc:pluralize (T02)
    # ------------------------------------------------------------------
    {
        "id": "proc:pluralize",
        "name": "pluralize",
        "description": (
            "Given a noun, return its plural form using English morphological "
            "rules. Irregular forms handled by direct-recall TRANSFORMS_TO "
            "edges (FST priority union)."
        ),
        "parameters": ["$WORD"],
        "depends_on": ["concept:word", "concept:noun"],
        "body": {
            "id": "step:plur:root",
            "step_type": "conditional",
            "operands": [
                # [0] condition: ends_with($WORD, "y")
                {
                    "id": "step:plur:cond_ends_y",
                    "step_type": "operation",
                    "operation": "string_ends_with",
                    "operands": [
                        {"id": "step:plur:w1", "step_type": "variable", "variable": "$WORD"},
                        {"id": "step:plur:lit_y", "step_type": "literal", "literal_value": "y", "literal_type": "string"},
                    ],
                },
                # [1] then: is the y preceded by a vowel?
                {
                    "id": "step:plur:then_y",
                    "step_type": "conditional",
                    "operands": [
                        # [0] condition: preceded_by_vowel($WORD, length($WORD)-1)
                        {
                            "id": "step:plur:cond_vowel_before_y",
                            "step_type": "operation",
                            "operation": "string_preceded_by_vowel",
                            "operands": [
                                {"id": "step:plur:w2", "step_type": "variable", "variable": "$WORD"},
                                {
                                    "id": "step:plur:pos_before_y",
                                    "step_type": "operation",
                                    "operation": "subtract",
                                    "operands": [
                                        {
                                            "id": "step:plur:len1",
                                            "step_type": "operation",
                                            "operation": "string_length",
                                            "operands": [
                                                {"id": "step:plur:w3", "step_type": "variable", "variable": "$WORD"},
                                            ],
                                        },
                                        {"id": "step:plur:lit_1a", "step_type": "literal", "literal_value": 1, "literal_type": "integer"},
                                    ],
                                },
                            ],
                        },
                        # [1] then: vowel precedes y -> boy->boys
                        {
                            "id": "step:plur:append_s_boy",
                            "step_type": "operation",
                            "operation": "string_append",
                            "operands": [
                                {"id": "step:plur:w4", "step_type": "variable", "variable": "$WORD"},
                                {"id": "step:plur:lit_s1", "step_type": "literal", "literal_value": "s", "literal_type": "string"},
                            ],
                        },
                        # [2] else: no vowel before y -> city->cit+ies
                        {
                            "id": "step:plur:strip_y_add_ies",
                            "step_type": "operation",
                            "operation": "string_append",
                            "operands": [
                                {
                                    "id": "step:plur:strip1",
                                    "step_type": "operation",
                                    "operation": "string_strip_suffix",
                                    "operands": [
                                        {"id": "step:plur:w5", "step_type": "variable", "variable": "$WORD"},
                                        {"id": "step:plur:lit_1b", "step_type": "literal", "literal_value": 1, "literal_type": "integer"},
                                    ],
                                },
                                {"id": "step:plur:lit_ies", "step_type": "literal", "literal_value": "ies", "literal_type": "string"},
                            ],
                        },
                    ],
                },
                # [2] else (not ends in y): check sibilant
                {
                    "id": "step:plur:else_y",
                    "step_type": "conditional",
                    "operands": [
                        # [0] condition: ends_with s OR x OR z OR ch OR sh
                        {
                            "id": "step:plur:cond_sib",
                            "step_type": "operation",
                            "operation": "boolean_or",
                            "operands": [
                                {
                                    "id": "step:plur:ends_s",
                                    "step_type": "operation",
                                    "operation": "string_ends_with",
                                    "operands": [
                                        {"id": "step:plur:w6", "step_type": "variable", "variable": "$WORD"},
                                        {"id": "step:plur:lit_s2", "step_type": "literal", "literal_value": "s", "literal_type": "string"},
                                    ],
                                },
                                {
                                    "id": "step:plur:or1",
                                    "step_type": "operation",
                                    "operation": "boolean_or",
                                    "operands": [
                                        {
                                            "id": "step:plur:ends_x",
                                            "step_type": "operation",
                                            "operation": "string_ends_with",
                                            "operands": [
                                                {"id": "step:plur:w7", "step_type": "variable", "variable": "$WORD"},
                                                {"id": "step:plur:lit_x", "step_type": "literal", "literal_value": "x", "literal_type": "string"},
                                            ],
                                        },
                                        {
                                            "id": "step:plur:or2",
                                            "step_type": "operation",
                                            "operation": "boolean_or",
                                            "operands": [
                                                {
                                                    "id": "step:plur:ends_z",
                                                    "step_type": "operation",
                                                    "operation": "string_ends_with",
                                                    "operands": [
                                                        {"id": "step:plur:w8", "step_type": "variable", "variable": "$WORD"},
                                                        {"id": "step:plur:lit_z", "step_type": "literal", "literal_value": "z", "literal_type": "string"},
                                                    ],
                                                },
                                                {
                                                    "id": "step:plur:or3",
                                                    "step_type": "operation",
                                                    "operation": "boolean_or",
                                                    "operands": [
                                                        {
                                                            "id": "step:plur:ends_ch",
                                                            "step_type": "operation",
                                                            "operation": "string_ends_with",
                                                            "operands": [
                                                                {"id": "step:plur:w9", "step_type": "variable", "variable": "$WORD"},
                                                                {"id": "step:plur:lit_ch", "step_type": "literal", "literal_value": "ch", "literal_type": "string"},
                                                            ],
                                                        },
                                                        {
                                                            "id": "step:plur:ends_sh",
                                                            "step_type": "operation",
                                                            "operation": "string_ends_with",
                                                            "operands": [
                                                                {"id": "step:plur:w10", "step_type": "variable", "variable": "$WORD"},
                                                                {"id": "step:plur:lit_sh", "step_type": "literal", "literal_value": "sh", "literal_type": "string"},
                                                            ],
                                                        },
                                                    ],
                                                },
                                            ],
                                        },
                                    ],
                                },
                            ],
                        },
                        # [1] then: sibilant -> append "es"
                        {
                            "id": "step:plur:append_es",
                            "step_type": "operation",
                            "operation": "string_append",
                            "operands": [
                                {"id": "step:plur:w11", "step_type": "variable", "variable": "$WORD"},
                                {"id": "step:plur:lit_es", "step_type": "literal", "literal_value": "es", "literal_type": "string"},
                            ],
                        },
                        # [2] else: default -> append "s"
                        {
                            "id": "step:plur:append_s_default",
                            "step_type": "operation",
                            "operation": "string_append",
                            "operands": [
                                {"id": "step:plur:w12", "step_type": "variable", "variable": "$WORD"},
                                {"id": "step:plur:lit_s3", "step_type": "literal", "literal_value": "s", "literal_type": "string"},
                            ],
                        },
                    ],
                },
            ],
        },
        "examples": [
            {
                "id": "example:plur:cat",
                "input_node_ids": [],
                "output_node_id": "",
                "description": "pluralize(cat) = cats",
                "step_trace": [
                    {"step": "ends_with(cat,y)?", "value": False},
                    {"step": "ends_with_sibilant?", "value": False},
                    {"step": "append s", "value": "cats"},
                ],
            },
            {
                "id": "example:plur:city",
                "input_node_ids": [],
                "output_node_id": "",
                "description": "pluralize(city) = cities",
                "step_trace": [
                    {"step": "ends_with(city,y)?", "value": True},
                    {"step": "preceded_by_vowel?", "value": False},
                    {"step": "strip y + ies", "value": "cities"},
                ],
            },
            {
                "id": "example:plur:box",
                "input_node_ids": [],
                "output_node_id": "",
                "description": "pluralize(box) = boxes",
                "step_trace": [
                    {"step": "ends_with(box,y)?", "value": False},
                    {"step": "ends_with x?", "value": True},
                    {"step": "append es", "value": "boxes"},
                ],
            },
        ],
    },
    # ------------------------------------------------------------------
    # proc:past_tense (T03)
    # ------------------------------------------------------------------
    {
        "id": "proc:past_tense",
        "name": "past_tense",
        "description": (
            "Given a verb, return its past tense form using English "
            "morphological rules. Irregular forms handled by direct-recall "
            "TRANSFORMS_TO edges (FST priority union)."
        ),
        "parameters": ["$WORD"],
        "depends_on": ["concept:word", "concept:verb"],
        "body": {
            # conditional: ends_with("e")?
            "id": "step:past:root",
            "step_type": "conditional",
            "operands": [
                # [0] condition: ends_with($WORD, "e")
                {
                    "id": "step:past:cond_ends_e",
                    "step_type": "operation",
                    "operation": "string_ends_with",
                    "operands": [
                        {"id": "step:past:w1", "step_type": "variable", "variable": "$WORD"},
                        {"id": "step:past:lit_e", "step_type": "literal", "literal_value": "e", "literal_type": "string"},
                    ],
                },
                # [1] then: ends_with("e") -> append "d" (love->loved)
                {
                    "id": "step:past:append_d",
                    "step_type": "operation",
                    "operation": "string_append",
                    "operands": [
                        {"id": "step:past:w2", "step_type": "variable", "variable": "$WORD"},
                        {"id": "step:past:lit_d", "step_type": "literal", "literal_value": "d", "literal_type": "string"},
                    ],
                },
                # [2] else: check ends_with("y")
                {
                    "id": "step:past:else_e",
                    "step_type": "conditional",
                    "operands": [
                        # [0] condition: ends_with($WORD, "y")
                        {
                            "id": "step:past:cond_ends_y",
                            "step_type": "operation",
                            "operation": "string_ends_with",
                            "operands": [
                                {"id": "step:past:w3", "step_type": "variable", "variable": "$WORD"},
                                {"id": "step:past:lit_y", "step_type": "literal", "literal_value": "y", "literal_type": "string"},
                            ],
                        },
                        # [1] then: ends_with("y") -> check vowel before y
                        {
                            "id": "step:past:then_y",
                            "step_type": "conditional",
                            "operands": [
                                # [0] condition: preceded_by_vowel
                                {
                                    "id": "step:past:cond_vowel_y",
                                    "step_type": "operation",
                                    "operation": "string_preceded_by_vowel",
                                    "operands": [
                                        {"id": "step:past:w4", "step_type": "variable", "variable": "$WORD"},
                                        {
                                            "id": "step:past:pos_y",
                                            "step_type": "operation",
                                            "operation": "subtract",
                                            "operands": [
                                                {
                                                    "id": "step:past:len1",
                                                    "step_type": "operation",
                                                    "operation": "string_length",
                                                    "operands": [
                                                        {"id": "step:past:w5", "step_type": "variable", "variable": "$WORD"},
                                                    ],
                                                },
                                                {"id": "step:past:lit_1a", "step_type": "literal", "literal_value": 1, "literal_type": "integer"},
                                            ],
                                        },
                                    ],
                                },
                                # [1] then: vowel before y -> append "ed" (play->played)
                                {
                                    "id": "step:past:append_ed_vowely",
                                    "step_type": "operation",
                                    "operation": "string_append",
                                    "operands": [
                                        {"id": "step:past:w6", "step_type": "variable", "variable": "$WORD"},
                                        {"id": "step:past:lit_ed1", "step_type": "literal", "literal_value": "ed", "literal_type": "string"},
                                    ],
                                },
                                # [2] else: no vowel before y -> strip_suffix(1) + "ied" (study->studied)
                                {
                                    "id": "step:past:strip_y_add_ied",
                                    "step_type": "operation",
                                    "operation": "string_append",
                                    "operands": [
                                        {
                                            "id": "step:past:strip1",
                                            "step_type": "operation",
                                            "operation": "string_strip_suffix",
                                            "operands": [
                                                {"id": "step:past:w7", "step_type": "variable", "variable": "$WORD"},
                                                {"id": "step:past:lit_1b", "step_type": "literal", "literal_value": 1, "literal_type": "integer"},
                                            ],
                                        },
                                        {"id": "step:past:lit_ied", "step_type": "literal", "literal_value": "ied", "literal_type": "string"},
                                    ],
                                },
                            ],
                        },
                        # [2] else: not "y" -> default append "ed" (walk->walked)
                        {
                            "id": "step:past:append_ed_default",
                            "step_type": "operation",
                            "operation": "string_append",
                            "operands": [
                                {"id": "step:past:w8", "step_type": "variable", "variable": "$WORD"},
                                {"id": "step:past:lit_ed2", "step_type": "literal", "literal_value": "ed", "literal_type": "string"},
                            ],
                        },
                    ],
                },
            ],
        },
        "examples": [
            {
                "id": "example:past:walk",
                "input_node_ids": [],
                "output_node_id": "",
                "description": "past_tense(walk) = walked",
                "step_trace": [
                    {"step": "ends_with(walk,e)?", "value": False},
                    {"step": "ends_with(walk,y)?", "value": False},
                    {"step": "append ed", "value": "walked"},
                ],
            },
            {
                "id": "example:past:love",
                "input_node_ids": [],
                "output_node_id": "",
                "description": "past_tense(love) = loved",
                "step_trace": [
                    {"step": "ends_with(love,e)?", "value": True},
                    {"step": "append d", "value": "loved"},
                ],
            },
            {
                "id": "example:past:study",
                "input_node_ids": [],
                "output_node_id": "",
                "description": "past_tense(study) = studied",
                "step_trace": [
                    {"step": "ends_with(study,e)?", "value": False},
                    {"step": "ends_with(study,y)?", "value": True},
                    {"step": "preceded_by_vowel?", "value": False},
                    {"step": "strip y + ied", "value": "studied"},
                ],
            },
            {
                "id": "example:past:play",
                "input_node_ids": [],
                "output_node_id": "",
                "description": "past_tense(play) = played",
                "step_trace": [
                    {"step": "ends_with(play,e)?", "value": False},
                    {"step": "ends_with(play,y)?", "value": True},
                    {"step": "preceded_by_vowel?", "value": True},
                    {"step": "append ed", "value": "played"},
                ],
            },
        ],
    },
    # ------------------------------------------------------------------
    # proc:present_participle (T04)
    # ------------------------------------------------------------------
    {
        "id": "proc:present_participle",
        "name": "present_participle",
        "description": (
            "Given a verb, return its present participle (-ing) form using "
            "English morphological rules. Irregular forms handled by "
            "direct-recall TRANSFORMS_TO edges (FST priority union)."
        ),
        "parameters": ["$WORD"],
        "depends_on": ["concept:word", "concept:verb"],
        "body": {
            # conditional: ends_with("ie")?
            "id": "step:ppart:root",
            "step_type": "conditional",
            "operands": [
                # [0] condition: ends_with($WORD, "ie")
                {
                    "id": "step:ppart:cond_ends_ie",
                    "step_type": "operation",
                    "operation": "string_ends_with",
                    "operands": [
                        {"id": "step:ppart:w1", "step_type": "variable", "variable": "$WORD"},
                        {"id": "step:ppart:lit_ie", "step_type": "literal", "literal_value": "ie", "literal_type": "string"},
                    ],
                },
                # [1] then: ends_with("ie") -> strip_suffix(2) + "ying" (lie->lying)
                {
                    "id": "step:ppart:strip_ie_add_ying",
                    "step_type": "operation",
                    "operation": "string_append",
                    "operands": [
                        {
                            "id": "step:ppart:strip_ie",
                            "step_type": "operation",
                            "operation": "string_strip_suffix",
                            "operands": [
                                {"id": "step:ppart:w2", "step_type": "variable", "variable": "$WORD"},
                                {"id": "step:ppart:lit_2", "step_type": "literal", "literal_value": 2, "literal_type": "integer"},
                            ],
                        },
                        {"id": "step:ppart:lit_ying", "step_type": "literal", "literal_value": "ying", "literal_type": "string"},
                    ],
                },
                # [2] else: check ends_with("e") AND NOT ends_with("ee")
                {
                    "id": "step:ppart:else_ie",
                    "step_type": "conditional",
                    "operands": [
                        # [0] condition: ends_with("e") AND NOT ends_with("ee")
                        {
                            "id": "step:ppart:cond_e_not_ee",
                            "step_type": "operation",
                            "operation": "boolean_and",
                            "operands": [
                                {
                                    "id": "step:ppart:ends_e",
                                    "step_type": "operation",
                                    "operation": "string_ends_with",
                                    "operands": [
                                        {"id": "step:ppart:w3", "step_type": "variable", "variable": "$WORD"},
                                        {"id": "step:ppart:lit_e", "step_type": "literal", "literal_value": "e", "literal_type": "string"},
                                    ],
                                },
                                {
                                    "id": "step:ppart:not_ends_ee",
                                    "step_type": "operation",
                                    "operation": "boolean_not",
                                    "operands": [
                                        {
                                            "id": "step:ppart:ends_ee",
                                            "step_type": "operation",
                                            "operation": "string_ends_with",
                                            "operands": [
                                                {"id": "step:ppart:w4", "step_type": "variable", "variable": "$WORD"},
                                                {"id": "step:ppart:lit_ee", "step_type": "literal", "literal_value": "ee", "literal_type": "string"},
                                            ],
                                        },
                                    ],
                                },
                            ],
                        },
                        # [1] then: strip_suffix(1) + "ing" (make->making)
                        {
                            "id": "step:ppart:strip_e_add_ing",
                            "step_type": "operation",
                            "operation": "string_append",
                            "operands": [
                                {
                                    "id": "step:ppart:strip_e",
                                    "step_type": "operation",
                                    "operation": "string_strip_suffix",
                                    "operands": [
                                        {"id": "step:ppart:w5", "step_type": "variable", "variable": "$WORD"},
                                        {"id": "step:ppart:lit_1", "step_type": "literal", "literal_value": 1, "literal_type": "integer"},
                                    ],
                                },
                                {"id": "step:ppart:lit_ing1", "step_type": "literal", "literal_value": "ing", "literal_type": "string"},
                            ],
                        },
                        # [2] else: default -> append "ing" (walk->walking)
                        {
                            "id": "step:ppart:append_ing_default",
                            "step_type": "operation",
                            "operation": "string_append",
                            "operands": [
                                {"id": "step:ppart:w6", "step_type": "variable", "variable": "$WORD"},
                                {"id": "step:ppart:lit_ing2", "step_type": "literal", "literal_value": "ing", "literal_type": "string"},
                            ],
                        },
                    ],
                },
            ],
        },
        "examples": [
            {
                "id": "example:ppart:walk",
                "input_node_ids": [],
                "output_node_id": "",
                "description": "present_participle(walk) = walking",
                "step_trace": [
                    {"step": "ends_with(walk,ie)?", "value": False},
                    {"step": "ends_with(walk,e) AND NOT ee?", "value": False},
                    {"step": "append ing", "value": "walking"},
                ],
            },
            {
                "id": "example:ppart:make",
                "input_node_ids": [],
                "output_node_id": "",
                "description": "present_participle(make) = making",
                "step_trace": [
                    {"step": "ends_with(make,ie)?", "value": False},
                    {"step": "ends_with(make,e) AND NOT ee?", "value": True},
                    {"step": "strip e + ing", "value": "making"},
                ],
            },
            {
                "id": "example:ppart:lie",
                "input_node_ids": [],
                "output_node_id": "",
                "description": "present_participle(lie) = lying",
                "step_trace": [
                    {"step": "ends_with(lie,ie)?", "value": True},
                    {"step": "strip ie + ying", "value": "lying"},
                ],
            },
        ],
    },
    # ------------------------------------------------------------------
    # proc:comparative (T05)
    # ------------------------------------------------------------------
    {
        "id": "proc:comparative",
        "name": "comparative",
        "description": (
            "Given an adjective, return its comparative form using English "
            "morphological rules. Irregular forms handled by direct-recall "
            "TRANSFORMS_TO edges (FST priority union)."
        ),
        "parameters": ["$WORD"],
        "depends_on": ["concept:word", "concept:adjective"],
        "body": {
            # conditional: ends_with("y") AND NOT preceded_by_vowel?
            "id": "step:comp:root",
            "step_type": "conditional",
            "operands": [
                # [0] condition: ends_with("y") AND NOT preceded_by_vowel
                {
                    "id": "step:comp:cond_y_no_vowel",
                    "step_type": "operation",
                    "operation": "boolean_and",
                    "operands": [
                        {
                            "id": "step:comp:ends_y",
                            "step_type": "operation",
                            "operation": "string_ends_with",
                            "operands": [
                                {"id": "step:comp:w1", "step_type": "variable", "variable": "$WORD"},
                                {"id": "step:comp:lit_y", "step_type": "literal", "literal_value": "y", "literal_type": "string"},
                            ],
                        },
                        {
                            "id": "step:comp:not_vowel",
                            "step_type": "operation",
                            "operation": "boolean_not",
                            "operands": [
                                {
                                    "id": "step:comp:preceded_vowel",
                                    "step_type": "operation",
                                    "operation": "string_preceded_by_vowel",
                                    "operands": [
                                        {"id": "step:comp:w2", "step_type": "variable", "variable": "$WORD"},
                                        {
                                            "id": "step:comp:pos_y",
                                            "step_type": "operation",
                                            "operation": "subtract",
                                            "operands": [
                                                {
                                                    "id": "step:comp:len1",
                                                    "step_type": "operation",
                                                    "operation": "string_length",
                                                    "operands": [
                                                        {"id": "step:comp:w3", "step_type": "variable", "variable": "$WORD"},
                                                    ],
                                                },
                                                {"id": "step:comp:lit_1", "step_type": "literal", "literal_value": 1, "literal_type": "integer"},
                                            ],
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
                # [1] then: strip_suffix(1) + "ier" (happy->happier)
                {
                    "id": "step:comp:strip_y_add_ier",
                    "step_type": "operation",
                    "operation": "string_append",
                    "operands": [
                        {
                            "id": "step:comp:strip1",
                            "step_type": "operation",
                            "operation": "string_strip_suffix",
                            "operands": [
                                {"id": "step:comp:w4", "step_type": "variable", "variable": "$WORD"},
                                {"id": "step:comp:lit_1b", "step_type": "literal", "literal_value": 1, "literal_type": "integer"},
                            ],
                        },
                        {"id": "step:comp:lit_ier", "step_type": "literal", "literal_value": "ier", "literal_type": "string"},
                    ],
                },
                # [2] else: default -> append "er"
                {
                    "id": "step:comp:append_er_default",
                    "step_type": "operation",
                    "operation": "string_append",
                    "operands": [
                        {"id": "step:comp:w5", "step_type": "variable", "variable": "$WORD"},
                        {"id": "step:comp:lit_er", "step_type": "literal", "literal_value": "er", "literal_type": "string"},
                    ],
                },
            ],
        },
        "examples": [
            {
                "id": "example:comp:big",
                "input_node_ids": [],
                "output_node_id": "",
                "description": "comparative(big) = bigger",
                "step_trace": [
                    {"step": "ends_with(big,y) AND NOT preceded_by_vowel?", "value": False},
                    {"step": "append er", "value": "bigger"},
                ],
            },
            {
                "id": "example:comp:happy",
                "input_node_ids": [],
                "output_node_id": "",
                "description": "comparative(happy) = happier",
                "step_trace": [
                    {"step": "ends_with(happy,y) AND NOT preceded_by_vowel?", "value": True},
                    {"step": "strip y + ier", "value": "happier"},
                ],
            },
        ],
    },
    # ------------------------------------------------------------------
    # proc:superlative (T06)
    # ------------------------------------------------------------------
    {
        "id": "proc:superlative",
        "name": "superlative",
        "description": (
            "Given an adjective, return its superlative form using English "
            "morphological rules. Irregular forms handled by direct-recall "
            "TRANSFORMS_TO edges (FST priority union)."
        ),
        "parameters": ["$WORD"],
        "depends_on": ["concept:word", "concept:adjective"],
        "body": {
            "id": "step:sup:root",
            "step_type": "conditional",
            "operands": [
                # [0] condition: ends_with("y") AND NOT preceded_by_vowel
                {
                    "id": "step:sup:cond_y_no_vowel",
                    "step_type": "operation",
                    "operation": "boolean_and",
                    "operands": [
                        {
                            "id": "step:sup:ends_y",
                            "step_type": "operation",
                            "operation": "string_ends_with",
                            "operands": [
                                {"id": "step:sup:w1", "step_type": "variable", "variable": "$WORD"},
                                {"id": "step:sup:lit_y", "step_type": "literal", "literal_value": "y", "literal_type": "string"},
                            ],
                        },
                        {
                            "id": "step:sup:not_vowel",
                            "step_type": "operation",
                            "operation": "boolean_not",
                            "operands": [
                                {
                                    "id": "step:sup:preceded_vowel",
                                    "step_type": "operation",
                                    "operation": "string_preceded_by_vowel",
                                    "operands": [
                                        {"id": "step:sup:w2", "step_type": "variable", "variable": "$WORD"},
                                        {
                                            "id": "step:sup:pos_y",
                                            "step_type": "operation",
                                            "operation": "subtract",
                                            "operands": [
                                                {
                                                    "id": "step:sup:len1",
                                                    "step_type": "operation",
                                                    "operation": "string_length",
                                                    "operands": [
                                                        {"id": "step:sup:w3", "step_type": "variable", "variable": "$WORD"},
                                                    ],
                                                },
                                                {"id": "step:sup:lit_1", "step_type": "literal", "literal_value": 1, "literal_type": "integer"},
                                            ],
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
                # [1] then: strip_suffix(1) + "iest" (happy->happiest)
                {
                    "id": "step:sup:strip_y_add_iest",
                    "step_type": "operation",
                    "operation": "string_append",
                    "operands": [
                        {
                            "id": "step:sup:strip1",
                            "step_type": "operation",
                            "operation": "string_strip_suffix",
                            "operands": [
                                {"id": "step:sup:w4", "step_type": "variable", "variable": "$WORD"},
                                {"id": "step:sup:lit_1b", "step_type": "literal", "literal_value": 1, "literal_type": "integer"},
                            ],
                        },
                        {"id": "step:sup:lit_iest", "step_type": "literal", "literal_value": "iest", "literal_type": "string"},
                    ],
                },
                # [2] else: default -> append "est"
                {
                    "id": "step:sup:append_est_default",
                    "step_type": "operation",
                    "operation": "string_append",
                    "operands": [
                        {"id": "step:sup:w5", "step_type": "variable", "variable": "$WORD"},
                        {"id": "step:sup:lit_est", "step_type": "literal", "literal_value": "est", "literal_type": "string"},
                    ],
                },
            ],
        },
        "examples": [
            {
                "id": "example:sup:big",
                "input_node_ids": [],
                "output_node_id": "",
                "description": "superlative(big) = biggest",
                "step_trace": [
                    {"step": "ends_with(big,y) AND NOT preceded_by_vowel?", "value": False},
                    {"step": "append est", "value": "biggest"},
                ],
            },
            {
                "id": "example:sup:happy",
                "input_node_ids": [],
                "output_node_id": "",
                "description": "superlative(happy) = happiest",
                "step_trace": [
                    {"step": "ends_with(happy,y) AND NOT preceded_by_vowel?", "value": True},
                    {"step": "strip y + iest", "value": "happiest"},
                ],
            },
        ],
    },
    # ------------------------------------------------------------------
    # proc:third_person (T07) -- identical morphological pattern to pluralize
    # ------------------------------------------------------------------
    {
        "id": "proc:third_person",
        "name": "third_person",
        "description": (
            "Given a verb, return its third person singular present form "
            "using English morphological rules (identical to noun pluralisation). "
            "Irregular forms handled by direct-recall TRANSFORMS_TO edges."
        ),
        "parameters": ["$WORD"],
        "depends_on": ["concept:word", "concept:verb"],
        "body": {
            "id": "step:thrd:root",
            "step_type": "conditional",
            "operands": [
                # [0] condition: ends_with($WORD, "y")
                {
                    "id": "step:thrd:cond_ends_y",
                    "step_type": "operation",
                    "operation": "string_ends_with",
                    "operands": [
                        {"id": "step:thrd:w1", "step_type": "variable", "variable": "$WORD"},
                        {"id": "step:thrd:lit_y", "step_type": "literal", "literal_value": "y", "literal_type": "string"},
                    ],
                },
                # [1] then: check vowel before y
                {
                    "id": "step:thrd:then_y",
                    "step_type": "conditional",
                    "operands": [
                        # [0] condition: preceded_by_vowel
                        {
                            "id": "step:thrd:cond_vowel_before_y",
                            "step_type": "operation",
                            "operation": "string_preceded_by_vowel",
                            "operands": [
                                {"id": "step:thrd:w2", "step_type": "variable", "variable": "$WORD"},
                                {
                                    "id": "step:thrd:pos_before_y",
                                    "step_type": "operation",
                                    "operation": "subtract",
                                    "operands": [
                                        {
                                            "id": "step:thrd:len1",
                                            "step_type": "operation",
                                            "operation": "string_length",
                                            "operands": [
                                                {"id": "step:thrd:w3", "step_type": "variable", "variable": "$WORD"},
                                            ],
                                        },
                                        {"id": "step:thrd:lit_1a", "step_type": "literal", "literal_value": 1, "literal_type": "integer"},
                                    ],
                                },
                            ],
                        },
                        # [1] then: vowel before y -> append "s" (play->plays)
                        {
                            "id": "step:thrd:append_s_vowely",
                            "step_type": "operation",
                            "operation": "string_append",
                            "operands": [
                                {"id": "step:thrd:w4", "step_type": "variable", "variable": "$WORD"},
                                {"id": "step:thrd:lit_s1", "step_type": "literal", "literal_value": "s", "literal_type": "string"},
                            ],
                        },
                        # [2] else: no vowel before y -> strip_suffix(1) + "ies" (study->studies)
                        {
                            "id": "step:thrd:strip_y_add_ies",
                            "step_type": "operation",
                            "operation": "string_append",
                            "operands": [
                                {
                                    "id": "step:thrd:strip1",
                                    "step_type": "operation",
                                    "operation": "string_strip_suffix",
                                    "operands": [
                                        {"id": "step:thrd:w5", "step_type": "variable", "variable": "$WORD"},
                                        {"id": "step:thrd:lit_1b", "step_type": "literal", "literal_value": 1, "literal_type": "integer"},
                                    ],
                                },
                                {"id": "step:thrd:lit_ies", "step_type": "literal", "literal_value": "ies", "literal_type": "string"},
                            ],
                        },
                    ],
                },
                # [2] else (not ends in y): check sibilant
                {
                    "id": "step:thrd:else_y",
                    "step_type": "conditional",
                    "operands": [
                        # [0] condition: ends_with s OR x OR z OR ch OR sh
                        {
                            "id": "step:thrd:cond_sib",
                            "step_type": "operation",
                            "operation": "boolean_or",
                            "operands": [
                                {
                                    "id": "step:thrd:ends_s",
                                    "step_type": "operation",
                                    "operation": "string_ends_with",
                                    "operands": [
                                        {"id": "step:thrd:w6", "step_type": "variable", "variable": "$WORD"},
                                        {"id": "step:thrd:lit_s2", "step_type": "literal", "literal_value": "s", "literal_type": "string"},
                                    ],
                                },
                                {
                                    "id": "step:thrd:or1",
                                    "step_type": "operation",
                                    "operation": "boolean_or",
                                    "operands": [
                                        {
                                            "id": "step:thrd:ends_x",
                                            "step_type": "operation",
                                            "operation": "string_ends_with",
                                            "operands": [
                                                {"id": "step:thrd:w7", "step_type": "variable", "variable": "$WORD"},
                                                {"id": "step:thrd:lit_x", "step_type": "literal", "literal_value": "x", "literal_type": "string"},
                                            ],
                                        },
                                        {
                                            "id": "step:thrd:or2",
                                            "step_type": "operation",
                                            "operation": "boolean_or",
                                            "operands": [
                                                {
                                                    "id": "step:thrd:ends_z",
                                                    "step_type": "operation",
                                                    "operation": "string_ends_with",
                                                    "operands": [
                                                        {"id": "step:thrd:w8", "step_type": "variable", "variable": "$WORD"},
                                                        {"id": "step:thrd:lit_z", "step_type": "literal", "literal_value": "z", "literal_type": "string"},
                                                    ],
                                                },
                                                {
                                                    "id": "step:thrd:or3",
                                                    "step_type": "operation",
                                                    "operation": "boolean_or",
                                                    "operands": [
                                                        {
                                                            "id": "step:thrd:ends_ch",
                                                            "step_type": "operation",
                                                            "operation": "string_ends_with",
                                                            "operands": [
                                                                {"id": "step:thrd:w9", "step_type": "variable", "variable": "$WORD"},
                                                                {"id": "step:thrd:lit_ch", "step_type": "literal", "literal_value": "ch", "literal_type": "string"},
                                                            ],
                                                        },
                                                        {
                                                            "id": "step:thrd:ends_sh",
                                                            "step_type": "operation",
                                                            "operation": "string_ends_with",
                                                            "operands": [
                                                                {"id": "step:thrd:w10", "step_type": "variable", "variable": "$WORD"},
                                                                {"id": "step:thrd:lit_sh", "step_type": "literal", "literal_value": "sh", "literal_type": "string"},
                                                            ],
                                                        },
                                                    ],
                                                },
                                            ],
                                        },
                                    ],
                                },
                            ],
                        },
                        # [1] then: sibilant -> append "es"
                        {
                            "id": "step:thrd:append_es",
                            "step_type": "operation",
                            "operation": "string_append",
                            "operands": [
                                {"id": "step:thrd:w11", "step_type": "variable", "variable": "$WORD"},
                                {"id": "step:thrd:lit_es", "step_type": "literal", "literal_value": "es", "literal_type": "string"},
                            ],
                        },
                        # [2] else: default -> append "s"
                        {
                            "id": "step:thrd:append_s_default",
                            "step_type": "operation",
                            "operation": "string_append",
                            "operands": [
                                {"id": "step:thrd:w12", "step_type": "variable", "variable": "$WORD"},
                                {"id": "step:thrd:lit_s3", "step_type": "literal", "literal_value": "s", "literal_type": "string"},
                            ],
                        },
                    ],
                },
            ],
        },
        "examples": [
            {
                "id": "example:thrd:run",
                "input_node_ids": [],
                "output_node_id": "",
                "description": "third_person(run) = runs",
                "step_trace": [
                    {"step": "ends_with(run,y)?", "value": False},
                    {"step": "ends_with_sibilant?", "value": False},
                    {"step": "append s", "value": "runs"},
                ],
            },
            {
                "id": "example:thrd:study",
                "input_node_ids": [],
                "output_node_id": "",
                "description": "third_person(study) = studies",
                "step_trace": [
                    {"step": "ends_with(study,y)?", "value": True},
                    {"step": "preceded_by_vowel?", "value": False},
                    {"step": "strip y + ies", "value": "studies"},
                ],
            },
            {
                "id": "example:thrd:watch",
                "input_node_ids": [],
                "output_node_id": "",
                "description": "third_person(watch) = watches",
                "step_trace": [
                    {"step": "ends_with(watch,y)?", "value": False},
                    {"step": "ends_with ch?", "value": True},
                    {"step": "append es", "value": "watches"},
                ],
            },
        ],
    },
]


async def _bootstrap_lang_layer3(
    persistence: GraphPersistence,
) -> dict[str, int]:
    """Create Layer 3: Morphological procedure ProceduralTemplate nodes.

    For each morphological procedure definition, creates:
      - The ProceduralTemplate node
      - All ProcedureStep nodes (recursive AST body)
      - All WorkedExample nodes
      - HAS_PROCEDURE_BODY, HAS_OPERAND, DEPENDS_ON, HAS_WORKED_EXAMPLE edges

    Returns a dict with keys: procedures_created, procedures_existing.
    """
    counts: dict[str, int] = {"procedures_created": 0, "procedures_existing": 0}
    for proc_def in _MORPHOLOGICAL_PROCEDURE_DEFS:
        created = await _bootstrap_single_procedure(persistence, proc_def)
        if created:
            counts["procedures_created"] += 1
        else:
            counts["procedures_existing"] += 1
    return counts




# ===========================================================================
# Layer 4: Syntactic parse template definitions (P1.7-E4)
# ===========================================================================
#
# Five ProceduralTemplate nodes for syntactic pattern matching. Each template
# has domain="syntax" so the SyntacticTemplateMatcher can discover them via
# property query. The AST body uses ProcedureStep nodes with step_types:
#   match_root     -- match the dependency root token (optional lemma_filter)
#   match_edge     -- match a required dependency edge (dep_filter + role_name)
#   match_optional -- match an optional dependency edge (dep_filter + role_name)
#   extract_role   -- extract the root token itself as a named role
#
# Each template has one WorkedExample showing expected input/output.
# ===========================================================================

_SYNTACTIC_PROCEDURE_DEFS: list[dict] = [
    # ------------------------------------------------------------------
    # proc:parse_transitive
    # ------------------------------------------------------------------
    {
        "id": "proc:parse_transitive",
        "name": "parse_transitive",
        "description": (
            "Parse a transitive sentence into agent/action/patient roles. "
            "Matches sentences with a subject (nsubj), direct object (obj), "
            "and a verb root."
        ),
        "domain": "syntax",
        "parameters": [],
        "depends_on": [],
        "body": {
            "id": "step:parse_transitive:root",
            "step_type": "match_root",
            "operands": [
                {
                    "id": "step:parse_transitive:root:0",
                    "step_type": "match_edge",
                    "dep_filter": "nsubj",
                    "role_name": "agent",
                },
                {
                    "id": "step:parse_transitive:root:1",
                    "step_type": "match_edge",
                    "dep_filter": "dobj",
                    "role_name": "patient",
                },
                {
                    "id": "step:parse_transitive:root:2",
                    "step_type": "extract_role",
                    "role_name": "action",
                },
            ],
        },
        "examples": [
            {
                "id": "example:parse_transitive:1",
                "input_node_ids": [],
                "output_node_id": "",
                "description": (
                    "parse_transitive('The cat chases the dog') = "
                    "{agent: cat, action: chase, patient: dog}"
                ),
                "step_trace": [
                    {"step": "input", "value": "The cat chases the dog"},
                    {
                        "step": "roles",
                        "value": {
                            "agent": "cat",
                            "action": "chase",
                            "patient": "dog",
                        },
                    },
                ],
            },
        ],
    },
    # ------------------------------------------------------------------
    # proc:parse_intransitive
    # ------------------------------------------------------------------
    {
        "id": "proc:parse_intransitive",
        "name": "parse_intransitive",
        "description": (
            "Parse an intransitive sentence into agent/action roles. "
            "Matches sentences with a subject (nsubj) and a verb root "
            "but no direct object."
        ),
        "domain": "syntax",
        "parameters": [],
        "depends_on": [],
        "body": {
            "id": "step:parse_intransitive:root",
            "step_type": "match_root",
            "pos_filter": "VERB",
            "operands": [
                {
                    "id": "step:parse_intransitive:root:0",
                    "step_type": "match_edge",
                    "dep_filter": "nsubj",
                    "role_name": "agent",
                },
                {
                    "id": "step:parse_intransitive:root:1",
                    "step_type": "extract_role",
                    "role_name": "action",
                },
            ],
        },
        "examples": [
            {
                "id": "example:parse_intransitive:1",
                "input_node_ids": [],
                "output_node_id": "",
                "description": (
                    "parse_intransitive('The cat runs') = "
                    "{agent: cat, action: run}"
                ),
                "step_trace": [
                    {"step": "input", "value": "The cat runs"},
                    {
                        "step": "roles",
                        "value": {"agent": "cat", "action": "run"},
                    },
                ],
            },
        ],
    },
    # ------------------------------------------------------------------
    # proc:parse_copular
    # ------------------------------------------------------------------
    {
        "id": "proc:parse_copular",
        "name": "parse_copular",
        "description": (
            "Parse a copular sentence (X is Y) into subject and predicate "
            "roles. Matches sentences where the root is a form of 'be' with "
            "a subject (nsubj) and either an attribute noun (attr) or "
            "adjective complement (acomp)."
        ),
        "domain": "syntax",
        "parameters": [],
        "depends_on": [],
        "body": {
            "id": "step:parse_copular:root",
            "step_type": "match_root",
            "lemma_filter": ["be", "is", "are", "was", "were"],
            "operands": [
                {
                    "id": "step:parse_copular:root:0",
                    "step_type": "match_edge",
                    "dep_filter": "nsubj",
                    "role_name": "subject",
                },
                {
                    "id": "step:parse_copular:root:1",
                    "step_type": "match_optional",
                    "dep_filter": "attr",
                    "role_name": "predicate_noun",
                },
                {
                    "id": "step:parse_copular:root:2",
                    "step_type": "match_optional",
                    "dep_filter": "acomp",
                    "role_name": "predicate_adj",
                },
            ],
        },
        "examples": [
            {
                "id": "example:parse_copular:1",
                "input_node_ids": [],
                "output_node_id": "",
                "description": (
                    "parse_copular('The cat is an animal') = "
                    "{subject: cat, predicate_noun: animal}"
                ),
                "step_trace": [
                    {"step": "input", "value": "The cat is an animal"},
                    {
                        "step": "roles",
                        "value": {
                            "subject": "cat",
                            "predicate_noun": "animal",
                        },
                    },
                ],
            },
        ],
    },
    # ------------------------------------------------------------------
    # proc:parse_question_what
    # ------------------------------------------------------------------
    {
        "id": "proc:parse_question_what",
        "name": "parse_question_what",
        "description": (
            "Parse a 'what is X' question into interrogative and query "
            "target roles. Matches questions where the root is a form of "
            "'be' with a required wh-word nsubj (what, which, who) and "
            "an optional attr (the query target). The required wh-word "
            "nsubj prevents this template from matching declarative "
            "copular sentences like 'A bird is an animal'."
        ),
        "domain": "syntax",
        "parameters": [],
        "depends_on": [],
        "body": {
            "id": "step:parse_question_what:root",
            "step_type": "match_root",
            "lemma_filter": ["be", "is", "are"],
            "operands": [
                {
                    "id": "step:parse_question_what:root:0",
                    "step_type": "match_edge",
                    "dep_filter": "attr",
                    "lemma_filter": ["what", "which", "who", "whom", "whose"],
                    "role_name": "interrogative",
                },
                {
                    "id": "step:parse_question_what:root:1",
                    "step_type": "match_optional",
                    "dep_filter": "nsubj",
                    "role_name": "query_target",
                },
            ],
        },
        "examples": [
            {
                "id": "example:parse_question_what:1",
                "input_node_ids": [],
                "output_node_id": "",
                "description": (
                    "parse_question_what('what is a cat') = "
                    "{interrogative: what, query_target: cat}"
                ),
                "step_trace": [
                    {"step": "input", "value": "what is a cat"},
                    {
                        "step": "roles",
                        "value": {
                            "interrogative": "what",
                            "query_target": "cat",
                        },
                    },
                ],
            },
        ],
    },
    # ------------------------------------------------------------------
    # proc:parse_question_math
    # ------------------------------------------------------------------
    {
        "id": "proc:parse_question_math",
        "name": "parse_question_math",
        "description": (
            "Parse a 'what is X plus Y' math question into interrogative "
            "and math expression roles. Matches questions where the root "
            "is a form of 'be' with a required attr child holding the "
            "math operator."
        ),
        "domain": "syntax",
        "parameters": [],
        "depends_on": [],
        "body": {
            "id": "step:parse_question_math:root",
            "step_type": "match_root",
            "lemma_filter": ["be", "is"],
            "operands": [
                {
                    "id": "step:parse_question_math:root:0",
                    "step_type": "match_optional",
                    "dep_filter": "nsubj",
                    "role_name": "interrogative",
                },
                {
                    "id": "step:parse_question_math:root:1",
                    "step_type": "match_edge",
                    "dep_filter": "attr",
                    "role_name": "math_expr",
                },
            ],
        },
        "examples": [
            {
                "id": "example:parse_question_math:1",
                "input_node_ids": [],
                "output_node_id": "",
                "description": (
                    "parse_question_math('what is 5 plus 3') = "
                    "{interrogative: what, math_expr: plus}"
                ),
                "step_trace": [
                    {"step": "input", "value": "what is 5 plus 3"},
                    {
                        "step": "roles",
                        "value": {
                            "interrogative": "what",
                            "math_expr": "plus",
                        },
                    },
                ],
            },
        ],
    },
]


async def _bootstrap_lang_layer4(
    persistence: GraphPersistence,
) -> dict[str, int]:
    """Create Layer 4: Syntactic parse template ProceduralTemplate nodes.

    For each syntactic template definition, creates:
      - The ProceduralTemplate node (with domain="syntax")
      - All ProcedureStep nodes (match_root, match_edge, etc.)
      - All WorkedExample nodes
      - HAS_PROCEDURE_BODY, HAS_OPERAND, HAS_WORKED_EXAMPLE edges

    Returns a dict with keys: procedures_created, procedures_existing.
    """
    counts: dict[str, int] = {"procedures_created": 0, "procedures_existing": 0}
    for proc_def in _SYNTACTIC_PROCEDURE_DEFS:
        created = await _bootstrap_single_procedure(persistence, proc_def)
        if created:
            counts["procedures_created"] += 1
        else:
            counts["procedures_existing"] += 1
    return counts


# ===========================================================================
# Layer 5: Disambiguation placeholder (P1.7-E4)
# ===========================================================================
#
# A single ProceduralTemplate registration node for lexical-chain WSD.
# The body is a single ProcedureStep with step_type="disambiguation_engine"
# and no children. No worked example is needed -- the engine operates on
# the full PRECEDES/MENTIONS graph at runtime.
# ===========================================================================

_DISAMBIGUATE_PROCEDURE_DEF: dict = {
    "id": "proc:disambiguate",
    "name": "proc:disambiguate",
    "description": (
        "Lexical chain WSD: scan PRECEDES chain backwards, collect "
        "MENTIONS salience scores, select highest-scoring sense."
    ),
    "domain": "language",
    "parameters": [],
    "depends_on": [],
    "body": {
        "id": "step:disambiguate:root",
        "step_type": "disambiguation_engine",
    },
    "examples": [],
}


async def _bootstrap_lang_layer5(
    persistence: GraphPersistence,
) -> dict[str, int]:
    """Create Layer 5: Disambiguation placeholder ProceduralTemplate node.

    Creates a single ProceduralTemplate node (proc:disambiguate) with a
    minimal body (one ProcedureStep of type disambiguation_engine).

    Returns a dict with keys: procedures_created, procedures_existing.
    """
    counts: dict[str, int] = {"procedures_created": 0, "procedures_existing": 0}
    created = await _bootstrap_single_procedure(
        persistence, _DISAMBIGUATE_PROCEDURE_DEF
    )
    if created:
        counts["procedures_created"] += 1
    else:
        counts["procedures_existing"] += 1
    return counts


# ===========================================================================
# Result type and main public function
# ===========================================================================


@dataclass(frozen=True)
class LanguageBootstrapResult:
    """Outcome of a ``bootstrap_language_ontology()`` call.

    Attributes:
        concepts_created: Linguistic ConceptPrimitive nodes created this call.
        concepts_existing: Linguistic ConceptPrimitive nodes already present.
        words_created: WordSenseNode nodes created this call.
        words_existing: WordSenseNode nodes already present.
        forms_created: WordFormNode nodes created this call (base forms from
            Layer 1 + all forms from Layer 2 irregular table).
        forms_existing: WordFormNode nodes already present.
        irregular_edges_created: TRANSFORMS_TO edges created this call.
        irregular_edges_existing: TRANSFORMS_TO edges already present.
        procedures_created: Morphological ProceduralTemplate nodes created
            this call. Each new template also creates its ProcedureStep and
            WorkedExample nodes -- this count covers templates only.
        procedures_existing: Morphological ProceduralTemplate nodes already
            present.
        total_nodes: Sum of all concept, word, form, and procedure counts
            (created + existing).
    """

    concepts_created: int
    concepts_existing: int
    words_created: int
    words_existing: int
    forms_created: int
    forms_existing: int
    irregular_edges_created: int
    irregular_edges_existing: int
    procedures_created: int
    procedures_existing: int

    @property
    def total_nodes(self) -> int:
        return (
            self.concepts_created
            + self.concepts_existing
            + self.words_created
            + self.words_existing
            + self.forms_created
            + self.forms_existing
            + self.procedures_created
            + self.procedures_existing
        )



_migration_log = logging.getLogger(__name__)


async def _migrate_question_what_nsubj_step(
    persistence: GraphPersistence,
) -> None:
    """Migrate the parse_question_what nsubj step from match_optional to match_edge.

    This is a one-time migration that fixes a bug where the parse_question_what
    template matched declarative copular sentences (e.g., 'A bird is an animal')
    because its nsubj step was match_optional with no lemma_filter. After this
    migration, the step requires a wh-word (what, which, who, whom, whose) in
    the nsubj position, preventing it from matching declarative statements.

    Idempotent: if the step already has step_type='match_edge' and the
    lemma_filter is present, no update is performed.
    """
    step_id = NodeId("step:parse_question_what:root:0")
    step_node = await persistence.get_node(step_id)
    if step_node is None:
        # Template not yet bootstrapped -- nothing to migrate.
        return

    current_step_type = step_node.properties.get("step_type", "")
    current_lemma_filter = step_node.properties.get("lemma_filter")

    current_dep_filter = step_node.properties.get("dep_filter", "")

    if (
        current_step_type == "match_edge"
        and current_lemma_filter is not None
        and current_dep_filter == "attr"
    ):
        # Already migrated -- nothing to do.
        _migration_log.debug(
            "parse_question_what interrogative step already migrated (step_type=%s, "
            "dep_filter=%s, lemma_filter=%s)",
            current_step_type,
            current_dep_filter,
            current_lemma_filter,
        )
        return

    # Update the step node properties.
    # spaCy parses "what is a cat?" with "what" as attr (not nsubj),
    # so this step must look at attr to find the interrogative pronoun.
    step_node.properties["step_type"] = "match_edge"
    step_node.properties["dep_filter"] = "attr"
    step_node.properties["lemma_filter"] = ["what", "which", "who", "whom", "whose"]

    try:
        await persistence.save_node(step_node)
        _migration_log.info(
            "Migrated parse_question_what interrogative step: "
            "dep_filter=nsubj -> attr, step_type -> match_edge, "
            "added lemma_filter=[what, which, who, whom, whose]"
        )
    except Exception as exc:
        _migration_log.warning(
            "Failed to migrate parse_question_what interrogative step: %s -- "
            "question routing may not work correctly",
            exc,
        )

    # Also fix step:root:1 (query_target) from attr to nsubj
    step1_id = NodeId("step:parse_question_what:root:1")
    step1_node = await persistence.get_node(step1_id)
    if step1_node is not None and step1_node.properties.get("dep_filter") == "attr":
        step1_node.properties["dep_filter"] = "nsubj"
        try:
            await persistence.save_node(step1_node)
            _migration_log.info(
                "Migrated parse_question_what query_target step: "
                "dep_filter=attr -> nsubj"
            )
        except Exception as exc:
            _migration_log.warning(
                "Failed to migrate parse_question_what query_target step: %s",
                exc,
            )



async def _migrate_intransitive_root_pos_filter(
    persistence: GraphPersistence,
) -> None:
    """Add pos_filter=VERB to the parse_intransitive root step.

    The parse_intransitive template had no pos_filter on its root step,
    causing it to match copular sentences (root POS=AUX) and steal matches
    from parse_copular. After this migration, parse_intransitive only
    matches sentences where the root token has POS=VERB, allowing
    parse_copular to correctly match 'X is Y' patterns and route them
    to SemanticTeachingHandler for IS_A edge creation.

    Without this fix, copular statements like 'a cat is an animal' match
    parse_intransitive (not in _SEMANTIC_TEMPLATE_NAMES) instead of
    parse_copular, causing them to fall through to the LLM path and
    never create IS_A edges in the graph.

    Idempotent: if the step already has a pos_filter, no update is performed.
    """
    step_id = NodeId("step:parse_intransitive:root")
    step_node = await persistence.get_node(step_id)
    if step_node is None:
        # Template not yet bootstrapped -- nothing to migrate.
        return

    current_pos_filter = step_node.properties.get("pos_filter")

    if current_pos_filter is not None:
        # Already migrated -- nothing to do.
        _migration_log.debug(
            "parse_intransitive root step already has pos_filter=%s",
            current_pos_filter,
        )
        return

    # Update the step node properties.
    step_node.properties["pos_filter"] = "VERB"

    try:
        await persistence.save_node(step_node)
        _migration_log.info(
            "Migrated parse_intransitive root step: added pos_filter=VERB "
            "(copular sentences will now match parse_copular instead)"
        )
    except Exception as exc:
        _migration_log.warning(
            "Failed to migrate parse_intransitive root step: %s -- "
            "copular sentences may still match parse_intransitive",
            exc,
        )


async def _migrate_transitive_dobj_step(
    persistence: GraphPersistence,
) -> None:
    """Fix parse_transitive patient step: dep_filter 'obj' → 'dobj'.

    spaCy en_core_web_sm labels direct objects as ``dobj``, not ``obj``.
    The original template used ``obj``, so transitive sentences like
    'rain causes floods' never matched parse_transitive and fell through
    to the LLM path instead of being routed to SemanticTeachingHandler.

    Idempotent: if the step already has dep_filter='dobj', no update.
    """
    step_id = NodeId("step:parse_transitive:root:1")
    step_node = await persistence.get_node(step_id)
    if step_node is None:
        return

    current_dep = step_node.properties.get("dep_filter")
    if current_dep == "dobj":
        _migration_log.debug(
            "parse_transitive patient step already has dep_filter=dobj"
        )
        return

    step_node.properties["dep_filter"] = "dobj"

    try:
        await persistence.save_node(step_node)
        _migration_log.info(
            "Migrated parse_transitive patient step: dep_filter '%s' → 'dobj'",
            current_dep,
        )
    except Exception as exc:
        _migration_log.warning(
            "Failed to migrate parse_transitive patient step: %s",
            exc,
        )


async def bootstrap_language_ontology(
    persistence: GraphPersistence,
) -> LanguageBootstrapResult:
    """Bootstrap the complete language ontology (Layers 0-5).

    Creates all linguistic ConceptPrimitive nodes, WordSenseNode nodes,
    WordFormNode nodes, INSTANCE_OF_WORD edges, TRANSFORMS_TO edges,
    morphological ProceduralTemplate / ProcedureStep / WorkedExample nodes,
    syntactic parse template ProceduralTemplate nodes, and the
    disambiguation placeholder for the full language bootstrap. Layers
    are created in dependency order (Layer 0 first through Layer 5 last).

    This function is idempotent. Nodes and edges that already exist are
    counted in the ``*_existing`` fields and not recreated.

    Args:
        persistence: The graph persistence backend to bootstrap.

    Returns:
        A :class:`LanguageBootstrapResult` with creation and existing
        counts for each category.

    Raises:
        BootstrapError: If any node or edge cannot be saved.
    """
    layer0 = await _bootstrap_lang_layer0(persistence)
    layer1 = await _bootstrap_lang_layer1(persistence)
    layer2 = await _bootstrap_lang_layer2(persistence)
    layer3 = await _bootstrap_lang_layer3(persistence)
    layer4 = await _bootstrap_lang_layer4(persistence)
    layer5 = await _bootstrap_lang_layer5(persistence)

    # ------------------------------------------------------------------
    # Migration: fix parse_question_what template step (P1.8 bug fix)
    # ------------------------------------------------------------------
    # The parse_question_what template's nsubj step was originally created
    # as match_optional with no lemma_filter, causing it to match declarative
    # copular sentences like 'A bird is an animal' and steal matches from
    # parse_copular. This migration updates the existing step node to
    # match_edge with a wh-word lemma_filter so it only matches questions.
    await _migrate_question_what_nsubj_step(persistence)

    # ------------------------------------------------------------------
    # Migration: fix parse_intransitive template root step (P1.8 bug fix)
    # ------------------------------------------------------------------
    # The parse_intransitive template had no pos_filter on its root step,
    # causing it to match copular sentences where root POS is AUX instead
    # of VERB. This made copular sentences like 'a cat is an animal' route
    # to parse_intransitive (not a semantic template) instead of
    # parse_copular (a semantic template), so IS_A edges were never created.
    await _migrate_intransitive_root_pos_filter(persistence)

    # ------------------------------------------------------------------
    # Migration: fix parse_transitive dep_filter obj → dobj (P1.8 bug fix)
    # ------------------------------------------------------------------
    # spaCy en_core_web_sm uses "dobj" (not "obj") for direct objects.
    # The parse_transitive template had dep_filter="obj" on its patient
    # step, so transitive sentences like "rain causes floods" never matched.
    await _migrate_transitive_dobj_step(persistence)


    return LanguageBootstrapResult(
        concepts_created=layer0["concepts_created"],
        concepts_existing=layer0["concepts_existing"],
        words_created=layer1["words_created"],
        words_existing=layer1["words_existing"],
        forms_created=layer1["forms_created"] + layer2["forms_created"],
        forms_existing=layer1["forms_existing"] + layer2["forms_existing"],
        irregular_edges_created=layer2["irregular_edges_created"],
        irregular_edges_existing=layer2["irregular_edges_existing"],
        procedures_created=(
            layer3["procedures_created"]
            + layer4["procedures_created"]
            + layer5["procedures_created"]
        ),
        procedures_existing=(
            layer3["procedures_existing"]
            + layer4["procedures_existing"]
            + layer5["procedures_existing"]
        ),
    )


__all__ = [
    "LanguageBootstrapResult",
    "bootstrap_language_ontology",
]
