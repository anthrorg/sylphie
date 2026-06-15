"""Neo4j-backed implementation of the ``GraphPersistence`` Protocol.

``Neo4jGraphPersistence`` is a drop-in alternative to
``InMemoryGraphPersistence``: same Protocol surface, same method semantics,
same return types and provenance discipline -- but persisted to a real Neo4j
instance instead of process-local dicts. Every behaviour documented on the
``GraphPersistence`` Protocol and exhibited by the in-memory reference is
reproduced here against Neo4j storage.

Wire format (mirrors the convention used across ``layer3_knowledge`` and the
hard contract in ``skill_reset.py``)
-------------------------------------------------------------------------------

A :class:`~cobeing.layer3_knowledge.node_types.KnowledgeNode` is stored as a
node carrying:

* the base label ``:KnowledgeNode`` (``node_id`` uniqueness is enforced here),
* a secondary label derived from ``node_type`` (e.g. ``:VisualObject``,
  ``:Person``, ``:FaceSnapshot``) so label-scoped queries -- and the KG
  three-graph isolation invariant -- can be expressed and asserted,
* the structural columns ``node_id``, ``node_type``, ``schema_level``,
  ``confidence``, ``status``, ``created_at``, ``valid_from``, ``valid_to``,
  ``last_confirmed``, ``confirmation_count``, ``prediction_errors``,
* the flattened provenance columns ``provenance_source`` (the lowercase
  ``ProvenanceSource`` value, e.g. ``'sensor'`` -- matching ``skill_reset``),
  ``provenance_source_id``, ``provenance_confidence``, ``provenance_timestamp``,
* every ``properties[k] = v`` flattened to a ``prop_<k>`` column (CANON
  Standard 4 -- provenance is *always* present and never collapsed into the
  free-form property bag).

A :class:`~cobeing.layer3_knowledge.node_types.KnowledgeEdge` is stored as a
relationship of type ``KNOWLEDGE_EDGE`` between the two ``:KnowledgeNode``
endpoints (matched by ``node_id``), carrying the analogous structural,
provenance, and ``prop_<k>`` columns. A homogeneous secondary signal,
``edge_type``, is stored as a column (Neo4j relationship *types* cannot be
parameterized at MERGE time without APOC, and the domain treats ``edge_type``
as data, not topology). The ``SIMILAR_TO`` / ``INSTANCE_OF`` / ``IS_A`` etc.
*relationship type* is ALSO applied as the Neo4j relationship type so the
semantic-query and skill-reset Cypher (which match on ``[:IS_A]`` etc.) keep
working.

Nested values
-------------
Neo4j node/relationship properties may only be primitives or *homogeneous*
arrays of primitives. A ``bounding_box`` (list-of-lists), a nested dict, or any
mixed-type list therefore cannot be stored as-is -- exactly the same
constraint the NestJS side hits. Such values are **JSON-encoded to a string**
on write and decoded on read; the keys that were JSON-encoded are recorded in
the array column ``prop__json_keys`` so the reader knows which ``prop_<k>``
strings to ``json.loads``. Plain ``list[float]`` embeddings are stored
natively as a Neo4j array (no JSON round-trip) so vector reads stay cheap.

Similarity search
-----------------
This deployment runs Neo4j **Community Edition**, which has no native vector
index. ``find_similar_nodes`` / ``find_nodes_by_embedding`` therefore fetch a
candidate shortlist by label / schema level, then compute **cosine similarity
in Python** over the shortlist -- the same approach as the in-memory backend
(``_cosine_similarity`` is imported from it so the maths is byte-identical).

Sync + async drivers
---------------------
The Protocol is fully async, so an :class:`neo4j.AsyncGraphDatabase` driver
(``self._adriver``) backs every Protocol method. ``skill_reset.py`` however
reaches into ``persistence._driver`` and uses the *synchronous* session API
(``with driver.session() as session: session.execute_write(...)``). To honour
that existing contract without re-writing skill-reset, this class also opens a
synchronous :class:`neo4j.GraphDatabase` driver exposed as ``self._driver``,
pointed at the same instance. ``close()`` closes both.

This class is NOT live-wired anywhere: the running stack binds Neo4j
NestJS-side via ``Neo4jService``; the Python A.5 path remains a reference spec
(vision build plan §9.3.2). It exists to (a) satisfy the
``skill_reset`` import contract and (b) be exercised class-correct + seeded
round-trip + KG-isolation under test.

See Also:
    - ``cobeing.layer3_knowledge.protocols`` -- the Protocol contract.
    - ``cobeing.layer3_knowledge.in_memory_persistence`` -- the reference impl.
    - ``cobeing.layer3_knowledge.infrastructure.neo4j_schema`` -- schema setup.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any

import neo4j

from cobeing.layer3_knowledge.exceptions import KnowledgeGraphError
from cobeing.layer3_knowledge.expectation_types import (
    PropertyExpectation,
    SimilarityCluster,
)
from cobeing.layer3_knowledge.in_memory_persistence import (
    InMemoryGraphPersistence,
    _cosine_similarity,
    _new_edge_id,
    _new_node_id,
)
from cobeing.layer3_knowledge.infrastructure.neo4j_schema import (
    NODE_LABEL,
    initialize_schema,
    verify_schema,
)
from cobeing.layer3_knowledge.node_types import (
    KnowledgeEdge,
    KnowledgeNode,
    NodeStatus,
    SchemaLevel,
)
from cobeing.layer3_knowledge.query_types import EdgeFilter, NodeFilter, TemporalWindow
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.time_utils import utc_now
from cobeing.shared.types import EdgeId, NodeId

_log = logging.getLogger(__name__)

# Property-bag flattening prefix. ``properties["color"] -> prop_color`` etc.
# Matches the ``prop_*`` convention used throughout ``layer3_knowledge``
# (e.g. ``prop_installed_by_skill`` in ``skill_reset.py``).
_PROP_PREFIX = "prop_"

# Array column recording which ``prop_<k>`` values were JSON-encoded on write
# (and must be ``json.loads``-decoded on read).
_JSON_KEYS_COLUMN = "prop__json_keys"

# The Neo4j relationship type used when an edge's ``edge_type`` is not a clean
# Cypher identifier. Concrete edge_types that ARE clean identifiers (INSTANCE_OF,
# SIMILAR_TO, IS_A, HAS_PROPERTY, ...) are used directly as the relationship
# type so existing semantic / skill-reset Cypher continues to match.
_GENERIC_REL_TYPE = "KNOWLEDGE_EDGE"


def _is_clean_rel_type(edge_type: str) -> bool:
    """Return True if ``edge_type`` is a safe bare Cypher relationship type.

    Neo4j relationship types cannot be parameterized in MERGE/CREATE, so we
    only inline an ``edge_type`` as the relationship type when it is a plain
    ``[A-Z_][A-Z0-9_]*`` token. Anything else falls back to the generic
    ``KNOWLEDGE_EDGE`` type (the ``edge_type`` is still stored as a column).
    """
    if not edge_type:
        return False
    return edge_type.replace("_", "").isalnum() and not edge_type[0].isdigit()


def _secondary_label(node_type: str) -> str | None:
    """Return a safe Neo4j secondary label derived from ``node_type``.

    Returns ``None`` if ``node_type`` is not a clean label token, in which
    case only the base ``:KnowledgeNode`` label is applied (the ``node_type``
    is still stored as a column either way).
    """
    if not node_type:
        return None
    if node_type.replace("_", "").isalnum() and not node_type[0].isdigit():
        return node_type
    return None


def _encode_value(value: Any) -> tuple[Any, bool]:
    """Encode one property value for Neo4j storage.

    Returns ``(stored_value, was_json_encoded)``. Primitives and homogeneous
    primitive arrays pass through untouched; everything else (nested dicts,
    lists-of-lists such as ``bounding_box``, mixed-type lists) is JSON-encoded
    to a string.
    """
    if value is None or isinstance(value, (str, bool, int, float)):
        return value, False

    if isinstance(value, list):
        # Neo4j arrays must be homogeneous primitives. A list of scalars
        # (e.g. an embedding) stores natively; anything else is JSON.
        if all(isinstance(item, (str, bool, int, float)) for item in value):
            # Guard against mixed bool/number, which Neo4j rejects: bool is a
            # subclass of int, so an all-bool or all-number list is fine, but a
            # list mixing them is not. Normalise by checking the concrete set
            # of primitive base types present.
            base_types = {
                bool if isinstance(item, bool) else type(item) for item in value
            }
            # Treat int/float as compatible; bool must stand alone.
            numeric = base_types - {bool}
            if numeric and bool in base_types:
                return json.dumps(value), True
            return value, False
        return json.dumps(value), True

    # dict, tuple, set, or any other structure -> JSON.
    return json.dumps(value, default=str), True


def _node_to_storage(node: KnowledgeNode) -> dict[str, Any]:
    """Flatten a ``KnowledgeNode`` into a Neo4j property map.

    The returned dict is passed straight to a parameterized ``SET n += $props``.
    Provenance is always present (CANON Standard 4). Property-bag keys are
    flattened under the ``prop_`` prefix; nested values are JSON-encoded and
    their keys recorded in :data:`_JSON_KEYS_COLUMN`.
    """
    props: dict[str, Any] = {
        "node_id": str(node.node_id),
        "node_type": node.node_type,
        "schema_level": str(node.schema_level.value),
        "confidence": node.confidence,
        "status": str(node.status.value),
        "created_at": node.created_at.isoformat(),
        "valid_from": node.valid_from.isoformat(),
        "valid_to": node.valid_to.isoformat() if node.valid_to is not None else None,
        "last_confirmed": (
            node.last_confirmed.isoformat()
            if node.last_confirmed is not None
            else None
        ),
        "confirmation_count": node.confirmation_count,
        "prediction_errors": node.prediction_errors,
        # Flattened provenance (CANON A.11 / Standard 4).
        "provenance_source": str(node.provenance.source.value),
        "provenance_source_id": node.provenance.source_id,
        "provenance_confidence": node.provenance.confidence,
        "provenance_timestamp": node.provenance.timestamp.isoformat(),
    }

    json_keys: list[str] = []
    for key, value in node.properties.items():
        stored, was_json = _encode_value(value)
        props[f"{_PROP_PREFIX}{key}"] = stored
        if was_json:
            json_keys.append(key)
    props[_JSON_KEYS_COLUMN] = json_keys
    return props


def _edge_to_storage(edge: KnowledgeEdge) -> dict[str, Any]:
    """Flatten a ``KnowledgeEdge`` into a Neo4j relationship property map."""
    props: dict[str, Any] = {
        "edge_id": str(edge.edge_id),
        "edge_type": edge.edge_type,
        "source_id": str(edge.source_id),
        "target_id": str(edge.target_id),
        "confidence": edge.confidence,
        "valid_from": edge.valid_from.isoformat(),
        "valid_to": edge.valid_to.isoformat() if edge.valid_to is not None else None,
        "provenance_source": str(edge.provenance.source.value),
        "provenance_source_id": edge.provenance.source_id,
        "provenance_confidence": edge.provenance.confidence,
        "provenance_timestamp": edge.provenance.timestamp.isoformat(),
    }

    json_keys: list[str] = []
    for key, value in edge.properties.items():
        stored, was_json = _encode_value(value)
        props[f"{_PROP_PREFIX}{key}"] = stored
        if was_json:
            json_keys.append(key)
    props[_JSON_KEYS_COLUMN] = json_keys
    return props


def _parse_dt(value: Any) -> datetime | None:
    """Parse an ISO-format datetime string back to a tz-aware ``datetime``."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    # neo4j may return a neo4j.time.DateTime for native temporal columns; we
    # store ISO strings, so the str path is the expected one.
    if isinstance(value, str):
        return datetime.fromisoformat(value)
    # neo4j.time.DateTime exposes to_native().
    to_native = getattr(value, "to_native", None)
    if callable(to_native):
        return to_native()
    raise KnowledgeGraphError(f"Cannot parse datetime from {value!r} ({type(value)})")


def _properties_from_storage(stored: dict[str, Any]) -> dict[str, Any]:
    """Reconstruct the ``properties`` bag from flattened ``prop_*`` columns."""
    json_keys = set(stored.get(_JSON_KEYS_COLUMN) or [])
    properties: dict[str, Any] = {}
    for column, value in stored.items():
        if not column.startswith(_PROP_PREFIX):
            continue
        if column == _JSON_KEYS_COLUMN:
            continue
        key = column[len(_PROP_PREFIX):]
        if key in json_keys and isinstance(value, str):
            properties[key] = json.loads(value)
        elif isinstance(value, list):
            # Native Neo4j arrays come back as lists; coerce to plain Python.
            properties[key] = list(value)
        else:
            properties[key] = value
    return properties


def _node_from_storage(stored: dict[str, Any]) -> KnowledgeNode:
    """Rehydrate a ``KnowledgeNode`` from a flattened Neo4j property map."""
    provenance = Provenance(
        source=ProvenanceSource(stored["provenance_source"]),
        source_id=stored["provenance_source_id"],
        confidence=stored["provenance_confidence"],
        timestamp=_parse_dt(stored["provenance_timestamp"]),
    )
    return KnowledgeNode(
        node_id=NodeId(stored["node_id"]),
        node_type=stored["node_type"],
        schema_level=SchemaLevel(stored["schema_level"]),
        properties=_properties_from_storage(stored),
        provenance=provenance,
        confidence=stored["confidence"],
        status=NodeStatus(stored["status"]),
        created_at=_parse_dt(stored["created_at"]),
        valid_from=_parse_dt(stored["valid_from"]),
        valid_to=_parse_dt(stored.get("valid_to")),
        last_confirmed=_parse_dt(stored.get("last_confirmed")),
        confirmation_count=stored.get("confirmation_count", 0),
        prediction_errors=stored.get("prediction_errors", 0),
    )


def _edge_from_storage(stored: dict[str, Any]) -> KnowledgeEdge:
    """Rehydrate a ``KnowledgeEdge`` from a flattened Neo4j property map."""
    provenance = Provenance(
        source=ProvenanceSource(stored["provenance_source"]),
        source_id=stored["provenance_source_id"],
        confidence=stored["provenance_confidence"],
        timestamp=_parse_dt(stored["provenance_timestamp"]),
    )
    return KnowledgeEdge(
        edge_id=EdgeId(stored["edge_id"]),
        source_id=NodeId(stored["source_id"]),
        target_id=NodeId(stored["target_id"]),
        edge_type=stored["edge_type"],
        properties=_properties_from_storage(stored),
        provenance=provenance,
        confidence=stored["confidence"],
        valid_from=_parse_dt(stored["valid_from"]),
        valid_to=_parse_dt(stored.get("valid_to")),
    )


class Neo4jGraphPersistence:
    """Neo4j-backed implementation of the ``GraphPersistence`` Protocol.

    A drop-in alternative to :class:`InMemoryGraphPersistence`. Construct it
    against a single Neo4j instance; it opens both an async driver (for the
    Protocol methods) and a sync driver (for ``skill_reset`` compatibility).

    Args:
        uri: Bolt URI of the Neo4j instance (e.g. ``"bolt://localhost:7687"``).
        user: Neo4j username.
        password: Neo4j password.
        database: Optional database name. ``None`` uses the server default
            (the only option on Community Edition).
        ensure_schema: When ``True`` (default), run :func:`initialize_schema`
            against the instance at construction time so the ``node_id``
            uniqueness constraint and lookup indexes exist. Set ``False`` if
            schema setup is managed elsewhere.

    Attributes:
        _adriver: The async ``neo4j.AsyncDriver`` backing all Protocol methods.
        _driver: The sync ``neo4j.Driver`` used by ``skill_reset`` (it reaches
            into ``persistence._driver`` and uses the sync session API).
        _database: The target database name, or ``None`` for the default.
        _closed: Whether ``close()`` has been called.
    """

    def __init__(
        self,
        uri: str,
        user: str,
        password: str,
        *,
        database: str | None = None,
        ensure_schema: bool = True,
    ) -> None:
        self._uri = uri
        self._database = database
        auth = (user, password)
        # Async driver -- powers every (async) Protocol method.
        self._adriver: neo4j.AsyncDriver = neo4j.AsyncGraphDatabase.driver(
            uri, auth=auth
        )
        # Sync driver -- skill_reset.py reaches into ._driver and uses the
        # synchronous session API. Pointed at the same instance.
        self._driver: neo4j.Driver = neo4j.GraphDatabase.driver(uri, auth=auth)
        self._closed = False

        if ensure_schema:
            try:
                with self._driver.session(database=self._database) as session:
                    initialize_schema(session)
            except Exception as exc:  # noqa: BLE001 - surface as domain error
                raise KnowledgeGraphError(
                    f"Failed to initialize Neo4j schema at {uri}: {exc}"
                ) from exc

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _session(self) -> neo4j.AsyncSession:
        """Open a new async session against the configured database."""
        return self._adriver.session(database=self._database)

    async def _run_single(self, cypher: str, **params: Any) -> dict[str, Any] | None:
        """Run a read query returning at most one record as a plain dict."""
        async with self._session() as session:
            result = await session.run(cypher, **params)
            record = await result.single()
            return dict(record) if record is not None else None

    async def _run_list(self, cypher: str, **params: Any) -> list[dict[str, Any]]:
        """Run a read query returning all records as plain dicts."""
        async with self._session() as session:
            result = await session.run(cypher, **params)
            records = [record async for record in result]
            return [dict(r) for r in records]

    # ------------------------------------------------------------------
    # Node CRUD
    # ------------------------------------------------------------------

    async def save_node(self, node: KnowledgeNode) -> None:
        """Persist a node (upsert by ``node_id``). Mirrors in-memory semantics."""
        props = _node_to_storage(node)
        label = _secondary_label(node.node_type)
        # MERGE on node_id guarantees upsert; reset the property map fully so
        # stale ``prop_*`` columns from a prior version do not linger. We clear
        # then re-set: SET n = $props would also drop the base/secondary
        # labels' membership? No -- labels are separate from properties, so we
        # SET n = $props to fully replace properties (true upsert/overwrite),
        # then (re)apply the secondary label.
        cypher = (
            f"MERGE (n:{NODE_LABEL} {{node_id: $node_id}}) "
            "SET n = $props"
        )
        try:
            async with self._session() as session:
                await session.run(cypher, node_id=str(node.node_id), props=props)
                if label is not None and label != NODE_LABEL:
                    await session.run(
                        f"MATCH (n:{NODE_LABEL} {{node_id: $node_id}}) "
                        f"SET n:{label}",
                        node_id=str(node.node_id),
                    )
        except Exception as exc:  # noqa: BLE001
            raise KnowledgeGraphError(
                f"Failed to save node {node.node_id}: {exc}"
            ) from exc

    async def get_node(self, node_id: NodeId) -> KnowledgeNode | None:
        """Retrieve a node by id, or ``None`` if absent."""
        try:
            record = await self._run_single(
                f"MATCH (n:{NODE_LABEL} {{node_id: $node_id}}) RETURN n",
                node_id=str(node_id),
            )
        except Exception as exc:  # noqa: BLE001
            raise KnowledgeGraphError(
                f"Failed to get node {node_id}: {exc}"
            ) from exc
        if record is None:
            return None
        return _node_from_storage(dict(record["n"]))

    async def delete_node(self, node_id: NodeId) -> bool:
        """Delete a node and all incident edges (idempotent).

        Returns ``True`` if a node was deleted, ``False`` if none existed.
        DETACH DELETE removes incident relationships, mirroring the in-memory
        backend which prunes incident edges on node deletion.
        """
        try:
            record = await self._run_single(
                f"MATCH (n:{NODE_LABEL} {{node_id: $node_id}}) "
                "WITH n, count(n) AS c "
                "DETACH DELETE n "
                "RETURN c",
                node_id=str(node_id),
            )
        except Exception as exc:  # noqa: BLE001
            raise KnowledgeGraphError(
                f"Failed to delete node {node_id}: {exc}"
            ) from exc
        return bool(record and record.get("c", 0) > 0)

    # ------------------------------------------------------------------
    # Edge CRUD
    # ------------------------------------------------------------------

    async def save_edge(self, edge: KnowledgeEdge) -> None:
        """Persist an edge (upsert by ``edge_id``). Mirrors in-memory semantics.

        The relationship is created between the two ``:KnowledgeNode``
        endpoints (matched by ``node_id``). When ``edge_type`` is a clean
        identifier (INSTANCE_OF, SIMILAR_TO, IS_A, ...) it is used as the Neo4j
        relationship type so semantic/skill-reset Cypher matches; otherwise the
        generic ``KNOWLEDGE_EDGE`` type is used. ``edge_type`` is always stored
        as a column regardless, so reads are type-faithful either way.

        Endpoint nodes are MERGEd by id so an edge can be saved before its
        endpoints exist (referential integrity is not enforced at the Protocol
        level, matching the in-memory backend).
        """
        props = _edge_to_storage(edge)
        rel_type = edge.edge_type if _is_clean_rel_type(edge.edge_type) else _GENERIC_REL_TYPE
        # MERGE the relationship on edge_id (unique). We match endpoints by the
        # stored source/target node_ids. Endpoints are MERGEd so the write does
        # not silently no-op when a node is absent.
        cypher = (
            f"MERGE (s:{NODE_LABEL} {{node_id: $source_id}}) "
            f"MERGE (t:{NODE_LABEL} {{node_id: $target_id}}) "
            f"MERGE (s)-[r:{rel_type} {{edge_id: $edge_id}}]->(t) "
            "SET r = $props"
        )
        try:
            async with self._session() as session:
                await session.run(
                    cypher,
                    source_id=str(edge.source_id),
                    target_id=str(edge.target_id),
                    edge_id=str(edge.edge_id),
                    props=props,
                )
        except Exception as exc:  # noqa: BLE001
            raise KnowledgeGraphError(
                f"Failed to save edge {edge.edge_id}: {exc}"
            ) from exc

    async def get_edge(self, edge_id: EdgeId) -> KnowledgeEdge | None:
        """Retrieve an edge by id, or ``None`` if absent."""
        try:
            record = await self._run_single(
                "MATCH ()-[r {edge_id: $edge_id}]->() RETURN r",
                edge_id=str(edge_id),
            )
        except Exception as exc:  # noqa: BLE001
            raise KnowledgeGraphError(
                f"Failed to get edge {edge_id}: {exc}"
            ) from exc
        if record is None:
            return None
        return _edge_from_storage(dict(record["r"]))

    async def delete_edge(self, edge_id: EdgeId) -> bool:
        """Delete an edge by id (idempotent). Does not affect endpoint nodes."""
        try:
            record = await self._run_single(
                "MATCH ()-[r {edge_id: $edge_id}]->() "
                "WITH r, count(r) AS c "
                "DELETE r "
                "RETURN c",
                edge_id=str(edge_id),
            )
        except Exception as exc:  # noqa: BLE001
            raise KnowledgeGraphError(
                f"Failed to delete edge {edge_id}: {exc}"
            ) from exc
        return bool(record and record.get("c", 0) > 0)

    # ------------------------------------------------------------------
    # Query
    # ------------------------------------------------------------------

    async def query_nodes(self, filter: NodeFilter) -> list[KnowledgeNode]:
        """Return nodes matching ``filter`` (AND semantics over non-None fields).

        Indexable scalar criteria (``node_type``, ``schema_level``,
        ``min_confidence``) are pushed into Cypher; the half-open temporal
        window on ``valid_from`` is applied in Python after rehydration to keep
        timezone handling identical to the in-memory backend.
        """
        clauses: list[str] = []
        params: dict[str, Any] = {}
        if filter.node_type is not None:
            clauses.append("n.node_type = $node_type")
            params["node_type"] = filter.node_type
        if filter.schema_level is not None:
            clauses.append("n.schema_level = $schema_level")
            params["schema_level"] = str(filter.schema_level.value)
        if filter.min_confidence is not None:
            clauses.append("n.confidence >= $min_confidence")
            params["min_confidence"] = filter.min_confidence

        where = f"WHERE {' AND '.join(clauses)} " if clauses else ""
        cypher = f"MATCH (n:{NODE_LABEL}) {where}RETURN n"

        try:
            records = await self._run_list(cypher, **params)
        except Exception as exc:  # noqa: BLE001
            raise KnowledgeGraphError(f"Failed to query nodes: {exc}") from exc

        nodes = [_node_from_storage(dict(r["n"])) for r in records]

        window = filter.temporal_window
        if window is not None:
            nodes = [n for n in nodes if self._in_window(n.valid_from, window)]
        return nodes

    @staticmethod
    def _in_window(value: datetime, window: TemporalWindow) -> bool:
        """Half-open ``[start, end)`` membership test, matching the reference."""
        if value < window.start:
            return False
        if window.end is not None and value >= window.end:
            return False
        return True

    async def query_edges(
        self, filter: EdgeFilter | None = None
    ) -> list[KnowledgeEdge]:
        """Return edges matching ``filter`` (AND semantics). ``None`` -> all edges."""
        clauses: list[str] = []
        params: dict[str, Any] = {}
        if filter is not None:
            if filter.edge_type is not None:
                clauses.append("r.edge_type = $edge_type")
                params["edge_type"] = filter.edge_type
            if filter.source_node_id is not None:
                clauses.append("r.source_id = $source_node_id")
                params["source_node_id"] = filter.source_node_id
            if filter.target_node_id is not None:
                clauses.append("r.target_id = $target_node_id")
                params["target_node_id"] = filter.target_node_id
            if filter.min_confidence is not None:
                clauses.append("r.confidence >= $min_confidence")
                params["min_confidence"] = filter.min_confidence

        # Match any relationship that carries an edge_id (all our edges do);
        # AND every non-None filter criterion onto that base predicate.
        all_clauses = ["r.edge_id IS NOT NULL", *clauses]
        cypher = f"MATCH ()-[r]->() WHERE {' AND '.join(all_clauses)} RETURN r"

        try:
            records = await self._run_list(cypher, **params)
        except Exception as exc:  # noqa: BLE001
            raise KnowledgeGraphError(f"Failed to query edges: {exc}") from exc
        return [_edge_from_storage(dict(r["r"])) for r in records]

    async def find_similar_nodes(
        self,
        embedding: list[float],
        threshold: float = 0.8,
        limit: int = 10,
    ) -> list[tuple[KnowledgeNode, float]]:
        """Find nodes whose ``properties["embedding"]`` is similar to ``embedding``.

        Cosine similarity computed in Python over a shortlist of nodes that
        carry an ``embedding`` array column (Community Edition has no vector
        index). Identical filtering / sorting / threshold semantics as the
        in-memory backend.
        """
        return await self._embedding_search(
            embedding=embedding,
            embedding_key="embedding",
            threshold=threshold,
            limit=limit,
            schema_level=None,
        )

    async def find_nodes_by_embedding(
        self,
        embedding: list[float],
        embedding_key: str = "embedding",
        min_similarity: float = 0.7,
        limit: int = 10,
        schema_level: SchemaLevel | None = None,
    ) -> list[tuple[KnowledgeNode, float]]:
        """Find nodes by direct embedding comparison at ``embedding_key``.

        Mirrors the in-memory backend: optional ``schema_level`` pre-filter,
        nodes lacking a list at ``embedding_key`` silently skipped, cosine in
        Python, results sorted by descending similarity and truncated to
        ``limit``.
        """
        return await self._embedding_search(
            embedding=embedding,
            embedding_key=embedding_key,
            threshold=min_similarity,
            limit=limit,
            schema_level=schema_level,
        )

    async def _embedding_search(
        self,
        embedding: list[float],
        embedding_key: str,
        threshold: float,
        limit: int,
        schema_level: SchemaLevel | None,
    ) -> list[tuple[KnowledgeNode, float]]:
        """Shared cosine-in-Python similarity search over an embedding column."""
        prop_col = f"{_PROP_PREFIX}{embedding_key}"
        clauses = [f"n.`{prop_col}` IS NOT NULL"]
        params: dict[str, Any] = {}
        if schema_level is not None:
            clauses.append("n.schema_level = $schema_level")
            params["schema_level"] = str(schema_level.value)
        where = " AND ".join(clauses)
        cypher = f"MATCH (n:{NODE_LABEL}) WHERE {where} RETURN n"

        try:
            records = await self._run_list(cypher, **params)
        except Exception as exc:  # noqa: BLE001
            raise KnowledgeGraphError(
                f"Failed embedding search on {embedding_key}: {exc}"
            ) from exc

        candidates: list[tuple[KnowledgeNode, float]] = []
        for r in records:
            node = _node_from_storage(dict(r["n"]))
            node_embedding = node.properties.get(embedding_key)
            if not isinstance(node_embedding, list):
                continue
            if len(node_embedding) == 0 or len(embedding) == 0:
                continue
            try:
                similarity = _cosine_similarity(embedding, node_embedding)
            except ValueError:
                continue
            if similarity >= threshold:
                candidates.append((node, similarity))

        candidates.sort(key=lambda pair: pair[1], reverse=True)
        return candidates[:limit]

    async def get_nodes_in_temporal_window(
        self, window: TemporalWindow
    ) -> list[KnowledgeNode]:
        """Return nodes whose ``valid_from`` falls in ``[start, end)``."""
        # valid_from is stored as an ISO string; lexicographic comparison of
        # ISO-8601 UTC strings is order-preserving, but to match the reference
        # exactly (tz-aware datetime comparison) we fetch and filter in Python.
        try:
            records = await self._run_list(
                f"MATCH (n:{NODE_LABEL}) WHERE n.valid_from IS NOT NULL RETURN n"
            )
        except Exception as exc:  # noqa: BLE001
            raise KnowledgeGraphError(
                f"Failed temporal-window query: {exc}"
            ) from exc
        nodes = [_node_from_storage(dict(r["n"])) for r in records]
        return [n for n in nodes if self._in_window(n.valid_from, window)]

    # ------------------------------------------------------------------
    # Schema evolution
    # ------------------------------------------------------------------

    async def apply_type_split(
        self,
        original_type_id: NodeId,
        new_type_a_name: str,
        new_type_b_name: str,
        instances_for_a: list[NodeId],
        instances_for_b: list[NodeId],
        source_id: str,
    ) -> tuple[NodeId, NodeId]:
        """Split a SchemaType into two new types. Mirrors the reference 7-step flow.

        1-2. Create SchemaType A and B (SCHEMA level, INFERENCE provenance).
        3-4. For each instance: create a new INSTANCE_OF edge to the new type,
             delete any existing INSTANCE_OF edge to the original type.
        5-6. Create SPLIT_FROM edges A->original and B->original (INFERENCE,
             D-TS-03).
        7.   Mark the original type SUPERSEDED with ``valid_to`` set.

        Returns ``(new_type_a_id, new_type_b_id)``.
        """
        provenance = Provenance(
            source=ProvenanceSource.INFERENCE,
            source_id=source_id,
            confidence=1.0,
        )

        new_type_a_id = _new_node_id("schema-type")
        type_a_node = KnowledgeNode(
            node_id=new_type_a_id,
            node_type="SchemaType",
            schema_level=SchemaLevel.SCHEMA,
            properties={
                "type_name": new_type_a_name,
                "original_type_id": str(original_type_id),
            },
            provenance=provenance,
            confidence=1.0,
        )
        await self.save_node(type_a_node)

        new_type_b_id = _new_node_id("schema-type")
        type_b_node = KnowledgeNode(
            node_id=new_type_b_id,
            node_type="SchemaType",
            schema_level=SchemaLevel.SCHEMA,
            properties={
                "type_name": new_type_b_name,
                "original_type_id": str(original_type_id),
            },
            provenance=provenance,
            confidence=1.0,
        )
        await self.save_node(type_b_node)

        for inst_id in instances_for_a:
            await self.save_edge(
                KnowledgeEdge(
                    edge_id=_new_edge_id("instance-of"),
                    source_id=inst_id,
                    target_id=new_type_a_id,
                    edge_type="INSTANCE_OF",
                    provenance=provenance,
                    confidence=1.0,
                )
            )
            await self._delete_instance_of_edges(inst_id, original_type_id)

        for inst_id in instances_for_b:
            await self.save_edge(
                KnowledgeEdge(
                    edge_id=_new_edge_id("instance-of"),
                    source_id=inst_id,
                    target_id=new_type_b_id,
                    edge_type="INSTANCE_OF",
                    provenance=provenance,
                    confidence=1.0,
                )
            )
            await self._delete_instance_of_edges(inst_id, original_type_id)

        await self.save_edge(
            KnowledgeEdge(
                edge_id=_new_edge_id("split-from"),
                source_id=new_type_a_id,
                target_id=original_type_id,
                edge_type="SPLIT_FROM",
                provenance=provenance,
                confidence=1.0,
            )
        )
        await self.save_edge(
            KnowledgeEdge(
                edge_id=_new_edge_id("split-from"),
                source_id=new_type_b_id,
                target_id=original_type_id,
                edge_type="SPLIT_FROM",
                provenance=provenance,
                confidence=1.0,
            )
        )

        original_node = await self.get_node(original_type_id)
        if original_node is not None:
            original_node.status = NodeStatus.SUPERSEDED
            original_node.valid_to = utc_now()
            await self.save_node(original_node)

        return (new_type_a_id, new_type_b_id)

    async def _delete_instance_of_edges(
        self, instance_id: NodeId, type_id: NodeId
    ) -> None:
        """Delete INSTANCE_OF edges from ``instance_id`` to ``type_id``."""
        try:
            async with self._session() as session:
                await session.run(
                    "MATCH ()-[r]->() WHERE r.edge_type = 'INSTANCE_OF' "
                    "AND r.source_id = $src AND r.target_id = $tgt "
                    "DELETE r",
                    src=str(instance_id),
                    tgt=str(type_id),
                )
        except Exception as exc:  # noqa: BLE001
            raise KnowledgeGraphError(
                f"Failed to delete INSTANCE_OF edge {instance_id}->{type_id}: {exc}"
            ) from exc

    # ------------------------------------------------------------------
    # Expectation management (Epic 4, T043b)
    # ------------------------------------------------------------------

    async def get_property_expectations(
        self, schema_type_id: NodeId
    ) -> list[PropertyExpectation]:
        """Return PropertyExpectation records for ``schema_type_id``.

        Expectations are stored as ``:PropertyExpectation`` nodes keyed by
        ``expectation_id`` (kept off the ``:KnowledgeNode`` query path, exactly
        as the in-memory backend keeps them out of ``_nodes``).
        """
        try:
            records = await self._run_list(
                "MATCH (e:PropertyExpectation {schema_type_id: $stid}) RETURN e",
                stid=str(schema_type_id),
            )
        except Exception as exc:  # noqa: BLE001
            raise KnowledgeGraphError(
                f"Failed to get expectations for {schema_type_id}: {exc}"
            ) from exc
        return [self._expectation_from_storage(dict(r["e"])) for r in records]

    async def save_property_expectation(
        self, expectation: PropertyExpectation
    ) -> None:
        """Create or update a PropertyExpectation (upsert by ``expectation_id``).

        On first save, also creates a single HAS_EXPECTATION edge from the
        schema-type node to the expectation node (D4-06), not duplicated on
        subsequent saves.
        """
        props = self._expectation_to_storage(expectation)
        try:
            async with self._session() as session:
                await session.run(
                    "MERGE (e:PropertyExpectation {expectation_id: $eid}) "
                    "SET e = $props",
                    eid=expectation.expectation_id,
                    props=props,
                )
                # Create the HAS_EXPECTATION edge once (MERGE is idempotent).
                await session.run(
                    f"MATCH (e:PropertyExpectation {{expectation_id: $eid}}) "
                    f"MERGE (s:{NODE_LABEL} {{node_id: $stid}}) "
                    "MERGE (s)-[:HAS_EXPECTATION]->(e)",
                    eid=expectation.expectation_id,
                    stid=str(expectation.schema_type_id),
                )
        except Exception as exc:  # noqa: BLE001
            raise KnowledgeGraphError(
                f"Failed to save expectation {expectation.expectation_id}: {exc}"
            ) from exc

    @staticmethod
    def _expectation_to_storage(exp: PropertyExpectation) -> dict[str, Any]:
        """Flatten a PropertyExpectation to a Neo4j property map."""
        return {
            "expectation_id": exp.expectation_id,
            "schema_type_id": str(exp.schema_type_id),
            "property_key": exp.property_key,
            "mean_vector": list(exp.mean_vector),
            "variance": exp.variance,
            "sample_count": exp.sample_count,
            "confirmation_count": exp.confirmation_count,
            "prediction_errors": exp.prediction_errors,
            "confidence": exp.confidence,
            "provenance": str(exp.provenance.value),
            "is_active": exp.is_active,
        }

    @staticmethod
    def _expectation_from_storage(stored: dict[str, Any]) -> PropertyExpectation:
        """Rehydrate a PropertyExpectation from a Neo4j property map."""
        return PropertyExpectation(
            expectation_id=stored["expectation_id"],
            schema_type_id=NodeId(stored["schema_type_id"]),
            property_key=stored["property_key"],
            mean_vector=[float(x) for x in stored["mean_vector"]],
            variance=stored["variance"],
            sample_count=stored["sample_count"],
            confirmation_count=stored["confirmation_count"],
            prediction_errors=stored["prediction_errors"],
            confidence=stored["confidence"],
            provenance=ProvenanceSource(stored["provenance"]),
            is_active=stored["is_active"],
        )

    async def get_nodes_with_embedding(
        self,
        embedding_key: str,
        schema_level: SchemaLevel,
        label_raw: str | None = None,
    ) -> list[KnowledgeNode]:
        """Return nodes at ``schema_level`` carrying a list at ``embedding_key``.

        Optional strict ``label_raw`` equality filter (D4-01: filter, not
        weight). Identical semantics to the in-memory backend.
        """
        prop_col = f"{_PROP_PREFIX}{embedding_key}"
        clauses = [
            "n.schema_level = $schema_level",
            f"n.`{prop_col}` IS NOT NULL",
        ]
        params: dict[str, Any] = {"schema_level": str(schema_level.value)}
        if label_raw is not None:
            clauses.append(f"n.`{_PROP_PREFIX}label_raw` = $label_raw")
            params["label_raw"] = label_raw
        cypher = f"MATCH (n:{NODE_LABEL}) WHERE {' AND '.join(clauses)} RETURN n"

        try:
            records = await self._run_list(cypher, **params)
        except Exception as exc:  # noqa: BLE001
            raise KnowledgeGraphError(
                f"Failed get_nodes_with_embedding({embedding_key}): {exc}"
            ) from exc

        results: list[KnowledgeNode] = []
        for r in records:
            node = _node_from_storage(dict(r["n"]))
            # Re-assert the list-typed guard (a JSON-encoded non-list would be
            # decoded to a non-list and must be excluded, matching reference).
            if not isinstance(node.properties.get(embedding_key), list):
                continue
            results.append(node)
        return results

    async def get_similar_to_cluster(
        self,
        label_raw: str,
        min_similarity: float,
        min_cluster_size: int,
    ) -> list[SimilarityCluster]:
        """Find SIMILAR_TO connected components within a label group.

        The clustering maths (BFS components, centroid, mean pairwise / cross
        similarity, contrast ratio, label distribution, session ids) is
        intricate and already correct in the in-memory backend. To guarantee
        *byte-identical* semantics, this method fetches the relevant
        INSTANCE-level nodes (by ``label_raw``) and their SIMILAR_TO edges from
        Neo4j, loads them into a transient ``InMemoryGraphPersistence``, and
        delegates the computation. No general read access to the graph is
        granted -- only the candidate subgraph is materialized.
        """
        try:
            node_records = await self._run_list(
                f"MATCH (n:{NODE_LABEL}) "
                "WHERE n.schema_level = $level "
                f"AND n.`{_PROP_PREFIX}label_raw` = $label_raw "
                "RETURN n",
                level=str(SchemaLevel.INSTANCE.value),
                label_raw=label_raw,
            )
        except Exception as exc:  # noqa: BLE001
            raise KnowledgeGraphError(
                f"Failed to load cluster candidates for {label_raw}: {exc}"
            ) from exc

        nodes = [_node_from_storage(dict(r["n"])) for r in node_records]
        if not nodes:
            return []
        candidate_ids = {str(n.node_id) for n in nodes}

        try:
            edge_records = await self._run_list(
                "MATCH ()-[r]->() WHERE r.edge_type = 'SIMILAR_TO' "
                "AND r.source_id IN $ids AND r.target_id IN $ids RETURN r",
                ids=list(candidate_ids),
            )
        except Exception as exc:  # noqa: BLE001
            raise KnowledgeGraphError(
                f"Failed to load SIMILAR_TO edges for {label_raw}: {exc}"
            ) from exc

        scratch = InMemoryGraphPersistence()
        for node in nodes:
            await scratch.save_node(node)
        for r in edge_records:
            await scratch.save_edge(_edge_from_storage(dict(r["r"])))

        return await scratch.get_similar_to_cluster(
            label_raw=label_raw,
            min_similarity=min_similarity,
            min_cluster_size=min_cluster_size,
        )

    # ------------------------------------------------------------------
    # Epic 5 queries (T052)
    # ------------------------------------------------------------------

    async def get_schema_proposal(self, proposal_id: NodeId) -> KnowledgeNode | None:
        """Return the SchemaProposal node by id, or ``None`` if absent/mistyped."""
        node = await self.get_node(proposal_id)
        if node is None or node.node_type != "SchemaProposal":
            return None
        return node

    async def get_instance_type(self, instance_node_id: NodeId) -> NodeId | None:
        """Return the schema type reached by an INSTANCE_OF edge, or ``None``."""
        try:
            record = await self._run_single(
                "MATCH ()-[r]->() WHERE r.edge_type = 'INSTANCE_OF' "
                "AND r.source_id = $src RETURN r.target_id AS target LIMIT 1",
                src=str(instance_node_id),
            )
        except Exception as exc:  # noqa: BLE001
            raise KnowledgeGraphError(
                f"Failed to get instance type for {instance_node_id}: {exc}"
            ) from exc
        if record is None or record.get("target") is None:
            return None
        return NodeId(record["target"])

    # ------------------------------------------------------------------
    # Primitive symbol operations (Conversation Engine Phase 1)
    # ------------------------------------------------------------------

    async def save_primitive_symbol(
        self, node_id: str, name: str, description: str
    ) -> None:
        """Persist a PrimitiveSymbolNode (upsert by ``node_id``)."""
        try:
            async with self._session() as session:
                await session.run(
                    "MERGE (p:PrimitiveSymbolNode {node_id: $node_id}) "
                    "SET p.name = $name, p.description = $description",
                    node_id=node_id,
                    name=name,
                    description=description,
                )
        except Exception as exc:  # noqa: BLE001
            raise KnowledgeGraphError(
                f"Failed to save primitive symbol {node_id}: {exc}"
            ) from exc

    async def get_primitive_symbol(self, node_id: str) -> dict | None:
        """Return a PrimitiveSymbolNode as a dict, or ``None`` if absent."""
        record = await self._run_single(
            "MATCH (p:PrimitiveSymbolNode {node_id: $node_id}) "
            "RETURN p.node_id AS node_id, p.name AS name, p.description AS description",
            node_id=node_id,
        )
        return dict(record) if record is not None else None

    async def get_all_primitive_symbols(self) -> list[dict]:
        """Return all PrimitiveSymbolNode nodes as dicts."""
        records = await self._run_list(
            "MATCH (p:PrimitiveSymbolNode) "
            "RETURN p.node_id AS node_id, p.name AS name, p.description AS description"
        )
        return [dict(r) for r in records]

    # ------------------------------------------------------------------
    # Grounding failure operations (Conversation Engine Phase 2)
    # ------------------------------------------------------------------

    async def save_grounding_failure(
        self,
        node_id: str,
        triggering_word: str,
        surrounding_words: list[str],
        primitive_activation_snapshot: dict,
        session_id: str,
        timestamp: str,
    ) -> None:
        """Persist a GroundingFailureRecord node (upsert by ``node_id``).

        ``primitive_activation_snapshot`` is a nested dict, so it is
        JSON-encoded to a string column -- the same nested-structure rule
        applied to node properties.
        """
        try:
            async with self._session() as session:
                await session.run(
                    "MERGE (g:GroundingFailureRecord {node_id: $node_id}) "
                    "SET g.triggering_word = $triggering_word, "
                    "g.surrounding_words = $surrounding_words, "
                    "g.primitive_activation_snapshot = $snapshot_json, "
                    "g.session_id = $session_id, "
                    "g.timestamp = $timestamp, "
                    "g.processed = false",
                    node_id=node_id,
                    triggering_word=triggering_word,
                    surrounding_words=list(surrounding_words),
                    snapshot_json=json.dumps(primitive_activation_snapshot),
                    session_id=session_id,
                    timestamp=timestamp,
                )
        except Exception as exc:  # noqa: BLE001
            raise KnowledgeGraphError(
                f"Failed to save grounding failure {node_id}: {exc}"
            ) from exc

    async def get_unprocessed_grounding_failures(
        self, limit: int = 50
    ) -> list[dict]:
        """Return unprocessed GroundingFailureRecord nodes as dicts."""
        records = await self._run_list(
            "MATCH (g:GroundingFailureRecord) WHERE g.processed = false "
            "RETURN g.node_id AS node_id, g.triggering_word AS triggering_word, "
            "g.surrounding_words AS surrounding_words, "
            "g.primitive_activation_snapshot AS snapshot_json, "
            "g.session_id AS session_id, g.timestamp AS timestamp "
            "LIMIT $limit",
            limit=limit,
        )
        results: list[dict] = []
        for r in records:
            snapshot_json = r.get("snapshot_json")
            results.append(
                {
                    "node_id": r["node_id"],
                    "triggering_word": r["triggering_word"],
                    "surrounding_words": list(r.get("surrounding_words") or []),
                    "primitive_activation_snapshot": (
                        json.loads(snapshot_json) if snapshot_json else {}
                    ),
                    "session_id": r["session_id"],
                    "timestamp": r["timestamp"],
                }
            )
        return results

    async def mark_grounding_failures_processed(
        self, node_ids: list[str]
    ) -> None:
        """Mark GroundingFailureRecord nodes as processed."""
        if not node_ids:
            return
        try:
            async with self._session() as session:
                await session.run(
                    "MATCH (g:GroundingFailureRecord) WHERE g.node_id IN $ids "
                    "SET g.processed = true",
                    ids=list(node_ids),
                )
        except Exception as exc:  # noqa: BLE001
            raise KnowledgeGraphError(
                f"Failed to mark grounding failures processed: {exc}"
            ) from exc

    # ------------------------------------------------------------------
    # Operations
    # ------------------------------------------------------------------

    async def health_check(self) -> bool:
        """Return ``True`` if the Neo4j instance answers a trivial probe."""
        try:
            record = await self._run_single("RETURN 1 AS ok")
            return bool(record and record.get("ok") == 1)
        except Exception:  # noqa: BLE001 - health check never raises
            return False

    async def close(self) -> None:
        """Close both drivers. Idempotent."""
        if self._closed:
            return
        self._closed = True
        try:
            await self._adriver.close()
        finally:
            self._driver.close()

    # ------------------------------------------------------------------
    # Schema helpers (not part of the Protocol; used by composition root/tests)
    # ------------------------------------------------------------------

    def initialize_schema(self) -> None:
        """Create constraints/indexes via the sync driver. Not on the Protocol."""
        with self._driver.session(database=self._database) as session:
            initialize_schema(session)

    def verify_schema(self) -> None:
        """Verify constraints/indexes exist. Raises SchemaNotInitializedError."""
        with self._driver.session(database=self._database) as session:
            verify_schema(session)


__all__ = ["Neo4jGraphPersistence"]
