"""Layer 3: Knowledge Graph -- where all value accumulates.

This package contains the core domain types, persistence protocols, and
graph operations for the Co-Being knowledge graph. The graph is the
architectural center of gravity (CANON Section 3): everything else either
writes to it (sensors, perception, human input) or reads from it
(reasoning, exploration planning, communication).

Public API::

    from cobeing.layer3_knowledge import (
        # Enums
        SchemaLevel, NodeStatus,
        # Domain types
        KnowledgeNode, KnowledgeEdge,
        # Query and filter types
        EdgeFilter, NodeFilter, TemporalWindow, SchemaHealthReport,
        # Persistence protocols
        GraphPersistence,
        BehavioralStore,
        # In-memory test double
        InMemoryGraphPersistence,
        # Bootstrap
        BootstrapResult, COBEING_SELF_NODE_ID, bootstrap_graph,
        # Observation ingestion
        IngestionResult, ObservationSession,
        add_observation, create_observation_session, close_observation_session,
        # Spatial relationships
        SpatialResult, add_spatial_relationship,
        # Temporal queries
        get_scene_at, get_provenance_chain,
        # Confidence decay
        DecayResult, run_confidence_decay,
        # Persistence check (CANON A.5 narrow Layer 2 read path)
        PersistenceResult, find_matching_object,
        # Read queries (Layer 4 primary read interface)
        get_current_scene, get_changes_since, get_spatial_relationships,
        get_object_history, get_type_instances, get_schema_types,
        get_pending_proposals, get_untyped_instances,
        # Health metrics (D-TS-08)
        get_health_metrics,
        # Guardian operations (T012)
        GuardianStatementResult, SchemaProposalResult, SchemaTypeResult,
        add_guardian_statement, create_schema_proposal,
        apply_schema_proposal, reject_schema_proposal,
        # Integrity validation and attractor warnings (T013c)
        IntegrityFinding, AttractorWarning,
        validate_graph_integrity, check_attractor_warnings,
        # Expectation and similarity data model types (Epic 4, T043a)
        PropertyExpectation, SimilarityCluster,
        # Similarity result and event types (Epic 4, T044)
        SimilarityResult, SimilarityComputedEvent,
        # Similarity computation (Epic 4, T045)
        SimilarityComputer,
        # Expectation manager and prediction check result (Epic 4, T046a/T046b)
        ExpectationManager, PredictionCheckResult,
        # Expectation verification event types (Epic 4, T044)
        PredictionError, PredictionErrorDetectedEvent, PredictionSuccessEvent,
        # Behavioral event types (Epic 5, T051a)
        ProposalOutcomeValue, RejectionReasonCategory, GapState,
        ProposalOutcome, CorrectionEvent,
        # Behavioral verification and gap types (Epic 5, T051b)
        VerificationResult, GapLifecycleEvent,
        VerificationCompleteEvent, GapLifecycleTransitionEvent,
        # Session summary and baseline types (Epic 5, T051c)
        SessionSummary, BaselineMetric, BehavioralBaseline,
        BehavioralBaselineEstablishedEvent, SessionSummaryProducedEvent,
        # Encoding strength (P2-OLA, CANON A.24.3.2)
        compute_encoding_strength,
        # Consolidation engine (Phase 1.9, Epic 3)
        ConsolidationEngine,
        ConsolidationAnalysis, ConsolidationReport,
        FailurePattern, ConfidenceTrend, SchemaProposal,
        # Constants
        MAX_TRAVERSAL_DEPTH,
        # Exceptions
        KnowledgeGraphError, NodeNotFoundError, EdgeNotFoundError,
        SchemaViolationError, BootstrapError, SchemaNotInitializedError,
        SimilarityError, ExpectationError,
    )
"""

from .behavioral_events import (
    BaselineMetric,
    BehavioralBaseline,
    BehavioralBaselineEstablishedEvent,
    CorrectionEvent,
    GapLifecycleEvent,
    GapLifecycleTransitionEvent,
    GapState,
    ProposalOutcome,
    ProposalOutcomeValue,
    RejectionReasonCategory,
    SessionSummary,
    SessionSummaryProducedEvent,
    VerificationCompleteEvent,
    VerificationResult,
)
from .bootstrap import COBEING_SELF_NODE_ID, BootstrapResult, bootstrap_graph
from .confidence_decay import DecayResult, run_confidence_decay
from .encoding_strength import compute_encoding_strength
from .consolidation_engine import (
    ConfidenceTrend,
    ConsolidationAnalysis,
    ConsolidationEngine,
    ConsolidationReport,
    FailurePattern,
    SchemaProposal,
)
from .constants import MAX_TRAVERSAL_DEPTH
from .exceptions import (
    BootstrapError,
    EdgeNotFoundError,
    ExpectationError,
    KnowledgeGraphError,
    NodeNotFoundError,
    SchemaNotInitializedError,
    SchemaViolationError,
    SimilarityError,
)
from .expectation_manager import ExpectationManager, PredictionCheckResult
from .expectation_types import PropertyExpectation, SimilarityCluster
from .expectations import (
    PredictionError,
    PredictionErrorDetectedEvent,
    PredictionSuccessEvent,
)
from .guardian_operations import (
    GuardianStatementResult,
    SchemaProposalResult,
    SchemaTypeResult,
    add_guardian_statement,
    apply_schema_proposal,
    create_schema_proposal,
    reject_schema_proposal,
)
from .health_metrics import get_health_metrics
from .in_memory_persistence import InMemoryGraphPersistence
from .integrity_validation import (
    AttractorWarning,
    IntegrityFinding,
    check_attractor_warnings,
    validate_graph_integrity,
)
from .node_types import KnowledgeEdge, KnowledgeNode, NodeStatus, SchemaLevel
from .observation_ingestion import (
    IngestionResult,
    ObservationSession,
    add_observation,
    close_observation_session,
    create_observation_session,
)
from .persistence_check import PersistenceResult, find_matching_object
from .protocols import BehavioralStore, GraphPersistence
from .query_types import EdgeFilter, NodeFilter, SchemaHealthReport, TemporalWindow
from .read_queries import (
    get_changes_since,
    get_current_scene,
    get_object_history,
    get_pending_proposals,
    get_schema_types,
    get_spatial_relationships,
    get_type_instances,
    get_untyped_instances,
)
from .similarity import SimilarityComputedEvent, SimilarityResult
from .similarity_computer import SimilarityComputer
from .spatial_relationships import SpatialResult, add_spatial_relationship
from .temporal_queries import get_provenance_chain, get_scene_at

__all__ = [
    # Bootstrap
    "BootstrapResult",
    "COBEING_SELF_NODE_ID",
    "bootstrap_graph",
    # Constants
    "MAX_TRAVERSAL_DEPTH",
    # Enums
    "NodeStatus",
    "SchemaLevel",
    # Domain types
    "KnowledgeEdge",
    "KnowledgeNode",
    # Query and filter types
    "EdgeFilter",
    "NodeFilter",
    "SchemaHealthReport",
    "TemporalWindow",
    # Persistence protocols
    "BehavioralStore",
    "GraphPersistence",
    # In-memory test double
    "InMemoryGraphPersistence",
    # Observation ingestion
    "IngestionResult",
    "ObservationSession",
    "add_observation",
    "close_observation_session",
    "create_observation_session",
    # Spatial relationships
    "SpatialResult",
    "add_spatial_relationship",
    # Temporal queries
    "get_provenance_chain",
    "get_scene_at",
    # Confidence decay
    "DecayResult",
    "run_confidence_decay",
    # Persistence check (CANON A.5)
    "PersistenceResult",
    "find_matching_object",
    # Read queries (Layer 4 primary read interface)
    "get_changes_since",
    "get_current_scene",
    "get_object_history",
    "get_pending_proposals",
    "get_schema_types",
    "get_spatial_relationships",
    "get_type_instances",
    "get_untyped_instances",
    # Health metrics (D-TS-08)
    "get_health_metrics",
    # Guardian operations (T012)
    "GuardianStatementResult",
    "SchemaProposalResult",
    "SchemaTypeResult",
    "add_guardian_statement",
    "apply_schema_proposal",
    "create_schema_proposal",
    "reject_schema_proposal",
    # Integrity validation and attractor warnings (T013c)
    "AttractorWarning",
    "IntegrityFinding",
    "check_attractor_warnings",
    "validate_graph_integrity",
    # Expectation and similarity data model types (Epic 4, T043a)
    "PropertyExpectation",
    "SimilarityCluster",
    # Similarity result and event types (Epic 4, T044)
    "SimilarityComputedEvent",
    "SimilarityResult",
    # Similarity computation (Epic 4, T045)
    "SimilarityComputer",
    # Expectation manager and prediction check result (Epic 4, T046a/T046b)
    "ExpectationManager",
    "PredictionCheckResult",
    # Expectation verification event types (Epic 4, T044)
    "PredictionError",
    "PredictionErrorDetectedEvent",
    "PredictionSuccessEvent",
    # Behavioral event types (Epic 5, T051a)
    "CorrectionEvent",
    "GapState",
    "ProposalOutcome",
    "ProposalOutcomeValue",
    "RejectionReasonCategory",
    # Behavioral verification and gap types (Epic 5, T051b)
    "GapLifecycleEvent",
    "GapLifecycleTransitionEvent",
    "VerificationCompleteEvent",
    "VerificationResult",
    # Session summary and baseline types (Epic 5, T051c)
    "BaselineMetric",
    "BehavioralBaseline",
    "BehavioralBaselineEstablishedEvent",
    "SessionSummary",
    "SessionSummaryProducedEvent",
    # Encoding strength (P2-OLA, CANON A.24.3.2)
    "compute_encoding_strength",
    # Consolidation engine (Phase 1.9, Epic 3)
    "ConfidenceTrend",
    "ConsolidationAnalysis",
    "ConsolidationEngine",
    "ConsolidationReport",
    "FailurePattern",
    "SchemaProposal",
    # Exceptions
    "BootstrapError",
    "EdgeNotFoundError",
    "ExpectationError",
    "KnowledgeGraphError",
    "NodeNotFoundError",
    "SchemaNotInitializedError",
    "SchemaViolationError",
    "SimilarityError",
]
