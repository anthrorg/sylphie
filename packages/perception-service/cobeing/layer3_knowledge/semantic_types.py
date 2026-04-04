"""Semantic domain type constants for the Co-Being knowledge graph.

Defines node type and edge type string constants for the SemanticDomain --
the fourth knowledge domain introduced in Phase 1.8, alongside MathDomain,
LanguageDomain, and AbstractDomain (CANON A.20).

SemanticDomain stores declarative semantic knowledge: taxonomic, causal,
spatial, and functional relationships between real-world concepts. All
semantic world knowledge (IS_A facts, HAS_PROPERTY assertions, causal
relationships) is earned through guardian teaching and sensor observation
per CANON A.1. Zero semantic facts are pre-loaded.

The 17 edge type constants map directly to the SemanticEdgeType vocabulary
nodes installed by the semantic-ontology skill package (T001). Each constant
is the string value stored in the ``edge_type`` property of Neo4j edges.

DENOTES is the cross-domain bridge between LanguageDomain and SemanticDomain.
Its constant is defined in language_types.py and re-exported here so callers
only need to import from one module. It is not redefined (D4 from the
semantic-ontology decisions).

Phase 1.8 (Comprehension Layer). CANON A.18 (TAUGHT_PROCEDURE provenance),
A.20 (Domain Structure), A.21 (Skill Package System).
"""

from __future__ import annotations

from cobeing.layer3_knowledge.language_types import DENOTES

# ---------------------------------------------------------------------------
# Node type string constants
# ---------------------------------------------------------------------------

CONVERSATION_CONTEXT = "ConversationContext"
"""INSTANCE-level node: active conversational context frame for a session.

Tracks the current topic, active entities under discussion, and the
discourse state that disambiguation and semantic resolution procedures
use to resolve reference and scope. One ConversationContext per active
session; archived (status=CLOSED) at session end.

node_id format: context:{session_id}.
Properties: session_id, active_entity_ids (list), topic_node_id (optional),
discourse_state, status, created_at, updated_at."""

SEMANTIC_EDGE_TYPE = "SemanticEdgeType"
"""SCHEMA-level node: vocabulary entry for one semantic relationship type.

One node per relationship type (IS_A, HAS_PROPERTY, CAUSES, etc.).
Installed by the semantic-ontology skill package. Carries the name,
description, symmetry flag, processing tier, and usage count for the
edge type.

node_id format: semantic:edge_type:{NAME}."""

LOGICAL_AXIOM = "LogicalAxiom"
"""META-SCHEMA-level node: a structural rule governing how semantic edge
types behave at query time (transitivity) or write time (asymmetry).

Four logical axioms are installed by the semantic-ontology skill package:
IS_A transitivity, IS_A asymmetry, CAUSES asymmetry, PART_OF transitivity.
These govern inference and contradiction detection -- they are structural
rules, not world knowledge.

node_id format: axiom:{EDGE_TYPE}:{rule_type}."""

DOMAIN_REGISTRATION = "DomainRegistration"
"""META-SCHEMA-level node: the formal registration of a knowledge domain.

Required per CANON A.20.5(a): every knowledge domain must have an
explicit DomainRegistration node with a label-based namespace declaration.
The SemanticDomain node_id is 'domain:semantic'.

Properties: domain_name, display_name, description, status,
install_timestamp, minimum_edge_count_before_monitoring, domain_label_prefix."""

# ---------------------------------------------------------------------------
# Semantic edge type string constants
# ---------------------------------------------------------------------------
# Grouped by the four functional clusters in the semantic-ontology.yaml:
#   1. Taxonomic and property types
#   2. Mereological and spatial types
#   3. Functional and purpose types
#   4. Causal and conditional types
#   5. Action-schema types (procedural memory adjacents)
#   6. Epistemic and semantic opposition types
#   7. Cross-domain bridge (DENOTES, re-exported from language_types)

# --- 1. Taxonomic and property types ---

IS_A = "IS_A"
"""Taxonomic subsumption: the subject is an instance or subtype of the object.

Governed by IS_A transitivity (query-time, 5% confidence degradation per hop)
and IS_A asymmetry (write-time, contradiction detector fires on cycle).

Asymmetric. Processing tier: fast.

Example: cat IS_A animal, robin IS_A bird."""

HAS_PROPERTY = "HAS_PROPERTY"
"""Asserts that an entity possesses a property or attribute.

Edge instances (created in E2 by guardian teaching) carry a property_type
field with one of three values: 'sensory', 'functional', 'categorical'.
These reflect the three biologically distinct processing streams in Luria's
neuropsychological model (Binder et al., 2009).

Asymmetric. Processing tier: fast.

Example: apple HAS_PROPERTY (color=red, property_type=sensory)."""

LACKS_PROPERTY = "LACKS_PROPERTY"
"""Explicit negation: the subject definitively does not possess this property.

Required by the Open World Assumption (CANON A.1): absence in the graph means
unknown, not false. LACKS_PROPERTY is the only way to record a confirmed
negative assertion. Distinct from the absence of a HAS_PROPERTY edge.

Asymmetric. Processing tier: moderate.

Example: penguin LACKS_PROPERTY (property=can_fly)."""

# --- 2. Mereological and spatial types ---

PART_OF = "PART_OF"
"""Mereological containment: the subject is a structural component of the object.

Governed by PART_OF transitivity (query-time, 15% confidence degradation per
hop, more aggressive than IS_A because biological PART_OF transitivity is
context-dependent). Both constituent edges must have scope_context_count >= 2
before automatic transitivity is applied.

Asymmetric. Processing tier: moderate.

Example: wheel PART_OF car, door PART_OF house."""

LOCATED_IN = "LOCATED_IN"
"""Spatial containment: the subject is physically or functionally located within
the object.

A thematic relation (co-occurrence based) processed in posterior middle
temporal gyrus -- anatomically distinct from taxonomic IS_A relations in
anterior temporal cortex (Schwartz et al., 2011). All spatial location
knowledge must come from sensor observations or guardian teaching per CANON A.1.

Asymmetric. Processing tier: fast.

Example: Paris LOCATED_IN France."""

# --- 3. Functional and purpose types ---

USED_FOR = "USED_FOR"
"""Functional purpose: the subject serves the stated purpose or use.

A thematic relation (co-occurrence based) processed in posterior middle
temporal gyrus. Distinct from ACHIEVES (which encodes what a process
accomplishes) -- USED_FOR is about the artifact-to-purpose association,
not an action outcome.

Asymmetric. Processing tier: fast.

Example: hammer USED_FOR driving_nails."""

# --- 4. Causal and conditional types ---

CAUSES = "CAUSES"
"""Sufficient causation: the subject brings about the object.

Governed by CAUSES asymmetry (write-time: prevents circular causal graphs).
Causal chain transitivity is NOT applied automatically -- causal chains
require deliberative inner monologue reasoning per Luria Section 3
(processing_tier: deliberative). Humans are poor at transitive causal
reasoning beyond two steps (Sloman, 2005). E5 inner monologue handles
multi-step causal chain reasoning.

Asymmetric. Processing tier: deliberative.

Example: fire CAUSES heat."""

ENABLES = "ENABLES"
"""Necessary but not sufficient condition: the subject makes the object possible
without directly causing it.

Weaker than CAUSES (sufficient causation). Example: having a key enables
opening a lock, but does not cause the lock to open. Processed within the
causal reasoning network (right lateral prefrontal, right TPJ) alongside
CAUSES and PREVENTS (Barbey & Patterson, 2011).

Asymmetric. Processing tier: deliberative.

Example: having_fuel ENABLES engine_running."""

PREVENTS = "PREVENTS"
"""Negative causal blocking: the subject makes the object impossible or
significantly less likely.

Semantic inverse of ENABLES within the causal schema network. Processed
in the causal reasoning network alongside CAUSES and ENABLES.

Asymmetric. Processing tier: deliberative.

Example: firewall PREVENTS unauthorized_access."""

# --- 5. Action-schema types (procedural memory adjacents) ---

REQUIRES = "REQUIRES"
"""Prerequisite relation: the subject cannot be achieved or executed without
the object first being satisfied.

Primary edge type for backward chaining in goal decomposition (E4).
Distinct from ENABLES (enabling condition) -- REQUIRES is a necessary
precondition that must be satisfied, not merely facilitated. Processed in
frontal-parietal action planning network (Schank & Abelson, 1977).

Asymmetric. Processing tier: deliberative.

Example: building_a_house REQUIRES having_a_foundation."""

ACHIEVES = "ACHIEVES"
"""Functional output of an action or process: the subject accomplishes the
stated goal or outcome.

Paired with REQUIRES for backward chaining: knowing what an action ACHIEVES
lets the system reason about which action to take given a goal. Processed in
frontal-parietal action planning network.

Asymmetric. Processing tier: deliberative.

Example: studying ACHIEVES passing_exam."""

PRODUCES = "PRODUCES"
"""Generative output: the subject generates, creates, or yields the object as
output.

Distinct from ACHIEVES (goal-directed accomplishment) -- PRODUCES is about
the generative outputs of processes, not goal satisfaction. Processed in
frontal-parietal action schema network.

Asymmetric. Processing tier: moderate.

Example: tree PRODUCES oxygen."""

CONSUMES = "CONSUMES"
"""Resource consumption: the subject uses up or depletes the object in the
course of its operation or existence.

Semantic inverse of PRODUCES within resource-flow schemas. Together PRODUCES
and CONSUMES model the input-output structure of physical processes.

Asymmetric. Processing tier: moderate.

Example: fire CONSUMES oxygen."""

# --- 6. Epistemic and semantic opposition types ---

CONTRADICTS = "CONTRADICTS"
"""Semantic contradiction: the subject and object cannot both be true of the
same entity at the same time.

Symmetric (if A contradicts B, B contradicts A). Activates anterior cingulate
cortex and dorsolateral prefrontal cortex for conflict detection (Botvinick
et al., 2001). Used by the E2 contradiction detector to flag conflicts in the
semantic graph.

Distinct from OPPOSITE_OF (antonymy between concepts) -- CONTRADICTS applies
to semantic assertions, not to the concepts themselves.

Symmetric. Processing tier: deliberative.

Example: assertion('cat is an animal') CONTRADICTS assertion('cat is not alive')."""

SIMILAR_TO = "SIMILAR_TO"
"""Analogical similarity: the subject shares significant properties or structural
features with the object without being in an IS_A relationship.

Processed in angular gyrus (inferior parietal lobe) as a cross-modal
convergence computation (Binder et al., 2009). Distinct from IS_A
(categorical membership) and HAS_PROPERTY (feature attribution). Enables
analogical reasoning once the semantic graph is sufficiently populated.

Symmetric. Processing tier: moderate.

Example: dolphin SIMILAR_TO fish."""

OPPOSITE_OF = "OPPOSITE_OF"
"""Antonymy: the subject and object occupy opposite ends of a semantic dimension.

Processed in angular gyrus alongside SIMILAR_TO (Binder et al., 2009).
Distinct from CONTRADICTS (which applies to assertions about entities, not to
the entities or properties themselves).

Symmetric. Processing tier: moderate.

Example: hot OPPOSITE_OF cold."""

# --- 7. Cross-domain bridge (defined in language_types, re-exported here) ---

# DENOTES is imported from language_types.DENOTES above.
# Re-exported in __all__ so callers can import all semantic edge types from
# this single module without also importing language_types directly.
#
# DENOTES -- cross-domain bridge: a WordSenseNode in LanguageDomain refers to
# a concept node in SemanticDomain. Implements the angular gyrus convergence
# zone (Damasio, 1989; Binder & Desai, 2011): binding linguistic form to
# meaning. The edge constant is language_types.DENOTES; it is not redefined
# here (D4 from decisions.md, A.20 cross-domain bridge declaration in
# semantic-ontology.yaml).

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

__all__ = [
    # Node type constants
    "CONVERSATION_CONTEXT",
    "SEMANTIC_EDGE_TYPE",
    "LOGICAL_AXIOM",
    "DOMAIN_REGISTRATION",
    # Edge type constants — taxonomic and property
    "IS_A",
    "HAS_PROPERTY",
    "LACKS_PROPERTY",
    # Edge type constants — mereological and spatial
    "PART_OF",
    "LOCATED_IN",
    # Edge type constants — functional and purpose
    "USED_FOR",
    # Edge type constants — causal and conditional
    "CAUSES",
    "ENABLES",
    "PREVENTS",
    # Edge type constants — action-schema
    "REQUIRES",
    "ACHIEVES",
    "PRODUCES",
    "CONSUMES",
    # Edge type constants — epistemic and semantic opposition
    "CONTRADICTS",
    "SIMILAR_TO",
    "OPPOSITE_OF",
    # Edge type constants — cross-domain bridge (re-exported from language_types)
    "DENOTES",
]
