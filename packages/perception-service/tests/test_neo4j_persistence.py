"""Live tests for ``Neo4jGraphPersistence`` (vision plan P3.3).

Two suites, both run against the *live* Neo4j test instances:

* **Seeded round-trip** -- save nodes + edges + expectations + primitives +
  grounding failures, then read them back through every query method and
  assert identity / round-trip. Includes a ``bounding_box`` (list-of-lists)
  JSON encode/decode round-trip to prove nested structures survive storage.

* **KG isolation** (the make-or-break invariant) -- assert ``:VisualObject``
  nodes live in the **WORLD** instance only, ``:Person`` / ``:FaceSnapshot``
  nodes live in the **OTHER** instance only, and that **no edge crosses
  instances** (each instance only contains edges whose endpoints are both
  local to it).

Both suites:

* connect to ``bolt://localhost:7687`` (WORLD, ``sylphie-neo4j-world``) and
  ``bolt://localhost:7689`` (OTHER, ``sylphie-neo4j-other``);
* read auth from the environment (``NEO4J_WORLD_*`` / ``NEO4J_OTHER_*``) with
  defaults derived from the containers' ``NEO4J_AUTH`` (``neo4j/sylphie_world``
  and ``neo4j/sylphie_other``) -- no secrets are hardcoded beyond the
  dev-container defaults, and any value can be overridden via env;
* namespace every node they create under :data:`_TEST_PREFIX` and **tear down
  exactly what they create** in a finally/fixture-teardown, so the live
  instances are left clean;
* **skip LOUDLY** with a named reason when the ``neo4j`` driver is absent or an
  instance is unreachable, so a missing dependency / database is reported,
  never silently passed.

These tests are NOT marked ``requires_models`` -- that project gate skips a
test when *any* heavy CV model dep (onnxruntime / mediapipe / insightface) is
absent, but this suite needs only the ``neo4j`` driver. Instead the module does
its own neo4j-specific guard (driver import + per-instance reachability probe)
so the suite runs whenever Neo4j is available, regardless of CV model presence.

Run with::

    cd packages/perception-service
    python -m pytest tests/test_neo4j_persistence.py -v
"""

from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime, timedelta

import pytest

# Import the neo4j driver defensively so collection never hard-fails when it
# is absent; the per-instance probe below converts an absent driver into a
# LOUD skip rather than a collection error.
try:
    import neo4j  # noqa: F401

    _NEO4J_IMPORT_ERROR: str | None = None
except Exception as exc:  # noqa: BLE001
    neo4j = None  # type: ignore[assignment]
    _NEO4J_IMPORT_ERROR = f"{type(exc).__name__}: {exc}"

import pytest_asyncio

from cobeing.layer3_knowledge.expectation_types import PropertyExpectation
from cobeing.layer3_knowledge.node_types import (
    KnowledgeEdge,
    KnowledgeNode,
    NodeStatus,
    SchemaLevel,
)
from cobeing.layer3_knowledge.query_types import (
    EdgeFilter,
    NodeFilter,
    TemporalWindow,
)
from cobeing.shared.provenance import Provenance, ProvenanceSource
from cobeing.shared.types import EdgeId, NodeId

# ---------------------------------------------------------------------------
# Connection config (env-overridable; defaults from the dev container auth).
# ---------------------------------------------------------------------------

_WORLD_URI = os.environ.get("NEO4J_WORLD_URI", "bolt://localhost:7687")
_WORLD_USER = os.environ.get("NEO4J_WORLD_USER", "neo4j")
_WORLD_PASSWORD = os.environ.get("NEO4J_WORLD_PASSWORD", "sylphie_world")

_OTHER_URI = os.environ.get("NEO4J_OTHER_URI", "bolt://localhost:7689")
_OTHER_USER = os.environ.get("NEO4J_OTHER_USER", "neo4j")
_OTHER_PASSWORD = os.environ.get("NEO4J_OTHER_PASSWORD", "sylphie_other")

# Every node this module creates carries a node_id starting with this prefix,
# so teardown can find and DETACH DELETE exactly what the tests created and
# nothing else.
_TEST_PREFIX = f"p33test-{uuid.uuid4().hex[:8]}-"


def _probe(uri: str, user: str, password: str) -> str | None:
    """Return ``None`` if the instance is reachable, else a loud skip reason."""
    if neo4j is None:
        return f"neo4j driver not importable ({_NEO4J_IMPORT_ERROR})"
    try:
        drv = neo4j.GraphDatabase.driver(uri, auth=(user, password))
        try:
            with drv.session() as session:
                session.run("RETURN 1").single()
        finally:
            drv.close()
        return None
    except Exception as exc:  # noqa: BLE001
        return (
            f"Neo4j at {uri} unreachable ({type(exc).__name__}: {exc}). "
            f"Bring up the container and/or set NEO4J_*_URI/USER/PASSWORD env "
            f"vars, then re-run. Tests are skip-guarded, not faked."
        )


_WORLD_SKIP = _probe(_WORLD_URI, _WORLD_USER, _WORLD_PASSWORD)
_OTHER_SKIP = _probe(_OTHER_URI, _OTHER_USER, _OTHER_PASSWORD)


def _prov(source: ProvenanceSource = ProvenanceSource.SENSOR) -> Provenance:
    return Provenance(source=source, source_id="p33-test-source", confidence=0.9)


def _tid(suffix: str) -> NodeId:
    """A test-namespaced NodeId."""
    return NodeId(f"{_TEST_PREFIX}{suffix}")


def _teardown_world_other_ids(persistence) -> None:
    """Delete every test-namespaced node (and incident edges) via sync driver."""
    with persistence._driver.session(database=persistence._database) as session:
        session.run(
            "MATCH (n:KnowledgeNode) WHERE n.node_id STARTS WITH $prefix "
            "DETACH DELETE n",
            prefix=_TEST_PREFIX,
        )
        # Expectation / primitive / grounding nodes are not :KnowledgeNode.
        for label in (
            "PropertyExpectation",
            "PrimitiveSymbolNode",
            "GroundingFailureRecord",
        ):
            session.run(
                f"MATCH (n:{label}) "
                "WHERE coalesce(n.node_id, n.expectation_id, '') STARTS WITH $prefix "
                "DETACH DELETE n",
                prefix=_TEST_PREFIX,
            )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def world_store():
    """A ``Neo4jGraphPersistence`` bound to the WORLD instance, auto-cleaned."""
    if _WORLD_SKIP is not None:
        pytest.skip(_WORLD_SKIP)
    from cobeing.layer3_knowledge.infrastructure.neo4j_persistence import (
        Neo4jGraphPersistence,
    )

    store = Neo4jGraphPersistence(
        _WORLD_URI, _WORLD_USER, _WORLD_PASSWORD, ensure_schema=True
    )
    try:
        yield store
    finally:
        try:
            _teardown_world_other_ids(store)
        finally:
            await store.close()


@pytest_asyncio.fixture
async def other_store():
    """A ``Neo4jGraphPersistence`` bound to the OTHER instance, auto-cleaned."""
    if _OTHER_SKIP is not None:
        pytest.skip(_OTHER_SKIP)
    from cobeing.layer3_knowledge.infrastructure.neo4j_persistence import (
        Neo4jGraphPersistence,
    )

    store = Neo4jGraphPersistence(
        _OTHER_URI, _OTHER_USER, _OTHER_PASSWORD, ensure_schema=True
    )
    try:
        yield store
    finally:
        try:
            _teardown_world_other_ids(store)
        finally:
            await store.close()


# ---------------------------------------------------------------------------
# Protocol completeness (cheap, runs even if instances are down... but the
# fixture-free check is also exercised here for visibility).
# ---------------------------------------------------------------------------


def test_satisfies_graph_persistence_protocol() -> None:
    """The class structurally satisfies the runtime_checkable Protocol."""
    from cobeing.layer3_knowledge.infrastructure.neo4j_persistence import (
        Neo4jGraphPersistence,
    )
    from cobeing.layer3_knowledge.protocols import GraphPersistence

    # __new__ avoids opening a driver -- we only need attribute presence for
    # the structural isinstance() check.
    obj = Neo4jGraphPersistence.__new__(Neo4jGraphPersistence)
    assert isinstance(obj, GraphPersistence)


# ---------------------------------------------------------------------------
# Seeded round-trip
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_node_crud_round_trip(world_store) -> None:
    nid = _tid("node-crud")
    node = KnowledgeNode(
        node_id=nid,
        node_type="ObjectInstance",
        schema_level=SchemaLevel.INSTANCE,
        properties={"label_raw": "cup", "area_px": 1234, "visible": True},
        provenance=_prov(),
        confidence=0.85,
    )
    await world_store.save_node(node)

    got = await world_store.get_node(nid)
    assert got is not None
    assert got.node_id == nid
    assert got.node_type == "ObjectInstance"
    assert got.schema_level == SchemaLevel.INSTANCE
    assert got.confidence == pytest.approx(0.85)
    assert got.properties["label_raw"] == "cup"
    assert got.properties["area_px"] == 1234
    assert got.properties["visible"] is True
    assert got.provenance.source == ProvenanceSource.SENSOR
    assert got.provenance.source_id == "p33-test-source"

    # Upsert overwrites.
    node.confidence = 0.42
    node.properties["label_raw"] = "mug"
    await world_store.save_node(node)
    got2 = await world_store.get_node(nid)
    assert got2 is not None
    assert got2.confidence == pytest.approx(0.42)
    assert got2.properties["label_raw"] == "mug"

    # Delete is idempotent.
    assert await world_store.delete_node(nid) is True
    assert await world_store.get_node(nid) is None
    assert await world_store.delete_node(nid) is False


@pytest.mark.asyncio
async def test_bounding_box_json_round_trip(world_store) -> None:
    """A nested ``bounding_box`` (list-of-lists) survives encode/decode."""
    nid = _tid("bbox")
    bbox = [[10.0, 20.0], [110.0, 220.0]]  # list-of-lists: cannot store natively
    nested = {"corners": bbox, "meta": {"unit": "px", "frame": 7}}
    node = KnowledgeNode(
        node_id=nid,
        node_type="VisualObject",
        schema_level=SchemaLevel.INSTANCE,
        properties={
            "bounding_box": bbox,
            "nested": nested,
            "embedding": [0.1, 0.2, 0.3],  # plain list -> stored natively
            "label_raw": "cup",
        },
        provenance=_prov(),
        confidence=0.7,
    )
    await world_store.save_node(node)

    got = await world_store.get_node(nid)
    assert got is not None
    # Symmetric JSON round-trip for the nested structures.
    assert got.properties["bounding_box"] == bbox
    assert got.properties["nested"] == nested
    # Native array round-trip for the embedding.
    assert got.properties["embedding"] == pytest.approx([0.1, 0.2, 0.3])
    assert got.properties["label_raw"] == "cup"


@pytest.mark.asyncio
async def test_edge_crud_and_query(world_store) -> None:
    src = _tid("edge-src")
    tgt = _tid("edge-tgt")
    await world_store.save_node(
        KnowledgeNode(
            node_id=src, node_type="ObjectInstance",
            schema_level=SchemaLevel.INSTANCE, properties={},
            provenance=_prov(), confidence=0.8,
        )
    )
    await world_store.save_node(
        KnowledgeNode(
            node_id=tgt, node_type="SchemaType",
            schema_level=SchemaLevel.SCHEMA, properties={},
            provenance=_prov(), confidence=0.9,
        )
    )
    eid = EdgeId(f"{_TEST_PREFIX}edge-instof")
    edge = KnowledgeEdge(
        edge_id=eid, source_id=src, target_id=tgt, edge_type="INSTANCE_OF",
        properties={"reason": "test"}, provenance=_prov(), confidence=0.77,
    )
    await world_store.save_edge(edge)

    got = await world_store.get_edge(eid)
    assert got is not None
    assert got.edge_id == eid
    assert got.source_id == src
    assert got.target_id == tgt
    assert got.edge_type == "INSTANCE_OF"
    assert got.confidence == pytest.approx(0.77)
    assert got.properties["reason"] == "test"

    # query_edges with filters (AND semantics).
    by_type = await world_store.query_edges(EdgeFilter(edge_type="INSTANCE_OF"))
    assert any(e.edge_id == eid for e in by_type)
    by_src = await world_store.query_edges(EdgeFilter(source_node_id=str(src)))
    assert any(e.edge_id == eid for e in by_src)
    by_conf = await world_store.query_edges(EdgeFilter(min_confidence=0.99))
    assert all(e.edge_id != eid for e in by_conf)

    # get_instance_type follows the INSTANCE_OF edge.
    assert await world_store.get_instance_type(src) == tgt

    # Delete edge does not affect endpoints.
    assert await world_store.delete_edge(eid) is True
    assert await world_store.get_edge(eid) is None
    assert await world_store.delete_edge(eid) is False
    assert await world_store.get_node(src) is not None
    assert await world_store.get_node(tgt) is not None

    # delete_node prunes incident edges.
    e2 = EdgeId(f"{_TEST_PREFIX}edge-2")
    await world_store.save_edge(
        KnowledgeEdge(
            edge_id=e2, source_id=src, target_id=tgt, edge_type="SPATIAL_ON",
            provenance=_prov(), confidence=0.5,
        )
    )
    assert await world_store.get_edge(e2) is not None
    await world_store.delete_node(src)
    assert await world_store.get_edge(e2) is None


@pytest.mark.asyncio
async def test_query_nodes_filters(world_store) -> None:
    base = datetime(2026, 1, 1, tzinfo=UTC)
    inst = _tid("qn-inst")
    schema = _tid("qn-schema")
    await world_store.save_node(
        KnowledgeNode(
            node_id=inst, node_type="ObjectInstance",
            schema_level=SchemaLevel.INSTANCE, properties={},
            provenance=_prov(), confidence=0.6,
            valid_from=base + timedelta(hours=1),
        )
    )
    await world_store.save_node(
        KnowledgeNode(
            node_id=schema, node_type="SchemaType",
            schema_level=SchemaLevel.SCHEMA, properties={},
            provenance=_prov(), confidence=0.95,
            valid_from=base + timedelta(hours=5),
        )
    )

    by_type = await world_store.query_nodes(NodeFilter(node_type="ObjectInstance"))
    ids = {n.node_id for n in by_type}
    assert inst in ids and schema not in ids

    by_level = await world_store.query_nodes(
        NodeFilter(schema_level=SchemaLevel.SCHEMA)
    )
    ids = {n.node_id for n in by_level}
    assert schema in ids and inst not in ids

    by_conf = await world_store.query_nodes(NodeFilter(min_confidence=0.9))
    ids = {n.node_id for n in by_conf}
    assert schema in ids and inst not in ids

    # Half-open temporal window [start, end).
    window = TemporalWindow(
        start=base, end=base + timedelta(hours=3)
    )
    in_window = await world_store.query_nodes(NodeFilter(temporal_window=window))
    ids = {n.node_id for n in in_window}
    assert inst in ids and schema not in ids

    # get_nodes_in_temporal_window agrees.
    tw = await world_store.get_nodes_in_temporal_window(window)
    ids = {n.node_id for n in tw}
    assert inst in ids and schema not in ids


@pytest.mark.asyncio
async def test_embedding_similarity(world_store) -> None:
    a = _tid("emb-a")
    b = _tid("emb-b")
    c = _tid("emb-c")
    await world_store.save_node(
        KnowledgeNode(
            node_id=a, node_type="VisualObject",
            schema_level=SchemaLevel.INSTANCE,
            properties={"embedding": [1.0, 0.0, 0.0], "label_raw": "cup"},
            provenance=_prov(), confidence=0.8,
        )
    )
    await world_store.save_node(
        KnowledgeNode(
            node_id=b, node_type="VisualObject",
            schema_level=SchemaLevel.INSTANCE,
            properties={"embedding": [0.99, 0.01, 0.0], "label_raw": "cup"},
            provenance=_prov(), confidence=0.8,
        )
    )
    await world_store.save_node(
        KnowledgeNode(
            node_id=c, node_type="VisualObject",
            schema_level=SchemaLevel.INSTANCE,
            properties={"embedding": [0.0, 0.0, 1.0], "label_raw": "cup"},
            provenance=_prov(), confidence=0.8,
        )
    )

    res = await world_store.find_similar_nodes([1.0, 0.0, 0.0], threshold=0.9, limit=10)
    found = {n.node_id for n, _ in res}
    assert a in found and b in found and c not in found
    # Sorted by descending similarity: a (==1.0) before b.
    ordered = [n.node_id for n, _ in res if n.node_id in {a, b}]
    assert ordered[0] == a

    # find_nodes_by_embedding with schema_level filter + custom key.
    res2 = await world_store.find_nodes_by_embedding(
        [1.0, 0.0, 0.0], embedding_key="embedding",
        min_similarity=0.9, schema_level=SchemaLevel.INSTANCE,
    )
    assert a in {n.node_id for n, _ in res2}

    # get_nodes_with_embedding (filter, not weight) honours label_raw.
    emb_nodes = await world_store.get_nodes_with_embedding(
        "embedding", SchemaLevel.INSTANCE, label_raw="cup"
    )
    assert {a, b, c}.issubset({n.node_id for n in emb_nodes})
    emb_none = await world_store.get_nodes_with_embedding(
        "embedding", SchemaLevel.INSTANCE, label_raw="nonexistent-label"
    )
    assert all(n.node_id not in {a, b, c} for n in emb_none)


@pytest.mark.asyncio
async def test_apply_type_split(world_store) -> None:
    original = _tid("split-original")
    inst_a = _tid("split-inst-a")
    inst_b = _tid("split-inst-b")
    await world_store.save_node(
        KnowledgeNode(
            node_id=original, node_type="SchemaType",
            schema_level=SchemaLevel.SCHEMA, properties={"type_name": "cup"},
            provenance=_prov(ProvenanceSource.INFERENCE), confidence=1.0,
        )
    )
    for nid in (inst_a, inst_b):
        await world_store.save_node(
            KnowledgeNode(
                node_id=nid, node_type="ObjectInstance",
                schema_level=SchemaLevel.INSTANCE, properties={},
                provenance=_prov(), confidence=0.8,
            )
        )
        await world_store.save_edge(
            KnowledgeEdge(
                edge_id=EdgeId(f"{_TEST_PREFIX}io-{nid}"),
                source_id=nid, target_id=original, edge_type="INSTANCE_OF",
                provenance=_prov(), confidence=0.9,
            )
        )

    type_a, type_b = await world_store.apply_type_split(
        original_type_id=original,
        new_type_a_name="mug",
        new_type_b_name="tumbler",
        instances_for_a=[inst_a],
        instances_for_b=[inst_b],
        source_id="p33-split",
    )

    # New types exist at SCHEMA level with INFERENCE provenance.
    na = await world_store.get_node(type_a)
    nb = await world_store.get_node(type_b)
    assert na is not None and na.schema_level == SchemaLevel.SCHEMA
    assert na.provenance.source == ProvenanceSource.INFERENCE
    assert na.properties["type_name"] == "mug"
    assert nb is not None and nb.properties["type_name"] == "tumbler"

    # Instances re-typed to the new types (old INSTANCE_OF edges gone).
    assert await world_store.get_instance_type(inst_a) == type_a
    assert await world_store.get_instance_type(inst_b) == type_b

    # SPLIT_FROM edges A->original and B->original exist.
    split_edges = await world_store.query_edges(EdgeFilter(edge_type="SPLIT_FROM"))
    pairs = {(e.source_id, e.target_id) for e in split_edges}
    assert (type_a, original) in pairs
    assert (type_b, original) in pairs

    # Original marked SUPERSEDED with valid_to set.
    orig = await world_store.get_node(original)
    assert orig is not None
    assert orig.status == NodeStatus.SUPERSEDED
    assert orig.valid_to is not None

    # Clean up the system-generated split nodes (not test-prefixed).
    await world_store.delete_node(type_a)
    await world_store.delete_node(type_b)


@pytest.mark.asyncio
async def test_property_expectations(world_store) -> None:
    stid = _tid("exp-type")
    exp = PropertyExpectation(
        expectation_id=f"{_TEST_PREFIX}exp-1",
        schema_type_id=stid,
        property_key="embedding",
        mean_vector=[0.1, 0.2, 0.3],
        variance=0.04,
        sample_count=7,
        confirmation_count=5,
        prediction_errors=2,
        confidence=0.71,
        provenance=ProvenanceSource.INFERENCE,
        is_active=True,
    )
    await world_store.save_property_expectation(exp)
    got = await world_store.get_property_expectations(stid)
    assert len(got) == 1
    assert got[0].expectation_id == exp.expectation_id
    assert got[0].mean_vector == pytest.approx([0.1, 0.2, 0.3])
    assert got[0].sample_count == 7
    assert got[0].provenance == ProvenanceSource.INFERENCE
    assert got[0].is_active is True

    # Upsert replaces (HAS_EXPECTATION edge not duplicated).
    exp2 = exp.model_copy(update={"sample_count": 99})
    await world_store.save_property_expectation(exp2)
    got2 = await world_store.get_property_expectations(stid)
    assert len(got2) == 1
    assert got2[0].sample_count == 99


@pytest.mark.asyncio
async def test_similar_to_cluster(world_store) -> None:
    """A 3-node SIMILAR_TO clique forms one cluster via the in-memory delegate."""
    members = [_tid(f"clust-{i}") for i in range(3)]
    for i, nid in enumerate(members):
        await world_store.save_node(
            KnowledgeNode(
                node_id=nid, node_type="VisualObject",
                schema_level=SchemaLevel.INSTANCE,
                properties={"label_raw": "widget", "session_id": f"sess-{i % 2}"},
                provenance=_prov(), confidence=0.8,
            )
        )
    # Fully connect the clique with high-confidence SIMILAR_TO edges.
    pairs = [(0, 1), (1, 2), (0, 2)]
    for j, (s, t) in enumerate(pairs):
        await world_store.save_edge(
            KnowledgeEdge(
                edge_id=EdgeId(f"{_TEST_PREFIX}sim-{j}"),
                source_id=members[s], target_id=members[t],
                edge_type="SIMILAR_TO", provenance=_prov(), confidence=0.95,
            )
        )

    clusters = await world_store.get_similar_to_cluster(
        label_raw="widget", min_similarity=0.9, min_cluster_size=3
    )
    assert len(clusters) == 1
    cl = clusters[0]
    assert set(cl.member_node_ids) == set(members)
    assert cl.mean_pairwise_similarity == pytest.approx(0.95)
    assert cl.label_raw_distribution == {"widget": 3}
    assert set(cl.session_ids) == {"sess-0", "sess-1"}


@pytest.mark.asyncio
async def test_schema_proposal_and_primitives_and_grounding(world_store) -> None:
    # get_schema_proposal: only returns SchemaProposal-typed nodes.
    prop_id = _tid("proposal-1")
    await world_store.save_node(
        KnowledgeNode(
            node_id=prop_id, node_type="SchemaProposal",
            schema_level=SchemaLevel.SCHEMA, properties={"name": "new-type"},
            provenance=_prov(ProvenanceSource.INFERENCE), confidence=0.5,
        )
    )
    not_prop = _tid("not-proposal")
    await world_store.save_node(
        KnowledgeNode(
            node_id=not_prop, node_type="ObjectInstance",
            schema_level=SchemaLevel.INSTANCE, properties={},
            provenance=_prov(), confidence=0.5,
        )
    )
    assert (await world_store.get_schema_proposal(prop_id)) is not None
    assert (await world_store.get_schema_proposal(not_prop)) is None

    # Primitive symbols.
    psid = f"{_TEST_PREFIX}primitive:self_other"
    await world_store.save_primitive_symbol(psid, "Self_Other", "a primitive")
    one = await world_store.get_primitive_symbol(psid)
    assert one is not None and one["name"] == "Self_Other"
    all_prims = await world_store.get_all_primitive_symbols()
    assert any(p["node_id"] == psid for p in all_prims)

    # Grounding failures (nested snapshot JSON round-trips).
    gfid = f"{_TEST_PREFIX}grounding-failure:foo:1"
    await world_store.save_grounding_failure(
        node_id=gfid,
        triggering_word="foo",
        surrounding_words=["a", "b"],
        primitive_activation_snapshot={"primitive:x": 0.5, "primitive:y": 0.25},
        session_id="sess-g",
        timestamp="2026-01-01T00:00:00+00:00",
    )
    unprocessed = await world_store.get_unprocessed_grounding_failures(limit=50)
    mine = [g for g in unprocessed if g["node_id"] == gfid]
    assert len(mine) == 1
    assert mine[0]["surrounding_words"] == ["a", "b"]
    assert mine[0]["primitive_activation_snapshot"] == {
        "primitive:x": 0.5,
        "primitive:y": 0.25,
    }
    await world_store.mark_grounding_failures_processed([gfid])
    still = await world_store.get_unprocessed_grounding_failures(limit=50)
    assert all(g["node_id"] != gfid for g in still)


@pytest.mark.asyncio
async def test_health_check(world_store) -> None:
    assert (await world_store.health_check()) is True


# ---------------------------------------------------------------------------
# KG isolation -- the make-or-break invariant (atlas P3.A)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_kg_isolation_world_vs_other(world_store, other_store) -> None:
    """:VisualObject lives in WORLD only; :Person/:FaceSnapshot in OTHER only.

    And no edge crosses instances: every edge in an instance has both
    endpoints local to that instance.
    """
    # --- WORLD: visual objects + an edge between them ---
    vo1 = _tid("iso-visual-1")
    vo2 = _tid("iso-visual-2")
    await world_store.save_node(
        KnowledgeNode(
            node_id=vo1, node_type="VisualObject",
            schema_level=SchemaLevel.INSTANCE,
            properties={"label_raw": "cup", "bounding_box": [[0, 0], [5, 5]]},
            provenance=_prov(), confidence=0.8,
        )
    )
    await world_store.save_node(
        KnowledgeNode(
            node_id=vo2, node_type="VisualObject",
            schema_level=SchemaLevel.INSTANCE,
            properties={"label_raw": "table"},
            provenance=_prov(), confidence=0.8,
        )
    )
    await world_store.save_edge(
        KnowledgeEdge(
            edge_id=EdgeId(f"{_TEST_PREFIX}iso-world-edge"),
            source_id=vo1, target_id=vo2, edge_type="SPATIAL_ON",
            provenance=_prov(), confidence=0.7,
        )
    )

    # --- OTHER: a person + a face snapshot + an edge between them ---
    person = _tid("iso-person-1")
    face = _tid("iso-face-1")
    await other_store.save_node(
        KnowledgeNode(
            node_id=person, node_type="Person",
            schema_level=SchemaLevel.INSTANCE, properties={"name": "guardian"},
            provenance=_prov(ProvenanceSource.GUARDIAN), confidence=0.9,
        )
    )
    await other_store.save_node(
        KnowledgeNode(
            node_id=face, node_type="FaceSnapshot",
            schema_level=SchemaLevel.INSTANCE,
            properties={"embedding": [0.1, 0.2, 0.3]},
            provenance=_prov(), confidence=0.8,
        )
    )
    await other_store.save_edge(
        KnowledgeEdge(
            edge_id=EdgeId(f"{_TEST_PREFIX}iso-other-edge"),
            source_id=person, target_id=face, edge_type="HAS_FACE",
            provenance=_prov(), confidence=0.85,
        )
    )

    # --- Assert label-scoped isolation via raw Cypher (test-prefixed only) ---
    def _labels_present(store, label: str) -> int:
        with store._driver.session(database=store._database) as session:
            rec = session.run(
                f"MATCH (n:{label}) WHERE n.node_id STARTS WITH $prefix "
                "RETURN count(n) AS c",
                prefix=_TEST_PREFIX,
            ).single()
            return rec["c"]

    # VisualObject: present in WORLD, absent in OTHER.
    assert _labels_present(world_store, "VisualObject") == 2
    assert _labels_present(other_store, "VisualObject") == 0

    # Person / FaceSnapshot: present in OTHER, absent in WORLD.
    assert _labels_present(other_store, "Person") == 1
    assert _labels_present(other_store, "FaceSnapshot") == 1
    assert _labels_present(world_store, "Person") == 0
    assert _labels_present(world_store, "FaceSnapshot") == 0

    # --- No edge crosses instances: every test edge's endpoints are local ---
    def _all_edge_endpoints_local(store) -> bool:
        """True if every test-prefixed edge has both endpoints in THIS instance."""
        with store._driver.session(database=store._database) as session:
            # An edge "crosses" if either endpoint node_id is not present as a
            # node in this instance. Since each instance only stores its own
            # nodes, a crossing edge would have a dangling endpoint. We assert
            # that for every test edge, both source_id and target_id resolve to
            # a local :KnowledgeNode.
            rec = session.run(
                "MATCH ()-[r]->() WHERE r.edge_id STARTS WITH $prefix "
                "WITH r.source_id AS s, r.target_id AS t "
                "OPTIONAL MATCH (sn:KnowledgeNode {node_id: s}) "
                "OPTIONAL MATCH (tn:KnowledgeNode {node_id: t}) "
                "RETURN count(*) AS total, "
                "sum(CASE WHEN sn IS NOT NULL AND tn IS NOT NULL THEN 1 ELSE 0 END) AS local",
                prefix=_TEST_PREFIX,
            ).single()
            return rec["total"] == rec["local"] and rec["total"] > 0

    assert _all_edge_endpoints_local(world_store)
    assert _all_edge_endpoints_local(other_store)

    # And cross-check: the WORLD edge endpoints do NOT exist in OTHER, and the
    # OTHER edge endpoints do NOT exist in WORLD -- so neither edge could span.
    def _node_exists(store, node_id) -> bool:
        with store._driver.session(database=store._database) as session:
            rec = session.run(
                "MATCH (n:KnowledgeNode {node_id: $nid}) RETURN count(n) AS c",
                nid=str(node_id),
            ).single()
            return rec["c"] > 0

    assert _node_exists(world_store, vo1) and not _node_exists(other_store, vo1)
    assert _node_exists(other_store, person) and not _node_exists(world_store, person)
