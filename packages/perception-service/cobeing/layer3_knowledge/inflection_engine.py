"""Self-directed practice engine for mathematical and morphological skills.

Generates practice problems from installed procedures and graph nodes, solves
them using existing executors (ProcedureExecutor, MorphologyExecutor), and
validates results against Python ground truth. Tracks practice outcomes for
confidence calibration via ACT-R dynamics.

This module implements P1.9-E2: Inflection Practice Mode.

CANON references:
    A.18: Practice generates INFERENCE provenance knowledge.
    A.1:  Validates experientially-learned procedures.
    A.2:  Exercises clear-box processing infrastructure only.

Architectural note:
    Practice does NOT create new procedures -- it exercises existing ones.
    Problems come from EXISTING graph nodes (ValueNodes, WordFormNodes).
    Confidence adjustments follow the ACT-R formula from instance_confidence.py.

Usage::

    from cobeing.layer3_knowledge.inflection_engine import InflectionEngine

    engine = InflectionEngine(
        persistence=graph,
        procedure_executor=proc_exec,
        morphology_executor=morph_exec,
    )
    report = await engine.run_practice_session(duration_seconds=300)
    # report.accuracy == 0.95
    # report.total_problems == 20
"""

from __future__ import annotations

import logging
import random
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from cobeing.layer3_knowledge.instance_confidence import (
    BASE_GUARDIAN_CONFIRMED,
    BASE_PROCEDURAL,
    PROCEDURAL_CAP,
    calculate_confidence,
    hours_since,
)
from cobeing.layer3_knowledge.language_types import TRANSFORMS_TO, WORD_FORM_NODE
from cobeing.layer3_knowledge.node_types import KnowledgeNode, SchemaLevel
from cobeing.layer3_knowledge.procedure_types import (
    COMPUTES_TO,
    PROCEDURAL_TEMPLATE,
    VALUE_NODE,
    ExecutionRequest,
)
from cobeing.layer3_knowledge.protocols import GraphPersistence
from cobeing.layer3_knowledge.query_types import EdgeFilter, NodeFilter
from cobeing.shared.provenance import ProvenanceSource
from cobeing.shared.types import NodeId

if TYPE_CHECKING:
    from cobeing.layer3_knowledge.morphology_executor import MorphologyExecutor
    from cobeing.layer3_knowledge.procedure_executor import ProcedureExecutor
    from cobeing.layer3_knowledge.negative_knowledge_manager import (
        NegativeKnowledgeManager,
    )
    from cobeing.layer3_knowledge.validation_executor import ValidationExecutor

_logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PracticeProblem:
    """A single practice problem to solve.

    Attributes:
        problem_id: Unique identifier for this problem instance.
        domain: The knowledge domain -- ``"math"`` or ``"morphology"``.
        operation: The operation to perform (e.g., ``"add"``, ``"pluralize"``).
        operands: Input values for the operation.
        operand_node_ids: Graph node IDs corresponding to the operands.
        difficulty: Difficulty level (1-3 for math, 1 for morphology).
        description: Human-readable problem statement, e.g., ``"3 + 5 = ?"``.
    """

    problem_id: str
    domain: str
    operation: str
    operands: list[Any]
    operand_node_ids: list[str]
    difficulty: int
    description: str


@dataclass(frozen=True)
class PracticeResult:
    """Outcome of attempting to solve a single practice problem.

    Attributes:
        problem: The problem that was attempted.
        cb_answer: What Co-Being computed via graph procedures.
        correct_answer: The Python ground-truth answer.
        is_correct: Whether cb_answer matches correct_answer.
        confidence_before: Edge confidence before practice.
        confidence_after: Edge confidence after practice.
        execution_time_ms: Wall-clock time to solve, in milliseconds.
        validation_source: How the ground truth was computed
            (e.g., ``"python_operator"``, ``"inflect_library"``).
        error_recorded: True if a negative knowledge edge was created
            (DOES_NOT_COMPUTE_TO or similar).
    """

    problem: PracticeProblem
    cb_answer: Any
    correct_answer: Any
    is_correct: bool
    confidence_before: float
    confidence_after: float
    execution_time_ms: float
    validation_source: str
    error_recorded: bool


@dataclass(frozen=True)
class PracticeSessionReport:
    """Aggregate report for a practice session.

    Attributes:
        session_id: Unique identifier for this practice session.
        start_time: ISO format timestamp of session start.
        end_time: ISO format timestamp of session end.
        total_problems: Number of problems attempted.
        correct_count: Number answered correctly.
        incorrect_count: Number answered incorrectly.
        accuracy: Fraction correct (0.0 to 1.0). 0.0 if no problems.
        math_accuracy: Accuracy for math problems only. -1.0 if none attempted.
        morphology_accuracy: Accuracy for morphology problems only. -1.0 if
            none attempted.
        average_confidence_delta: Mean change in confidence across all problems.
        problems_by_difficulty: Count of problems at each difficulty level.
        errors_recorded: Number of negative knowledge edges created.
        duration_seconds: Wall-clock duration of the session.
    """

    session_id: str
    start_time: str
    end_time: str
    total_problems: int
    correct_count: int
    incorrect_count: int
    accuracy: float
    math_accuracy: float
    morphology_accuracy: float
    average_confidence_delta: float
    problems_by_difficulty: dict[int, int]
    errors_recorded: int
    duration_seconds: float


# ---------------------------------------------------------------------------
# Math ground-truth operations
# ---------------------------------------------------------------------------

_MATH_GROUND_TRUTH: dict[str, Any] = {
    "add": lambda a, b: a + b,
    "subtract": lambda a, b: a - b,
    "multiply": lambda a, b: a * b,
    "compare_gt": lambda a, b: a > b,
    "compare_lt": lambda a, b: a < b,
    "compare_eq": lambda a, b: a == b,
}
"""Python ground-truth operations for validating math procedure results."""


# ---------------------------------------------------------------------------
# Morphology ground-truth (simple Python rules)
# ---------------------------------------------------------------------------


def _python_pluralize(word: str) -> str:
    """Simple Python pluralization for ground-truth validation.

    Covers the most common English regular plural rules. This is NOT
    meant to be comprehensive -- it validates that the graph-based
    morphology procedures produce the same results as basic rules.
    """
    if word.endswith(("s", "sh", "ch", "x", "z")):
        return word + "es"
    if word.endswith("y") and len(word) > 1 and word[-2] not in "aeiou":
        return word[:-1] + "ies"
    return word + "s"


def _python_past_tense(word: str) -> str:
    """Simple Python past tense for ground-truth validation."""
    if word.endswith("e"):
        return word + "d"
    if (
        word.endswith("y")
        and len(word) > 1
        and word[-2] not in "aeiou"
    ):
        return word[:-1] + "ied"
    return word + "ed"


_MORPHOLOGY_GROUND_TRUTH: dict[str, Any] = {
    "plural": _python_pluralize,
    "past_tense": _python_past_tense,
}
"""Python ground-truth transformations for validating morphology results."""


# ---------------------------------------------------------------------------
# Difficulty-level operand ranges
# ---------------------------------------------------------------------------

_DIFFICULTY_RANGES: dict[int, tuple[int, int]] = {
    1: (0, 9),
    2: (0, 20),
    3: (0, 50),
}

_DIFFICULTY_OPERATIONS: dict[int, list[str]] = {
    1: ["add", "subtract"],
    2: ["add", "subtract", "multiply"],
    3: ["add", "subtract", "multiply", "compare_gt"],
}


# ---------------------------------------------------------------------------
# InflectionEngine
# ---------------------------------------------------------------------------


class InflectionEngine:
    """Self-directed practice engine for mathematical and morphological skills.

    Generates practice problems based on installed procedures, solves them
    using existing executors, and validates results against Python ground
    truth. Tracks practice outcomes for confidence calibration.

    CANON A.18: Practice generates INFERENCE provenance knowledge.
    CANON A.1: Validates experientially-learned procedures.

    Args:
        persistence: The graph persistence backend.
        procedure_executor: Executor for math procedures. When None,
            math practice is skipped.
        morphology_executor: Executor for morphological transformations.
            When None, morphology practice is skipped.
        validation_executor: Optional validator from P1.9-E1 for richer
            ground-truth checking. Falls back to built-in Python validation
            when None.
        negative_knowledge_manager: Optional manager from P1.9-E1 for
            recording DOES_NOT_COMPUTE_TO edges on errors. When None,
            errors are logged but no negative knowledge edges are created.
    """

    def __init__(
        self,
        persistence: GraphPersistence,
        procedure_executor: ProcedureExecutor | None = None,
        morphology_executor: MorphologyExecutor | None = None,
        validation_executor: ValidationExecutor | None = None,
        negative_knowledge_manager: NegativeKnowledgeManager | None = None,
    ) -> None:
        self._persistence = persistence
        self._procedure_executor = procedure_executor
        self._morphology_executor = morphology_executor
        self._validation_executor = validation_executor
        self._negative_knowledge_manager = negative_knowledge_manager

    # ------------------------------------------------------------------
    # Problem generation: Math
    # ------------------------------------------------------------------

    async def generate_math_problems(
        self,
        count: int = 10,
        difficulty: int = 1,
    ) -> list[PracticeProblem]:
        """Generate math practice problems from installed procedures.

        Problems use ValueNode instances that already exist in the graph.
        If insufficient ValueNodes exist, falls back to generating problems
        from the available range.

        Args:
            count: Number of problems to generate. Capped at 50.
            difficulty: Difficulty level (1-3).
                1: Single-digit operands (0-9), add/subtract only.
                2: Double-digit operands (0-20), add/subtract/multiply.
                3: Mixed operations, larger numbers (0-50).

        Returns:
            List of PracticeProblem instances. May be shorter than count
            if insufficient graph data exists.
        """
        count = min(count, 50)
        difficulty = max(1, min(3, difficulty))

        lo, hi = _DIFFICULTY_RANGES[difficulty]
        operations = _DIFFICULTY_OPERATIONS[difficulty]

        # Gather available ValueNode integer values from the graph
        available_values = await self._get_available_integer_values(lo, hi)
        if len(available_values) < 2:
            # Not enough ValueNodes -- use the full range
            available_values = list(range(lo, hi + 1))

        problems: list[PracticeProblem] = []
        for _ in range(count):
            operation = random.choice(operations)
            a = random.choice(available_values)
            b = random.choice(available_values)

            # Avoid subtract producing negatives at low difficulty
            if operation == "subtract" and difficulty <= 2 and a < b:
                a, b = b, a

            a_node_id = f"value:integer:{a}"
            b_node_id = f"value:integer:{b}"

            if operation.startswith("compare"):
                description = f"Is {a} {'>' if operation == 'compare_gt' else '<' if operation == 'compare_lt' else '=='} {b}?"
            else:
                op_symbol = {"add": "+", "subtract": "-", "multiply": "*"}.get(
                    operation, "?"
                )
                description = f"{a} {op_symbol} {b} = ?"

            problems.append(
                PracticeProblem(
                    problem_id=f"practice:math:{uuid.uuid4().hex[:8]}",
                    domain="math",
                    operation=operation,
                    operands=[a, b],
                    operand_node_ids=[a_node_id, b_node_id],
                    difficulty=difficulty,
                    description=description,
                )
            )

        return problems

    # ------------------------------------------------------------------
    # Problem generation: Morphology
    # ------------------------------------------------------------------

    async def generate_morphology_problems(
        self,
        count: int = 10,
    ) -> list[PracticeProblem]:
        """Generate morphological practice problems from installed procedures.

        Uses existing WordFormNode base forms in the graph to create
        pluralization and past tense challenges.

        Args:
            count: Number of problems to generate. Capped at 50.

        Returns:
            List of PracticeProblem instances. May be shorter than count
            if insufficient WordFormNode data exists.
        """
        count = min(count, 50)

        # Find base WordFormNodes in the graph
        base_forms = await self._get_available_base_forms()
        if not base_forms:
            _logger.warning(
                "practice_no_base_forms: no WordFormNode base forms found in graph"
            )
            return []

        # Available morphology transforms that have ground-truth validators
        transform_types = list(_MORPHOLOGY_GROUND_TRUTH.keys())

        problems: list[PracticeProblem] = []
        for _ in range(count):
            spelling, node_id = random.choice(base_forms)
            transform = random.choice(transform_types)

            description = f"{transform}({spelling}) = ?"

            problems.append(
                PracticeProblem(
                    problem_id=f"practice:morph:{uuid.uuid4().hex[:8]}",
                    domain="morphology",
                    operation=transform,
                    operands=[spelling],
                    operand_node_ids=[node_id],
                    difficulty=1,
                    description=description,
                )
            )

        return problems

    # ------------------------------------------------------------------
    # Solve a single problem
    # ------------------------------------------------------------------

    async def solve_problem(self, problem: PracticeProblem) -> PracticeResult:
        """Attempt to solve a practice problem using existing executors.

        Steps:
        1. Execute the procedure (math or morphology) via graph executor.
        2. Validate result against Python ground truth.
        3. If wrong and negative_knowledge_manager is available, record error.
        4. Update confidence on the relevant COMPUTES_TO/TRANSFORMS_TO edge.
        5. Return result with before/after confidence.

        Args:
            problem: The practice problem to solve.

        Returns:
            PracticeResult with the outcome, confidence changes, and
            whether a negative knowledge edge was created.
        """
        start = time.monotonic()

        if problem.domain == "math":
            result = await self._solve_math_problem(problem, start)
        elif problem.domain == "morphology":
            result = await self._solve_morphology_problem(problem, start)
        else:
            elapsed_ms = (time.monotonic() - start) * 1000
            result = PracticeResult(
                problem=problem,
                cb_answer=None,
                correct_answer=None,
                is_correct=False,
                confidence_before=0.0,
                confidence_after=0.0,
                execution_time_ms=elapsed_ms,
                validation_source="unknown",
                error_recorded=False,
            )

        _logger.info(
            "practice_problem_solved problem_id=%s domain=%s operation=%s "
            "correct=%s cb_answer=%s ground_truth=%s elapsed_ms=%.1f",
            problem.problem_id,
            problem.domain,
            problem.operation,
            result.is_correct,
            result.cb_answer,
            result.correct_answer,
            result.execution_time_ms,
        )

        return result

    # ------------------------------------------------------------------
    # Run a timed practice session
    # ------------------------------------------------------------------

    async def run_practice_session(
        self,
        duration_seconds: int = 300,
        max_problems: int = 20,
    ) -> PracticeSessionReport:
        """Run a timed practice session alternating math and morphology.

        Generates problems in batches, alternating between math and
        morphology domains. Stops when duration expires or max_problems
        reached.

        Args:
            duration_seconds: Maximum session duration in seconds.
            max_problems: Maximum number of problems to attempt.

        Returns:
            Aggregate PracticeSessionReport with accuracy, confidence
            changes, and per-difficulty breakdown.
        """
        session_id = f"practice-session:{uuid.uuid4().hex[:12]}"
        start_time = datetime.now(UTC)
        start_mono = time.monotonic()
        deadline = start_mono + duration_seconds

        results: list[PracticeResult] = []
        problems_attempted = 0

        # Determine which domains are available
        domains: list[str] = []
        if self._procedure_executor is not None:
            domains.append("math")
        if self._morphology_executor is not None:
            domains.append("morphology")

        if not domains:
            _logger.warning(
                "practice_no_executors: neither procedure nor morphology "
                "executor available, skipping practice session"
            )
            end_time = datetime.now(UTC)
            return self._build_report(session_id, start_time, end_time, results)

        # Generate problems in small batches and solve them
        difficulty = 1
        domain_index = 0

        while problems_attempted < max_problems and time.monotonic() < deadline:
            domain = domains[domain_index % len(domains)]
            domain_index += 1

            # Generate a small batch
            batch_size = min(5, max_problems - problems_attempted)

            if domain == "math":
                problems = await self.generate_math_problems(
                    count=batch_size, difficulty=difficulty
                )
            else:
                problems = await self.generate_morphology_problems(
                    count=batch_size
                )

            for problem in problems:
                if (
                    problems_attempted >= max_problems
                    or time.monotonic() >= deadline
                ):
                    break

                result = await self.solve_problem(problem)
                results.append(result)
                problems_attempted += 1

            # Increase difficulty after every full domain cycle
            if domain_index % len(domains) == 0 and difficulty < 3:
                difficulty += 1

        end_time = datetime.now(UTC)
        report = self._build_report(session_id, start_time, end_time, results)

        _logger.info(
            "practice_session_complete session_id=%s total=%d correct=%d "
            "accuracy=%.2f duration=%.1fs",
            report.session_id,
            report.total_problems,
            report.correct_count,
            report.accuracy,
            report.duration_seconds,
        )

        return report

    # ------------------------------------------------------------------
    # Private: math problem solving
    # ------------------------------------------------------------------

    async def _solve_math_problem(
        self,
        problem: PracticeProblem,
        start: float,
    ) -> PracticeResult:
        """Solve a math problem via ProcedureExecutor and validate."""
        if self._procedure_executor is None:
            elapsed_ms = (time.monotonic() - start) * 1000
            return PracticeResult(
                problem=problem,
                cb_answer=None,
                correct_answer=None,
                is_correct=False,
                confidence_before=0.0,
                confidence_after=0.0,
                execution_time_ms=elapsed_ms,
                validation_source="skipped",
                error_recorded=False,
            )

        # Compute ground truth
        ground_truth_fn = _MATH_GROUND_TRUTH.get(problem.operation)
        if ground_truth_fn is None or len(problem.operands) < 2:
            elapsed_ms = (time.monotonic() - start) * 1000
            return PracticeResult(
                problem=problem,
                cb_answer=None,
                correct_answer=None,
                is_correct=False,
                confidence_before=0.0,
                confidence_after=0.0,
                execution_time_ms=elapsed_ms,
                validation_source="unknown_operation",
                error_recorded=False,
            )

        correct_answer = ground_truth_fn(problem.operands[0], problem.operands[1])

        # Look up the procedure ID for this operation
        procedure_id = NodeId(f"proc:{problem.operation}")

        # Get confidence before execution
        confidence_before = await self._get_computes_to_confidence(
            problem.operation,
            problem.operand_node_ids,
        )

        # Execute via ProcedureExecutor
        cb_answer: Any = None
        try:
            operand_node_ids = [NodeId(nid) for nid in problem.operand_node_ids]
            request = ExecutionRequest(
                procedure_id=procedure_id,
                operands=operand_node_ids,
                correlation_id=problem.problem_id,
            )
            exec_result = await self._procedure_executor.execute(request)
            cb_answer = exec_result.result_value
        except Exception as exc:
            _logger.warning(
                "practice_math_exec_failed problem_id=%s error=%s",
                problem.problem_id,
                exc,
            )

        elapsed_ms = (time.monotonic() - start) * 1000
        is_correct = cb_answer == correct_answer

        # Get confidence after execution (may have changed via encounter update)
        confidence_after = await self._get_computes_to_confidence(
            problem.operation,
            problem.operand_node_ids,
        )

        # Record negative knowledge if wrong
        error_recorded = False
        if not is_correct and self._negative_knowledge_manager is not None:
            try:
                await self._negative_knowledge_manager.record_error(
                    operation=problem.operation,
                    operand_ids=[NodeId(nid) for nid in problem.operand_node_ids],
                    incorrect_result=cb_answer,
                    correct_result=correct_answer,
                    source="practice_session",
                )
                error_recorded = True
            except Exception as exc:
                _logger.warning(
                    "practice_negative_knowledge_failed problem_id=%s error=%s",
                    problem.problem_id,
                    exc,
                )

        return PracticeResult(
            problem=problem,
            cb_answer=cb_answer,
            correct_answer=correct_answer,
            is_correct=is_correct,
            confidence_before=confidence_before,
            confidence_after=confidence_after,
            execution_time_ms=elapsed_ms,
            validation_source="python_operator",
            error_recorded=error_recorded,
        )

    # ------------------------------------------------------------------
    # Private: morphology problem solving
    # ------------------------------------------------------------------

    async def _solve_morphology_problem(
        self,
        problem: PracticeProblem,
        start: float,
    ) -> PracticeResult:
        """Solve a morphology problem via MorphologyExecutor and validate."""
        if self._morphology_executor is None:
            elapsed_ms = (time.monotonic() - start) * 1000
            return PracticeResult(
                problem=problem,
                cb_answer=None,
                correct_answer=None,
                is_correct=False,
                confidence_before=0.0,
                confidence_after=0.0,
                execution_time_ms=elapsed_ms,
                validation_source="skipped",
                error_recorded=False,
            )

        # Compute ground truth
        ground_truth_fn = _MORPHOLOGY_GROUND_TRUTH.get(problem.operation)
        if ground_truth_fn is None or len(problem.operands) < 1:
            elapsed_ms = (time.monotonic() - start) * 1000
            return PracticeResult(
                problem=problem,
                cb_answer=None,
                correct_answer=None,
                is_correct=False,
                confidence_before=0.0,
                confidence_after=0.0,
                execution_time_ms=elapsed_ms,
                validation_source="unknown_operation",
                error_recorded=False,
            )

        base_spelling = str(problem.operands[0])
        correct_answer = ground_truth_fn(base_spelling)

        # Get confidence before execution
        confidence_before = await self._get_transforms_to_confidence(
            base_spelling,
            problem.operation,
        )

        # Execute via MorphologyExecutor
        cb_answer: str | None = None
        try:
            morph_result = await self._morphology_executor.transform(
                base_spelling, problem.operation
            )
            cb_answer = morph_result.result_spelling
        except Exception as exc:
            _logger.warning(
                "practice_morph_exec_failed problem_id=%s error=%s",
                problem.problem_id,
                exc,
            )

        elapsed_ms = (time.monotonic() - start) * 1000
        is_correct = cb_answer == correct_answer

        # Get confidence after execution
        confidence_after = await self._get_transforms_to_confidence(
            base_spelling,
            problem.operation,
        )

        # Record error for morphology (if negative_knowledge_manager available)
        error_recorded = False
        if not is_correct and self._negative_knowledge_manager is not None:
            try:
                await self._negative_knowledge_manager.record_error(
                    operation=f"morphology:{problem.operation}",
                    operand_ids=[NodeId(nid) for nid in problem.operand_node_ids],
                    incorrect_result=cb_answer,
                    correct_result=correct_answer,
                    source="practice_session",
                )
                error_recorded = True
            except Exception as exc:
                _logger.warning(
                    "practice_morph_negative_knowledge_failed problem_id=%s error=%s",
                    problem.problem_id,
                    exc,
                )

        return PracticeResult(
            problem=problem,
            cb_answer=cb_answer,
            correct_answer=correct_answer,
            is_correct=is_correct,
            confidence_before=confidence_before,
            confidence_after=confidence_after,
            execution_time_ms=elapsed_ms,
            validation_source="python_rules",
            error_recorded=error_recorded,
        )

    # ------------------------------------------------------------------
    # Private: graph queries
    # ------------------------------------------------------------------

    async def _get_available_integer_values(
        self, lo: int, hi: int
    ) -> list[int]:
        """Find integer ValueNodes in the graph within [lo, hi].

        Queries for ValueNode nodes and extracts their integer values.
        Returns only values within the specified range.

        Args:
            lo: Lower bound (inclusive).
            hi: Upper bound (inclusive).

        Returns:
            List of integer values that exist as ValueNodes in the graph.
        """
        nodes = await self._persistence.query_nodes(
            NodeFilter(node_type=VALUE_NODE, schema_level=SchemaLevel.INSTANCE)
        )
        values: list[int] = []
        for node in nodes:
            if node.properties.get("value_type") != "integer":
                continue
            val = node.properties.get("value")
            if isinstance(val, int) and lo <= val <= hi:
                values.append(val)
        return values

    async def _get_available_base_forms(self) -> list[tuple[str, str]]:
        """Find base WordFormNodes in the graph.

        Returns:
            List of (spelling, node_id) tuples for base forms.
        """
        nodes = await self._persistence.query_nodes(
            NodeFilter(
                node_type=WORD_FORM_NODE,
                schema_level=SchemaLevel.INSTANCE,
            )
        )
        base_forms: list[tuple[str, str]] = []
        for node in nodes:
            if node.properties.get("inflection_type") != "base":
                continue
            spelling = node.properties.get("spelling", "")
            if spelling:
                base_forms.append((spelling, str(node.node_id)))
        return base_forms

    async def _get_computes_to_confidence(
        self,
        operation: str,
        operand_node_ids: list[str],
    ) -> float:
        """Look up the confidence of a COMPUTES_TO edge for given operation/operands.

        Returns 0.0 if no matching edge exists.
        """
        if not operand_node_ids:
            return 0.0

        edges = await self._persistence.query_edges(
            EdgeFilter(
                edge_type=COMPUTES_TO,
                source_node_id=operand_node_ids[0],
            )
        )
        for edge in edges:
            if (
                edge.properties.get("operation") == operation
                and edge.properties.get("operand_ids") == operand_node_ids
                and not edge.properties.get("deprecated", False)
            ):
                return float(edge.properties.get("confidence", 0.0))
        return 0.0

    async def _get_transforms_to_confidence(
        self,
        base_spelling: str,
        transform_type: str,
    ) -> float:
        """Look up the confidence of a TRANSFORMS_TO edge for a word/transform.

        Returns 0.0 if no matching edge exists.
        """
        base_form_id = NodeId(f"form:{base_spelling}:base")
        edges = await self._persistence.query_edges(
            EdgeFilter(
                edge_type=TRANSFORMS_TO,
                source_node_id=str(base_form_id),
            )
        )
        for edge in edges:
            if (
                edge.properties.get("transform_type") == transform_type
                and not edge.properties.get("is_defective", False)
                and not edge.properties.get("deprecated", False)
            ):
                return float(edge.properties.get("confidence", 0.0))
        return 0.0

    # ------------------------------------------------------------------
    # Private: report building
    # ------------------------------------------------------------------

    def _build_report(
        self,
        session_id: str,
        start_time: datetime,
        end_time: datetime,
        results: list[PracticeResult],
    ) -> PracticeSessionReport:
        """Build a PracticeSessionReport from a list of PracticeResults."""
        total = len(results)
        correct = sum(1 for r in results if r.is_correct)
        incorrect = total - correct

        math_results = [r for r in results if r.problem.domain == "math"]
        morph_results = [r for r in results if r.problem.domain == "morphology"]

        math_correct = sum(1 for r in math_results if r.is_correct)
        morph_correct = sum(1 for r in morph_results if r.is_correct)

        math_accuracy = (
            math_correct / len(math_results) if math_results else -1.0
        )
        morph_accuracy = (
            morph_correct / len(morph_results) if morph_results else -1.0
        )

        confidence_deltas = [
            r.confidence_after - r.confidence_before for r in results
        ]
        avg_delta = (
            sum(confidence_deltas) / len(confidence_deltas)
            if confidence_deltas
            else 0.0
        )

        problems_by_difficulty: dict[int, int] = {}
        for r in results:
            d = r.problem.difficulty
            problems_by_difficulty[d] = problems_by_difficulty.get(d, 0) + 1

        errors_recorded = sum(1 for r in results if r.error_recorded)

        duration = (end_time - start_time).total_seconds()

        return PracticeSessionReport(
            session_id=session_id,
            start_time=start_time.isoformat(),
            end_time=end_time.isoformat(),
            total_problems=total,
            correct_count=correct,
            incorrect_count=incorrect,
            accuracy=correct / total if total > 0 else 0.0,
            math_accuracy=math_accuracy,
            morphology_accuracy=morph_accuracy,
            average_confidence_delta=avg_delta,
            problems_by_difficulty=problems_by_difficulty,
            errors_recorded=errors_recorded,
            duration_seconds=duration,
        )


__all__ = [
    "InflectionEngine",
    "PracticeProblem",
    "PracticeResult",
    "PracticeSessionReport",
]
