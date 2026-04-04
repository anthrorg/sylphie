"""ConversationLogger -- session-level plain-text conversation log writer.

Each ConversationLogger instance manages a single session log file.
The file is created on construction with a timestamped filename under
``logs/conversations/``.  Every turn is appended as a human-readable
block with timestamp, guardian input, system response, intent type,
and optional voice metadata.

Design notes
------------
**Not Python logging.**  This is a direct-write log file for conversation
audit.  Python's ``logging`` module is used separately for debug/operational
output.  This logger produces a skimmable plain-text record of what the
guardian said and what Co-Being answered.

**Thread safety.**  The logger uses simple synchronous file writes.  All
calls are expected to come from the single asyncio event loop thread.
No locking is required.

**No rotation, no compression.**  Each session gets one file.  Files
accumulate in ``logs/conversations/``.  Manual cleanup is the operator's
responsibility for now.

**Duplicate prevention.**  The logger tracks ``turn_id`` values in a set.
If ``log_turn()`` is called with a ``turn_id`` that was already logged,
the call is silently ignored.  This prevents double-logging when both
ConversationManager and VoiceLoopRunner share the same logger instance.

Usage::

    from cobeing.shared.conversation_logger import ConversationLogger

    logger = ConversationLogger(log_dir="logs/conversations")
    logger.log_turn(
        turn_id="abc-123",
        guardian_text="What can you see?",
        response_text="I don't have my camera active yet.",
        intent_type="question",
    )
    logger.log_voice_turn(voice_result)
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import IO


class ConversationLogger:
    """Writes a human-readable conversation log for one session.

    Creates a log file named by start timestamp on construction.  Each
    call to :meth:`log_turn` or :meth:`log_voice_turn` appends a
    formatted block to the file.

    Args:
        log_dir: Directory for conversation log files.  Created if it
            does not exist.  Defaults to ``"logs/conversations"``.
    """

    def __init__(
        self,
        log_dir: str | Path = "logs/conversations",
        prior_turn_count: int = 5,
    ) -> None:
        self._log_dir = Path(log_dir)
        self._log_dir.mkdir(parents=True, exist_ok=True)
        self._session_start = datetime.now()
        self._logged_turn_ids: set[str] = set()

        filename = self._session_start.strftime("%Y-%m-%d_%H-%M-%S") + ".log"
        self._filepath = self._log_dir / filename

        self._file: IO[str] = open(  # noqa: SIM115
            self._filepath, "a", encoding="utf-8"
        )
        self._write_header()
        self._write_prior_context(prior_turn_count)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def log_turn(
        self,
        *,
        turn_id: str,
        guardian_text: str,
        response_text: str,
        intent_type: str,
        error_type: str | None = None,
        tts_succeeded: bool | None = None,
    ) -> None:
        """Log a single conversation turn.

        Called by ConversationManager at the end of ``process_turn()``.
        If ``turn_id`` was already logged, the call is silently ignored
        to prevent double-logging from overlapping call sites.

        Args:
            turn_id: Unique turn identifier (UUID4 string).
            guardian_text: What the guardian said (raw or transcribed).
            response_text: What Co-Being responded.
            intent_type: The PT-8 intent classification result.
            error_type: Optional error identifier (e.g. ``"stt_failed"``).
                ``None`` on the happy path.
            tts_succeeded: ``True`` if TTS produced audio, ``False`` if
                TTS failed, ``None`` for text-only turns (no TTS involved).
        """
        if turn_id in self._logged_turn_ids:
            return
        self._logged_turn_ids.add(turn_id)

        now = datetime.now()
        ts = now.strftime("%H:%M:%S")

        lines: list[str] = []
        lines.append(f"[{ts}] GUARDIAN: {guardian_text}")
        lines.append(f"           COBEING:  {response_text}")

        # Metadata line
        meta_parts: list[str] = []
        if intent_type:
            meta_parts.append(f"intent={intent_type}")
        if error_type:
            meta_parts.append(f"error={error_type}")
        if tts_succeeded is not None:
            meta_parts.append(f"tts={'yes' if tts_succeeded else 'no'}")
        if meta_parts:
            lines.append("           " + "  ".join(meta_parts))

        lines.append("")  # blank line between entries
        self._file.write("\n".join(lines) + "\n")
        self._file.flush()

    def log_voice_turn(self, voice_result: object) -> None:
        """Log a voice turn from a VoiceTurnResult using duck-typed access.

        Extracts fields from the result using ``getattr`` to avoid importing
        VoiceTurnResult directly (which would create a circular import from
        shared -> voice).

        For voice errors that never reached the conversation pipeline
        (stt_failed, recording_too_short, no_speech, low_confidence), the
        guardian text and response may be empty.  The log entry still records
        the error type for debugging.

        For voice turns that reached ConversationManager: if the turn was
        already logged by ConversationManager's ``log_turn()`` call, this
        method is a no-op (duplicate prevention by ``turn_id``).

        Args:
            voice_result: A ``VoiceTurnResult`` instance (duck-typed).
                Expected attributes: ``turn_id``, ``transcription_text``,
                ``response_text``, ``intent_type``, ``error_type``,
                ``tts_succeeded``.
        """
        turn_id: str = getattr(voice_result, "turn_id", "")
        if not turn_id:
            return

        # If this turn was already logged by ConversationManager, skip.
        if turn_id in self._logged_turn_ids:
            return

        transcription_text: str = getattr(voice_result, "transcription_text", "")
        response_text: str = getattr(voice_result, "response_text", "")
        intent_type: str = getattr(voice_result, "intent_type", "")
        error_type: str | None = getattr(voice_result, "error_type", None)
        tts_succeeded: bool = getattr(voice_result, "tts_succeeded", False)

        # For error-only entries (stt_failed, etc.), format differently.
        if error_type and not response_text:
            self._logged_turn_ids.add(turn_id)
            now = datetime.now()
            ts = now.strftime("%H:%M:%S")

            lines: list[str] = []
            if transcription_text:
                lines.append(f"[{ts}] GUARDIAN: {transcription_text}")
            else:
                lines.append(f"[{ts}] GUARDIAN: (voice error)")
            lines.append(f"           error={error_type}")
            lines.append("")
            self._file.write("\n".join(lines) + "\n")
            self._file.flush()
            return

        # For successful voice turns, log the full entry with tts status.
        self.log_turn(
            turn_id=turn_id,
            guardian_text=transcription_text or "(no transcription)",
            response_text=response_text,
            intent_type=intent_type,
            error_type=error_type,
            tts_succeeded=tts_succeeded,
        )

    def close(self) -> None:
        """Close the log file handle.

        Safe to call multiple times.  After closing, further ``log_turn``
        and ``log_voice_turn`` calls will raise ``ValueError`` (closed file).
        """
        if not self._file.closed:
            self._file.close()

    @property
    def filepath(self) -> Path:
        """Absolute path to the current session log file."""
        return self._filepath

    # ------------------------------------------------------------------
    # Private
    # ------------------------------------------------------------------

    def _write_header(self) -> None:
        """Write the session header block to the log file."""
        started = self._session_start.strftime("%Y-%m-%d %H:%M:%S")
        separator = "=" * 80
        header = (
            f"{separator}\n"
            "Co-Being Conversation Session\n"
            f"Started: {started}\n"
            f"{separator}\n"
            "\n"
        )
        self._file.write(header)
        self._file.flush()

    def _write_prior_context(self, turn_count: int) -> None:
        """Append the last N turns from the most recent prior session log.

        Reads the previous log file (if any), extracts the last ``turn_count``
        turn blocks, and writes them under a "Prior Session Context" divider.
        This gives the reader (and any auditing agent) continuity across
        session boundaries.

        Args:
            turn_count: Number of prior turns to include. 0 disables.
        """
        if turn_count <= 0:
            return

        # Find the most recent log file that is NOT this session's file.
        prior_logs = sorted(
            [f for f in self._log_dir.glob("*.log") if f != self._filepath],
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        if not prior_logs:
            return

        try:
            prior_text = prior_logs[0].read_text(encoding="utf-8")
        except Exception:
            return

        # Extract turn blocks: each starts with "[HH:MM:SS] GUARDIAN:"
        turns: list[str] = []
        current_turn_lines: list[str] = []
        for line in prior_text.splitlines():
            if line.startswith("[") and "] GUARDIAN:" in line:
                if current_turn_lines:
                    turns.append("\n".join(current_turn_lines))
                current_turn_lines = [line]
            elif current_turn_lines:
                current_turn_lines.append(line)
        if current_turn_lines:
            turns.append("\n".join(current_turn_lines))

        if not turns:
            return

        # Take the last N turns.
        recent = turns[-turn_count:]
        divider = "-" * 40
        self._file.write(f"{divider} Prior Session Context {divider}\n\n")
        for turn_block in recent:
            self._file.write(turn_block.rstrip() + "\n\n")
        self._file.write(f"{divider} New Session {divider}\n\n")
        self._file.flush()


__all__ = ["ConversationLogger"]
