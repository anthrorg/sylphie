"""Language layer type constants for the Co-Being Procedural Knowledge Graph.

Defines the node type and edge type string constants used by the language
bootstrap, syntactic template matcher, morphological procedure engine, and
organic language acquisition pipeline.
Analogous to procedure_types.py for the math/procedural domain.

Node types cover five concerns:
  - WordSenseNode (SCHEMA): polysemy-aware word senses
  - WordFormNode (INSTANCE): inflected surface forms
  - ConversationTurnNode (INSTANCE): utterances in context
  - InterpretationNode (INSTANCE): competing parse candidates
  - PhraseNode (INSTANCE): opaque holophrase chunks from guardian speech

Edge types encode the relationships between these nodes and between the
language layer and the existing procedural/concept layer.

Phase 1.7 (Language Foundation). CANON A.18 (TAUGHT_PROCEDURE provenance).
Phase 2 OLA (Organic Language Acquisition). CANON A.26.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Node type string constants
# ---------------------------------------------------------------------------

WORD_SENSE_NODE = "WordSenseNode"
"""SCHEMA-level node: one node per word sense. node_id format: word:{spelling}:{sense_tag}.
Separate nodes for polysemous words (bank:financial vs bank:geographical).
Properties: spelling, part_of_speech, sense_tag, frequency_rank, scope_contexts."""

WORD_FORM_NODE = "WordFormNode"
"""INSTANCE-level node: a specific inflected spelling. Instance of a WordSenseNode.
node_id format: form:{spelling}:{inflection_type}.
Properties: spelling, inflection_type (base/plural/past_tense/present_participle/
comparative/superlative/third_person_singular/past_participle)."""

CONVERSATION_TURN_NODE = "ConversationTurnNode"
"""INSTANCE-level node: a specific utterance in a specific conversation.
node_id format: turn:{session_id}:{sequence_number}.
Properties: session_id, sequence_number, speaker, raw_text, timestamp, parsed, intent_classification."""

INTERPRETATION_NODE = "InterpretationNode"
"""INSTANCE-level node: one interpretation (parse candidate) for an ambiguous turn.
node_id format: interp:{turn_id}:{seq}.
Properties: source_turn_id, template_id, confidence, status, role_bindings."""

WORD_NODE = "WordNode"
"""INSTANCE-level node: a single normalized word token extracted from guardian speech.
node_id format: word:{normalized_text}.
Deduplicated by normalized form — the same word heard across multiple phrases is a
single node with multiple IS_PART_OF edges.

Properties:
    normalized_text (str): Lowercase, punctuation-stripped word.
    encounter_count (int): How many times this word has been heard (across all phrases).
    first_heard (str): ISO 8601.
    last_heard (str): ISO 8601.

Word meaning emerges from IS_PART_OF graph structure (distributional semantics).
No NLP required. CANON A.26."""

PHRASE_NODE = "PhraseNode"
"""INSTANCE-level node: an opaque holophrase chunk heard from the guardian.
node_id format: phrase:{sha256_of_normalized_text_first_12_chars}.

Created by InputParser when the guardian speaks. Comprehension-only until
the consolidation engine creates a CAN_PRODUCE edge (A.26.1).

Properties:
    normalized_text (str): Lowercased, whitespace-collapsed full phrase.
    raw_texts (list[str]): All raw forms heard (preserves casing/punctuation).
        JSON-serialized.
    confidence (float): ACT-R comprehension confidence (decay rate 0.03).
    encounter_count (int): Spaced encounters only (one per maintenance cycle
        or guardian encounter). InputParser NEVER increments this.
    rehearsal_credits (float): Accumulated 0.5x internal rehearsal. When
        >= 1.0, converts to encounter_count increment.
    encoding_strength (float): Computed at creation from pressure vector
        via arousal * novelty * anxiety_penalty (A.24.3.2).
    first_heard (str): ISO 8601.
    last_heard (str): ISO 8601.
    last_retrieved (str|null): ISO 8601. For reconsolidation lability window.
    consolidated (bool): False until first maintenance processing.
    heard_from (str): 'GUARDIAN' (future: other sources).
    provenance (str): 'GUARDIAN' per A.11.
    domain (str): 'LanguageDomain' per A.20.

CANON A.26.2."""

# ---------------------------------------------------------------------------
# Edge type string constants
# ---------------------------------------------------------------------------

SAME_SPELLING = "SAME_SPELLING"
"""SCHEMA edge: WordSenseNode -> WordSenseNode.
Links two senses that share an orthographic form (polysemy). No properties."""

DENOTES = "DENOTES"
"""SCHEMA edge: WordSenseNode -> SchemaType or ConceptPrimitive.
This word sense refers to this concept. Properties: none."""

INSTANCE_OF_WORD = "INSTANCE_OF_WORD"
"""INSTANCE->SCHEMA edge: WordFormNode -> WordSenseNode.
This inflected form is an instance of this word sense.
Named to avoid collision with INSTANCE_OF (ObjectInstance->SchemaType) and
INSTANCE_OF_CONCEPT (ValueNode->ConceptPrimitive)."""

TRANSFORMS_TO = "TRANSFORMS_TO"
"""INSTANCE edge: WordFormNode -> WordFormNode.
Morphological transformation from one form to another.
Properties: transform_type, is_regular (bool), confidence, encounter_count,
guardian_confirmed, source_procedure_id, deprecated, error_count."""

PRECEDES = "PRECEDES"
"""INSTANCE edge: ConversationTurnNode -> ConversationTurnNode.
Temporal chain: earlier turn PRECEDES later turn.
Properties: gap_seconds (float)."""

MENTIONS = "MENTIONS"
"""INSTANCE->SCHEMA edge: ConversationTurnNode -> WordSenseNode or ConceptPrimitive.
This turn references this concept.
Properties: salience (float 0-1), syntactic_role (str: subject/object/oblique/modifier)."""

INTERPRETS = "INTERPRETS"
"""INSTANCE edge: InterpretationNode -> ConversationTurnNode.
This interpretation is a parse of this turn. No properties."""

PRODUCED_BY_TEMPLATE = "PRODUCED_BY_TEMPLATE"
"""INSTANCE->SCHEMA edge: InterpretationNode -> ProceduralTemplate.
Which syntactic template generated this interpretation. No properties."""

COMPETES_WITH = "COMPETES_WITH"
"""INSTANCE edge: InterpretationNode -> InterpretationNode.
These two interpretations are competing parses of the same turn.
Properties: competition_set_id (str)."""

# ---------------------------------------------------------------------------
# Organic Language Acquisition edge types (CANON A.26.3)
# ---------------------------------------------------------------------------

CAN_PRODUCE = "CAN_PRODUCE"
"""SCHEMA-level edge: ActionProcedure(action:speak) -> PhraseNode.
Developmental gate: exists only after consolidation promotes the phrase.
Created by PhraseConsolidator when weighted readiness score >= 1.0 and
encounter_count >= 3 (hard floor).

Properties:
    promoted_at (str): ISO 8601 timestamp of promotion.
    promoted_by (str): 'CONSOLIDATION'.
    encounter_count_at_promotion (int): Encounters when promoted.
    confidence_at_promotion (float): Comprehension confidence at promotion.
    production_confidence (float): Starts 0.0, grows with successful
        production via ACT-R reinforcement.
    production_count (int): Times successfully spoken.
    last_produced (str|null): ISO 8601 of last production.
    discriminative_context (dict): Contextual conditions for appropriate
        use, extracted from HEARD_DURING edge patterns by consolidation.
        Keys: dominant_drive, drive_profile, guardian_present,
        typical_session_position, co_occurring_phrases.
    deprecated_at (str|null): ISO 8601 if revoked.
    deprecated_reason (str|null): Why revoked.

CANON A.26.3."""

HEARD_DURING = "HEARD_DURING"
"""INSTANCE-level edge: PhraseNode -> ConversationTurnNode.
Created on every guardian encounter. Captures encoding context at the
moment the phrase was heard -- the drive state, prediction error, and
environmental context that modulate learning quality.

Properties:
    drive_snapshot (dict): 11-float pressure vector at encoding time.
        JSON-serialized.
    encoding_strength (float): Computed arousal * novelty * anxiety_penalty
        (A.24.3.2).
    prediction_error (float): From A.24 at encoding time.
    session_id (str): Which observation session.
    yolo_co_detections (list[str]|null): Objects visible at encoding time.
        Null until Phase 3 camera integration.

CANON A.26.3."""

IS_PART_OF = "IS_PART_OF"
"""INSTANCE-level edge: WordNode -> PhraseNode.
A word IS_PART_OF a phrase. Created by InputParser during word decomposition.

Properties:
    position (int): 0-indexed position of the word in the phrase.
    heard_count (int): How many times this word was heard in this specific phrase.

Edge direction rationale: IS_PART_OF goes FROM WordNode TO PhraseNode.
- "What phrases contain 'how'?" → follow IS_PART_OF edges outward from word:how
- "What words are in this phrase?" → follow IS_PART_OF edges inward to PhraseNode
- A word's meaning is the set of phrases it participates in (distributional semantics).

CANON A.26."""

SUPERSEDES = "SUPERSEDES"
"""INSTANCE-level edge: PhraseNode -> PhraseNode.
Within-episode correction: later phrase supersedes earlier. Created when
the guardian corrects a phrase immediately after saying it (e.g., "no,
I meant..." pattern). The superseding phrase inherits some encoding
strength from the superseded phrase.

Properties:
    superseded_at (str): ISO 8601 timestamp.
    reason (str): Why the supersession occurred (e.g., 'guardian_correction',
        'self_repair').

CANON A.26.3."""

VARIANT_OF = "VARIANT_OF"
"""INSTANCE-level edge: PhraseNode -> PhraseNode (variant -> canonical).
Links surface variants of the same semantic content. Created during
consolidation when two PhraseNodes share >60% word overlap after
punctuation stripping.

Direction: variant -> canonical. The canonical phrase is the one with
the highest encounter_count in the cluster.

Properties:
    overlap_ratio (float): Word-set overlap between the two phrases.
    cluster_id (str): Shared identifier for the cluster group.
    clustered_at (str): ISO 8601 timestamp of cluster detection.

Created by phrase consolidation clustering pass."""

# ---------------------------------------------------------------------------
# Synaptogenesis edge types (LLM-proposed connections)
# ---------------------------------------------------------------------------

FOLLOWS_PATTERN = "FOLLOWS_PATTERN"
"""INSTANCE-level edge: WordNode -> ConceptPrimitive.
Word tends to appear in a specific positional pattern. Proposed by
synaptogenesis when it detects positional regularity across phrases.
e.g., "the" -> position_0_determiner (always at phrase start).

Properties:
    rationale (str): Why the LLM proposed this connection.
    source_process (str): 'synaptogenesis'.

Created by synaptogenesis only. Entry confidence 0.15."""

USED_DURING = "USED_DURING"
"""INSTANCE-level edge: PhraseNode -> ConceptPrimitive.
Phrase is typically heard during a specific drive state context.
Proposed by synaptogenesis from HEARD_DURING drive_snapshot patterns.
e.g., "it's ok" -> high_anxiety_context.

Properties:
    rationale (str): Why the LLM proposed this connection.
    source_process (str): 'synaptogenesis'.

Created by synaptogenesis only. Entry confidence 0.15."""

RELATED_TO = "RELATED_TO"
"""SCHEMA-level edge: ConceptPrimitive -> ConceptPrimitive.
Abstract relationship between concepts. Proposed by synaptogenesis
when it detects structural similarity between concept clusters.
e.g., greeting -> social_interaction.

Properties:
    rationale (str): Why the LLM proposed this connection.
    source_process (str): 'synaptogenesis'.

Created by synaptogenesis only. Entry confidence 0.15."""

IDENTIFIES_WITH = "IDENTIFIES_WITH"
"""SCHEMA-level edge: ActionProcedure(innate speak act) -> PhraseNode.
**Deferred implementation.** Designed now, created only when consolidation
detects that an innate speech act (e.g., action:speak:hello) matches
an organically heard PhraseNode (e.g., phrase:abc123 for "hello").

This is a developmental milestone -- CB recognizes that its innate cry
and the guardian's word are the same concept. Implementation deferred
per Jim's decision (2026-03-08).

Properties:
    identified_at (str): ISO 8601 timestamp.
    confidence (float): How confident the identification is.
    identification_method (str): How the match was detected
        (e.g., 'text_match', 'drive_effect_similarity').

CANON A.26.3."""

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

__all__ = [
    # Node type constants
    "WORD_SENSE_NODE",
    "WORD_FORM_NODE",
    "CONVERSATION_TURN_NODE",
    "INTERPRETATION_NODE",
    "WORD_NODE",
    "PHRASE_NODE",
    # Edge type constants
    "SAME_SPELLING",
    "DENOTES",
    "INSTANCE_OF_WORD",
    "TRANSFORMS_TO",
    "PRECEDES",
    "MENTIONS",
    "INTERPRETS",
    "PRODUCED_BY_TEMPLATE",
    "COMPETES_WITH",
    # OLA edge type constants (A.26.3)
    "CAN_PRODUCE",
    "HEARD_DURING",
    "IS_PART_OF",
    "SUPERSEDES",
    "VARIANT_OF",
    "IDENTIFIES_WITH",
    # Synaptogenesis edge type constants
    "FOLLOWS_PATTERN",
    "USED_DURING",
    "RELATED_TO",
]
