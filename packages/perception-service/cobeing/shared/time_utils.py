"""Shared UTC timestamp utility.

Every module in Co-Being that needs the current time uses this function
to ensure consistent timezone-aware UTC datetimes across the entire
codebase. This eliminates the previously-duplicated ``_utc_now()``
helper that appeared in seven Layer 3 modules.
"""

from __future__ import annotations

from datetime import UTC, datetime


def utc_now() -> datetime:
    """Return the current UTC datetime (timezone-aware).

    All timestamps in Co-Being are timezone-aware UTC to prevent
    ambiguity when comparing across sessions or serializing to storage.

    Returns:
        A ``datetime`` with ``tzinfo=UTC``.
    """
    return datetime.now(UTC)
