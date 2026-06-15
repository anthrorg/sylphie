"""Infrastructure adapters for the Co-Being knowledge graph (Layer 3).

This package holds the concrete persistence *adapters* in the ports-and-adapters
architecture. The *ports* (the ``GraphPersistence`` and ``BehavioralStore``
Protocols) live one level up in ``cobeing.layer3_knowledge.protocols``; the
domain depends only on those Protocols, never on anything in this package.

Modules
-------

``neo4j_persistence``
    ``Neo4jGraphPersistence`` -- a Neo4j-backed implementation of the
    ``GraphPersistence`` Protocol. A drop-in alternative to
    ``InMemoryGraphPersistence`` with identical semantics, persisting nodes
    and edges to a real Neo4j instance.

``neo4j_schema``
    ``initialize_schema`` / ``verify_schema`` -- constraint and index setup
    for the Neo4j knowledge graph. Creates the uniqueness constraint on
    ``node_id`` (provenance/integrity discipline, CANON A.11) plus the lookup
    indexes the read path and the semantic-query benchmark rely on.

**Layer placement (CANON):** persistence interfaces are Sentinel's domain;
Forge owns the contract, not the implementation. These adapters are wired in
at the composition root, never imported by domain logic directly.
"""

from __future__ import annotations

from cobeing.layer3_knowledge.infrastructure.neo4j_persistence import (
    Neo4jGraphPersistence,
)
from cobeing.layer3_knowledge.infrastructure.neo4j_schema import (
    initialize_schema,
    verify_schema,
)

__all__ = [
    "Neo4jGraphPersistence",
    "initialize_schema",
    "verify_schema",
]
