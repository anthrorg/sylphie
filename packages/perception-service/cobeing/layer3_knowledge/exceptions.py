"""Layer 3 knowledge graph exceptions.

Every exception in this module inherits from ``KnowledgeGraphError``, which
itself inherits from ``CoBeingError``. This allows callers to catch at the
granularity they need:

- ``CoBeingError`` catches everything application-level.
- ``KnowledgeGraphError`` catches any Layer 3 failure.
- A specific subclass (e.g., ``NodeNotFoundError``) catches one failure mode.

Usage::

    from cobeing.layer3_knowledge.exceptions import (
        NodeNotFoundError,
        SchemaViolationError,
        SimilarityError,
        ExpectationError,
    )

    try:
        node = graph.get_node(node_id, required=True)
    except NodeNotFoundError as exc:
        logger.warning("Node %s not found: %s", exc.node_id, exc)

    try:
        result = compute_similarity(source, target)
    except SimilarityError as exc:
        logger.error("Similarity computation failed: %s", exc)
"""

from __future__ import annotations

from cobeing.shared.exceptions import CoBeingError


class KnowledgeGraphError(CoBeingError):
    """Base exception for all Layer 3 (knowledge graph) errors.

    All knowledge-graph-specific exceptions inherit from this. Catching
    ``KnowledgeGraphError`` catches any graph-layer failure without
    catching errors from other layers.
    """


class NodeNotFoundError(KnowledgeGraphError):
    """Raised when a node lookup fails to find the requested node.

    Attributes:
        node_id: The identifier that was looked up but not found.
    """

    def __init__(self, node_id: str) -> None:
        self.node_id = node_id
        super().__init__(f"Node not found: {node_id}")


class EdgeNotFoundError(KnowledgeGraphError):
    """Raised when an edge lookup fails to find the requested edge.

    Attributes:
        edge_id: The identifier that was looked up but not found.
    """

    def __init__(self, edge_id: str) -> None:
        self.edge_id = edge_id
        super().__init__(f"Edge not found: {edge_id}")


class SchemaViolationError(KnowledgeGraphError):
    """Raised when a graph operation would violate a schema invariant.

    Examples of invariants that can be violated:

    - Adding an INSTANCE_OF edge where the target is not a SCHEMA-level node.
    - Creating a node at META_SCHEMA level without INFERENCE provenance.
    - Attempting to modify a frozen bootstrap rule.

    Attributes:
        invariant: Short identifier for which invariant was violated.
        detail: Human-readable explanation of the violation.
    """

    def __init__(self, invariant: str, detail: str) -> None:
        self.invariant = invariant
        self.detail = detail
        super().__init__(f"Schema violation [{invariant}]: {detail}")


class BootstrapError(KnowledgeGraphError):
    """Raised when the graph bootstrap sequence fails.

    The bootstrap sequence creates the initial META_SCHEMA nodes
    (EvolutionRules) required by CANON A.2. If these cannot be created
    -- for example because the database is in an inconsistent state or
    the bootstrap data is invalid -- the system cannot start.

    Attributes:
        detail: Human-readable explanation of what went wrong.
    """

    def __init__(self, detail: str) -> None:
        self.detail = detail
        super().__init__(f"Bootstrap failed: {detail}")


class SchemaNotInitializedError(KnowledgeGraphError):
    """Raised when the Neo4j database schema has not been initialized.

    The Co-Being knowledge graph requires constraints and indexes to enforce
    provenance (CANON A.11) and ensure data integrity. This exception is
    raised by ``verify_schema()`` when required constraints or indexes are
    missing from the database, indicating that ``initialize_schema()`` has
    not been run.

    Attributes:
        missing_constraints: Names of constraints that were expected but not found.
        missing_indexes: Names of indexes that were expected but not found.
    """

    def __init__(
        self,
        missing_constraints: list[str],
        missing_indexes: list[str],
    ) -> None:
        self.missing_constraints = missing_constraints
        self.missing_indexes = missing_indexes
        parts: list[str] = []
        if missing_constraints:
            parts.append(f"missing constraints: {', '.join(missing_constraints)}")
        if missing_indexes:
            parts.append(f"missing indexes: {', '.join(missing_indexes)}")
        detail = "; ".join(parts) if parts else "unknown schema issue"
        super().__init__(
            f"Schema not initialized: {detail}. "
            f"Run initialize_schema() before using the knowledge graph."
        )


class MigrationChecksumError(KnowledgeGraphError):
    """Raised when a previously-applied migration's checksum does not match.

    This indicates the migration's ``up`` Cypher was modified after it was
    applied to the database. Modifying an applied migration is dangerous
    because the database state no longer matches what the migration file
    describes. The runner refuses to proceed to protect data integrity.

    Attributes:
        version: The migration version number with the mismatch.
        expected_checksum: The SHA256 hex digest stored in the ``_Migration``
            node (i.e., what was applied to the database).
        actual_checksum: The SHA256 hex digest computed from the current
            migration's ``up`` field (i.e., what the file contains now).
    """

    def __init__(self, version: int, expected: str, actual: str) -> None:
        self.version = version
        self.expected_checksum = expected
        self.actual_checksum = actual
        super().__init__(
            f"Migration v{version} checksum mismatch: "
            f"stored={expected!r} but current={actual!r}. "
            f"The migration's 'up' Cypher was modified after it was applied. "
            f"Reverting the modification or rolling back the database is required."
        )


class SimilarityError(KnowledgeGraphError):
    """Raised when similarity computation fails.

    This exception covers failures in the Epic 4 similarity pipeline:
    embedding vectors missing from nodes, dimension mismatches between
    vectors being compared, or any other condition that prevents a valid
    similarity score from being produced.

    Callers that catch ``SimilarityError`` should treat the affected node
    pair as unscored for this computation cycle. The graph is not corrupted;
    no SIMILAR_TO edge is created for the failing pair.

    Example::

        try:
            result = compute_similarity(source_node, target_node)
        except SimilarityError as exc:
            logger.warning("Skipping similarity for pair: %s", exc)
    """


class ExpectationError(KnowledgeGraphError):
    """Raised when expectation operations fail.

    This exception covers failures in the Epic 4 expectation verification
    pipeline: missing PropertyExpectation nodes, malformed statistical
    parameters (e.g., negative standard deviation), or any condition that
    prevents a valid comparison between an observed value and its expected
    range.

    Callers that catch ``ExpectationError`` should treat the affected
    expectation as unverified for this observation cycle. The graph is not
    corrupted; no confidence update is applied to the failing expectation.

    Example::

        try:
            verify_expectations(instance_node, schema_type_node)
        except ExpectationError as exc:
            logger.warning("Expectation check skipped: %s", exc)
    """


__all__ = [
    "BootstrapError",
    "EdgeNotFoundError",
    "ExpectationError",
    "KnowledgeGraphError",
    "MigrationChecksumError",
    "NodeNotFoundError",
    "SchemaNotInitializedError",
    "SchemaViolationError",
    "SimilarityError",
]
