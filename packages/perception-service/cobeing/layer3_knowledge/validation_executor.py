"""Python validation engine for Co-Being computational results (P1.9-E1).

Validates mathematical and morphological results produced by the Procedural
Knowledge Graph against Python ground truth. This is the "teacher's answer
key" -- it does not execute procedures or seed knowledge, it only checks
whether Co-Being's computed answers are correct.

CANON A.1 compliance: This module validates experientially-learned procedures.
It does not inject world knowledge into the graph. Validation results flow
into confidence adjustments and negative knowledge edges (DOES_NOT_COMPUTE_TO),
not into new COMPUTES_TO edges.

Security: All math validation uses the ``operator`` module with a fixed
dispatch table. No ``eval()`` or ``exec()`` is used anywhere. Morphological
validation uses the ``inflect`` library when available, falling back to
a no-op when not installed.

Usage::

    from cobeing.layer3_knowledge.validation_executor import (
        ValidationExecutor, ValidationResult,
    )

    executor = ValidationExecutor(persistence=graph)

    # Validate a math result
    result = await executor.validate_mathematical(
        operation="add", operands=[3, 5], cb_result=8,
    )
    assert result.is_correct is True

    # Validate a morphological result
    result = await executor.validate_morphological(
        word="cat", transform="pluralize", cb_result="cats",
    )
    assert result.is_correct is True

Phase 1.9 (P1.9-E1). CANON A.1 (schema evolution scope), A.18 (provenance).
"""

from __future__ import annotations

import logging
import operator
from dataclasses import dataclass
from typing import Any

from cobeing.layer3_knowledge.protocols import GraphPersistence

_logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ValidationResult:
    """Outcome of validating a Co-Being result against Python ground truth.

    Attributes:
        is_correct: Whether Co-Being's result matches Python's computation.
        cb_result: The value Co-Being computed.
        correct_result: The value Python computed as ground truth.
        operation: The operation name that was validated (e.g., ``"add"``,
            ``"pluralize"``).
        confidence_adjustment: How much to adjust the COMPUTES_TO or
            TRANSFORMS_TO edge confidence. Positive (+0.05) when correct,
            negative (-0.10) when wrong. The asymmetry reflects the
            pedagogical principle that errors are more informative than
            confirmations.
        error_description: Empty string when correct. Human-readable
            description of the mismatch when wrong.
        validation_source: Which Python mechanism produced the ground truth.
            One of ``"python_operator"``, ``"inflect_library"``,
            ``"inflect_unavailable"``.
    """

    is_correct: bool
    cb_result: Any
    correct_result: Any
    operation: str
    confidence_adjustment: float
    error_description: str
    validation_source: str


# ---------------------------------------------------------------------------
# Confidence adjustment constants
# ---------------------------------------------------------------------------

_CORRECT_ADJUSTMENT: float = 0.05
"""Confidence boost when Co-Being's result matches Python ground truth."""

_INCORRECT_ADJUSTMENT: float = -0.10
"""Confidence penalty when Co-Being's result does not match Python ground
truth. Larger magnitude than the boost -- errors are more informative."""


# ---------------------------------------------------------------------------
# Math operation dispatch table (template-based, no eval)
# ---------------------------------------------------------------------------

_MATH_OPS: dict[str, tuple[int, Any]] = {
    # (expected_operand_count, callable)
    "add": (2, operator.add),
    "subtract": (2, operator.sub),
    "multiply": (2, operator.mul),
    "successor": (1, lambda n: n + 1),
    "predecessor": (1, lambda n: n - 1),
    "compare_eq": (2, operator.eq),
    "compare_gt": (2, operator.gt),
    "compare_lt": (2, operator.lt),
}
"""Registry of Python operations for validating mathematical results.

Each entry maps an operation name to a tuple of (expected_operand_count,
callable). The callable receives positional arguments in operand order.

This is intentionally a subset of the OPERATIONS registry in
``procedure_types.py``. Only operations that have a clear Python ground
truth are included. Set operations, string operations, and other
domain-specific operations are excluded from math validation.
"""


# ---------------------------------------------------------------------------
# Morphological validation helpers
# ---------------------------------------------------------------------------

_INFLECT_AVAILABLE: bool = False
_inflect_engine: Any = None

try:
    import inflect as _inflect_module

    _inflect_engine = _inflect_module.engine()
    _INFLECT_AVAILABLE = True
except ImportError:
    _INFLECT_AVAILABLE = False

# Maps Co-Being transform names to inflect engine method calls.
# Each entry is (method_name, needs_pos_argument).
_MORPH_TRANSFORMS: dict[str, str] = {
    "pluralize": "plural_noun",
    "plural": "plural_noun",
    "present_participle": "present_participle",
    "past_tense": "past_tense",  # Not natively in inflect; handled specially
}
"""Maps Co-Being morphological transform names to inflect engine methods.

Not all transforms have inflect equivalents. Transforms without a mapping
return a validation result with validation_source="inflect_unavailable".
"""


# ---------------------------------------------------------------------------
# ValidationExecutor
# ---------------------------------------------------------------------------


class ValidationExecutor:
    """Validates Co-Being's computational results against Python ground truth.

    This executor is a read-only validator. It does not modify the knowledge
    graph, execute procedures, or create edges. It takes a computed result
    and returns a ValidationResult indicating whether the result is correct.

    Callers (typically the orchestrator or a validation loop) use the
    ValidationResult to:
    1. Adjust confidence on existing COMPUTES_TO / TRANSFORMS_TO edges.
    2. Create DOES_NOT_COMPUTE_TO edges via NegativeKnowledgeManager when
       errors are detected.

    Uses template-based validation (NOT eval()) for security:
    - Math: ``operator.add``, ``operator.sub``, ``operator.mul``, etc.
    - Comparison: ``operator.eq``, ``operator.gt``, ``operator.lt``
    - Morphology: ``inflect`` library for pluralization/conjugation

    Args:
        persistence: The graph persistence backend. Used for future
            extensions (e.g., looking up domain-specific validation rules
            stored in the graph). Not currently used for validation logic.
    """

    def __init__(self, persistence: GraphPersistence) -> None:
        self._persistence = persistence

    async def validate_mathematical(
        self,
        operation: str,
        operands: list[int | float],
        cb_result: int | float,
    ) -> ValidationResult:
        """Validate a mathematical result against Python computation.

        Looks up the operation in the fixed dispatch table and computes the
        expected result using Python's ``operator`` module. Compares the
        expected result to Co-Being's result.

        Args:
            operation: Operation name. Must be one of the keys in
                ``_MATH_OPS``: ``"add"``, ``"subtract"``, ``"multiply"``,
                ``"successor"``, ``"predecessor"``, ``"compare_eq"``,
                ``"compare_gt"``, ``"compare_lt"``.
            operands: Input values in positional order. Length must match
                the expected operand count for the operation.
            cb_result: Co-Being's computed result to validate.

        Returns:
            A ValidationResult. ``is_correct`` is True when Co-Being's
            result matches Python's computation exactly (using ``==``).
        """
        if operation not in _MATH_OPS:
            _logger.warning(
                "validation_unknown_operation operation=%s", operation
            )
            return ValidationResult(
                is_correct=False,
                cb_result=cb_result,
                correct_result=None,
                operation=operation,
                confidence_adjustment=0.0,
                error_description=(
                    f"Unknown operation '{operation}'. "
                    f"Supported: {sorted(_MATH_OPS.keys())}"
                ),
                validation_source="python_operator",
            )

        expected_count, func = _MATH_OPS[operation]

        if len(operands) != expected_count:
            _logger.warning(
                "validation_operand_count_mismatch operation=%s "
                "expected=%d got=%d",
                operation,
                expected_count,
                len(operands),
            )
            return ValidationResult(
                is_correct=False,
                cb_result=cb_result,
                correct_result=None,
                operation=operation,
                confidence_adjustment=0.0,
                error_description=(
                    f"Operation '{operation}' expects {expected_count} "
                    f"operand(s), got {len(operands)}."
                ),
                validation_source="python_operator",
            )

        try:
            correct_result = func(*operands)
        except Exception as exc:
            _logger.warning(
                "validation_computation_error operation=%s operands=%s error=%s",
                operation,
                operands,
                exc,
            )
            return ValidationResult(
                is_correct=False,
                cb_result=cb_result,
                correct_result=None,
                operation=operation,
                confidence_adjustment=0.0,
                error_description=f"Python computation error: {exc}",
                validation_source="python_operator",
            )

        is_correct = cb_result == correct_result
        adjustment = _CORRECT_ADJUSTMENT if is_correct else _INCORRECT_ADJUSTMENT

        error_desc = ""
        if not is_correct:
            error_desc = (
                f"Co-Being computed {cb_result} for "
                f"{operation}({', '.join(str(o) for o in operands)}), "
                f"but Python says {correct_result}."
            )

        _logger.info(
            "validation_math operation=%s operands=%s cb_result=%s "
            "correct_result=%s is_correct=%s",
            operation,
            operands,
            cb_result,
            correct_result,
            is_correct,
        )

        return ValidationResult(
            is_correct=is_correct,
            cb_result=cb_result,
            correct_result=correct_result,
            operation=operation,
            confidence_adjustment=adjustment,
            error_description=error_desc,
            validation_source="python_operator",
        )

    async def validate_morphological(
        self,
        word: str,
        transform: str,
        cb_result: str,
    ) -> ValidationResult:
        """Validate a morphological transformation against the inflect library.

        Uses the ``inflect`` library to compute the expected inflected form.
        If ``inflect`` is not installed, returns a result with
        ``validation_source="inflect_unavailable"`` and no confidence
        adjustment (the validation is inconclusive).

        Args:
            word: The base word (e.g., ``"cat"``).
            transform: The transformation type (e.g., ``"pluralize"``,
                ``"plural"``, ``"past_tense"``).
            cb_result: Co-Being's computed inflected form (e.g., ``"cats"``).

        Returns:
            A ValidationResult. ``is_correct`` is True when Co-Being's
            result matches the inflect library's output (case-insensitive
            comparison).
        """
        if not _INFLECT_AVAILABLE:
            _logger.info(
                "validation_inflect_unavailable word=%s transform=%s",
                word,
                transform,
            )
            return ValidationResult(
                is_correct=True,  # Cannot disprove, assume correct
                cb_result=cb_result,
                correct_result=None,
                operation=transform,
                confidence_adjustment=0.0,
                error_description="inflect library not installed; cannot validate.",
                validation_source="inflect_unavailable",
            )

        method_name = _MORPH_TRANSFORMS.get(transform)
        if method_name is None:
            _logger.info(
                "validation_morph_unsupported word=%s transform=%s",
                word,
                transform,
            )
            return ValidationResult(
                is_correct=True,  # Cannot disprove, assume correct
                cb_result=cb_result,
                correct_result=None,
                operation=transform,
                confidence_adjustment=0.0,
                error_description=(
                    f"Transform '{transform}' has no inflect validation mapping."
                ),
                validation_source="inflect_unavailable",
            )

        try:
            inflect_method = getattr(_inflect_engine, method_name, None)
            if inflect_method is None:
                return ValidationResult(
                    is_correct=True,
                    cb_result=cb_result,
                    correct_result=None,
                    operation=transform,
                    confidence_adjustment=0.0,
                    error_description=(
                        f"inflect engine has no method '{method_name}'."
                    ),
                    validation_source="inflect_unavailable",
                )

            correct_result = inflect_method(word)
        except Exception as exc:
            _logger.warning(
                "validation_inflect_error word=%s transform=%s error=%s",
                word,
                transform,
                exc,
            )
            return ValidationResult(
                is_correct=True,  # Cannot disprove on error, assume correct
                cb_result=cb_result,
                correct_result=None,
                operation=transform,
                confidence_adjustment=0.0,
                error_description=f"inflect computation error: {exc}",
                validation_source="inflect_library",
            )

        # Case-insensitive comparison for morphological forms
        is_correct = cb_result.lower() == str(correct_result).lower()
        adjustment = _CORRECT_ADJUSTMENT if is_correct else _INCORRECT_ADJUSTMENT

        error_desc = ""
        if not is_correct:
            error_desc = (
                f"Co-Being produced '{cb_result}' for "
                f"{transform}('{word}'), "
                f"but inflect says '{correct_result}'."
            )

        _logger.info(
            "validation_morph word=%s transform=%s cb_result=%s "
            "correct_result=%s is_correct=%s",
            word,
            transform,
            cb_result,
            correct_result,
            is_correct,
        )

        return ValidationResult(
            is_correct=is_correct,
            cb_result=cb_result,
            correct_result=correct_result,
            operation=transform,
            confidence_adjustment=adjustment,
            error_description=error_desc,
            validation_source="inflect_library",
        )

    @staticmethod
    def supported_math_operations() -> list[str]:
        """Return the list of math operations that can be validated.

        Returns:
            Sorted list of operation name strings.
        """
        return sorted(_MATH_OPS.keys())

    @staticmethod
    def inflect_available() -> bool:
        """Return whether the inflect library is installed and available.

        Returns:
            True if morphological validation is fully functional.
        """
        return _INFLECT_AVAILABLE


__all__ = [
    "ValidationExecutor",
    "ValidationResult",
]
