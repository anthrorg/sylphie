"""Debug frame annotator -- draws pipeline stage visualizations on camera frames.

Produces annotated JPEG bytes from a raw frame plus pipeline results. All
drawing is done server-side with OpenCV so the browser only needs an ``<img>``
tag pointing at an MJPEG stream.

Each pipeline stage is visualized:

- **Detection**: bounding boxes color-coded by track state.
- **Tracking**: track ID, state, and frame count labels.
- **Features**: dominant color swatches along the bottom edge of each box.
- **Persistence**: match result (KNOWN/NEW/AMBIGUOUS) and surprise flag.
- **Spatial**: teal arrows between box centroids with predicate text.
- **Global**: semi-transparent status bar at the top of the frame.

Usage::

    from cobeing.layer2_perception.debug_annotator import DebugAnnotator
    annotator = DebugAnnotator()
    jpeg_bytes = annotator.annotate(frame, tracks, persistence, relations)
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

import cv2
import numpy as np

if TYPE_CHECKING:
    from cobeing.layer2_perception.spatial_extractor import SpatialRelation
    from cobeing.layer2_perception.types import (
        Frame,
        PersistenceResult,
        TrackId,
        TrackedObject,
    )

logger = logging.getLogger(__name__)

# Track state -> BGR color
_STATE_COLORS: dict[str, tuple[int, int, int]] = {
    "confirmed": (0, 200, 0),     # green
    "tentative": (0, 220, 220),   # yellow
    "lost":      (0, 0, 180),     # red
    "deleted":   (80, 80, 80),    # gray
}

# Spatial relation line color (teal in BGR)
_SPATIAL_COLOR = (200, 180, 0)

# Status bar background (dark semi-transparent via overlay)
_STATUS_BAR_HEIGHT = 24

# JPEG encode quality
_JPEG_QUALITY = 75


class DebugAnnotator:
    """Draws debug overlays on perception pipeline frames.

    Stateless: each ``annotate()`` call is independent. Thread-safe for use
    with ``run_in_executor``.
    """

    def annotate(
        self,
        frame: Frame,
        tracked_objects: list[TrackedObject],
        persistence_results: dict[TrackId, PersistenceResult],
        spatial_relations: list[SpatialRelation],
    ) -> bytes:
        """Draw all debug annotations on the frame and return JPEG bytes.

        Args:
            frame: The raw camera frame (JPEG bytes in ``frame.data``).
            tracked_objects: All tracked objects (all states).
            persistence_results: Persistence check results keyed by track ID.
            spatial_relations: Spatial relationships between objects.

        Returns:
            Annotated frame as JPEG-encoded bytes.
        """
        # Decode JPEG to numpy array
        buf = np.frombuffer(frame.data, dtype=np.uint8)
        img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
        if img is None:
            logger.warning("debug_annotator: failed to decode frame, returning raw")
            return frame.data

        h, w = img.shape[:2]

        # Build a track_id -> TrackedObject lookup for spatial line drawing
        track_map: dict[int, TrackedObject] = {
            t.track_id: t for t in tracked_objects
        }

        # 1. Draw spatial relation lines (under boxes so boxes draw on top)
        self._draw_spatial_lines(img, spatial_relations, track_map, w, h)

        # 2. Draw bounding boxes, labels, persistence info, color swatches
        for track in tracked_objects:
            self._draw_track(img, track, persistence_results, w, h)

        # 3. Draw status bar at top
        self._draw_status_bar(img, frame, tracked_objects, w, h)

        # Encode to JPEG
        ok, encoded = cv2.imencode(
            ".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, _JPEG_QUALITY]
        )
        if not ok:
            logger.warning("debug_annotator: JPEG encode failed, returning raw")
            return frame.data

        return encoded.tobytes()

    def _draw_track(
        self,
        img: np.ndarray,
        track: TrackedObject,
        persistence_results: dict[TrackId, PersistenceResult],
        frame_w: int,
        frame_h: int,
    ) -> None:
        """Draw bounding box, labels, persistence info, and color swatches."""
        det = track.detection
        x1 = int(det.bbox_x_min)
        y1 = int(det.bbox_y_min)
        x2 = int(det.bbox_x_max)
        y2 = int(det.bbox_y_max)

        color = _STATE_COLORS.get(track.state.value, (128, 128, 128))
        thickness = 2 if track.state.value == "confirmed" else 1

        # Bounding box
        cv2.rectangle(img, (x1, y1), (x2, y2), color, thickness)

        # Label line 1: "{label} {confidence%}"
        label = f"{det.label_raw} {det.confidence:.0%}"
        self._put_text_bg(img, label, x1, y1 - 22, color)

        # Label line 2: "T{id} {state} f{frames}"
        track_info = f"T{track.track_id} {track.state.value.upper()} f{track.frames_seen}"
        self._put_text_bg(img, track_info, x1, y1 - 8, color)

        # Persistence info (below line 2, inside box top)
        pr = persistence_results.get(track.track_id)
        if pr is not None:
            if pr.matched_node_id:
                short_id = pr.matched_node_id[:8]
                p_text = f"KNOWN:{short_id} {pr.confidence:.0%}"
            elif pr.ambiguous_candidates:
                p_text = "AMBIGUOUS"
            else:
                p_text = "NEW"

            if pr.surprise_flag:
                p_text += " [!]"

            p_color = (0, 0, 200) if pr.surprise_flag else (200, 200, 200)
            self._put_text_bg(img, p_text, x1 + 2, y1 + 14, p_color, scale=0.35)

        # Color swatches (dominant colors along bottom edge of box)
        if track.features and track.features.dominant_colors:
            swatch_size = 8
            sx = x1
            for i, (r, g, b) in enumerate(track.features.dominant_colors[:3]):
                # OpenCV uses BGR
                cv2.rectangle(
                    img,
                    (sx + i * (swatch_size + 1), y2 - swatch_size),
                    (sx + i * (swatch_size + 1) + swatch_size, y2),
                    (int(b), int(g), int(r)),
                    cv2.FILLED,
                )

    def _draw_spatial_lines(
        self,
        img: np.ndarray,
        relations: list[SpatialRelation],
        track_map: dict[int, TrackedObject],
        frame_w: int,
        frame_h: int,
    ) -> None:
        """Draw arrows between box centroids with predicate labels."""
        for rel in relations:
            subj = track_map.get(rel.subject_track_id)
            obj = track_map.get(rel.object_track_id)
            if not subj or not obj:
                continue

            # Compute centroids
            sd = subj.detection
            sx = int((sd.bbox_x_min + sd.bbox_x_max) / 2)
            sy = int((sd.bbox_y_min + sd.bbox_y_max) / 2)

            od = obj.detection
            ox = int((od.bbox_x_min + od.bbox_x_max) / 2)
            oy = int((od.bbox_y_min + od.bbox_y_max) / 2)

            # Arrow from subject to object
            cv2.arrowedLine(img, (sx, sy), (ox, oy), _SPATIAL_COLOR, 1, tipLength=0.05)

            # Predicate label at midpoint
            mx = (sx + ox) // 2
            my = (sy + oy) // 2
            self._put_text_bg(img, rel.predicate, mx, my, _SPATIAL_COLOR, scale=0.35)

    def _draw_status_bar(
        self,
        img: np.ndarray,
        frame: Frame,
        tracked_objects: list[TrackedObject],
        frame_w: int,
        frame_h: int,
    ) -> None:
        """Draw a semi-transparent status bar at the top of the frame."""
        # Semi-transparent overlay
        overlay = img.copy()
        cv2.rectangle(overlay, (0, 0), (frame_w, _STATUS_BAR_HEIGHT), (0, 0, 0), cv2.FILLED)
        cv2.addWeighted(overlay, 0.6, img, 0.4, 0, img)

        # Count track states
        confirmed = sum(1 for t in tracked_objects if t.state.value == "confirmed")
        tentative = sum(1 for t in tracked_objects if t.state.value == "tentative")
        lost = sum(1 for t in tracked_objects if t.state.value == "lost")

        ts = frame.observed_at.strftime("%H:%M:%S")
        text = (
            f"Frame #{frame.frame_sequence} | "
            f"{confirmed}/{tentative}/{lost} tracks (C/T/L) | "
            f"{ts}"
        )
        cv2.putText(
            img, text, (6, 16),
            cv2.FONT_HERSHEY_SIMPLEX, 0.42, (220, 220, 220), 1, cv2.LINE_AA,
        )

    @staticmethod
    def _put_text_bg(
        img: np.ndarray,
        text: str,
        x: int,
        y: int,
        color: tuple[int, int, int],
        scale: float = 0.4,
    ) -> None:
        """Draw text with a dark background rectangle for readability."""
        font = cv2.FONT_HERSHEY_SIMPLEX
        thickness = 1
        (tw, th), baseline = cv2.getTextSize(text, font, scale, thickness)

        # Background
        cv2.rectangle(
            img,
            (x, y - th - 2),
            (x + tw + 2, y + baseline + 1),
            (0, 0, 0),
            cv2.FILLED,
        )
        # Text
        cv2.putText(img, text, (x + 1, y), font, scale, color, thickness, cv2.LINE_AA)


__all__ = ["DebugAnnotator"]
