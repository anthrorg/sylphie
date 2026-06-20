"""TK-25 — P5.1b: Verify OnnxEmbeddingExtractor and orphaned init state deleted.

Pure structural tests (no model runtime required). Parse source files as text
and AST to verify the three acceptance criteria:

  AC1: 'class OnnxEmbeddingExtractor', '_DEFAULT_MODEL_FILENAME', and the
       'efficientnet_b0.onnx' literal have ZERO matches in
       packages/perception-service (excluding .venv/site-packages).
       Bare prose/docstring mentions of EfficientNet may remain.

  AC2: feature_extraction.py has OnnxEmbeddingExtractor + model-filename
       constants absent; DominantColorExtractor, EmbeddingExtractor protocol,
       MockEmbeddingExtractor, DINOv2BaseEmbeddingExtractor, ArcFaceEmbedder
       all present; the stale main.py:188 'face keeps OnnxEmbeddingExtractor'
       comment is removed/corrected.

  AC3 (structural proxy for AC3 live boot): main.py imports DINOv2Base and
       ArcFaceEmbedder at the live call sites (no import of OnnxEmbeddingExtractor
       anywhere in AST), and the /status endpoint no longer references the
       deleted _embedding_init_failed module variable.

Run with::

    cd packages/perception-service
    python -m pytest tests/test_tk25_onnx_extractor_deleted.py -v
"""

from __future__ import annotations

import ast
from pathlib import Path

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_SVC_ROOT = Path(__file__).parent.parent
_FEATURE_EXTRACTION = _SVC_ROOT / "cobeing" / "layer2_perception" / "feature_extraction.py"
_MAIN_PY = _SVC_ROOT / "main.py"


_THIS_FILE = Path(__file__)


def _all_source_py_files() -> list[Path]:
    """All .py source files in perception-service, excluding .venv and this test file.

    The test file itself references the target strings in assertions/docstrings;
    excluding it avoids false self-matches (same pattern as test_tk24_dead_code_audit).
    """
    return [
        p
        for p in _SVC_ROOT.rglob("*.py")
        if ".venv" not in p.parts
        and "site-packages" not in p.parts
        and p != _THIS_FILE
    ]


def _all_source_text_files() -> list[Path]:
    """All text source files that may contain the target literals (py, Dockerfile)."""
    py_files = _all_source_py_files()
    dockerfile = _SVC_ROOT / "Dockerfile"
    extras = [dockerfile] if dockerfile.exists() else []
    return py_files + extras


# ---------------------------------------------------------------------------
# AC1 — zero grep matches for the three target symbols
# ---------------------------------------------------------------------------


class TestAC1SymbolsAbsent:
    """AC1: The three gated symbols have zero matches in the source tree."""

    def test_class_onnxembeddingextractor_absent(self) -> None:
        """'class OnnxEmbeddingExtractor' must not appear in any source file."""
        hits: list[tuple[str, int]] = []
        for path in _all_source_py_files():
            for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                if "class OnnxEmbeddingExtractor" in line:
                    hits.append((str(path), i))

        assert hits == [], (
            "Found 'class OnnxEmbeddingExtractor' (the class definition) in:\n"
            + "\n".join(f"  {p}:{ln}" for p, ln in hits)
        )

    def test_default_model_filename_const_absent(self) -> None:
        """'_DEFAULT_MODEL_FILENAME' constant must not appear in any source file."""
        hits: list[tuple[str, int]] = []
        for path in _all_source_py_files():
            for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                if "_DEFAULT_MODEL_FILENAME" in line:
                    hits.append((str(path), i))

        assert hits == [], (
            "Found '_DEFAULT_MODEL_FILENAME' in:\n"
            + "\n".join(f"  {p}:{ln}" for p, ln in hits)
        )

    def test_efficientnet_b0_onnx_literal_absent_in_source(self) -> None:
        """'efficientnet_b0.onnx' literal must not appear in any source/config file."""
        hits: list[tuple[str, int]] = []
        for path in _all_source_text_files():
            try:
                text = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue  # binary file — skip
            for i, line in enumerate(text.splitlines(), 1):
                if "efficientnet_b0.onnx" in line:
                    hits.append((str(path), i))

        assert hits == [], (
            "Found 'efficientnet_b0.onnx' literal in:\n"
            + "\n".join(f"  {p}:{ln}" for p, ln in hits)
        )


# ---------------------------------------------------------------------------
# AC2 — feature_extraction.py: correct set of classes present/absent
# ---------------------------------------------------------------------------


class TestAC2FeatureExtractionShape:
    """AC2: feature_extraction.py has the right class set after deletion."""

    def _classes_in_file(self) -> list[str]:
        src = _FEATURE_EXTRACTION.read_text(encoding="utf-8")
        tree = ast.parse(src)
        return [n.name for n in ast.walk(tree) if isinstance(n, ast.ClassDef)]

    def test_onnxembeddingextractor_class_absent(self) -> None:
        """OnnxEmbeddingExtractor class must not be defined."""
        assert "OnnxEmbeddingExtractor" not in self._classes_in_file(), (
            "OnnxEmbeddingExtractor is still defined in feature_extraction.py"
        )

    def test_required_classes_present(self) -> None:
        """All five required classes must be defined."""
        required = {
            "DominantColorExtractor",
            "EmbeddingExtractor",
            "MockEmbeddingExtractor",
            "DINOv2BaseEmbeddingExtractor",
            "ArcFaceEmbedder",
        }
        defined = set(self._classes_in_file())
        missing = required - defined
        assert not missing, (
            f"Required classes missing from feature_extraction.py: {missing}"
        )

    def test_onnxembeddingextractor_absent_from_dunder_all(self) -> None:
        """OnnxEmbeddingExtractor must not be in __all__."""
        src = _FEATURE_EXTRACTION.read_text(encoding="utf-8")
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                for t in node.targets:
                    if isinstance(t, ast.Name) and t.id == "__all__":
                        exports = ast.literal_eval(node.value)
                        assert "OnnxEmbeddingExtractor" not in exports, (
                            "OnnxEmbeddingExtractor is still in __all__"
                        )

    def test_required_classes_in_dunder_all(self) -> None:
        """All five required classes must appear in __all__."""
        src = _FEATURE_EXTRACTION.read_text(encoding="utf-8")
        tree = ast.parse(src)
        required = {
            "DominantColorExtractor",
            "EmbeddingExtractor",
            "MockEmbeddingExtractor",
            "DINOv2BaseEmbeddingExtractor",
            "ArcFaceEmbedder",
        }
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                for t in node.targets:
                    if isinstance(t, ast.Name) and t.id == "__all__":
                        exports = set(ast.literal_eval(node.value))
                        missing = required - exports
                        assert not missing, (
                            f"Required classes missing from __all__: {missing}"
                        )
                        return
        raise AssertionError("__all__ not found in feature_extraction.py")

    def test_stale_face_keeps_onnx_comment_gone_from_main(self) -> None:
        """Stale 'face keeps OnnxEmbeddingExtractor' / equivalent comments removed.

        The TK-24 comments that said the /crop-face face path still uses
        OnnxEmbeddingExtractor must not exist. These specific phrases were
        present before TK-24 and should already be gone.
        """
        main_text = _MAIN_PY.read_text(encoding="utf-8")
        stale_phrases = [
            "FACE path keeps OnnxEmbeddingExtractor",
            "FACE path still uses ``OnnxEmbeddingExtractor``",
            # P5.1b: neither 'OnnxEmbeddingExtractor initialized' log nor import
            "OnnxEmbeddingExtractor initialized",
        ]
        found = [p for p in stale_phrases if p in main_text]
        assert not found, (
            f"Stale OnnxEmbeddingExtractor reference(s) still in main.py: {found}"
        )


# ---------------------------------------------------------------------------
# AC3 (structural proxy) — main.py: no OnnxEmbeddingExtractor in AST
# ---------------------------------------------------------------------------


class TestAC3MainPyClean:
    """AC3 proxy: main.py has no OnnxEmbeddingExtractor import or call in AST."""

    def _main_ast(self) -> ast.Module:
        return ast.parse(_MAIN_PY.read_text(encoding="utf-8"))

    def test_no_import_of_onnxembeddingextractor(self) -> None:
        """main.py must not import OnnxEmbeddingExtractor."""
        tree = self._main_ast()
        hits: list[int] = []
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                for alias in node.names:
                    if alias.name == "OnnxEmbeddingExtractor":
                        hits.append(node.lineno)
        assert hits == [], (
            f"main.py still imports OnnxEmbeddingExtractor at lines: {hits}"
        )

    def test_no_call_to_get_or_init_embedding_extractor(self) -> None:
        """_get_or_init_embedding_extractor must not be called anywhere in main.py."""
        tree = self._main_ast()
        calls: list[int] = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                func = node.func
                if isinstance(func, ast.Name) and func.id == "_get_or_init_embedding_extractor":
                    calls.append(node.lineno)
                if isinstance(func, ast.Attribute) and func.attr == "_get_or_init_embedding_extractor":
                    calls.append(node.lineno)
        assert calls == [], (
            f"_get_or_init_embedding_extractor still called in main.py at lines: {calls}"
        )

    def test_no_name_ref_to_embedding_init_failed(self) -> None:
        """_embedding_init_failed (deleted module-level bool) must not appear in AST."""
        tree = self._main_ast()
        refs: list[int] = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and node.id == "_embedding_init_failed":
                refs.append(node.lineno)
        assert refs == [], (
            f"_embedding_init_failed still referenced in main.py AST at lines: {refs}"
        )

    def test_dinov2_and_arcface_live_call_sites_intact(self) -> None:
        """DINOv2 and ArcFace init functions must still be called (live paths intact)."""
        tree = self._main_ast()
        dinov2_calls: list[int] = []
        arcface_calls: list[int] = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                func = node.func
                if isinstance(func, ast.Name):
                    if func.id == "_get_or_init_object_extractor":
                        dinov2_calls.append(node.lineno)
                    if func.id == "_get_or_init_face_extractor":
                        arcface_calls.append(node.lineno)

        assert dinov2_calls, (
            "_get_or_init_object_extractor (DINOv2 object-track path) is no longer called"
        )
        assert arcface_calls, (
            "_get_or_init_face_extractor (ArcFace /crop-face path) is no longer called"
        )
