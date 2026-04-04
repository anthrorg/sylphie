"""Shared text utilities for consistent PhraseNode ID computation."""

import hashlib


def phrase_node_id(text: str) -> str:
    """Compute PhraseNode node_id from raw or normalized text.

    Normalizes (lowercase, collapse whitespace) then hashes.
    Format: ``phrase:{sha256_12}``.
    """
    normalized = " ".join(text.lower().split())
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:12]
    return f"phrase:{digest}"
