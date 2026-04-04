"""Visual feature extractors for Layer 2 object identity matching.

This module provides two complementary feature extraction strategies used to
build a :class:`~cobeing.layer2_perception.types.FeatureProfile` for each
tracked object.  The profile is later compared against stored profiles during
the Layer 2 -> Layer 3 persistence-check (CANON A.5) to answer the
"is that the same mug I saw yesterday?" question.

**Design constraints:**

- ``DominantColorExtractor`` has no dependency on OpenCV or numpy.  It works
  directly on raw RGB byte arrays so it can be used in tests and in any
  execution context without the ``[cv]`` extras installed.
- ``OnnxEmbeddingExtractor`` requires ``cv2`` and ``onnxruntime`` but
  delays their import to ``__init__`` time so that *importing this module*
  never fails even when the ``[cv]`` extras are absent.
- All extractors are safe to use as drop-in replacements for each other via
  the :class:`EmbeddingExtractor` protocol.

Typical usage::

    from cobeing.layer2_perception.feature_extraction import (
        DominantColorExtractor,
        MockEmbeddingExtractor,
        OnnxEmbeddingExtractor,
        EmbeddingExtractor,
    )

    color_extractor = DominantColorExtractor(n_colors=3)
    colors = color_extractor.extract(
        frame_data=raw_rgb_bytes,
        bbox=(10, 20, 110, 120),
        frame_width=640,
        frame_height=480,
    )
    # [(R, G, B), ...] sorted by frequency

    # For testing:
    mock = MockEmbeddingExtractor()
    vec = mock.extract(raw_rgb_bytes, (10, 20, 110, 120), 640, 480)
    # [0.0] * 128

    # For real inference (requires [cv] extras):
    try:
        real = OnnxEmbeddingExtractor()
        vec = real.extract(raw_rgb_bytes, (10, 20, 110, 120), 640, 480)
    except ImportError:
        pass  # Fall back to mock in environments without cv extras
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

# ---------------------------------------------------------------------------
# Dominant Color Extractor
# ---------------------------------------------------------------------------

# Bin counts per channel.  8 bins per channel -> 8^3 = 512 bins total.
# This is deliberately coarse: fine bins cause sparsity and noise in small
# crops; coarse bins give robust, lighting-tolerant dominant-color signatures.
_BINS_PER_CHANNEL: int = 8
_BIN_SIZE: int = 256 // _BINS_PER_CHANNEL  # 32 values per bin


class DominantColorExtractor:
    """Extract dominant colors from a bounding-box region using color binning.

    Uses a simple 8x8x8 RGB histogram (512 bins) rather than K-means so that
    the extractor has no dependency on scipy or scikit-learn.  The approach is
    fast, deterministic, and produces stable color signatures across minor
    lighting variations.

    Color extraction runs entirely in pure Python on raw byte arrays.
    ``cv2`` and ``numpy`` are **not** imported anywhere in this class.

    Args:
        n_colors: Number of dominant colors to return.  Must be >= 1.
            Defaults to 3.  If the cropped region contains fewer unique
            occupied bins than ``n_colors``, only the occupied bins are
            returned.

    Example::

        extractor = DominantColorExtractor(n_colors=3)
        colors = extractor.extract(frame_data, (10, 20, 110, 120), 640, 480)
        # Returns a list of up to 3 (R, G, B) tuples.
    """

    def __init__(self, n_colors: int = 3) -> None:
        if n_colors < 1:
            raise ValueError(f"n_colors must be >= 1, got {n_colors}")
        self.n_colors = n_colors

    def extract(
        self,
        frame_data: bytes,
        bbox: tuple[float, float, float, float],
        frame_width: int,
        frame_height: int,
    ) -> list[tuple[int, int, int]]:
        """Extract dominant colors from a bounding-box region.

        The method crops the requested region from the flat raw-RGB byte array,
        bins each pixel into an 8x8x8 RGB grid, and returns the centers of the
        ``n_colors`` most-populated bins sorted descending by pixel count.

        Args:
            frame_data: Raw frame bytes.  Must be uncompressed RGB data laid
                out row-major as ``R G B R G B …`` with
                ``len(frame_data) == frame_width * frame_height * 3``.
                JPEG-encoded data is not supported by this extractor; callers
                must decode before passing to ``extract``.
            bbox: ``(x_min, y_min, x_max, y_max)`` bounding box in **pixel**
                coordinates.  Values are clamped to the frame boundary before
                cropping, so edge-touching or partially-outside boxes are
                handled gracefully.
            frame_width: Width of the full frame in pixels.  Must be > 0.
            frame_height: Height of the full frame in pixels.  Must be > 0.

        Returns:
            A list of ``(R, G, B)`` tuples representing bin-center colors,
            sorted by frequency (most common first).  The list length is
            ``min(n_colors, number_of_occupied_bins)``.  For a completely
            uniform crop all pixels fall into the same bin and one color is
            returned.  For a crop smaller than 4 pixels the same logic
            applies -- at least one color is always returned unless the crop
            area is zero, in which case an empty list is returned.

        Raises:
            ValueError: If ``frame_width`` or ``frame_height`` is <= 0, or if
                ``len(frame_data)`` does not equal
                ``frame_width * frame_height * 3``.
        """
        if frame_width <= 0:
            raise ValueError(f"frame_width must be > 0, got {frame_width}")
        if frame_height <= 0:
            raise ValueError(f"frame_height must be > 0, got {frame_height}")

        expected_bytes = frame_width * frame_height * 3
        if len(frame_data) != expected_bytes:
            raise ValueError(
                f"frame_data length {len(frame_data)} does not match "
                f"frame_width * frame_height * 3 = {expected_bytes}"
            )

        # Clamp bbox to frame boundaries (integer pixel coords).
        x_min = max(0, int(bbox[0]))
        y_min = max(0, int(bbox[1]))
        x_max = min(frame_width, int(bbox[2]))
        y_max = min(frame_height, int(bbox[3]))

        # Zero-area bbox: nothing to extract.
        if x_min >= x_max or y_min >= y_max:
            return []

        # Count pixels per bin.  Bin index: r_bin * 64 + g_bin * 8 + b_bin.
        # Pre-allocate a 512-element list for speed.
        counts: list[int] = [0] * (_BINS_PER_CHANNEL ** 3)

        row_stride = frame_width * 3  # bytes per row
        for row in range(y_min, y_max):
            row_offset = row * row_stride + x_min * 3
            for col_offset in range(0, (x_max - x_min) * 3, 3):
                byte_pos = row_offset + col_offset
                r = frame_data[byte_pos]
                g = frame_data[byte_pos + 1]
                b = frame_data[byte_pos + 2]
                bin_idx = (
                    (r // _BIN_SIZE) * (_BINS_PER_CHANNEL * _BINS_PER_CHANNEL)
                    + (g // _BIN_SIZE) * _BINS_PER_CHANNEL
                    + (b // _BIN_SIZE)
                )
                counts[bin_idx] += 1

        # Find the top-N occupied bins by descending count.
        # Build (count, bin_idx) pairs for non-zero bins only.
        occupied = [(counts[i], i) for i in range(len(counts)) if counts[i] > 0]

        # Sort descending by count.  For equal counts, lower bin_idx wins
        # (deterministic tie-breaking).
        occupied.sort(key=lambda pair: (-pair[0], pair[1]))

        top_n = occupied[: self.n_colors]

        # Convert bin indices back to representative RGB values (bin centers).
        result: list[tuple[int, int, int]] = []
        for _count, bin_idx in top_n:
            r_bin = bin_idx // (_BINS_PER_CHANNEL * _BINS_PER_CHANNEL)
            g_bin = (bin_idx // _BINS_PER_CHANNEL) % _BINS_PER_CHANNEL
            b_bin = bin_idx % _BINS_PER_CHANNEL
            # Center of the bin: bin_index * bin_size + bin_size // 2
            half = _BIN_SIZE // 2
            r_center = r_bin * _BIN_SIZE + half
            g_center = g_bin * _BIN_SIZE + half
            b_center = b_bin * _BIN_SIZE + half
            # Clamp to [0, 255] to guard against arithmetic edge cases.
            result.append((
                min(255, r_center),
                min(255, g_center),
                min(255, b_center),
            ))

        return result


# ---------------------------------------------------------------------------
# EmbeddingExtractor Protocol
# ---------------------------------------------------------------------------


@runtime_checkable
class EmbeddingExtractor(Protocol):
    """Structural interface for embedding extractors.

    Any class that implements ``extract(frame_data, bbox, frame_width,
    frame_height)`` returning ``list[float] | None`` satisfies this protocol.
    Use :class:`MockEmbeddingExtractor` in tests and during development before
    the ONNX model is available; use :class:`OnnxEmbeddingExtractor` when the
    ``[cv]`` extras are installed and a model is available.

    The protocol is ``@runtime_checkable`` so ``isinstance(obj, EmbeddingExtractor)``
    works in tests.
    """

    def extract(
        self,
        frame_data: bytes,
        bbox: tuple[float, float, float, float],
        frame_width: int,
        frame_height: int,
    ) -> list[float] | None:
        """Extract a visual embedding vector from a bounding-box region.

        Args:
            frame_data: Raw frame bytes (interpretation is extractor-dependent;
                real extractors expect raw RGB, mock extractors ignore the bytes).
            bbox: ``(x_min, y_min, x_max, y_max)`` in pixel coordinates.
            frame_width: Full frame width in pixels.
            frame_height: Full frame height in pixels.

        Returns:
            A list of floats representing the embedding, or ``None`` if
            extraction failed (e.g., the crop is too small for the model).
        """
        ...  # pragma: no cover


# ---------------------------------------------------------------------------
# MockEmbeddingExtractor
# ---------------------------------------------------------------------------


class MockEmbeddingExtractor:
    """Fixed-vector embedding extractor for use in tests and development.

    Returns a configurable default vector for all bounding boxes.  Individual
    bounding boxes can be given specific overrides via :meth:`set_embedding`
    to simulate distinct objects in unit tests.

    The extractor satisfies the :class:`EmbeddingExtractor` protocol.

    Args:
        default_embedding: The vector returned when no override is set for
            the requested bounding box.  Defaults to a zero vector of length
            128 if ``None``.  The stored default is copied on each ``extract``
            call so that callers cannot mutate the internal state.

    Example::

        mock = MockEmbeddingExtractor(default_embedding=[0.5] * 64)
        mock.set_embedding("10,20,110,120", [1.0, 0.0, 0.0])

        vec = mock.extract(b"", (10, 20, 110, 120), 640, 480)
        # Returns [1.0, 0.0, 0.0]

        vec2 = mock.extract(b"", (0, 0, 50, 50), 640, 480)
        # Returns [0.5] * 64 (default)
    """

    def __init__(self, default_embedding: list[float] | None = None) -> None:
        self._default: list[float] = (
            default_embedding if default_embedding is not None else [0.0] * 128
        )
        self._overrides: dict[str, list[float]] = {}

    def set_embedding(self, bbox_key: str, embedding: list[float]) -> None:
        """Register a specific embedding for a bounding box key.

        The key format must match the auto-generated key used internally:
        ``f"{int(bbox[0])},{int(bbox[1])},{int(bbox[2])},{int(bbox[3])}"``

        Args:
            bbox_key: String key identifying the bounding box, e.g.
                ``"10,20,110,120"`` for the bbox ``(10, 20, 110, 120)``.
            embedding: The vector to return when ``extract`` is called with
                the matching bbox coordinates.
        """
        self._overrides[bbox_key] = embedding

    def extract(
        self,
        frame_data: bytes,
        bbox: tuple[float, float, float, float],
        frame_width: int,
        frame_height: int,
    ) -> list[float]:
        """Return the configured embedding for the bounding box.

        Args:
            frame_data: Ignored.  The mock does not process image data.
            bbox: Bounding box coordinates.  Used to look up an override.
            frame_width: Ignored.
            frame_height: Ignored.

        Returns:
            A **copy** of the matching override, or a copy of the default
            embedding if no override is registered for this bbox.  Always
            returns a list (never ``None``).
        """
        key = f"{int(bbox[0])},{int(bbox[1])},{int(bbox[2])},{int(bbox[3])}"
        source = self._overrides.get(key, self._default)
        return source.copy()


# ---------------------------------------------------------------------------
# OnnxEmbeddingExtractor
# ---------------------------------------------------------------------------

# Default URL and filename for the EfficientNet-B0 ONNX model.
# The model is auto-downloaded on first use if not already present at
# ``model_path``.  The output of the penultimate layer (before the
# classification head) is a 1280-dimensional feature vector.
_DEFAULT_MODEL_FILENAME = "efficientnet_b0.onnx"
_DEFAULT_MODEL_URL = (
    "https://github.com/onnx/models/raw/main/validated/"
    "vision/classification/efficientnet-lite4/model/"
    "efficientnet-lite4-11.onnx"
)
_MODEL_INPUT_SIZE = 224  # EfficientNet-B0 input: 224x224 RGB
_EMBEDDING_DIM = 1280  # Feature vector dimension before the FC head


class OnnxEmbeddingExtractor:
    """EfficientNet-B0 visual embeddings via ONNX Runtime.

    Crops the bounding-box region from the raw-RGB frame, resizes to 224x224,
    applies ImageNet normalisation, runs inference with ONNX Runtime, and
    returns the 1280-dimensional feature vector from the penultimate layer.

    **Lazy imports:** ``cv2`` and ``onnxruntime`` are imported inside
    ``__init__``, not at module level.  Importing this module never raises
    ``ImportError`` even when the ``[cv]`` extras are absent.  The error is
    deferred to the point of construction.

    Args:
        model_path: Path to the ``.onnx`` model file.  If ``None`` the
            extractor looks for ``efficientnet_b0.onnx`` in the current
            working directory and attempts to download it automatically if
            not found.

    Raises:
        ImportError: If ``cv2`` or ``onnxruntime`` is not installed.
            The message includes the pip install hint for the ``[cv]``
            extras.

    Example::

        try:
            extractor = OnnxEmbeddingExtractor()
        except ImportError as exc:
            print(exc)  # Explains which package is missing and how to install
    """

    def __init__(self, model_path: str | None = None) -> None:
        # Lazy import -- fail loudly with an actionable message.
        try:
            import cv2 as _cv2  # type: ignore[import-untyped]
        except ImportError as exc:
            raise ImportError(
                "OnnxEmbeddingExtractor requires OpenCV. "
                "Install with: pip install 'cobeing[cv]'"
            ) from exc

        try:
            import onnxruntime as _ort  # type: ignore[import-untyped]
        except ImportError as exc:
            raise ImportError(
                "OnnxEmbeddingExtractor requires ONNX Runtime. "
                "Install with: pip install 'cobeing[cv]'"
            ) from exc

        self._cv2 = _cv2
        self._ort = _ort

        resolved_path = model_path or _DEFAULT_MODEL_FILENAME
        if not _path_exists(resolved_path):
            resolved_path = self._download_model(resolved_path)

        self._session: object = _ort.InferenceSession(
            resolved_path,
            providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
        )
        # Cache the input name once so extract() does not introspect every call.
        self._input_name: str = self._session.get_inputs()[0].name  # type: ignore[union-attr]

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def extract(
        self,
        frame_data: bytes,
        bbox: tuple[float, float, float, float],
        frame_width: int,
        frame_height: int,
    ) -> list[float] | None:
        """Extract a 1280-dimensional visual embedding from a bounding-box crop.

        Steps:

        1. Decode ``frame_data`` as raw RGB (row-major, 3 bytes/pixel).
        2. Crop the region defined by ``bbox``.
        3. Resize the crop to 224x224 using bilinear interpolation.
        4. Normalise to ImageNet mean/std.
        5. Run ONNX Runtime inference.
        6. Return the output as a Python list of floats.

        Args:
            frame_data: Raw RGB bytes of the full frame.
                ``len(frame_data)`` must equal ``frame_width * frame_height * 3``.
            bbox: ``(x_min, y_min, x_max, y_max)`` in pixel coordinates.
                Clamped to frame boundaries automatically.
            frame_width: Full frame width in pixels.
            frame_height: Full frame height in pixels.

        Returns:
            A list of 1280 floats, or ``None`` if the crop area is zero
            (degenerate bounding box).
        """
        import numpy as np  # type: ignore[import-untyped]

        cv2 = self._cv2

        # Build a numpy array from raw bytes without copying if possible.
        arr = np.frombuffer(frame_data, dtype=np.uint8).reshape(
            (frame_height, frame_width, 3)
        )

        # Clamp bbox and check for degenerate region.
        x_min = max(0, int(bbox[0]))
        y_min = max(0, int(bbox[1]))
        x_max = min(frame_width, int(bbox[2]))
        y_max = min(frame_height, int(bbox[3]))

        if x_min >= x_max or y_min >= y_max:
            return None

        crop = arr[y_min:y_max, x_min:x_max]

        # Resize to model input size (bilinear).
        resized = cv2.resize(
            crop,
            (_MODEL_INPUT_SIZE, _MODEL_INPUT_SIZE),
            interpolation=cv2.INTER_LINEAR,
        )

        # Normalise: ImageNet mean and std per channel (RGB order).
        mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
        std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
        normalised = (resized.astype(np.float32) / 255.0 - mean) / std

        # ONNX Runtime expects NCHW layout.
        blob = normalised.transpose(2, 0, 1)[np.newaxis, ...]  # (1, 3, H, W)

        outputs = self._session.run(None, {self._input_name: blob})  # type: ignore[union-attr]
        # The first output is the feature vector (shape: (1, 1280) or similar).
        feature_vector = outputs[0].flatten()

        return feature_vector.tolist()

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _download_model(self, dest_path: str) -> str:
        """Download the EfficientNet-B0 ONNX model to ``dest_path``.

        Uses only stdlib ``urllib`` -- no requests/httpx dependency.

        Args:
            dest_path: Local file path where the model should be saved.

        Returns:
            ``dest_path`` after successful download.

        Raises:
            RuntimeError: If the download fails.
        """
        import urllib.request

        try:
            urllib.request.urlretrieve(_DEFAULT_MODEL_URL, dest_path)
        except Exception as exc:
            raise RuntimeError(
                f"Failed to download EfficientNet-B0 ONNX model from "
                f"{_DEFAULT_MODEL_URL} to {dest_path}: {exc}"
            ) from exc

        return dest_path


def _path_exists(path: str) -> bool:
    """Return True if ``path`` points to an existing file."""
    import os

    return os.path.isfile(path)


# ---------------------------------------------------------------------------
# Module exports
# ---------------------------------------------------------------------------

__all__ = [
    "DominantColorExtractor",
    "EmbeddingExtractor",
    "MockEmbeddingExtractor",
    "OnnxEmbeddingExtractor",
]
