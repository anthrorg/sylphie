"""Encoding strength formula for Organic Language Acquisition (CANON A.24.3.2).

Computes how strongly a heard phrase is encoded into the knowledge graph based
on CB's internal state at hearing time. Grounded in Luria's NE + DA dual
gating model: norepinephrine (arousal) and dopamine (novelty) jointly gate
memory encoding, while excessive anxiety degrades encoding quality
(Yerkes-Dodson).

The formula:
    arousal_factor  = clamp(0.3, (total_pressure - anxiety) / 5.0, 1.5)
    novelty_factor  = clamp(0.5, 1.0 + prediction_error * 2.0, 2.0)
    anxiety_penalty = clamp(0.2, 1.0 - anxiety, 1.0)
    encoding_strength = arousal_factor * novelty_factor * anxiety_penalty

Output range: [0.03, 3.0] (product of three clamped factors at their extremes).

This is learning machinery -- it determines HOW STRONGLY a phrase is encoded,
not WHAT is learned. A phrase heard during a surprising event (high prediction
error) is encoded more strongly than one heard during routine interaction.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Clamp bounds (documented per T002 acceptance criteria)
# ---------------------------------------------------------------------------

AROUSAL_MIN: float = 0.3
"""Minimum arousal factor. Even low-arousal states encode something."""

AROUSAL_MAX: float = 1.5
"""Maximum arousal factor. High drive pressure amplifies encoding."""

NOVELTY_MIN: float = 0.5
"""Minimum novelty factor. Routine encounters still encode at half strength."""

NOVELTY_MAX: float = 2.0
"""Maximum novelty factor. Highly surprising events double encoding."""

ANXIETY_PENALTY_MIN: float = 0.2
"""Floor for anxiety penalty. Even maximal anxiety doesn't zero out encoding."""

ANXIETY_PENALTY_MAX: float = 1.0
"""Ceiling for anxiety penalty. Zero anxiety means no penalty."""

# Derived theoretical bounds
ENCODING_MIN: float = AROUSAL_MIN * NOVELTY_MIN * ANXIETY_PENALTY_MIN  # 0.03
ENCODING_MAX: float = AROUSAL_MAX * NOVELTY_MAX * ANXIETY_PENALTY_MAX  # 3.0

# ---------------------------------------------------------------------------
# Drive key used in pressure snapshot
# ---------------------------------------------------------------------------

ANXIETY_KEY: str = "anxiety"
"""Key for anxiety drive in the pressure snapshot dict."""


# ---------------------------------------------------------------------------
# Core function
# ---------------------------------------------------------------------------


def _clamp(lo: float, value: float, hi: float) -> float:
    """Clamp value to [lo, hi]."""
    if value < lo:
        return lo
    if value > hi:
        return hi
    return value


def compute_encoding_strength(
    pressure_snapshot: dict[str, float] | None,
    prediction_error: float = 0.0,
) -> float:
    """Compute encoding strength from pressure vector and prediction error.

    Args:
        pressure_snapshot: Dict mapping drive names to pressure values (0.0-1.0
            each). If None, returns a default mid-range encoding (graceful
            degradation when pressure source is unavailable).
        prediction_error: Prediction error from the most recent executor cycle.
            Higher values indicate more surprising events. Can be negative
            (over-prediction) but the formula uses the raw value, not absolute.

    Returns:
        Encoding strength in [0.03, 3.0]. Higher means the phrase will be
        encoded more strongly in the knowledge graph.
    """
    if pressure_snapshot is None:
        # Graceful degradation: mid-range default when no pressure data
        return 1.0

    # Total pressure: sum of all drive values
    total_pressure = sum(pressure_snapshot.values())

    # Anxiety value from snapshot (default 0.0 if missing)
    anxiety = pressure_snapshot.get(ANXIETY_KEY, 0.0)

    # Arousal: overall drive activation minus anxiety, scaled to useful range
    arousal_factor = _clamp(
        AROUSAL_MIN, (total_pressure - anxiety) / 5.0, AROUSAL_MAX
    )

    # Novelty: prediction error amplifies encoding of surprising events
    novelty_factor = _clamp(
        NOVELTY_MIN, 1.0 + prediction_error * 2.0, NOVELTY_MAX
    )

    # Anxiety penalty: high anxiety degrades encoding quality (Yerkes-Dodson)
    anxiety_penalty = _clamp(
        ANXIETY_PENALTY_MIN, 1.0 - anxiety, ANXIETY_PENALTY_MAX
    )

    return arousal_factor * novelty_factor * anxiety_penalty


__all__ = [
    "compute_encoding_strength",
    "AROUSAL_MIN",
    "AROUSAL_MAX",
    "NOVELTY_MIN",
    "NOVELTY_MAX",
    "ANXIETY_PENALTY_MIN",
    "ANXIETY_PENALTY_MAX",
    "ENCODING_MIN",
    "ENCODING_MAX",
    "ANXIETY_KEY",
]
