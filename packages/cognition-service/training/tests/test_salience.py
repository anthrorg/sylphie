"""Tests for salience-weighted experience replay (cluster 3b).

Covers the final-step landing of the reinforce / correct / boost-salience
control path: a sample injected with elevated salience must be preferentially
drawn in the replay slice of a batch, and boost_category_salience must raise
the draw probability of an already-buffered pattern.
"""

from __future__ import annotations

import numpy as np

from training.data_buffer import DataBuffer

_EMB = 768
_DV = 12


def _components(seed: float = 0.0) -> dict:
    """Minimal well-formed sample component dict."""
    return {
        "fused_embedding": [seed] * _EMB,
        "drive_vector": [0.0] * _DV,
        "drive_deltas": [0.0] * _DV,
        "total_pressure": 0.0,
        "episodic_context": [0.0] * _EMB,
    }


def test_default_salience_is_one() -> None:
    buf = DataBuffer(capacity=8)
    buf.add_sample(action_category="a", **_components())
    batch = buf.sample_batch(batch_size=1, replay_fraction=1.0)
    assert len(batch) == 1
    assert batch[0]["salience"] == 1.0


def test_add_path_defaults_salience() -> None:
    """A plain TrainingSample dict (no salience field) gets salience 1.0."""
    buf = DataBuffer(capacity=4)
    buf.add({"action_category": "x", "fused_embedding": [0.1] * _EMB})
    batch = buf.sample_batch(batch_size=1, replay_fraction=1.0)
    assert batch[0]["salience"] == 1.0


def test_high_salience_sample_is_preferentially_replayed() -> None:
    """A salience-3 sample should dominate the replay draw vs salience-1 noise.

    100 default-salience filler samples + 1 high-salience target. Drawing a
    single-sample replay slice many times, the high-salience sample should be
    over-represented far beyond its 1/101 uniform share.
    """
    np.random.seed(1234)
    buf = DataBuffer(capacity=256)
    for i in range(100):
        buf.add_sample(action_category="filler", salience=1.0, **_components(float(i)))
    buf.add_sample(action_category="TARGET", salience=20.0, **_components(999.0))

    hits = 0
    trials = 400
    for _ in range(trials):
        batch = buf.sample_batch(batch_size=1, replay_fraction=1.0)
        if batch and batch[0].get("action_category") == "TARGET":
            hits += 1

    uniform_share = 1.0 / 101.0
    observed_share = hits / trials
    # salience 20 vs ~100 units of filler => expected ~20/120 ≈ 0.166, far above
    # the uniform 1/101 ≈ 0.0099. Assert it clears a conservative 5× uniform.
    assert observed_share > 5 * uniform_share, (
        f"high-salience sample under-drawn: {observed_share:.4f} "
        f"(uniform={uniform_share:.4f})"
    )


def test_boost_category_salience_raises_and_counts() -> None:
    buf = DataBuffer(capacity=16)
    buf.add_sample(action_category="greet", salience=1.0, **_components(1.0))
    buf.add_sample(action_category="greet", salience=1.0, **_components(2.0))
    buf.add_sample(action_category="other", salience=1.0, **_components(3.0))

    boosted = buf.boost_category_salience("greet", multiplier=3.0)
    assert boosted == 2

    # Drain the whole buffer and confirm only greet samples were raised.
    batch = buf.sample_batch(batch_size=16, replay_fraction=1.0)
    by_cat = {}
    for s in batch:
        by_cat.setdefault(s["action_category"], []).append(s["salience"])
    assert all(v == 3.0 for v in by_cat["greet"])
    assert all(v == 1.0 for v in by_cat["other"])


def test_boost_is_case_insensitive_and_trimmed() -> None:
    buf = DataBuffer(capacity=8)
    buf.add_sample(action_category="Greet", salience=1.0, **_components())
    boosted = buf.boost_category_salience("  greet ", multiplier=2.0)
    assert boosted == 1


def test_boost_respects_ceiling() -> None:
    buf = DataBuffer(capacity=8)
    buf.add_sample(action_category="c", salience=5.0, **_components())
    buf.boost_category_salience("c", multiplier=10.0, max_salience=8.0)
    batch = buf.sample_batch(batch_size=1, replay_fraction=1.0)
    assert batch[0]["salience"] == 8.0


def test_boost_unknown_category_is_noop() -> None:
    buf = DataBuffer(capacity=8)
    buf.add_sample(action_category="a", **_components())
    assert buf.boost_category_salience("nonexistent", multiplier=5.0) == 0
    assert buf.boost_category_salience("", multiplier=5.0) == 0


def test_degenerate_salience_falls_back_to_uniform() -> None:
    """All-zero salience must not crash the draw (fallback to uniform)."""
    buf = DataBuffer(capacity=8)
    for i in range(4):
        buf.add_sample(action_category="z", salience=0.0, **_components(float(i)))
    batch = buf.sample_batch(batch_size=2, replay_fraction=1.0)
    assert len(batch) == 2
