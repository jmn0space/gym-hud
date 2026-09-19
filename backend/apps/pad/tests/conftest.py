"""Shared fixtures for apps.pad.tests."""

from __future__ import annotations

import pytest
from django.core.cache import cache


@pytest.fixture(autouse=True)
def _clear_throttle_cache() -> None:
    """Reset the throttle cache so the per-user sync budget never leaks between tests."""
    cache.clear()
