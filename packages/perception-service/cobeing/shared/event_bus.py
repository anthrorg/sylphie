"""Typed async event bus with priority-based dispatch.

Generic infrastructure -- no Co-Being domain knowledge here. Domain event
types (ObservationIngested, RuleFired, etc.) are defined elsewhere and
registered at the composition root.

Usage::

    from cobeing.shared.event_bus import Event, EventBus, EventPriority
    from dataclasses import dataclass

    @dataclass(frozen=True)
    class SomethingHappened(Event):
        value: str = ""

    bus = EventBus()

    async def my_handler(event: SomethingHappened) -> None:
        print(event.value)

    bus.subscribe(SomethingHappened, my_handler, priority=EventPriority.NORMAL)
    await bus.publish(SomethingHappened(value="hello"))

Priority ordering::

    CRITICAL > HIGH > NORMAL > LOW

    All handlers for a given event type are called in priority order,
    highest-priority first. Within the same priority level, handlers are called
    in registration order (first registered, first called).

Error handling -- hybrid model::

    Handlers are registered with a ``critical`` flag (default ``True``).

    - ``critical=True`` (default): if the handler raises, the exception is
      logged at ERROR level and then re-raised. Dispatch halts; no subsequent
      handlers run for that event.

    - ``critical=False``: if the handler raises, the exception is logged at
      CRITICAL level (because a non-critical handler failing is still
      noteworthy) and dispatch continues to the next handler. The exception
      is never propagated to the ``publish()`` caller.

    Choosing ``critical=True`` for a handler signals: "this handler must not
    silently fail -- if it raises the caller needs to know." Use this for
    handlers that write to persistent state or maintain invariants.

    Choosing ``critical=False`` signals: "this handler is best-effort -- a
    failure should not derail the broader dispatch chain." Use this for
    logging, metrics, or UI updates.
"""

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import IntEnum
from typing import TypeVar

logger = logging.getLogger(__name__)


class EventPriority(IntEnum):
    """Dispatch priority for event handlers.

    Handlers are called in descending priority order: CRITICAL handlers run
    before HIGH, HIGH before NORMAL, NORMAL before LOW.

    Attributes:
        LOW: Background / best-effort processing.
        NORMAL: Default priority for most handlers.
        HIGH: Time-sensitive processing that should run before normal handlers.
        CRITICAL: Safety-critical handlers that must run first (e.g., emergency
            stop, fault isolation).
    """

    LOW = 0
    NORMAL = 1
    HIGH = 2
    CRITICAL = 3


@dataclass(frozen=True)
class Event:
    """Base event type. All domain events should subclass this.

    Subclass and add fields for the data your event carries::

        @dataclass(frozen=True)
        class ObjectDetected(Event):
            label: str = ""
            confidence: float = 0.0

    The ``timestamp`` field is populated automatically to the current UTC time
    at construction. It is frozen (immutable) once set.

    Attributes:
        timestamp: UTC datetime when the event was created.
    """

    timestamp: datetime = field(default_factory=lambda: datetime.now(UTC))


T = TypeVar("T", bound=Event)


class EventBus:
    """Typed async event bus with priority-based dispatch.

    Supports registering multiple handlers per event type. Handlers are
    dispatched in priority order (CRITICAL first, LOW last). Within the same
    priority level, handlers are called in registration order.

    Error handling is controlled per-handler via the ``critical`` flag on
    ``subscribe()``:

    - ``critical=True`` (default): a handler exception is logged then
      re-raised. Dispatch halts and the exception propagates to the
      ``publish()`` caller.
    - ``critical=False``: a handler exception is logged at CRITICAL level and
      dispatch continues to the next handler. The exception is never
      propagated to the ``publish()`` caller.

    This class is generic infrastructure. It imports nothing from cobeing
    domain layers and has no knowledge of any specific event type.

    Example::

        bus = EventBus()

        async def on_event(event: MyEvent) -> None:
            ...

        bus.subscribe(MyEvent, on_event, priority=EventPriority.HIGH, critical=True)
        await bus.publish(MyEvent())
        bus.unsubscribe(MyEvent, on_event)
    """

    def __init__(self) -> None:
        # Maps event type -> list of (priority, critical, handler) tuples.
        # The list is maintained in insertion order; sorting by priority
        # happens at publish time. This avoids re-sorting on every subscribe.
        self._handlers: dict[
            type, list[tuple[EventPriority, bool, Callable[..., Awaitable[None]]]]
        ] = {}

    def subscribe(
        self,
        event_type: type[T],
        handler: Callable[[T], Awaitable[None]],
        priority: EventPriority = EventPriority.NORMAL,
        critical: bool = True,
    ) -> None:
        """Register a handler for an event type.

        Handlers are called during ``publish()`` in priority order (CRITICAL
        first, LOW last). Multiple handlers can be registered for the same
        event type; within the same priority they are called in registration
        order.

        Registering the same handler object more than once for the same event
        type results in it being called multiple times. Callers are responsible
        for avoiding duplicate registrations.

        Args:
            event_type: The class of events this handler should receive. Only
                events whose runtime type is exactly ``event_type`` trigger
                this handler (no subclass matching).
            handler: An async callable that accepts a single argument of type
                ``event_type``.
            priority: Dispatch priority. Defaults to ``EventPriority.NORMAL``.
            critical: Controls exception propagation if this handler raises.

                ``True`` (default): the exception is logged at ERROR level and
                then re-raised. Dispatch halts; no subsequent handlers run for
                this event. The exception propagates to ``publish()``'s caller.

                ``False``: the exception is logged at CRITICAL level (a
                non-critical handler failing is still noteworthy) and dispatch
                continues to the next handler. The exception is never
                propagated to the ``publish()`` caller.
        """
        if event_type not in self._handlers:
            self._handlers[event_type] = []
        self._handlers[event_type].append((priority, critical, handler))

    def unsubscribe(
        self,
        event_type: type[T],
        handler: Callable[[T], Awaitable[None]],
    ) -> None:
        """Remove a handler registration.

        Removes the first matching (event_type, handler) pair. If the same
        handler was registered multiple times, only the first registration is
        removed per call.

        No-op if the event type has no registered handlers or the handler is
        not found.

        Args:
            event_type: The event class the handler was registered for.
            handler: The handler callable to remove.
        """
        if event_type not in self._handlers:
            return
        entries = self._handlers[event_type]
        for i, (_, _critical, registered_handler) in enumerate(entries):
            if registered_handler is handler:
                del entries[i]
                break
        # Clean up the key if no handlers remain, keeps the dict tidy.
        if not entries:
            del self._handlers[event_type]

    async def publish(self, event: Event) -> None:
        """Dispatch an event to all registered handlers for its exact type.

        Handlers are sorted by priority (CRITICAL=3 first, LOW=0 last) and
        then called sequentially in that order.

        Exception handling depends on each handler's ``critical`` flag
        (set at ``subscribe()`` time):

        - ``critical=True``: if the handler raises, the exception is logged
          at ERROR level and then re-raised. Dispatch halts immediately; no
          subsequent handlers are called. The exception propagates to the
          caller of ``publish()``.
        - ``critical=False``: if the handler raises, the exception is logged
          at CRITICAL level and dispatch continues to the next handler. The
          exception is never propagated to the ``publish()`` caller.

        Handlers for other event types are never invoked (no subclass
        matching). Publishing to a type with no registered handlers is a
        silent no-op.

        Args:
            event: The event instance to dispatch. Its exact runtime type
                determines which handlers are called.

        Raises:
            Exception: Any exception raised by a ``critical=True`` handler
                is re-raised after being logged. The specific exception type
                depends on the handler implementation.
        """
        event_type = type(event)
        entries = self._handlers.get(event_type)
        if not entries:
            return

        # Sort a copy by priority descending (CRITICAL=3 first, LOW=0 last).
        # Stable sort preserves registration order within equal priorities.
        sorted_entries = sorted(entries, key=lambda triple: triple[0], reverse=True)

        for priority, is_critical, handler in sorted_entries:
            try:
                await handler(event)
            except Exception:
                handler_name = getattr(handler, "__qualname__", repr(handler))
                if is_critical:
                    logger.error(
                        "EventBus critical handler error — re-raising: "
                        "handler=%s event_type=%s priority=%s",
                        handler_name,
                        event_type.__name__,
                        priority.name,
                    )
                    raise
                else:
                    logger.critical(
                        "EventBus non-critical handler error (dispatch continues): "
                        "handler=%s event_type=%s priority=%s",
                        handler_name,
                        event_type.__name__,
                        priority.name,
                    )

    @property
    def handler_count(self) -> int:
        """Total number of registered handlers across all event types.

        Returns:
            The sum of handler registrations for every event type known to
            this bus. A handler registered for two different event types counts
            as two registrations.
        """
        return sum(len(entries) for entries in self._handlers.values())
