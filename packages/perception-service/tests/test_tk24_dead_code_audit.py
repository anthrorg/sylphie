"""TK-24 — P5.1a: Confirm _get_or_init_embedding_extractor is dead code.

These tests are PURE (no marker, no model runtime required). They parse
main.py and cobeing/ as text and verify the structural properties that must
hold before _get_or_init_embedding_extractor can be safely deleted:

  AC1: The ONLY occurrences of "_get_or_init_embedding_extractor" in main.py
       and cobeing/ are its own definition and cross-references in docstrings /
       comments — zero external call sites (no reachable code path calls it).

  AC2: /crop-face calls _get_or_init_face_extractor (ArcFace, P3.2) and
       object-track (_extract_track_embedding) calls _get_or_init_object_extractor
       (DINOv2, P3.1). The old "face keeps Onnx" comments in main.py are
       confirmed stale (text no longer present) after the P3.2 landing.

Run with::

    cd packages/perception-service
    python -m pytest tests/test_tk24_dead_code_audit.py -v
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Root of the perception-service package, regardless of cwd.
_SVC_ROOT = Path(__file__).parent.parent


def _main_py() -> Path:
    return _SVC_ROOT / "main.py"


def _cobeing_root() -> Path:
    return _SVC_ROOT / "cobeing"


def _all_py_sources() -> list[Path]:
    """All .py files in main.py + cobeing/ tree."""
    return [_main_py()] + list(_cobeing_root().rglob("*.py"))


# ---------------------------------------------------------------------------
# AC1 — _get_or_init_embedding_extractor has zero external call sites
# ---------------------------------------------------------------------------

_SYMBOL = "_get_or_init_embedding_extractor"

# Lines that are ALLOWED to reference the symbol (definition + comments/docs).
# We detect them structurally: the line is a def statement (definition),
# or the line is entirely a comment (# …), or the line appears inside a
# triple-quoted docstring.  Any plain expression or assignment referencing
# the symbol outside those contexts IS an external call site.
_DEF_RE = re.compile(r"^\s*def\s+_get_or_init_embedding_extractor\s*\(")


def _is_in_docstring(lines: list[str], idx: int) -> bool:
    """Return True if line[idx] is inside a triple-quoted string literal.

    We walk the file line-by-line, tracking whether we are inside a
    triple-quoted block.  This is intentionally simple — sufficient for
    the narrow task of finding whether a specific symbol reference lives
    in a docstring, without needing a full AST parse of the whole file.
    """
    in_triple = False
    triple_char: str | None = None
    for i, line in enumerate(lines):
        stripped = line.strip()
        if not in_triple:
            # Check for opening triple-quote on this line.
            for q in ('"""', "'''"):
                if q in stripped:
                    # Count occurrences: odd count → we enter/exit.
                    cnt = stripped.count(q)
                    if cnt % 2 == 1:
                        # Opened but not closed on this line.
                        in_triple = True
                        triple_char = q
                        break
                    # Even count means it opened and closed on the same line;
                    # no state change.
        else:
            # We are inside a triple-quoted block; check for closing delimiter.
            if triple_char and triple_char in line:
                in_triple = False
                triple_char = None
        if i == idx:
            return in_triple
    return False


class TestAC1NoExternalCallSites:
    """AC1: _get_or_init_embedding_extractor has zero external call sites."""

    def test_symbol_absent_from_cobeing_entirely(self) -> None:
        """The symbol must not appear anywhere in the cobeing/ sub-tree at all.

        cobeing/ is shared library code.  The only file that SHOULD reference
        this function is main.py (where it is defined).  Any hit in cobeing/
        means it is called from the library layer — a live call site.
        """
        cobeing_hits: list[str] = []
        for py_file in _cobeing_root().rglob("*.py"):
            text = py_file.read_text(encoding="utf-8")
            if _SYMBOL in text:
                cobeing_hits.append(str(py_file))

        assert cobeing_hits == [], (
            f"_get_or_init_embedding_extractor found in cobeing/ files "
            f"(these would be live call sites): {cobeing_hits}"
        )

    def test_all_main_py_references_are_definition_or_comment_or_docstring(
        self,
    ) -> None:
        """Every line in main.py referencing the symbol is non-callable.

        A line is acceptable only if it is:
          (a) the function definition itself (``def _get_or_init_embedding_extractor``),
          (b) a pure comment line (first non-whitespace character is ``#``), or
          (c) inside a triple-quoted docstring.

        Any other line — a bare call, an assignment RHS, an argument — is an
        EXTERNAL CALL SITE and would mean the function is reachable.
        """
        main_text = _main_py().read_text(encoding="utf-8")
        lines = main_text.splitlines()

        bad_lines: list[tuple[int, str]] = []
        for i, line in enumerate(lines):
            if _SYMBOL not in line:
                continue
            stripped = line.strip()
            # (a) Definition line.
            if _DEF_RE.match(line):
                continue
            # (b) Pure comment line.
            if stripped.startswith("#"):
                continue
            # (c) Inside a triple-quoted docstring.
            if _is_in_docstring(lines, i):
                continue
            # Anything else is a potential call site.
            bad_lines.append((i + 1, line.rstrip()))

        assert bad_lines == [], (
            f"main.py contains external reference(s) to "
            f"_get_or_init_embedding_extractor that are NOT definition / "
            f"comment / docstring (these are live call sites):\n"
            + "\n".join(f"  line {ln}: {txt}" for ln, txt in bad_lines)
        )

    def test_no_call_expression_in_ast(self) -> None:
        """AST walk confirms zero Call nodes referencing the symbol in main.py.

        This is the most rigorous check: we parse main.py into an AST and walk
        every Call node, verifying none invoke _get_or_init_embedding_extractor.
        An AST-level call cannot be hidden inside a comment or string.
        """
        source = _main_py().read_text(encoding="utf-8")
        tree = ast.parse(source)

        call_sites: list[int] = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            # Direct call: _get_or_init_embedding_extractor()
            if isinstance(func, ast.Name) and func.id == _SYMBOL:
                call_sites.append(node.lineno)
            # Attribute call: obj._get_or_init_embedding_extractor()
            if isinstance(func, ast.Attribute) and func.attr == _SYMBOL:
                call_sites.append(node.lineno)

        assert call_sites == [], (
            f"AST walk found Call node(s) for {_SYMBOL!r} in main.py "
            f"at line(s): {call_sites}. The function is NOT dead code."
        )


# ---------------------------------------------------------------------------
# AC2 — /crop-face uses ArcFace; object-track uses DINOv2
# ---------------------------------------------------------------------------


class TestAC2LivePathExtractors:
    """AC2: the live embedding paths use the correct post-P3.x extractors."""

    def test_crop_face_calls_get_or_init_face_extractor(self) -> None:
        """_compute_embedding (inside crop_face) calls _get_or_init_face_extractor.

        We look for the call in the AST within the scope of the ``crop_face``
        function.  This proves the ArcFace path is wired for /crop-face (P3.2).
        """
        source = _main_py().read_text(encoding="utf-8")
        tree = ast.parse(source)

        face_calls: list[int] = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if isinstance(func, ast.Name) and func.id == "_get_or_init_face_extractor":
                face_calls.append(node.lineno)

        assert face_calls, (
            "_get_or_init_face_extractor is NEVER called in main.py — "
            "the /crop-face ArcFace path appears to be disconnected."
        )

    def test_extract_track_embedding_calls_get_or_init_object_extractor(
        self,
    ) -> None:
        """_extract_track_embedding calls _get_or_init_object_extractor.

        This proves the DINOv2 path is wired for object-track (P3.1).
        """
        source = _main_py().read_text(encoding="utf-8")
        tree = ast.parse(source)

        obj_calls: list[int] = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if (
                isinstance(func, ast.Name)
                and func.id == "_get_or_init_object_extractor"
            ):
                obj_calls.append(node.lineno)

        assert obj_calls, (
            "_get_or_init_object_extractor is NEVER called in main.py — "
            "the object-track DINOv2 path appears to be disconnected."
        )

    def test_crop_face_does_not_call_onnx_embedding_extractor(self) -> None:
        """_get_or_init_embedding_extractor (OnnxEmbeddingExtractor) is never called.

        Belt-and-suspenders complement to AC1 AST test: the face path must NOT
        go through the old OnnxEmbeddingExtractor initialiser.  This is the
        final gate confirming that the P3.2 ArcFace swap is complete and the
        old ONNX path is truly unreachable.
        """
        source = _main_py().read_text(encoding="utf-8")
        tree = ast.parse(source)

        old_calls: list[int] = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if (
                isinstance(func, ast.Name)
                and func.id == "_get_or_init_embedding_extractor"
            ):
                old_calls.append(node.lineno)

        assert old_calls == [], (
            f"main.py still calls _get_or_init_embedding_extractor (OnnxEmbeddingExtractor) "
            f"at line(s) {old_calls}. P3.2 should have replaced all face-path calls with "
            f"_get_or_init_face_extractor (ArcFace)."
        )

    def test_stale_face_keeps_onnx_comment_is_gone(self) -> None:
        """The 'face keeps Onnx' / 'face still uses OnnxEmbeddingExtractor' comments are gone.

        main.py:188 and the _extract_track_embedding docstring both contained
        comments claiming the /crop-face path still uses OnnxEmbeddingExtractor.
        Those comments were written before P3.2 landed (ArcFace swap) and are
        now stale. TK-24 AC2 explicitly asks us to confirm they are removed.
        """
        main_text = _main_py().read_text(encoding="utf-8")

        # These specific stale phrases must no longer appear in the file.
        stale_phrases = [
            # P3.1 block comment (original line 188)
            "FACE path keeps OnnxEmbeddingExtractor",
            # _extract_track_embedding docstring (original line 1185)
            "FACE path still uses ``OnnxEmbeddingExtractor``",
        ]

        found: list[str] = [p for p in stale_phrases if p in main_text]
        assert found == [], (
            f"Stale 'face keeps Onnx' comment(s) still present in main.py "
            f"(these should have been removed as part of TK-24 / P3.2): {found}"
        )
