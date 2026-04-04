"""Co-Being shared type definitions.

Strongly-typed identifiers used across all layers of the Co-Being system.
Each identifier is a NewType wrapper over ``str``, which means:

- At runtime they are plain strings (zero overhead).
- At type-check time (mypy) they are distinct types, so you cannot
  accidentally pass a NodeId where an EdgeId is expected.

Usage::

    from cobeing.shared.types import NodeId, EdgeId, CorrelationId

    node = NodeId("node-abc-123")
    edge = EdgeId("edge-xyz-789")
    corr = CorrelationId("corr-001")

    # mypy will reject: process_node(edge)  -- EdgeId is not NodeId
"""

from typing import NewType

NodeId = NewType("NodeId", str)
"""Unique identifier for a node in the knowledge graph.

Wraps ``str``. Distinct from EdgeId and CorrelationId at type-check time.
Format is not enforced here -- the graph layer decides what values are valid.
"""

EdgeId = NewType("EdgeId", str)
"""Unique identifier for an edge (relationship) in the knowledge graph.

Wraps ``str``. Distinct from NodeId and CorrelationId at type-check time.
"""

CorrelationId = NewType("CorrelationId", str)
"""Identifier for tracing a single operation across multiple components.

Wraps ``str``. Typically a UUID4 string, but format is not enforced here.
Used in structured logging to correlate log entries from a camera frame
through perception, into the knowledge graph, and through any LLM reasoning
it triggers.
"""

__all__ = ["NodeId", "EdgeId", "CorrelationId"]
