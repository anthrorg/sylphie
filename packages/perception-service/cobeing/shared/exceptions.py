"""Co-Being shared exceptions.

Exceptions used across multiple layers of the Co-Being system.
Each exception is designed to carry enough context for callers
to produce actionable error messages without catching-and-inspecting.
"""


class CoBeingError(Exception):
    """Base exception for all Co-Being application errors.

    All custom exceptions in the project inherit from this so that
    a caller can catch ``CoBeingError`` to handle any application-level
    failure uniformly.
    """


class GraphUnavailableError(CoBeingError):
    """Raised when the graph database cannot be reached or is not ready.

    This covers several failure modes:
      - The database process is not running or not reachable on the network.
      - Authentication credentials are rejected.
      - A required plugin (e.g. APOC) is missing or non-functional.
      - The database version does not meet minimum requirements.

    Attributes:
        reason: A short machine-friendly tag for the failure mode.
        detail: A human-readable explanation suitable for log messages.
    """

    def __init__(self, reason: str, detail: str) -> None:
        self.reason = reason
        self.detail = detail
        super().__init__(f"[{reason}] {detail}")
