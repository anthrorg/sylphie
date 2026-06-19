"""Tests for BootstrapTracker category demotion (TK-40 / EP8-3).

Acceptance criteria:
  AC1: A graduated category whose rolling agreement drops below 0.70 is removed
       from the graduated set, a WARNING is logged, and should_use_tensor returns
       False for it afterwards.
  AC2: A category whose agreement is between 0.70 and 0.85 (inclusive of 0.70,
       exclusive of 0.85) is NOT demoted.
"""

from __future__ import annotations

import logging

import pytest

from inference.bootstrap import BootstrapTracker


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _graduate(tracker: BootstrapTracker, category: str, agree_count: int = 20) -> None:
    """Force a category to graduate by recording agree_count agreements."""
    for _ in range(agree_count):
        tracker.record_comparison(category, category)
    newly = tracker.check_graduations()
    assert category in newly, f"Setup failed: '{category}' did not graduate"


def _flood_disagreements(
    tracker: BootstrapTracker, category: str, n: int
) -> None:
    """Record n total disagreements for category (tensor sends 'other')."""
    for _ in range(n):
        tracker.record_comparison("other_category", category)


# ---------------------------------------------------------------------------
# AC1 — agreement drops below 0.70 → demoted, warning logged, tensor False
# ---------------------------------------------------------------------------

def test_demoted_when_agreement_below_threshold(caplog: pytest.LogCaptureFixture) -> None:
    """AC1: agreement < 0.70 on a graduated category triggers demotion."""
    tracker = BootstrapTracker(initial_mode="partial")

    # Seed with 20 agreements so the category graduates.
    _graduate(tracker, "greet", agree_count=20)
    assert tracker.should_use_tensor("greet") is True

    # Push the window to 100 entries with enough disagreements to land below 0.70.
    # We have 20 agrees; add 80 more entries: 80 disagrees => agreement = 20/100 = 0.20
    _flood_disagreements(tracker, "greet", 80)

    with caplog.at_level(logging.WARNING, logger="cognition_service.bootstrap"):
        demoted = tracker.check_demotions()

    assert "greet" in demoted, "Expected 'greet' in demoted list"
    assert "greet" not in tracker._graduated_categories
    # Warning must have been emitted.
    assert any("demoted" in msg.lower() for msg in caplog.messages), (
        "Expected a WARNING log containing 'demoted'"
    )


def test_should_use_tensor_false_after_demotion() -> None:
    """AC1: should_use_tensor returns False for a demoted category (partial mode)."""
    tracker = BootstrapTracker(initial_mode="partial")
    _graduate(tracker, "greet", agree_count=20)

    # Sink agreement below threshold.
    _flood_disagreements(tracker, "greet", 80)
    tracker.check_demotions()

    assert tracker.should_use_tensor("greet") is False


def test_demotion_returns_sorted_list() -> None:
    """AC1 (multi-category): check_demotions returns a sorted list of demoted names."""
    tracker = BootstrapTracker(initial_mode="partial")
    for cat in ("zebra", "apple", "mango"):
        _graduate(tracker, cat, agree_count=20)

    for cat in ("zebra", "apple", "mango"):
        _flood_disagreements(tracker, cat, 80)

    demoted = tracker.check_demotions()
    assert demoted == sorted(demoted)
    assert set(demoted) == {"zebra", "apple", "mango"}


def test_demotion_logged_as_warning(caplog: pytest.LogCaptureFixture) -> None:
    """AC1: the log record is at WARNING level (not INFO)."""
    tracker = BootstrapTracker(initial_mode="partial")
    _graduate(tracker, "greet", agree_count=20)
    _flood_disagreements(tracker, "greet", 80)

    with caplog.at_level(logging.WARNING, logger="cognition_service.bootstrap"):
        tracker.check_demotions()

    warning_records = [
        r for r in caplog.records
        if r.levelno == logging.WARNING and "demoted" in r.getMessage().lower()
    ]
    assert warning_records, "Expected at least one WARNING log about demotion"


def test_check_demotions_noop_when_none_graduated() -> None:
    """check_demotions is safe to call when the graduated set is empty."""
    tracker = BootstrapTracker()
    assert tracker.check_demotions() == []


def test_no_demotion_without_minimum_samples() -> None:
    """A graduated category with fewer than 20 samples is not demoted (thin history guard)."""
    tracker = BootstrapTracker(initial_mode="partial")

    # Manually inject the category as graduated without seeding any history,
    # simulating the edge case of history being wiped or a brand-new category
    # that somehow ended up in the graduated set.
    tracker._graduated_categories.add("phantom")
    # No history at all → history length is 0, below the 20-sample minimum.

    demoted = tracker.check_demotions()
    assert "phantom" not in demoted
    assert "phantom" in tracker._graduated_categories


# ---------------------------------------------------------------------------
# AC2 — agreement between 0.70 and 0.85 → NOT demoted
# ---------------------------------------------------------------------------

def test_not_demoted_when_agreement_at_exactly_0_70() -> None:
    """AC2: agreement == 0.70 is NOT below the demotion threshold (strict <)."""
    tracker = BootstrapTracker(initial_mode="partial")

    # Build 100-sample window: 70 agrees, 30 disagrees → agreement = 0.70 exactly.
    # Start fresh with 70 agreements, then push 30 disagreements.
    for _ in range(70):
        tracker.record_comparison("focus", "focus")  # agrees
    for _ in range(30):
        tracker.record_comparison("other", "focus")  # disagrees

    # At 100 samples with 70 agrees the category is not yet graduated
    # (needs >=0.85). Force it into the graduated set manually to test demotion
    # in isolation (the graduation path is covered by test_check_graduations).
    tracker._graduated_categories.add("focus")

    demoted = tracker.check_demotions()
    assert "focus" not in demoted, "0.70 agreement should NOT trigger demotion (threshold is strict <)"
    assert "focus" in tracker._graduated_categories


def test_not_demoted_when_agreement_between_0_70_and_0_85() -> None:
    """AC2: a category at 0.75 agreement (between demotion and graduation) is safe."""
    tracker = BootstrapTracker(initial_mode="partial")

    # 75 agrees, 25 disagrees → agreement = 0.75
    for _ in range(75):
        tracker.record_comparison("focus", "focus")
    for _ in range(25):
        tracker.record_comparison("other", "focus")

    tracker._graduated_categories.add("focus")

    demoted = tracker.check_demotions()
    assert "focus" not in demoted
    assert "focus" in tracker._graduated_categories


def test_not_demoted_when_agreement_still_high() -> None:
    """AC2: a still-healthy graduated category (agreement >=0.85) is not demoted."""
    tracker = BootstrapTracker(initial_mode="partial")
    _graduate(tracker, "greet", agree_count=20)

    # Add 4 more disagreements — well above threshold (20 agrees / 24 samples ≈ 0.833).
    _flood_disagreements(tracker, "greet", 4)

    demoted = tracker.check_demotions()
    assert "greet" not in demoted
    assert "greet" in tracker._graduated_categories
