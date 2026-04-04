"""Async circuit breaker utility.

A generic circuit breaker that protects any async callable from repeated
failures. This module has zero Co-Being domain knowledge -- it contains only
the state machine and the concurrency primitives needed to make it correct.

State machine::

    CLOSED ──(N consecutive failures)──> OPEN
    OPEN   ──(cooldown elapsed)────────> HALF_OPEN  (on next call attempt)
    HALF_OPEN ──(probe success)────────> CLOSED
    HALF_OPEN ──(probe failure)────────> OPEN

Usage::

    from cobeing.shared.circuit_breaker import CircuitBreaker, CircuitBreakerOpenError

    breaker = CircuitBreaker(failure_threshold=3, cooldown_seconds=30.0, name="llm-api")

    try:
        result = await breaker.call(some_async_func, arg1, kwarg=value)
    except CircuitBreakerOpenError as exc:
        # Circuit is OPEN; retry_after_seconds indicates how long to wait.
        logger.warning("circuit open, retry after %.1fs", exc.retry_after_seconds)
    except SomeOtherError:
        # The underlying function raised; circuit breaker re-raised it.
        ...
"""

import asyncio
import time
from collections.abc import Awaitable, Callable
from enum import StrEnum
from typing import TypeVar

from .exceptions import CoBeingError

T = TypeVar("T")


class CircuitBreakerState(StrEnum):
    """Possible states of a CircuitBreaker.

    Attributes:
        CLOSED: Normal operation. Calls pass through to the wrapped callable.
        OPEN: Fault state. Calls are rejected immediately without executing
            the wrapped callable.
        HALF_OPEN: Recovery probe state. Exactly one call is allowed through.
            Success transitions to CLOSED; failure returns to OPEN.
    """

    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


class CircuitBreakerOpenError(CoBeingError):
    """Raised when a call is attempted while the circuit breaker is OPEN.

    This error is raised *instead* of calling the wrapped function -- no
    downstream I/O is performed when the circuit is open.

    Attributes:
        name: The circuit breaker's name, for log correlation.
        retry_after_seconds: Approximate seconds until the circuit may
            transition to HALF_OPEN and allow a probe call. Zero if the
            cooldown has already elapsed.

    Example::

        try:
            result = await breaker.call(fetch_data)
        except CircuitBreakerOpenError as exc:
            log.warning(
                "circuit_open",
                breaker=exc.name,
                retry_after=exc.retry_after_seconds,
            )
    """

    def __init__(self, name: str, retry_after_seconds: float) -> None:
        self.name = name
        self.retry_after_seconds = max(0.0, retry_after_seconds)
        super().__init__(
            f"Circuit breaker '{name}' is OPEN. "
            f"Retry after {self.retry_after_seconds:.1f}s."
        )


class CircuitBreaker:
    """Async circuit breaker protecting a wrapped async callable.

    Tracks consecutive failures and opens the circuit after
    ``failure_threshold`` are reached, blocking further calls for
    ``cooldown_seconds``. After the cooldown a single probe call is
    permitted (HALF_OPEN); if it succeeds the circuit closes, if it
    fails the circuit reopens.

    All state transitions are guarded by an ``asyncio.Lock`` so concurrent
    coroutines see a consistent view of the state. The HALF_OPEN probe is
    additionally serialized by a one-token ``asyncio.Semaphore`` so that
    only one caller executes the probe while all other concurrent callers
    receive ``CircuitBreakerOpenError``.

    Args:
        failure_threshold: Number of consecutive failures required to open
            the circuit. Must be >= 1. Defaults to 3.
        cooldown_seconds: Seconds the circuit stays OPEN before allowing a
            probe call. Must be >= 0. Defaults to 30.0.
        name: Human-readable label used in log messages and exception text.

    Example::

        breaker = CircuitBreaker(
            failure_threshold=5,
            cooldown_seconds=60.0,
            name="neo4j-write",
        )
        result = await breaker.call(graph.write_node, node)
    """

    def __init__(
        self,
        failure_threshold: int = 3,
        cooldown_seconds: float = 30.0,
        name: str = "default",
    ) -> None:
        if failure_threshold < 1:
            raise ValueError(f"failure_threshold must be >= 1, got {failure_threshold}")
        if cooldown_seconds < 0:
            raise ValueError(f"cooldown_seconds must be >= 0, got {cooldown_seconds}")

        self._failure_threshold = failure_threshold
        self._cooldown_seconds = cooldown_seconds
        self._name = name

        self._state: CircuitBreakerState = CircuitBreakerState.CLOSED
        self._consecutive_failures: int = 0
        self._opened_at: float | None = None  # time.monotonic() when OPEN was entered

        # Serializes all state reads and transitions.
        self._lock = asyncio.Lock()

        # Limits concurrent probe calls in HALF_OPEN to exactly one.
        # The semaphore starts with one token; the probe acquires it and
        # holds it for the duration of the call.
        self._probe_semaphore = asyncio.Semaphore(1)

    @property
    def state(self) -> CircuitBreakerState:
        """Current state of the circuit breaker.

        Note: This is a snapshot. The state may change immediately after
        reading it if a concurrent coroutine is executing ``call()``.
        Use this property for observability (logging, monitoring) rather
        than for control flow.
        """
        return self._state

    async def call(self, func: Callable[..., Awaitable[T]], *args: object, **kwargs: object) -> T:
        """Execute ``func`` through the circuit breaker.

        Behaviour depends on the current state:

        - **CLOSED**: Calls ``func`` normally. Success resets the consecutive
          failure counter. Failure increments it; if the threshold is reached
          the circuit opens.
        - **OPEN**: Raises ``CircuitBreakerOpenError`` immediately without
          calling ``func``. If the cooldown has elapsed, transitions to
          HALF_OPEN first; the caller that triggers the transition still
          receives ``CircuitBreakerOpenError`` and must retry.
        - **HALF_OPEN**: Allows exactly one probe call through. All other
          concurrent callers receive ``CircuitBreakerOpenError``. Probe
          success transitions to CLOSED; probe failure returns to OPEN.

        Args:
            func: Any async callable to protect.
            *args: Positional arguments forwarded to ``func``.
            **kwargs: Keyword arguments forwarded to ``func``.

        Returns:
            Whatever ``func`` returns on success.

        Raises:
            CircuitBreakerOpenError: If the circuit is OPEN (or HALF_OPEN
                and a probe is already running).
            Exception: Any exception raised by ``func`` is re-raised after
                the circuit breaker records the failure.
        """
        async with self._lock:
            # Check for cooldown expiry while we hold the lock.
            if self._state == CircuitBreakerState.OPEN:
                elapsed = time.monotonic() - self._opened_at  # type: ignore[operator]
                if elapsed >= self._cooldown_seconds:
                    self._state = CircuitBreakerState.HALF_OPEN
                else:
                    retry_after = self._cooldown_seconds - elapsed
                    raise CircuitBreakerOpenError(self._name, retry_after)

            if self._state == CircuitBreakerState.HALF_OPEN:
                # Only one probe allowed at a time. If the semaphore is
                # already held by another probe, reject this caller.
                if not self._probe_semaphore._value:  # noqa: SLF001
                    raise CircuitBreakerOpenError(self._name, retry_after_seconds=0.0)

        # --- Execute the callable outside the lock to avoid blocking others. ---

        if self._state == CircuitBreakerState.HALF_OPEN:
            return await self._execute_probe(func, *args, **kwargs)

        # CLOSED path.
        return await self._execute_closed(func, *args, **kwargs)

    async def _execute_closed(
        self, func: Callable[..., Awaitable[T]], *args: object, **kwargs: object
    ) -> T:
        """Run ``func`` on the CLOSED path and update failure accounting.

        Args:
            func: The async callable to execute.
            *args: Positional arguments forwarded to ``func``.
            **kwargs: Keyword arguments forwarded to ``func``.

        Returns:
            The return value of ``func``.

        Raises:
            Exception: Any exception from ``func`` is re-raised after
                the circuit breaker records it.
        """
        try:
            result = await func(*args, **kwargs)
        except Exception:
            async with self._lock:
                self._consecutive_failures += 1
                if self._consecutive_failures >= self._failure_threshold:
                    self._state = CircuitBreakerState.OPEN
                    self._opened_at = time.monotonic()
            raise
        else:
            async with self._lock:
                self._consecutive_failures = 0
            return result

    async def _execute_probe(
        self, func: Callable[..., Awaitable[T]], *args: object, **kwargs: object
    ) -> T:
        """Run a single probe call in HALF_OPEN state.

        Acquires the probe semaphore before calling ``func`` and releases it
        afterward. Transitions to CLOSED on success, OPEN on failure.

        Args:
            func: The async callable to probe with.
            *args: Positional arguments forwarded to ``func``.
            **kwargs: Keyword arguments forwarded to ``func``.

        Returns:
            The return value of ``func`` if the probe succeeds.

        Raises:
            Exception: Any exception from ``func`` is re-raised after
                transitioning the circuit back to OPEN.
        """
        async with self._probe_semaphore:
            try:
                result = await func(*args, **kwargs)
            except Exception:
                async with self._lock:
                    self._state = CircuitBreakerState.OPEN
                    self._opened_at = time.monotonic()
                    self._consecutive_failures = self._failure_threshold
                raise
            else:
                async with self._lock:
                    self._state = CircuitBreakerState.CLOSED
                    self._consecutive_failures = 0
                    self._opened_at = None
                return result

    def reset(self) -> None:
        """Reset the circuit breaker to CLOSED state.

        Clears all failure tracking and cancels any open/half-open state.
        Intended for manual recovery after an outage has been confirmed
        resolved, or for use in tests that need a clean slate between
        scenarios.

        Note: This method is *not* coroutine-safe by itself -- if called
        while coroutines are executing ``call()``, the state update is not
        atomic with respect to the internal lock. In production use, call
        ``reset()`` only from a maintenance context where no concurrent
        ``call()`` invocations are in flight. In tests it is safe because
        tests are single-threaded.
        """
        self._state = CircuitBreakerState.CLOSED
        self._consecutive_failures = 0
        self._opened_at = None
