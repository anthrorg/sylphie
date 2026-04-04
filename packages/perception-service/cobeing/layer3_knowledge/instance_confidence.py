"""ACT-R-based confidence dynamics for COMPUTES_TO instance edges (PKG-2.3).

All functions are stateless — they take values and return a float.
Edge updates (writing the new confidence back to the graph) are performed
by ProcedureExecutor.

The core formula (Anderson & Lebiere 1998, recalibrated for the ln-based
decay structure — see docs/research/piaget-pkg-confidence-dynamics.md):

    effective_confidence = min(1.0, base + k * ln(n) - d * ln(hours + 1))

Parameters used:
    base_procedural            = 0.15   starting confidence for new unconfirmed results
    base_guardian_confirmed    = 0.60   base after guardian confirms (crosses threshold)
    k                          = 0.12   learning rate (produces ~20-encounter transition)
    d                          = 0.05   decay rate (default; per-type override via decay_rate param)
    retrieval_threshold        = 0.50   minimum confidence for direct recall
    procedural_cap             = 0.52   maximum confidence without guardian confirmation

Per-type decay rates (CANON A.17.3):
    ProceduralTemplate         = 0.05   procedural memory (default)
    WordFormNode               = 0.04   lexical memory
    PhraseNode                 = 0.03   declarative/episodic linguistic traces
    ConceptPrimitive           = 0.02   semantic memory (highly persistent)

The procedural_cap is set to 0.52 to allow genome actions to stabilize above
the 0.50 retrieval threshold after reinforcement. The 0.02 gap above threshold
provides a stability buffer. Unconfirmed COMPUTES_TO edges (math computations)
use this cap; ActionProcedure confidence uses retrieval_floor instead.

Note: The previous cap of 0.48 created an extinction hole where genome-
bootstrapped actions (installed at 0.55) would decay to 0.48 after ACT-R
reinforcement (formula at encounter_count=1, base=0.50 yields 0.50, then
clamped to 0.48), falling permanently below the 0.50 retrieval threshold.

Behavioral guarantees:
    - 1 encounter, unconfirmed:          ~0.15  (ln(1) = 0)
    - 20 encounters, unconfirmed:         0.52  (procedural cap)
    - 100 encounters, unconfirmed:        0.52  (cap holds)
    - Guardian confirmation (n=1):        0.60  (above threshold → direct recall)
    - Guardian confirmed, 24h later:      ~0.44  (d * ln(25) ≈ 0.161)
    - Guardian confirmed, 7 days later:   decay term ≈ 0.26  (d * ln(169) = 0.257)
"""

from __future__ import annotations

import math
from datetime import UTC, datetime

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

BASE_PROCEDURAL: float = 0.15
"""Starting confidence for new, unconfirmed computation results."""

BASE_GUARDIAN_CONFIRMED: float = 0.60
"""Base confidence after guardian confirmation. Crosses retrieval threshold."""

K: float = 0.12
"""Learning rate. Produces ~20-encounter transition for unconfirmed results,
matching Siegler's empirical data for simple arithmetic (1988)."""

D: float = 0.05
"""Default decay rate. Recalibrated from ACT-R's d=0.5 for this formula's
ln-based structure. Direct transplant of 0.5 would produce overnight decay
catastrophe for guardian-confirmed facts. See Piaget advisory.

Per-type rates override this via the decay_rate parameter to
calculate_confidence(). See CANON A.17.3."""

WORD_FORM_DECAY_RATE: float = 0.04
"""Decay rate for WordFormNodes. Slightly slower than default (0.05),
reflecting the persistence of lexical memory. CANON A.17.3."""

PHRASE_DECAY_RATE: float = 0.03
"""Decay rate for PhraseNodes. Slower than default (0.05), reflecting the
persistence of declarative/episodic linguistic traces. A PhraseNode heard
once survives ~6 days vs ~19 hours for default decay. CANON A.17.3, A.26.2."""

CONCEPT_PRIMITIVE_DECAY_RATE: float = 0.02
"""Decay rate for ConceptPrimitive nodes. Slowest decay (0.02), reflecting
the high persistence of semantic memory. Core concepts like 'dog IS_A animal'
should be highly stable once learned. CANON A.17.3."""

RETRIEVAL_THRESHOLD: float = 0.50
"""Minimum COMPUTES_TO edge confidence for direct recall. Below this threshold,
the procedure is always executed."""

PROCEDURAL_CAP: float = 0.52
"""Maximum confidence achievable without guardian confirmation.
Set to 0.52 (above the 0.50 retrieval threshold) so that genome actions
can stabilize above threshold after reinforcement. The 0.02 gap provides
a stability buffer against floating-point boundary artifacts."""


# ---------------------------------------------------------------------------
# Core functions
# ---------------------------------------------------------------------------


def calculate_confidence(
    base: float,
    encounter_count: int,
    hours_since_last_access: float,
    guardian_confirmed: bool,
    procedural_cap: float = PROCEDURAL_CAP,
    decay_rate: float = D,
) -> float:
    """Calculate effective confidence using the ACT-R base-level learning formula.

    Applies the formula ``min(1.0, base + k * ln(n) - d * ln(hours + 1))``
    then clamps unconfirmed results to the procedural cap.

    Args:
        base: Starting confidence (BASE_PROCEDURAL or BASE_GUARDIAN_CONFIRMED).
        encounter_count: Total times this computation has been performed.
            Must be >= 1. At count=1, ln(1)=0 so result equals base.
        hours_since_last_access: Hours since last retrieval or computation.
            0.0 means just accessed (no decay).
        guardian_confirmed: Whether the guardian has confirmed this result.
            Confirmed results are not subject to the procedural cap.
        procedural_cap: Maximum confidence for unconfirmed results.
            Defaults to 0.52 (0.02 above retrieval threshold).
        decay_rate: Per-type decay coefficient (d in the formula). Defaults
            to D (0.05). PhraseNodes use PHRASE_DECAY_RATE (0.03) for slower
            decay. See CANON A.17.3 for per-type rates.

    Returns:
        Effective confidence in [0.0, 1.0]. Clamped to procedural_cap for
        unconfirmed results.
    """
    n = max(1, encounter_count)
    h = max(0.0, hours_since_last_access)

    raw = base + K * math.log(n) - decay_rate * math.log(h + 1)
    clamped = min(1.0, max(0.0, raw))

    if not guardian_confirmed:
        clamped = min(clamped, procedural_cap)

    return clamped


def apply_guardian_confirmation(
    encounter_count: int = 1,
    hours_since_last_access: float = 0.0,
) -> float:
    """Calculate confidence after guardian confirmation.

    Guardian confirmation sets the base to BASE_GUARDIAN_CONFIRMED (0.60)
    and removes the procedural cap. The result will exceed the retrieval
    threshold, enabling direct recall for subsequent identical computations.

    Args:
        encounter_count: Total encounters so far (including the confirmation).
            Defaults to 1 (first encounter, no strengthening yet).
        hours_since_last_access: Hours since last access. Defaults to 0.0
            (just confirmed, no decay applied).

    Returns:
        New effective confidence (>= 0.60 when hours_since_last_access=0).
    """
    return calculate_confidence(
        base=BASE_GUARDIAN_CONFIRMED,
        encounter_count=encounter_count,
        hours_since_last_access=hours_since_last_access,
        guardian_confirmed=True,
    )


def should_use_direct_recall(
    confidence: float,
    threshold: float = RETRIEVAL_THRESHOLD,
) -> bool:
    """Return True if confidence is high enough to use direct recall.

    Args:
        confidence: Current COMPUTES_TO edge confidence.
        threshold: Minimum confidence for direct recall. Defaults to 0.50.

    Returns:
        True if confidence >= threshold, False otherwise.
    """
    return confidence >= threshold


def hours_since(timestamp_iso: str | None) -> float:
    """Compute hours elapsed since a UTC ISO-format timestamp.

    Args:
        timestamp_iso: ISO 8601 datetime string (timezone-aware or naive UTC).
            None or empty string returns 0.0.

    Returns:
        Hours elapsed, or 0.0 if timestamp is missing or unparseable.
    """
    if not timestamp_iso:
        return 0.0
    try:
        dt = datetime.fromisoformat(timestamp_iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        now = datetime.now(UTC)
        return max(0.0, (now - dt).total_seconds() / 3600.0)
    except (ValueError, TypeError):
        return 0.0


__all__ = [
    # Constants
    "BASE_PROCEDURAL",
    "BASE_GUARDIAN_CONFIRMED",
    "K",
    "D",
    "WORD_FORM_DECAY_RATE",
    "PHRASE_DECAY_RATE",
    "CONCEPT_PRIMITIVE_DECAY_RATE",
    "RETRIEVAL_THRESHOLD",
    "PROCEDURAL_CAP",
    # Functions
    "calculate_confidence",
    "apply_guardian_confirmation",
    "should_use_direct_recall",
    "hours_since",
]
