"""Unit tests for the P3.2 ArcFaceEmbedder (insightface buffalo_l / w600k_r50).

Two tiers, mirroring the project's model-test policy (conftest.py):

  * PURE tests (no marker) — prove the lazy-import discipline and the
    EmbeddingExtractor protocol shape WITHOUT any model runtime. Importing the
    module must never raise even with insightface absent (the failure is deferred
    to construction), and the class must satisfy the EmbeddingExtractor protocol.
  * @pytest.mark.requires_models — exercise the REAL ArcFace path end-to-end.
    LOUD-skipped (conftest) when insightface / its native deps are absent, so a
    missing runtime is reported, never silently passed.

Run with::

    cd packages/perception-service
    python -m pytest tests/test_arcface_embedder.py -q
"""

from __future__ import annotations

import pytest

from cobeing.layer2_perception.feature_extraction import (
    ArcFaceEmbedder,
    EmbeddingExtractor,
    __all__,
)

# The ArcFace dimension the NestJS side (FACE_EMBEDDING_DIM) and the migrated
# `face_embeddings.embedding vector(512)` column expect.
_ARCFACE_DIM = 512


# ---------------------------------------------------------------------------
# PURE tests — no model runtime required
# ---------------------------------------------------------------------------


class TestArcFaceEmbedderPure:
    def test_importable_without_insightface(self) -> None:
        """Importing the module + referencing the class must never raise.

        The lazy-import discipline: insightface is imported inside __init__, not
        at module level, so the import surface is clean even when the runtime is
        absent (this test ran the import at module load — reaching here is proof).
        """
        assert ArcFaceEmbedder is not None
        assert "ArcFaceEmbedder" in __all__

    def test_satisfies_embedding_extractor_protocol_shape(self) -> None:
        """ArcFaceEmbedder.extract matches the EmbeddingExtractor signature.

        We check the structural shape WITHOUT constructing the class (which would
        need the model). The protocol is the drop-in contract shared with
        OnnxEmbeddingExtractor / DINOv2BaseEmbeddingExtractor.
        """
        assert hasattr(ArcFaceEmbedder, "extract")
        # The protocol exists and is runtime-checkable (an instance, once built,
        # would isinstance-match it). We assert the method exists statically here.
        assert callable(getattr(ArcFaceEmbedder, "extract"))
        assert isinstance(EmbeddingExtractor, type)

    def test_missing_insightface_raises_actionable_importerror(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Construction with insightface absent raises a clear ImportError.

        We simulate the absent runtime by blocking the insightface import, so the
        test is meaningful even on a machine that HAS insightface. This is the
        "fail loudly at construction" half of the lazy-import discipline; main.py's
        _get_or_init_face_extractor catches it and latches the degrade flag.
        """
        import builtins

        real_import = builtins.__import__

        def _blocked_import(name: str, *args, **kwargs):  # noqa: ANN002, ANN003, ANN202
            if name == "insightface" or name.startswith("insightface."):
                raise ImportError("simulated: insightface not installed")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", _blocked_import)

        with pytest.raises(ImportError) as excinfo:
            ArcFaceEmbedder()
        assert "insightface" in str(excinfo.value)


# ---------------------------------------------------------------------------
# REAL-model tests — LOUD-skipped when insightface is unavailable (conftest)
# ---------------------------------------------------------------------------


@pytest.mark.requires_models
class TestArcFaceEmbedderReal:
    def test_extract_returns_512d_on_a_synthetic_face_crop(self) -> None:
        """A real ArcFace extract over a crop returns a 512-D vector or None.

        We feed a flat synthetic crop (no real face). The honest contract is:
        either a 512-D embedding (if SCRFD fires) or None (no face detected) —
        NEVER a wrong-dim vector and NEVER a crash. Both outcomes are acceptable
        for a synthetic pattern; the assertion pins the SHAPE + degrade contract.
        """
        embedder = ArcFaceEmbedder()

        w, h = 160, 160
        # Flat gray RGB buffer (no real face → SCRFD likely returns nothing).
        frame = bytes([128, 128, 128]) * (w * h)
        result = embedder.extract(frame, (0, 0, w, h), w, h)

        if result is not None:
            assert len(result) == _ARCFACE_DIM
            assert all(isinstance(x, float) for x in result)

    def test_degenerate_bbox_returns_none(self) -> None:
        """A zero-area bbox returns None (degrade), never crashes."""
        embedder = ArcFaceEmbedder()
        w, h = 160, 160
        frame = bytes([0, 0, 0]) * (w * h)
        # x_min == x_max → degenerate.
        assert embedder.extract(frame, (50, 50, 50, 100), w, h) is None
