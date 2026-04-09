"""Bootstrap tracking and mode transition logic.

During bootstrap, the LLM is the authority on decisions. The tensor models
run in parallel and their outputs are compared against the LLM's choices to
build a per-category agreement record.

Mode progression:
    shadow  -> audit   : after 100+ total comparisons
    audit   -> partial : after any category crosses 85% agreement (100-sample
                         window, minimum 20 samples)
    partial -> full    : overall agreement >= 90% with at least 3 graduated
                         categories

In shadow/audit mode, should_use_tensor() always returns False — the LLM
decides. In partial mode, graduated categories return True. In full mode,
all categories return True and the LLM exits the cognitive loop.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

logger = logging.getLogger("cognition_service.bootstrap")


class BootstrapTracker:
    """Tracks agreement between tensor model outputs and LLM decisions.

    During shadow/audit mode, each training sample includes both the tensor
    model's action_bias and the LLM's arbitration_type + action_category.
    This class compares them to measure agreement.

    Thread safety: accessed only from the main FastAPI async thread. No
    internal locks are needed — do not call from the training thread.
    """

    def __init__(self, initial_mode: str = "shadow") -> None:
        """Initialise the tracker.

        Args:
            initial_mode: Starting bootstrap mode. One of shadow, audit,
                          partial, full.
        """
        self.mode: str = initial_mode

        # Per-category sliding window of agreement booleans.
        self._category_history: dict[str, list[bool]] = {}
        self._window_size: int = 100   # maximum retained comparisons per category
        self._graduation_threshold: float = 0.85  # per-category threshold for partial
        self._full_threshold: float = 0.90         # overall threshold for full handoff
        self._graduated_categories: set[str] = set()

        logger.info("BootstrapTracker initialised (mode=%s)", initial_mode)

    # ------------------------------------------------------------------
    # Recording
    # ------------------------------------------------------------------

    def record_comparison(self, tensor_top_category: str, llm_category: str) -> None:
        """Record whether the tensor model agreed with the LLM on this sample.

        Called after each training sample is processed in POST /cognition/train.
        The comparison is keyed on the LLM's category — we want to know how
        well the tensor predicts what the LLM would have chosen.

        Args:
            tensor_top_category: The category name corresponding to the tensor
                                 model's argmax action_bias output.
            llm_category:        The action_category the LLM actually chose,
                                 as reported in the TrainingSample.
        """
        # Normalise to lowercase for comparison — NestJS sends PascalCase
        # (e.g. "ConversationalResponse") but the tensor vocab stores lowercase.
        tensor_norm = tensor_top_category.lower()
        llm_norm = llm_category.lower()
        agreed = (tensor_norm == llm_norm)
        if llm_norm not in self._category_history:
            self._category_history[llm_norm] = []
        history = self._category_history[llm_norm]
        history.append(agreed)
        # Enforce the sliding window by discarding the oldest entry.
        if len(history) > self._window_size:
            history.pop(0)

    # ------------------------------------------------------------------
    # Graduation checks
    # ------------------------------------------------------------------

    def check_graduations(self) -> list[str]:
        """Check which categories have newly crossed the graduation threshold.

        A category graduates when its per-category agreement rate is at or
        above _graduation_threshold over its last window_size comparisons,
        and it has accumulated at least 20 samples. Already-graduated
        categories are skipped.

        Returns:
            Sorted list of category names that graduated on this call.
        """
        newly_graduated: list[str] = []
        for cat, history in self._category_history.items():
            if cat in self._graduated_categories:
                continue
            if len(history) < 20:
                continue
            agreement = sum(history) / len(history)
            if agreement >= self._graduation_threshold:
                self._graduated_categories.add(cat)
                newly_graduated.append(cat)
                logger.info(
                    "Category '%s' graduated (agreement=%.3f, samples=%d)",
                    cat,
                    agreement,
                    len(history),
                )
        return sorted(newly_graduated)

    # ------------------------------------------------------------------
    # Decision gate
    # ------------------------------------------------------------------

    def should_use_tensor(self, category: str) -> bool:
        """Return True if the tensor model should decide for this category.

        In shadow/audit mode this is always False — the LLM decides.
        In partial mode, only graduated categories return True.
        In full mode, all categories return True.

        Args:
            category: The action category being evaluated.

        Returns:
            True when the tensor model's output should be used directly.
        """
        if self.mode == "full":
            return True
        if self.mode == "partial":
            return category in self._graduated_categories
        return False  # shadow / audit: LLM always decides

    # ------------------------------------------------------------------
    # Agreement rates
    # ------------------------------------------------------------------

    def get_overall_agreement(self) -> float:
        """Compute the overall agreement rate across all categories.

        All recorded comparisons are pooled — no weighting by category size.

        Returns:
            Float in [0.0, 1.0], or 0.0 if no comparisons have been recorded.
        """
        all_agreements: list[bool] = []
        for history in self._category_history.values():
            all_agreements.extend(history)
        if not all_agreements:
            return 0.0
        return sum(all_agreements) / len(all_agreements)

    def get_per_category_agreement(self) -> dict[str, float]:
        """Return per-category agreement rates for the current sliding window.

        Returns:
            Dict mapping category name to agreement rate in [0.0, 1.0].
            Only categories with at least one recorded comparison are included.
        """
        result: dict[str, float] = {}
        for cat, history in self._category_history.items():
            if history:
                result[cat] = sum(history) / len(history)
        return result

    # ------------------------------------------------------------------
    # Mode transitions
    # ------------------------------------------------------------------

    def check_mode_transition(self) -> str | None:
        """Determine whether the current mode should advance.

        Transition conditions:
            shadow  -> audit:   total comparisons >= 100
            audit   -> partial: at least one graduated category exists
            partial -> full:    overall agreement >= 90% AND >= 3 graduated
                                categories

        Returns:
            The new mode string if a transition is warranted, else None.
        """
        if self.mode == "shadow":
            total = sum(len(h) for h in self._category_history.values())
            if total >= 100:
                return "audit"

        elif self.mode == "audit":
            if self._graduated_categories:
                return "partial"

        elif self.mode == "partial":
            overall = self.get_overall_agreement()
            if overall >= self._full_threshold and len(self._graduated_categories) >= 3:
                return "full"

        return None

    def advance_mode(self) -> bool:
        """Attempt to advance to the next bootstrap mode.

        Calls check_mode_transition() and, if a new mode is warranted, updates
        self.mode and logs the transition at INFO level.

        Returns:
            True if the mode was advanced, False otherwise.
        """
        new_mode = self.check_mode_transition()
        if new_mode:
            logger.info(
                "Bootstrap mode advancing: %s -> %s "
                "(overall_agreement=%.3f, graduated=%d)",
                self.mode,
                new_mode,
                self.get_overall_agreement(),
                len(self._graduated_categories),
            )
            self.mode = new_mode
            return True
        return False

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------

    def get_status(self) -> dict:
        """Return a status dict compatible with the BootstrapStatus schema.

        Returns:
            Dict with keys: mode, agreement_rate, per_category_agreement,
            categories_graduated.
        """
        return {
            "mode": self.mode,
            "agreement_rate": self.get_overall_agreement(),
            "per_category_agreement": self.get_per_category_agreement(),
            "categories_graduated": sorted(self._graduated_categories),
        }
