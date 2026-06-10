"""Pytest configuration for the cognition service.

Puts the package root on sys.path so tests can import the service modules as
top-level packages (``config``, ``training.trainer``, ``models.convergence``,
…) — the same import style the service itself uses at runtime.
"""

from __future__ import annotations

import os
import sys

_PACKAGE_ROOT = os.path.dirname(__file__)
if _PACKAGE_ROOT not in sys.path:
    sys.path.insert(0, _PACKAGE_ROOT)
