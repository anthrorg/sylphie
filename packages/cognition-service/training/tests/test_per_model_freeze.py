"""Tests for per-model freeze (TK-38, EP8-1).

Exercises AC-1, AC-2, and AC-3 of the per-model freeze ticket:

  AC-1: panel_0 frozen → a training pass targeting a different model leaves
        the panel_0 NPZ byte-identical (sha256 unchanged).

  AC-2: panel_0 unfrozen → a training pass targeting panel_0 runs and its
        NPZ sha256 changes (training resumes, freeze was the cause).

  AC-3: model_name=all preserves existing behaviour; model_name=unknown
        returns accepted=false with an error (not a silent no-op).

The tests drive the Trainer.save_panel_checkpoint() API directly (not the
background training loop) to isolate the freeze gate from scheduling.
The FastAPI endpoints are exercised for AC-3 via TestClient.
"""

from __future__ import annotations

import hashlib
import os
import tempfile
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

import config
import main
from fastapi.testclient import TestClient
from training.data_buffer import DataBuffer
from training.trainer import Trainer


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _sha256(path: str) -> str:
    """Return the hex sha256 digest of a file."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _make_trainer_with_panels(panel_dir: str) -> Trainer:
    """Build a minimal Trainer whose panel models can be saved to panel_dir."""
    # Build a real CognitiveCycle so panel_models is fully populated.
    # Patch WEIGHTS_DIR so no real checkpoint is loaded.
    with patch.object(config, "WEIGHTS_DIR", panel_dir):
        from inference.cycle import CognitiveCycle
        cycle = CognitiveCycle()

    buf = DataBuffer(capacity=128)
    trainer = Trainer(cycle, buf)
    return trainer


def _save_initial_npz(trainer: Trainer, panel_dir: str) -> str:
    """Save panel_0's current weights and return the NPZ path."""
    os.makedirs(panel_dir, exist_ok=True)
    panel = trainer._cycle.panel_models.panels[0]
    panel.save(panel_dir)
    return os.path.join(panel_dir, f"panel_{panel.name}.npz")


def _perturb_panel0_weights(trainer: Trainer) -> None:
    """Nudge panel_0 in-memory weights so a subsequent save produces a new NPZ."""
    panel = trainer._cycle.panel_models.panels[0]
    panel.b1 += 1.0  # small in-place change; guaranteed to change sha256


# ---------------------------------------------------------------------------
# AC-1: Frozen panel → training pass on different model leaves NPZ unchanged
# ---------------------------------------------------------------------------

def test_ac1_frozen_panel_npz_unchanged_after_other_model_trains() -> None:
    """Freeze panel_0, train a different model, verify panel_0 NPZ is byte-identical."""
    with tempfile.TemporaryDirectory() as tmpdir:
        panel_dir = os.path.join(tmpdir, "panels")
        trainer = _make_trainer_with_panels(tmpdir)

        # Save initial panel_0 NPZ to disk.
        npz_path = _save_initial_npz(trainer, panel_dir)
        hash_before = _sha256(npz_path)

        # Freeze panel_0.
        trainer.freeze("panel_0")
        assert trainer.is_model_frozen("panel_0")

        # Simulate a training pass targeting a DIFFERENT model (panel_1).
        # Perturb panel_1 in memory and commit it — this should not touch panel_0.
        panel1 = trainer._cycle.panel_models.panels[1]
        panel1.b1 += 1.0
        with patch.object(config, "WEIGHTS_DIR", tmpdir):
            saved = trainer.save_panel_checkpoint("panel_1")
        assert saved is True, "panel_1 is not frozen, its checkpoint should be written"

        # panel_0 NPZ must be byte-identical.
        hash_after = _sha256(npz_path)
        assert hash_before == hash_after, (
            f"panel_0 NPZ changed while frozen — freeze is not protecting the snapshot. "
            f"before={hash_before!r} after={hash_after!r}"
        )


# ---------------------------------------------------------------------------
# AC-1 variant: save_panel_checkpoint on panel_0 while frozen → returns False,
#               NPZ byte-identical (the direct gate).
# ---------------------------------------------------------------------------

def test_ac1_save_panel_checkpoint_blocked_when_frozen() -> None:
    """save_panel_checkpoint returns False and does not write when panel is frozen."""
    with tempfile.TemporaryDirectory() as tmpdir:
        panel_dir = os.path.join(tmpdir, "panels")
        trainer = _make_trainer_with_panels(tmpdir)

        npz_path = _save_initial_npz(trainer, panel_dir)
        hash_before = _sha256(npz_path)

        trainer.freeze("panel_0")
        # Perturb in memory — weights have changed, but freeze should block the save.
        _perturb_panel0_weights(trainer)

        with patch.object(config, "WEIGHTS_DIR", tmpdir):
            saved = trainer.save_panel_checkpoint("panel_0")

        assert saved is False, "Expected save_panel_checkpoint to return False when frozen"
        hash_after = _sha256(npz_path)
        assert hash_before == hash_after, "NPZ must not change while panel_0 is frozen"


# ---------------------------------------------------------------------------
# AC-2: Unfreeze panel_0 → training pass changes the NPZ
# ---------------------------------------------------------------------------

def test_ac2_unfrozen_panel_npz_changes_after_training_pass() -> None:
    """Unfreeze panel_0, run a training pass targeting panel_0, verify NPZ sha256 changes."""
    with tempfile.TemporaryDirectory() as tmpdir:
        panel_dir = os.path.join(tmpdir, "panels")
        trainer = _make_trainer_with_panels(tmpdir)

        # Freeze, save initial NPZ, then unfreeze.
        trainer.freeze("panel_0")
        npz_path = _save_initial_npz(trainer, panel_dir)
        hash_frozen = _sha256(npz_path)

        trainer.unfreeze("panel_0")
        assert not trainer.is_model_frozen("panel_0")

        # Perturb weights in memory (simulates a completed training step).
        _perturb_panel0_weights(trainer)

        # Save — should now succeed and produce a different sha256.
        with patch.object(config, "WEIGHTS_DIR", tmpdir):
            saved = trainer.save_panel_checkpoint("panel_0")

        assert saved is True, "save_panel_checkpoint should return True after unfreeze"

        hash_after = _sha256(npz_path)
        assert hash_after != hash_frozen, (
            f"NPZ sha256 did not change after unfreezing and running a training pass. "
            f"before={hash_frozen!r} after={hash_after!r}"
        )


# ---------------------------------------------------------------------------
# AC-3a: model_name=all preserves existing behaviour
# ---------------------------------------------------------------------------

def _client_with_trainer() -> tuple[TestClient, Trainer]:
    """Build a TestClient wired to a minimal Trainer (no background thread)."""
    with tempfile.TemporaryDirectory() as tmpdir:
        with patch.object(config, "WEIGHTS_DIR", tmpdir):
            from inference.cycle import CognitiveCycle
            cycle = CognitiveCycle()
    buf = DataBuffer(capacity=128)
    trainer = Trainer(cycle, buf)
    main._state.trainer = trainer
    return TestClient(main.app), trainer


def test_ac3_all_freeze_sets_global_flag() -> None:
    """POST /freeze?model_name=all must set the global freeze flag."""
    client, trainer = _client_with_trainer()
    resp = client.post("/cognition/control/freeze?model_name=all")
    assert resp.status_code == 200
    body = resp.json()
    assert body["accepted"] is True
    assert body["frozen"] is True
    assert trainer.is_frozen  # global flag set


def test_ac3_all_unfreeze_clears_global_flag() -> None:
    """POST /unfreeze?model_name=all must clear the global freeze flag."""
    client, trainer = _client_with_trainer()
    trainer.freeze("all")
    resp = client.post("/cognition/control/unfreeze?model_name=all")
    assert resp.status_code == 200
    body = resp.json()
    assert body["accepted"] is True
    assert body["frozen"] is False
    assert not trainer.is_frozen


# ---------------------------------------------------------------------------
# AC-3b: unknown model_name returns accepted=false (not a silent no-op)
# ---------------------------------------------------------------------------

def test_ac3_unknown_model_name_freeze_returns_error() -> None:
    """POST /freeze with an unknown model_name must return accepted=false."""
    client, trainer = _client_with_trainer()
    resp = client.post("/cognition/control/freeze?model_name=does_not_exist")
    assert resp.status_code == 200
    body = resp.json()
    assert body["accepted"] is False
    assert "error" in body
    # Must not silently freeze anything — neither the global flag nor the per-model set.
    assert not trainer.is_frozen
    assert not trainer.is_model_frozen("does_not_exist")


def test_ac3_unknown_model_name_unfreeze_returns_error() -> None:
    """POST /unfreeze with an unknown model_name must return accepted=false."""
    client, trainer = _client_with_trainer()
    resp = client.post("/cognition/control/unfreeze?model_name=does_not_exist")
    assert resp.status_code == 200
    body = resp.json()
    assert body["accepted"] is False
    assert "error" in body


# ---------------------------------------------------------------------------
# Unit: Trainer.freeze/unfreeze per-model bookkeeping
# ---------------------------------------------------------------------------

def test_per_model_freeze_does_not_set_global_flag() -> None:
    """freeze('panel_0') must NOT set the global is_frozen flag."""
    with tempfile.TemporaryDirectory() as tmpdir:
        trainer = _make_trainer_with_panels(tmpdir)
        trainer.freeze("panel_0")
        assert not trainer.is_frozen, "Global freeze must not be set for a per-model freeze"
        assert trainer.is_model_frozen("panel_0")
        assert not trainer.is_model_frozen("panel_1")


def test_global_freeze_makes_all_models_report_frozen() -> None:
    """When global freeze is active, is_model_frozen returns True for any name."""
    with tempfile.TemporaryDirectory() as tmpdir:
        trainer = _make_trainer_with_panels(tmpdir)
        trainer.freeze("all")
        assert trainer.is_model_frozen("panel_0")
        assert trainer.is_model_frozen("panel_3")
        assert trainer.is_model_frozen("global")


def test_unfreeze_all_clears_per_model_set() -> None:
    """unfreeze('all') must clear individual per-model frozen entries too."""
    with tempfile.TemporaryDirectory() as tmpdir:
        trainer = _make_trainer_with_panels(tmpdir)
        trainer.freeze("panel_0")
        trainer.freeze("panel_1")
        trainer.unfreeze("all")
        assert not trainer.is_model_frozen("panel_0")
        assert not trainer.is_model_frozen("panel_1")


def test_unfreeze_specific_does_not_affect_others() -> None:
    """unfreeze('panel_0') must leave other frozen models frozen."""
    with tempfile.TemporaryDirectory() as tmpdir:
        trainer = _make_trainer_with_panels(tmpdir)
        trainer.freeze("panel_0")
        trainer.freeze("panel_1")
        trainer.unfreeze("panel_0")
        assert not trainer.is_model_frozen("panel_0")
        assert trainer.is_model_frozen("panel_1")
