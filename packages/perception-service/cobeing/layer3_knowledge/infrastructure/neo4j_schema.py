"""Neo4j schema setup for the Co-Being knowledge graph.

This module creates the constraints and indexes that the Neo4j-backed
knowledge graph depends on, and provides a verification helper used by
readiness checks.

**What it creates**

1. A uniqueness constraint on ``(:KnowledgeNode {node_id})``. Every node in
   the graph carries a globally-unique ``node_id``; the constraint enforces
   that invariant at the storage layer and gives us O(1) MERGE-by-id (the
   upsert path used by :meth:`Neo4jGraphPersistence.save_node`).
2. Lookup indexes on the node fields the read/query path filters on:
   ``node_type``, ``schema_level``, ``status``, ``valid_from``, and
   ``provenance_source`` (the last is used by the skill-reset operations).
3. The semantic relationship-property indexes (``sem_*``) on the ``IS_A`` and
   ``HAS_PROPERTY`` edge types that the semantic-query benchmark (P1.8-E2 /
   T007) measures. ``cobeing.layer3_knowledge.semantic_query_benchmark`` calls
   :func:`initialize_schema` directly, so these must exist here.

**Sync vs async**

``initialize_schema`` and ``verify_schema`` accept a *synchronous*
``neo4j.Session`` because their existing caller (the benchmark) opens a sync
session, and because constraint/index creation is a one-shot setup step rather
than a hot path. :class:`Neo4jGraphPersistence` runs them via the sync driver
it already holds for skill-reset compatibility (see that class for why both a
sync and an async driver are kept).

All statements are idempotent (``IF NOT EXISTS`` / ``IF EXISTS``) so repeated
initialization is safe.

See Also:
    - ``cobeing.layer3_knowledge.infrastructure.neo4j_persistence`` -- the adapter.
    - ``cobeing.layer3_knowledge.exceptions`` -- ``SchemaNotInitializedError``.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from cobeing.layer3_knowledge.exceptions import SchemaNotInitializedError

if TYPE_CHECKING:
    import neo4j

_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Schema definitions
# ---------------------------------------------------------------------------

#: The single label every knowledge-graph node carries in addition to its
#: ``node_type``-derived secondary label. ``node_id`` uniqueness is enforced
#: against this label.
NODE_LABEL = "KnowledgeNode"

#: Name of the ``node_id`` uniqueness constraint.
NODE_ID_CONSTRAINT = "kn_node_id_unique"

#: Core node-property indexes: (index_name, property). These back the
#: ``query_nodes`` / read-query filter paths and the skill-reset provenance
#: scans.
_CORE_NODE_INDEXES: tuple[tuple[str, str], ...] = (
    ("kn_node_type_idx", "node_type"),
    ("kn_schema_level_idx", "schema_level"),
    ("kn_status_idx", "status"),
    ("kn_valid_from_idx", "valid_from"),
    ("kn_provenance_source_idx", "provenance_source"),
)

#: Semantic relationship-property indexes the benchmark (P1.8-E2/T007) relies
#: on: (index_name, relationship_type, property). Named ``sem_*`` so the
#: benchmark's ``_drop_semantic_indexes`` can find and drop them.
_SEMANTIC_REL_INDEXES: tuple[tuple[str, str, str], ...] = (
    ("sem_is_a_scope_context_count", "IS_A", "prop_scope_context_count"),
    ("sem_is_a_confidence", "IS_A", "confidence"),
    ("sem_is_a_valid_to", "IS_A", "valid_to"),
    ("sem_has_property_property_type", "HAS_PROPERTY", "prop_property_type"),
    ("sem_has_property_confidence", "HAS_PROPERTY", "confidence"),
    ("sem_has_property_valid_to", "HAS_PROPERTY", "valid_to"),
)


# ---------------------------------------------------------------------------
# Initialization
# ---------------------------------------------------------------------------


def initialize_schema(session: "neo4j.Session") -> None:
    """Create the knowledge-graph constraints and indexes (idempotent).

    Runs all statements with ``IF NOT EXISTS`` so calling this on an
    already-initialized database is a no-op. Safe to call on every startup.

    Args:
        session: An open *synchronous* ``neo4j.Session``. The caller owns the
            session lifecycle.
    """
    # 1. node_id uniqueness constraint (also provides the MERGE-by-id index).
    session.run(
        f"CREATE CONSTRAINT {NODE_ID_CONSTRAINT} IF NOT EXISTS "
        f"FOR (n:{NODE_LABEL}) REQUIRE n.node_id IS UNIQUE"
    )

    # 2. Core node-property lookup indexes.
    for index_name, prop in _CORE_NODE_INDEXES:
        session.run(
            f"CREATE INDEX {index_name} IF NOT EXISTS "
            f"FOR (n:{NODE_LABEL}) ON (n.{prop})"
        )

    # 3. Semantic relationship-property indexes (benchmark / semantic queries).
    for index_name, rel_type, prop in _SEMANTIC_REL_INDEXES:
        session.run(
            f"CREATE INDEX {index_name} IF NOT EXISTS "
            f"FOR ()-[r:{rel_type}]-() ON (r.{prop})"
        )

    _log.info(
        "Neo4j knowledge-graph schema initialized: 1 constraint, "
        "%d node indexes, %d semantic relationship indexes",
        len(_CORE_NODE_INDEXES),
        len(_SEMANTIC_REL_INDEXES),
    )


def verify_schema(session: "neo4j.Session") -> None:
    """Verify that the required constraint and core node indexes exist.

    Checks for the ``node_id`` uniqueness constraint and the core node
    indexes. The semantic relationship indexes are intentionally *not*
    required here -- the benchmark drops and recreates them at will, so their
    absence is not an error for general knowledge-graph operation.

    Args:
        session: An open *synchronous* ``neo4j.Session``.

    Raises:
        SchemaNotInitializedError: If the constraint or any core index is
            missing.
    """
    constraint_names = {
        record["name"]
        for record in session.run("SHOW CONSTRAINTS YIELD name RETURN name")
    }
    index_names = {
        record["name"]
        for record in session.run("SHOW INDEXES YIELD name RETURN name")
    }

    missing_constraints = (
        [NODE_ID_CONSTRAINT]
        if NODE_ID_CONSTRAINT not in constraint_names
        else []
    )
    missing_indexes = [
        index_name
        for index_name, _prop in _CORE_NODE_INDEXES
        if index_name not in index_names
    ]

    if missing_constraints or missing_indexes:
        raise SchemaNotInitializedError(
            missing_constraints=missing_constraints,
            missing_indexes=missing_indexes,
        )


__all__ = [
    "NODE_ID_CONSTRAINT",
    "NODE_LABEL",
    "initialize_schema",
    "verify_schema",
]
