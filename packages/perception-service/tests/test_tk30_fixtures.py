"""TK-30 acceptance tests: synthetic JPEG fixtures + seeded DB fixture scripts.

Verifies both acceptance criteria without requiring a live camera, database, or
model dependency:

AC-1  test/fixtures/vision/ contains mug_640x480.jpg, book_640x480.jpg,
      person_640x480.jpg, and mug_1280x720.jpg — all valid labeled-rectangle
      JPEGs with the correct dimensions.

AC-2  seed_timescale.sql and seed_neo4j.cypher exist and contain the required
      claims: 768-D embedding + JSON bbox in the SQL, and provenance_type SENSOR
      + confidence 0.40 in the Cypher.  (Structural/content checks — no live DB
      connection required for this gate.)

Run with::

    cd packages/perception-service
    python -m pytest tests/test_tk30_fixtures.py -v
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Paths — resolve relative to this file so tests run from any cwd.
# ---------------------------------------------------------------------------

# This file lives at packages/perception-service/tests/; fixtures are at
# test/fixtures/vision/ from the repo root (4 levels up from here).
_REPO_ROOT = Path(__file__).resolve().parents[3]
_FIXTURES_DIR = _REPO_ROOT / "test" / "fixtures" / "vision"


# ---------------------------------------------------------------------------
# AC-1: synthetic JPEG fixtures
# ---------------------------------------------------------------------------

class TestSyntheticJpegFixtures:
    """AC-1 — mug/book/person_640x480.jpg + mug_1280x720.jpg must exist as
    valid labeled-rectangle JPEGs with correct dimensions."""

    @pytest.mark.parametrize(
        "filename, expected_width, expected_height",
        [
            ("mug_640x480.jpg",    640,  480),
            ("book_640x480.jpg",   640,  480),
            ("person_640x480.jpg", 640,  480),
            ("mug_1280x720.jpg",  1280,  720),
        ],
    )
    def test_jpeg_exists_with_correct_dimensions(
        self, filename: str, expected_width: int, expected_height: int
    ) -> None:
        """File must exist, be a valid JPEG, and have the expected dimensions."""
        # Import Pillow inside the test so a missing dep gives a clear error
        # rather than a conftest collection failure.
        from PIL import Image  # type: ignore[import]

        path = _FIXTURES_DIR / filename
        assert path.exists(), (
            f"{filename} not found in {_FIXTURES_DIR}. "
            "Run test/fixtures/vision/synth_frames.py to generate it."
        )

        img = Image.open(path)

        # Verify JPEG format (Pillow returns 'JPEG' for .jpg files)
        assert img.format == "JPEG", (
            f"{filename}: expected JPEG format, got {img.format!r}"
        )

        # Verify exact pixel dimensions
        width, height = img.size
        assert (width, height) == (expected_width, expected_height), (
            f"{filename}: expected {expected_width}x{expected_height}, got {width}x{height}"
        )

    @pytest.mark.parametrize(
        "filename",
        ["mug_640x480.jpg", "book_640x480.jpg", "person_640x480.jpg", "mug_1280x720.jpg"],
    )
    def test_jpeg_is_color_image_with_rectangle(self, filename: str) -> None:
        """Each fixture must be an RGB image (not grayscale) with visible content."""
        from PIL import Image  # type: ignore[import]

        path = _FIXTURES_DIR / filename
        img = Image.open(path).convert("RGB")

        # Must be RGB (3-channel), not grayscale
        assert img.mode == "RGB", f"{filename}: expected RGB mode, got {img.mode}"

        # Simple sanity: the image must have more than one unique colour (i.e.
        # it is not a blank frame — the rectangle is there).
        # get_flattened_data is preferred from Pillow 10+ (getdata is deprecated).
        try:
            pixels = list(img.get_flattened_data())  # type: ignore[attr-defined]
        except AttributeError:
            pixels = list(img.getdata())  # Pillow < 10 fallback
        unique_colors = len(set(pixels))
        assert unique_colors > 1, (
            f"{filename}: image appears blank (only {unique_colors} distinct color(s))"
        )

    def test_synth_frames_script_exists(self) -> None:
        """The generator script must be present so fixtures can be reproduced."""
        script = _FIXTURES_DIR / "synth_frames.py"
        assert script.exists(), (
            f"synth_frames.py not found at {script}. "
            "The generator script is required for reproducibility."
        )


# ---------------------------------------------------------------------------
# AC-2: DB fixture scripts — structural / content checks
# ---------------------------------------------------------------------------

class TestSeedScripts:
    """AC-2 — seed_timescale.sql and seed_neo4j.cypher must exist and contain
    the required claims (768-D embedding + JSON bbox; SENSOR + 0.40)."""

    def test_seed_timescale_sql_exists(self) -> None:
        path = _FIXTURES_DIR / "seed_timescale.sql"
        assert path.exists(), f"seed_timescale.sql not found at {path}"

    def test_seed_neo4j_cypher_exists(self) -> None:
        path = _FIXTURES_DIR / "seed_neo4j.cypher"
        assert path.exists(), f"seed_neo4j.cypher not found at {path}"

    def test_seed_timescale_targets_correct_table(self) -> None:
        """SQL must target visual_object_embeddings."""
        sql = (_FIXTURES_DIR / "seed_timescale.sql").read_text(encoding="utf-8")
        assert "visual_object_embeddings" in sql, (
            "seed_timescale.sql does not reference visual_object_embeddings"
        )

    def test_seed_timescale_has_768d_embedding(self) -> None:
        """SQL vector literal must have exactly 768 dimensions."""
        sql = (_FIXTURES_DIR / "seed_timescale.sql").read_text(encoding="utf-8")

        # Extract the vector literal: content between '[' and ']'::vector
        # Allow for the literal to span multiple lines (it's long).
        match = re.search(r"'\[([^\]]+)\]'\s*::vector", sql, re.DOTALL)
        assert match is not None, (
            "seed_timescale.sql does not contain a '[ ... ]'::vector literal"
        )

        elements = [e.strip() for e in match.group(1).split(",") if e.strip()]
        assert len(elements) == 768, (
            f"seed_timescale.sql vector has {len(elements)} dimensions, expected 768"
        )

    def test_seed_timescale_has_json_bounding_box(self) -> None:
        """SQL must populate the bounding_box column with a JSON-format value."""
        import json

        sql = (_FIXTURES_DIR / "seed_timescale.sql").read_text(encoding="utf-8")

        # Look for a JSON array value passed as the bounding_box.
        # The pattern: any '[ [...] ]' string literal in the SQL (not the vector
        # literal — that uses ::vector cast; bbox does not).
        # We search for a quoted string that decodes as a list-of-lists.
        matches = re.findall(r"'(\[\[.*?\]\])'", sql, re.DOTALL)
        assert matches, (
            "seed_timescale.sql does not contain a nested-list JSON string "
            "for bounding_box (expected pattern: '[[...]]')"
        )

        # At least one match must parse as valid JSON
        parsed_ok = False
        for m in matches:
            try:
                val = json.loads(m)
                if isinstance(val, list) and len(val) > 0:
                    parsed_ok = True
                    break
            except json.JSONDecodeError:
                continue

        assert parsed_ok, (
            f"bounding_box value in seed_timescale.sql is not valid JSON: {matches}"
        )

    def test_seed_timescale_confidence_040(self) -> None:
        """SQL must set confidence = 0.40."""
        sql = (_FIXTURES_DIR / "seed_timescale.sql").read_text(encoding="utf-8")
        # Confidence value appears as a bare float in the VALUES list
        assert re.search(r"\b0\.40\b", sql), (
            "seed_timescale.sql does not set confidence to 0.40"
        )

    def test_seed_neo4j_has_visual_object_label(self) -> None:
        """Cypher must create/merge a :VisualObject node."""
        cypher = (_FIXTURES_DIR / "seed_neo4j.cypher").read_text(encoding="utf-8")
        assert ":VisualObject" in cypher, (
            "seed_neo4j.cypher does not reference :VisualObject label"
        )

    def test_seed_neo4j_provenance_sensor(self) -> None:
        """Cypher must set provenance_type = 'SENSOR'."""
        cypher = (_FIXTURES_DIR / "seed_neo4j.cypher").read_text(encoding="utf-8")
        assert "SENSOR" in cypher, (
            "seed_neo4j.cypher does not set provenance_type to 'SENSOR'"
        )

    def test_seed_neo4j_confidence_040(self) -> None:
        """Cypher must set confidence = 0.40."""
        cypher = (_FIXTURES_DIR / "seed_neo4j.cypher").read_text(encoding="utf-8")
        assert re.search(r"\b0\.40\b", cypher), (
            "seed_neo4j.cypher does not set confidence to 0.40"
        )
