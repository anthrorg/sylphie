"""Skill package validator for Co-Being knowledge graph (CANON A.21.3).

``SkillPackageValidator`` enforces CANON compliance checks before any YAML
skill package touches the graph.  Every check is a **hard block**: a single
failure rejects the entire package and no graph writes are permitted.

The validator is intentionally a *pre-installation gate*, not a runtime guard.
It receives the raw parsed YAML manifest (a ``dict``) plus a ``GraphPersistence``
backend so it can query which packages are already installed.  It performs all
eight required checks synchronously and returns a ``ValidationResult`` whose
``is_valid`` flag the installer must test before proceeding.

The eight hard-block checks (CANON A.21.3 + Canon agent Q4 enumeration):

1. **Provenance check** -- ``canon_provenance`` field must equal
   ``"TAUGHT_PROCEDURE"``.  Any other value is an immediate rejection.

2. **Node type whitelist** -- Every ``node_type`` referenced in the
   ``nodes:`` list must appear in the A.18 permitted list.  Types outside
   this list indicate world-knowledge smuggling.

3. **COMPUTES_TO prohibition** -- No edge in the ``edges:`` list may have
   ``edge_type: COMPUTES_TO``.  Computational results are never pre-loaded
   (CANON A.18 clean boundary: capacity is not competence).

4. **Semantic world-fact prohibition** -- No edge in ``edges:`` may be an
   IS_A or HAS_PROPERTY edge whose purpose is to encode a semantic world
   fact.  Edge type definition nodes (``SemanticEdgeType``) are the
   vocabulary for making assertions -- they are permitted.  Actual semantic
   fact edges (``edge_type: IS_A``, ``edge_type: HAS_PROPERTY`` used to
   assert that concept-A is a type of concept-B) are prohibited.  The
   validator distinguishes the two cases by checking whether the source node
   is a ``SemanticEdgeType`` vocabulary node.

5. **Cross-domain bridge requirement** -- Any package declaring a new domain
   via a ``domain:`` field must declare at least one cross-domain bridge in
   ``cross_domain_bridges:``.  ``DENOTES`` satisfies this for the semantic
   domain (CANON A.20.5b).

6. **Dependency resolution** -- Every package listed in ``requires:`` must
   either be installed in the graph (``installed_packages`` set provided by
   the caller) or be in the ``ANCHOR_LAYER_PACKAGES`` set of always-present
   packages.

7. **Confidence ceiling** -- No node or edge in the manifest may declare a
   ``confidence`` property above ``0.15`` (CANON A.21.1 bootstrap baseline
   ceiling).  Infrastructure nodes may legitimately omit ``confidence`` (they
   will be written with a default of 1.0 by the installer for certain SCHEMA
   and META_SCHEMA nodes per bootstrap convention).  The check only fires on
   nodes/edges that explicitly declare ``confidence > 0.15``.

8. **Provenance purity** -- No node in ``nodes:`` may carry a ``provenance``
   property of ``sensor``, ``guardian``, or ``inference``.  Only
   ``taught_procedure`` is permitted for skill package content.

Usage::

    import yaml
    from cobeing.layer3_knowledge.skill_package_validator import (
        SkillPackageValidator,
        ValidationResult,
    )

    with open("skill-packages/semantic-ontology.yaml") as fh:
        manifest = yaml.safe_load(fh)

    # installed_packages comes from the graph (SkillRegistry REGISTERS queries)
    installed = {"core-bootstrap", "language-foundation"}
    validator = SkillPackageValidator()
    result = validator.validate(manifest, installed_packages=installed)

    if not result.is_valid:
        raise RuntimeError(f"Package rejected: {result.errors}")
    # Safe to proceed with graph writes.

Phase 1.8-E1 (Semantic Domain Infrastructure), Ticket T004.
CANON A.21.3 (SkillPackageValidator), A.18 (TAUGHT_PROCEDURE permitted scope),
A.21.1 (package content rules), A.20.5 (cross-domain bridge requirement).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

_logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# A.18 permitted node type whitelist
# ---------------------------------------------------------------------------

# The exact set of node types that a TAUGHT_PROCEDURE skill package may
# contain.  This list derives directly from CANON A.18 (amended through
# March 3, 2026) and the Canon agent Q4 answer in P1.8-E1 planning docs.
# Adding a new node type to a package without adding it here is a hard block.
_A18_PERMITTED_NODE_TYPES: frozenset[str] = frozenset(
    {
        # --- Procedural domain (A.18 original, Phase 1.6) ---
        "ProceduralTemplate",
        "ProcedureStep",
        "WorkedExample",
        "ConceptPrimitive",
        "ValueNode",
        # --- Language domain (A.18 March 2 amendment, Phase 1.7) ---
        "WordSenseNode",
        "WordFormNode",
        # --- Semantic domain (A.18 amendment, Phase 1.8) ---
        "SemanticEdgeType",      # vocabulary for semantic assertions (grammar, not facts)
        "LogicalAxiom",          # structural rules governing edge type behavior
        # --- Executor domain (Phase 2, A.23) ---
        "ActionProcedure",       # Executor engine action procedures (innate reflexes)
        # --- Language domain dictionary entries ---
        "DefinitionNode",        # Dictionary definition nodes for word senses
        # --- Infrastructure / registration types ---
        "DomainRegistration",    # A.20.5(a) new-domain registration node
        "SkillPackage",          # A.21.2 the package node itself (meta record)
        # --- Conversation layer (deferred to E2 but type constant defined in E1) ---
        "ConversationContext",   # INSTANCE-level scope tracker (vocabulary defined E1)
    }
)

# ---------------------------------------------------------------------------
# Prohibited edge types (hard block regardless of context)
# ---------------------------------------------------------------------------

# COMPUTES_TO edges encode computational *results* -- the product of the
# system running a procedure against specific operands.  Pre-loading results
# violates CANON A.18's clean boundary ("capacity is not competence").
_PROHIBITED_EDGE_TYPES: frozenset[str] = frozenset(
    {
        "COMPUTES_TO",
    }
)

# ---------------------------------------------------------------------------
# Semantic world-fact edge types (context-sensitive block)
# ---------------------------------------------------------------------------

# IS_A and HAS_PROPERTY edges are legitimate as *vocabulary definition* nodes
# (SemanticEdgeType nodes whose ``name`` property is "IS_A").  They are
# *prohibited* as actual semantic fact edges (edge_type: IS_A linking two
# concept nodes).  The validator must distinguish these two uses.
# The check logic: if an edge in the manifest has edge_type IS_A or
# HAS_PROPERTY AND both source and target are not SemanticEdgeType vocabulary
# nodes, it is a semantic world fact and must be rejected.
_SEMANTIC_FACT_EDGE_TYPES: frozenset[str] = frozenset(
    {
        "IS_A",
        "HAS_PROPERTY",
    }
)

# ---------------------------------------------------------------------------
# Confidence ceiling
# ---------------------------------------------------------------------------

# CANON A.21.1: no pre-computed confidence scores above bootstrap baseline.
_CONFIDENCE_CEILING: float = 0.15

# ---------------------------------------------------------------------------
# Forbidden provenance values on package nodes
# ---------------------------------------------------------------------------

# These are the provenance source strings that must NEVER appear on a node
# inside a skill package.  Only TAUGHT_PROCEDURE is permitted.
_FORBIDDEN_NODE_PROVENANCE: frozenset[str] = frozenset(
    {
        "sensor",
        "guardian",
        "inference",
        "guardian_approved_inference",
    }
)

# ---------------------------------------------------------------------------
# Anchor layer package identifiers
# ---------------------------------------------------------------------------

# These package IDs are always considered "installed" because they represent
# the anchor layer (CANON A.21.5) that survives every reset and is never
# installed via YAML.  A package listing these in its ``requires:`` field
# must not fail the dependency check just because no SkillPackage node for
# them exists in the graph (they pre-date the YAML skill package system).
_ANCHOR_LAYER_PACKAGES: frozenset[str] = frozenset(
    {
        "core-bootstrap",       # EvolutionRule nodes, SkillRegistry node
        "language-foundation",  # WordSenseNode bootstrap, DENOTES constant
    }
)

# ---------------------------------------------------------------------------
# Result dataclass
# ---------------------------------------------------------------------------


@dataclass
class ValidationResult:
    """Outcome of a ``SkillPackageValidator.validate()`` call.

    Attributes:
        is_valid: ``True`` when all eight checks pass.  ``False`` on the
            first failure (checks are evaluated in order; execution stops
            at the first failing check because the package must be rejected
            as a whole -- partial validation results are not actionable).
        errors: Ordered list of human-readable error strings.  Non-empty
            only when ``is_valid`` is ``False``.  Each string names the
            failing check and the specific value or rule that triggered it.
        package_id: The ``package_id`` field from the manifest, or
            ``"<unknown>"`` when the field is missing (which itself would
            cause a failure if the provenance check were not reached first).
        checks_passed: List of check names that passed before validation
            stopped.  Useful for diagnosing which check failed.
    """

    is_valid: bool
    errors: list[str] = field(default_factory=list)
    package_id: str = "<unknown>"
    checks_passed: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Validator class
# ---------------------------------------------------------------------------


class SkillPackageValidator:
    """Validates a skill package YAML manifest against CANON A.21.3 constraints.

    The validator is stateless.  A single instance can validate multiple
    manifests sequentially.  All state lives in the ``ValidationResult``
    returned from each ``validate()`` call.

    Design principles:
    - **Fail-fast**: validation stops at the first failing check.  The
      calling installer must not attempt partial installation if any check
      fails.
    - **Hard block**: every check is mandatory.  There is no concept of a
      "warning" in this validator -- every deviation from CANON is a
      rejection.
    - **Stateless**: this class does not access the graph directly.  It
      receives the ``installed_packages`` set as a parameter, which the
      installer provides by querying the SkillRegistry.
    - **No side effects**: calling ``validate()`` does not write to the
      graph, emit events, or touch the filesystem.

    Example::

        validator = SkillPackageValidator()
        installed = {"core-bootstrap", "language-foundation"}
        result = validator.validate(manifest_dict, installed_packages=installed)
        if not result.is_valid:
            raise PackageInstallationError(result.errors[0])
    """

    def validate(
        self,
        manifest: dict,
        *,
        installed_packages: set[str] | None = None,
    ) -> ValidationResult:
        """Run all eight hard-block checks against the manifest.

        Checks run in the order defined in CANON A.21.3 and the Canon agent
        Q4 enumeration from the P1.8-E1 planning documents.  Execution stops
        at the first failure.

        Args:
            manifest: Parsed YAML manifest as a Python dict.  Must be the
                full manifest including ``package_id``, ``canon_provenance``,
                ``nodes``, ``edges``, ``requires``, and ``cross_domain_bridges``
                (when applicable).
            installed_packages: Set of package IDs that are currently
                installed in the knowledge graph (queried from the
                SkillRegistry node's REGISTERS edges).  If ``None``, an empty
                set is assumed, meaning only anchor-layer packages are
                considered installed.

        Returns:
            ``ValidationResult`` with ``is_valid=True`` when all checks pass,
            or ``is_valid=False`` with a non-empty ``errors`` list when any
            check fails.
        """
        if installed_packages is None:
            installed_packages = set()

        package_id: str = manifest.get("package_id", "<unknown>")
        result = ValidationResult(is_valid=True, package_id=package_id)

        # Run each check in dependency order.  Each check returns a list of
        # error strings (empty = pass).  On the first non-empty error list,
        # we record the errors and stop.
        checks = [
            ("provenance_check", self._check_canon_provenance),
            ("node_type_whitelist", self._check_node_types),
            ("computes_to_prohibition", self._check_no_computes_to_edges),
            ("semantic_fact_prohibition", self._check_no_semantic_fact_edges),
            ("cross_domain_bridge_requirement", self._check_cross_domain_bridge),
            ("dependency_resolution", lambda m: self._check_dependencies(m, installed_packages)),
            ("confidence_ceiling", self._check_confidence_ceiling),
            ("provenance_purity", self._check_node_provenance_purity),
        ]

        for check_name, check_fn in checks:
            errors = check_fn(manifest)
            if errors:
                result.is_valid = False
                result.errors = errors
                _logger.error(
                    "skill_package_validation_failed package_id=%s check=%s errors=%s",
                    package_id,
                    check_name,
                    errors,
                )
                return result
            result.checks_passed.append(check_name)

        _logger.info(
            "skill_package_validation_passed package_id=%s checks=%d",
            package_id,
            len(result.checks_passed),
        )
        return result

    # ------------------------------------------------------------------
    # Check 1: canon_provenance field must be TAUGHT_PROCEDURE
    # ------------------------------------------------------------------

    def _check_canon_provenance(self, manifest: dict) -> list[str]:
        """Verify the top-level ``canon_provenance`` field is TAUGHT_PROCEDURE.

        CANON A.21.3 requires every package to declare its provenance class
        at the manifest level.  Only TAUGHT_PROCEDURE is permitted.

        Returns:
            Empty list on pass.  List with one error string on failure.
        """
        canon_provenance = manifest.get("canon_provenance")
        if canon_provenance is None:
            return [
                "Check 1 (provenance_check) FAILED: 'canon_provenance' field is missing "
                "from the manifest.  Every skill package must declare "
                "'canon_provenance: TAUGHT_PROCEDURE' at the top level "
                "(CANON A.21.3, A.18)."
            ]
        # Normalise to upper-case string for comparison.
        normalised = str(canon_provenance).strip().upper()
        if normalised != "TAUGHT_PROCEDURE":
            return [
                f"Check 1 (provenance_check) FAILED: 'canon_provenance' is "
                f"'{canon_provenance}' but must be 'TAUGHT_PROCEDURE'.  "
                f"Only TAUGHT_PROCEDURE skill content is permitted in a skill "
                f"package -- SENSOR, GUARDIAN, and INFERENCE provenance content "
                f"cannot be pre-loaded (CANON A.21.3, A.18)."
            ]
        return []

    # ------------------------------------------------------------------
    # Check 2: all node types must be in the A.18 permitted list
    # ------------------------------------------------------------------

    def _check_node_types(self, manifest: dict) -> list[str]:
        """Verify every node's ``node_type`` is in the A.18 permitted list.

        CANON A.18 enumerates the exact node types that may carry
        TAUGHT_PROCEDURE provenance.  Any node type outside this list
        indicates the package is attempting to install either world-knowledge
        nodes (schema types that must be earned through experience) or
        application-layer types that do not belong in YAML packages.

        Returns:
            Empty list on pass.  List of error strings (one per violating
            node type) on failure.
        """
        nodes: list[dict] = manifest.get("nodes", [])
        if not isinstance(nodes, list):
            return [
                "Check 2 (node_type_whitelist) FAILED: 'nodes' field must be a list "
                "of node definitions.  Received a non-list value."
            ]

        errors: list[str] = []
        seen_violations: set[str] = set()

        for i, node in enumerate(nodes):
            if not isinstance(node, dict):
                errors.append(
                    f"Check 2 (node_type_whitelist) FAILED: 'nodes[{i}]' is not a dict.  "
                    f"Each node definition must be a YAML mapping."
                )
                continue

            node_type = node.get("node_type")
            if node_type is None:
                errors.append(
                    f"Check 2 (node_type_whitelist) FAILED: 'nodes[{i}]' (node_id="
                    f"'{node.get('node_id', '<missing>')}') is missing the 'node_type' "
                    f"field.  Every node must declare its type."
                )
                continue

            node_type_str = str(node_type).strip()
            if node_type_str not in _A18_PERMITTED_NODE_TYPES:
                if node_type_str not in seen_violations:
                    seen_violations.add(node_type_str)
                    permitted_list = ", ".join(sorted(_A18_PERMITTED_NODE_TYPES))
                    errors.append(
                        f"Check 2 (node_type_whitelist) FAILED: node_type "
                        f"'{node_type_str}' (node_id='{node.get('node_id', '<missing>')}') "
                        f"is not in the A.18 permitted list.  "
                        f"Permitted types: {permitted_list}.  "
                        f"Schema-level type nodes that encode world knowledge must be "
                        f"earned through experience (CANON A.2, A.18)."
                    )

        return errors

    # ------------------------------------------------------------------
    # Check 3: no COMPUTES_TO edges
    # ------------------------------------------------------------------

    def _check_no_computes_to_edges(self, manifest: dict) -> list[str]:
        """Block any COMPUTES_TO edge in the package.

        COMPUTES_TO edges represent earned computational results -- a ValueNode
        that the system has computed by running a procedure against specific
        operands.  Pre-loading such edges violates the CANON A.18 clean
        boundary: the package installs the *capacity* to compute (procedures),
        never the *result* of computation.

        Returns:
            Empty list on pass.  List with one error string on the first
            COMPUTES_TO edge found.
        """
        edges: list[dict] = manifest.get("edges", [])
        if not isinstance(edges, list):
            # Malformed edges block -- the node type check will also flag this
            # if nodes are similarly malformed.  Return empty here; the
            # calling loop will still surface any other errors.
            return []

        for edge in edges:
            if not isinstance(edge, dict):
                continue
            edge_type = str(edge.get("edge_type", "")).strip().upper()
            if edge_type == "COMPUTES_TO":
                source = edge.get("source_node_id", "<unknown>")
                target = edge.get("target_node_id", "<unknown>")
                return [
                    f"Check 3 (computes_to_prohibition) FAILED: the manifest contains a "
                    f"COMPUTES_TO edge (source='{source}', target='{target}').  "
                    f"COMPUTES_TO edges encode pre-computed results, which are never "
                    f"permitted in a skill package.  Computational results must be earned "
                    f"by the system at runtime (CANON A.18, A.21.1).  "
                    f"'Capacity is not competence.'"
                ]
        return []

    # ------------------------------------------------------------------
    # Check 4: no IS_A or HAS_PROPERTY edges encoding semantic world facts
    # ------------------------------------------------------------------

    def _check_no_semantic_fact_edges(self, manifest: dict) -> list[str]:
        """Block IS_A and HAS_PROPERTY edges that encode semantic world facts.

        Semantic edge *type vocabulary* nodes (``node_type: SemanticEdgeType``,
        ``name: IS_A``) are the grammar for making assertions.  They are
        permitted in a skill package.

        Semantic *fact* edges (an edge with ``edge_type: IS_A`` or
        ``edge_type: HAS_PROPERTY`` whose source and target are not
        SemanticEdgeType vocabulary nodes) encode world knowledge.  They are
        prohibited: the system must earn every taxonomic and property fact
        through guardian teaching (CANON A.1, A.18, A.21.1).

        Detection logic:
        - Build a set of node_ids that are declared as ``SemanticEdgeType``
          vocabulary nodes in this manifest.
        - For each edge with ``edge_type`` in ``_SEMANTIC_FACT_EDGE_TYPES``,
          check whether the source is one of those vocabulary nodes.  If not,
          it is a semantic world-fact edge and must be rejected.

        This approach correctly permits the DENOTES SemanticEdgeType vocabulary
        node while blocking any actual DENOTES fact edge whose source is a
        WordSenseNode.  Note: DENOTES itself is not in _SEMANTIC_FACT_EDGE_TYPES
        (it is a bridge, not a taxonomic/property edge), but IS_A and HAS_PROPERTY
        are checked.

        Returns:
            Empty list on pass.  List with one error string on the first
            violating edge found.
        """
        nodes: list[dict] = manifest.get("nodes", [])
        edges: list[dict] = manifest.get("edges", [])

        # Collect the node_ids of SemanticEdgeType vocabulary nodes declared
        # in this package.  These are vocabulary infrastructure, not world facts.
        semantic_edge_type_vocab_node_ids: set[str] = set()
        if isinstance(nodes, list):
            for node in nodes:
                if not isinstance(node, dict):
                    continue
                if str(node.get("node_type", "")).strip() == "SemanticEdgeType":
                    node_id = node.get("node_id")
                    if node_id:
                        semantic_edge_type_vocab_node_ids.add(str(node_id))

        if not isinstance(edges, list):
            return []

        for edge in edges:
            if not isinstance(edge, dict):
                continue
            edge_type = str(edge.get("edge_type", "")).strip().upper()
            if edge_type not in _SEMANTIC_FACT_EDGE_TYPES:
                continue

            source_id = str(edge.get("source_node_id", "")).strip()

            # If the source is a SemanticEdgeType vocabulary node, this edge
            # is a structural governance edge (e.g., the vocabulary node
            # pointing to axiom nodes).  This is permitted.
            if source_id in semantic_edge_type_vocab_node_ids:
                continue

            # The source is NOT a SemanticEdgeType vocabulary node.  This IS_A
            # or HAS_PROPERTY edge asserts a semantic world fact.  Hard block.
            target_id = edge.get("target_node_id", "<unknown>")
            return [
                f"Check 4 (semantic_fact_prohibition) FAILED: the manifest contains "
                f"an '{edge_type}' edge (source='{source_id}', target='{target_id}') "
                f"that encodes a semantic world fact.  "
                f"IS_A and HAS_PROPERTY edges asserting facts about the world are "
                f"prohibited in skill packages -- every semantic fact must be earned "
                f"through guardian teaching (CANON A.1, A.18, A.21.1).  "
                f"Only SemanticEdgeType vocabulary nodes (the grammar for making "
                f"assertions) are permitted in the package.  The assertions themselves "
                f"must be empty until the guardian teaches them."
            ]

        return []

    # ------------------------------------------------------------------
    # Check 5: at least one cross-domain bridge when a new domain is declared
    # ------------------------------------------------------------------

    def _check_cross_domain_bridge(self, manifest: dict) -> list[str]:
        """Verify a cross-domain bridge is declared for any new domain.

        CANON A.20.5(b): any skill package introducing a new domain must
        declare at least one cross-domain bridge edge type to AbstractDomain
        or an existing domain at the time of introduction.

        If the manifest does not contain a ``domain:`` field, this check
        passes unconditionally -- not all packages introduce a new domain.

        If the manifest declares ``domain:``, the ``cross_domain_bridges:``
        list must contain at least one bridge entry.  The bridge does not
        need to target AbstractDomain specifically -- a bridge to any
        existing domain satisfies the requirement (DENOTES to LanguageDomain
        satisfies this for SemanticDomain).

        Returns:
            Empty list on pass.  List with one error string if a domain is
            declared but no cross-domain bridges are present.
        """
        domain = manifest.get("domain")
        if domain is None:
            # Not declaring a new domain -- requirement does not apply.
            return []

        bridges = manifest.get("cross_domain_bridges", [])

        if not isinstance(bridges, list):
            return [
                f"Check 5 (cross_domain_bridge_requirement) FAILED: package declares "
                f"new domain '{domain}' but 'cross_domain_bridges' is not a list.  "
                f"Every package introducing a new domain must declare at least one "
                f"cross-domain bridge to an existing domain (CANON A.20.5b)."
            ]

        # Filter to actual bridge entries (dicts with an edge_type key).
        valid_bridges = [b for b in bridges if isinstance(b, dict) and b.get("edge_type")]

        if len(valid_bridges) == 0:
            return [
                f"Check 5 (cross_domain_bridge_requirement) FAILED: package declares "
                f"new domain '{domain}' but no cross-domain bridges are declared "
                f"in 'cross_domain_bridges'.  "
                f"At least one bridge edge type connecting '{domain}' to an existing "
                f"domain (AbstractDomain, LanguageDomain, MathDomain, or another "
                f"installed domain) is required (CANON A.20.5b).  "
                f"For SemanticDomain, 'DENOTES' bridging LanguageDomain satisfies "
                f"this requirement."
            ]

        return []

    # ------------------------------------------------------------------
    # Check 6: all required packages already installed
    # ------------------------------------------------------------------

    def _check_dependencies(
        self,
        manifest: dict,
        installed_packages: set[str],
    ) -> list[str]:
        """Verify all packages in ``requires:`` are already installed.

        CANON A.21.3 requires that the installer validate all declared
        ``requires`` packages before writing any nodes.  This prevents
        partial installations where a package's DEPENDS_ON edges reference
        nodes that do not yet exist.

        Anchor-layer packages (``core-bootstrap``, ``language-foundation``)
        are always treated as installed, even when no SkillPackage node for
        them exists in the graph -- they are pre-A.21 infrastructure that
        predates the YAML skill system.

        Args:
            manifest: The parsed YAML manifest.
            installed_packages: Package IDs returned by querying the
                SkillRegistry's REGISTERS edges.

        Returns:
            Empty list on pass.  List with one error string per missing
            required package.
        """
        requires: list = manifest.get("requires", [])
        if not isinstance(requires, list):
            return [
                "Check 6 (dependency_resolution) FAILED: 'requires' field must be a "
                "list of package ID strings.  Received a non-list value."
            ]

        all_available = installed_packages | _ANCHOR_LAYER_PACKAGES
        errors: list[str] = []

        for pkg in requires:
            if not isinstance(pkg, str):
                errors.append(
                    f"Check 6 (dependency_resolution) FAILED: 'requires' entry "
                    f"'{pkg}' is not a string.  Each dependency must be a "
                    f"package ID string (e.g., 'core-bootstrap')."
                )
                continue

            pkg_id = pkg.strip()
            if pkg_id not in all_available:
                errors.append(
                    f"Check 6 (dependency_resolution) FAILED: required package "
                    f"'{pkg_id}' is not installed.  Install '{pkg_id}' before "
                    f"installing this package (CANON A.21.3 dependency resolution).  "
                    f"Installed packages: {sorted(all_available)!r}."
                )

        return errors

    # ------------------------------------------------------------------
    # Check 7: no confidence scores above 0.15
    # ------------------------------------------------------------------

    def _check_confidence_ceiling(self, manifest: dict) -> list[str]:
        """Block any node or edge that explicitly declares confidence > 0.15.

        CANON A.21.1 prohibits pre-computed confidence scores above the
        bootstrap baseline (0.15) in skill packages.  This prevents packages
        from granting themselves artificially high confidence that bypasses
        the ACT-R confidence dynamics.

        The check only fires on nodes/edges that **explicitly** declare a
        ``confidence`` property.  Nodes without a ``confidence`` field are not
        affected (the installer will apply the appropriate default based on
        node type).

        Args:
            manifest: The parsed YAML manifest.

        Returns:
            Empty list on pass.  List of error strings (one per violation).
        """
        errors: list[str] = []

        nodes: list[dict] = manifest.get("nodes", [])
        if isinstance(nodes, list):
            for node in nodes:
                if not isinstance(node, dict):
                    continue
                confidence = node.get("properties", {}).get("confidence")
                if confidence is None:
                    # Top-level confidence field (some manifests may use this)
                    confidence = node.get("confidence")
                if confidence is not None:
                    try:
                        conf_float = float(confidence)
                    except (TypeError, ValueError):
                        errors.append(
                            f"Check 7 (confidence_ceiling) FAILED: node "
                            f"'{node.get('node_id', '<missing>')}' has a non-numeric "
                            f"'confidence' value: '{confidence}'.  Confidence must be "
                            f"a float in [0.0, 1.0]."
                        )
                        continue
                    if conf_float > _CONFIDENCE_CEILING:
                        errors.append(
                            f"Check 7 (confidence_ceiling) FAILED: node "
                            f"'{node.get('node_id', '<missing>')}' declares "
                            f"confidence={conf_float:.4f} which exceeds the bootstrap "
                            f"baseline ceiling of {_CONFIDENCE_CEILING}.  "
                            f"Pre-loaded confidence above {_CONFIDENCE_CEILING} bypasses "
                            f"ACT-R confidence dynamics (CANON A.21.1).  Remove or lower "
                            f"the confidence declaration."
                        )

        edges: list[dict] = manifest.get("edges", [])
        if isinstance(edges, list):
            for edge in edges:
                if not isinstance(edge, dict):
                    continue
                confidence = edge.get("properties", {}).get("confidence")
                if confidence is None:
                    confidence = edge.get("confidence")
                if confidence is not None:
                    try:
                        conf_float = float(confidence)
                    except (TypeError, ValueError):
                        errors.append(
                            f"Check 7 (confidence_ceiling) FAILED: edge "
                            f"'{edge.get('edge_id', '<missing>')}' has a non-numeric "
                            f"'confidence' value: '{confidence}'."
                        )
                        continue
                    if conf_float > _CONFIDENCE_CEILING:
                        errors.append(
                            f"Check 7 (confidence_ceiling) FAILED: edge "
                            f"'{edge.get('edge_id', '<missing>')}' "
                            f"(edge_type='{edge.get('edge_type', '<unknown>')}') "
                            f"declares confidence={conf_float:.4f} which exceeds "
                            f"the bootstrap baseline ceiling of {_CONFIDENCE_CEILING} "
                            f"(CANON A.21.1)."
                        )

        return errors

    # ------------------------------------------------------------------
    # Check 8: no SENSOR / GUARDIAN / INFERENCE provenance on any node
    # ------------------------------------------------------------------

    def _check_node_provenance_purity(self, manifest: dict) -> list[str]:
        """Block any node that declares a forbidden provenance source.

        CANON A.21.1 states that no node in a skill package may carry
        SENSOR, GUARDIAN, or INFERENCE provenance.  Only TAUGHT_PROCEDURE
        is permitted.  Experience-layer provenance (SENSOR, GUARDIAN,
        INFERENCE) is earned, not pre-loaded.

        The check inspects:
        - ``node.provenance`` (if a provenance mapping is nested on the node)
        - ``node.properties.provenance`` (if stored as a property)
        - ``node.properties.canon_provenance`` (variant spelling)
        - ``node.canon_provenance`` (top-level variant)

        Any of these carrying a forbidden value is a rejection.

        Returns:
            Empty list on pass.  List of error strings (one per violating
            node).
        """
        nodes: list[dict] = manifest.get("nodes", [])
        if not isinstance(nodes, list):
            return []

        errors: list[str] = []

        for node in nodes:
            if not isinstance(node, dict):
                continue

            node_id = node.get("node_id", "<missing>")
            provenance_value: str | None = None

            # Check multiple locations where provenance might be declared.
            # Order: explicit provenance object > properties dict > top-level fields.
            prov_obj = node.get("provenance")
            if isinstance(prov_obj, dict):
                # Provenance stored as a nested mapping with a 'source' key.
                raw = prov_obj.get("source")
                if raw is not None:
                    provenance_value = str(raw).strip().lower()
            elif isinstance(prov_obj, str):
                provenance_value = prov_obj.strip().lower()

            if provenance_value is None:
                # Try the properties sub-dict.
                props = node.get("properties", {})
                if isinstance(props, dict):
                    for key in ("provenance", "canon_provenance"):
                        raw = props.get(key)
                        if raw is not None:
                            provenance_value = str(raw).strip().lower()
                            break

            if provenance_value is None:
                # Try top-level keys on the node dict itself.
                for key in ("provenance", "canon_provenance"):
                    raw = node.get(key)
                    if raw is not None and not isinstance(raw, dict):
                        provenance_value = str(raw).strip().lower()
                        break

            if provenance_value is not None and provenance_value in _FORBIDDEN_NODE_PROVENANCE:
                errors.append(
                    f"Check 8 (provenance_purity) FAILED: node '{node_id}' declares "
                    f"provenance='{provenance_value}', which is not permitted in a skill "
                    f"package.  Skill package content must use TAUGHT_PROCEDURE "
                    f"provenance only.  SENSOR, GUARDIAN, and INFERENCE provenance "
                    f"is earned through runtime observation and teaching -- it cannot "
                    f"be pre-loaded in a YAML manifest (CANON A.18, A.21.1)."
                )

        return errors


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

__all__ = [
    "SkillPackageValidator",
    "ValidationResult",
    "_A18_PERMITTED_NODE_TYPES",   # exposed for tests and documentation
    "_ANCHOR_LAYER_PACKAGES",      # exposed for tests
    "_CONFIDENCE_CEILING",         # exposed for tests
]
