"""Graph traversal and query constants for the Co-Being knowledge graph.

These constants are referenced by read query functions and any component that
traverses the graph. They encode operational limits that protect query
performance at scale (D-TS-11).

Usage::

    from cobeing.layer3_knowledge.constants import MAX_TRAVERSAL_DEPTH

    # Enforce depth limit in a traversal loop
    if current_depth >= MAX_TRAVERSAL_DEPTH:
        break
"""

MAX_TRAVERSAL_DEPTH: int = 5
"""Maximum depth for graph traversal queries (D-TS-11).

Unbounded graph traversal is O(V+E) and unacceptable for real-time queries
at the target scale of 100,000+ nodes. Every traversal query must respect
this limit. The query interface enforces it -- callers may not override it
without an explicit CANON amendment.
"""

__all__ = ["MAX_TRAVERSAL_DEPTH"]
