"""Pytest configuration for the perception-service test suite.

This file anchors the pytest rootdir at the package root (so the in-tree
``cobeing`` package imports without an install step) and implements the
LOUD-skip policy for tests that need heavy model dependencies.

Policy (M0.5 scaffold):

* Pure unit tests (no marker) run normally. They depend only on the standard
  library and the ``cobeing`` package, so they must never be skipped here.
* Tests marked ``@pytest.mark.requires_models`` need one or more of the heavy
  model-runtime dependencies (onnxruntime / mediapipe / insightface / neo4j).
  When ANY of those imports fails we SKIP LOUDLY: the skip reason names the
  exact missing dependency and its import error, and we also emit a warning so
  the gap is visible in the run summary. We never silently pass a model test
  whose runtime is absent — an absent runtime is reported, not hidden.

The probe is import-only (it does not instantiate models or download weights),
so it is cheap and side-effect free, and is cached for the whole session.
"""

from __future__ import annotations

import importlib
import warnings

import pytest

# Heavy model-runtime dependencies a `requires_models` test may need. We probe
# all of them so the skip reason can name every one that is missing, not just
# the first.
_MODEL_DEPS: tuple[str, ...] = (
    "onnxruntime",
    "mediapipe",
    "insightface",
    "neo4j",
)

# Cache: dep name -> error string (only populated for deps that FAILED to
# import). Empty dict means every model dep is importable. ``None`` means we
# have not probed yet.
_missing_model_deps: dict[str, str] | None = None


def _probe_model_deps() -> dict[str, str]:
    """Import-probe every model dep once; cache and return the missing ones.

    Returns a mapping of ``dep name -> short error description`` for each
    dependency that could not be imported. An empty mapping means all model
    dependencies are present.
    """
    global _missing_model_deps
    if _missing_model_deps is not None:
        return _missing_model_deps

    missing: dict[str, str] = {}
    for dep in _MODEL_DEPS:
        try:
            importlib.import_module(dep)
        except Exception as exc:  # noqa: BLE001 - any import-time failure means "unavailable"
            # ImportError/ModuleNotFoundError are the common case, but native
            # deps (onnxruntime, mediapipe) can raise OSError/RuntimeError when
            # a shared library is missing. Treat all of those as "unavailable".
            missing[dep] = f"{type(exc).__name__}: {exc}"

    _missing_model_deps = missing
    return missing


def pytest_runtest_setup(item: pytest.Item) -> None:
    """Skip ``requires_models`` tests LOUDLY when a model dep is unavailable.

    Unmarked tests pass through untouched.
    """
    if item.get_closest_marker("requires_models") is None:
        return  # pure unit test — run normally

    missing = _probe_model_deps()
    if not missing:
        return  # all model deps present — let the test run

    detail = "; ".join(f"{dep} ({err})" for dep, err in missing.items())
    reason = (
        "SKIPPED (requires_models): missing model dependency import(s): "
        f"{detail}. Install the perception-service requirements "
        "(packages/perception-service/requirements.txt) into the venv to run "
        "this test."
    )

    # Be loud: surface the gap in the warnings summary too, so a skip from a
    # missing runtime is never silent in CI/gate output.
    warnings.warn(
        f"requires_models test '{item.nodeid}' skipped — missing: "
        f"{', '.join(missing)}",
        stacklevel=2,
    )

    pytest.skip(reason)
