"""Co-Being shared types, provenance, observations, and exceptions.

This package provides foundational types used across all layers of the
Co-Being system. Nothing in this package depends on any specific layer --
it is the leaf of the dependency tree.

Public API::

    from cobeing.shared import (
        # Identifiers
        NodeId, EdgeId, CorrelationId,
        # Provenance
        Provenance, ProvenanceSource,
        # Observations (Layer 2 / Layer 3 contract)
        Observation, BoundingBox,
        # Exceptions
        CoBeingError, GraphUnavailableError,
        # Circuit breaker
        CircuitBreaker, CircuitBreakerOpenError, CircuitBreakerState,
        # Event bus
        Event, EventBus, EventPriority,
    )
"""

from .circuit_breaker import CircuitBreaker, CircuitBreakerOpenError, CircuitBreakerState
from .event_bus import Event, EventBus, EventPriority
from .exceptions import CoBeingError, GraphUnavailableError
from .observation import BoundingBox, Observation
from .provenance import Provenance, ProvenanceSource
from .types import CorrelationId, EdgeId, NodeId

__all__ = [
    # Identifiers
    "NodeId",
    "EdgeId",
    "CorrelationId",
    # Provenance
    "Provenance",
    "ProvenanceSource",
    # Observations (Layer 2 / Layer 3 contract)
    "Observation",
    "BoundingBox",
    # Exceptions
    "CoBeingError",
    "GraphUnavailableError",
    # Circuit breaker
    "CircuitBreaker",
    "CircuitBreakerOpenError",
    "CircuitBreakerState",
    # Event bus
    "Event",
    "EventBus",
    "EventPriority",
]
