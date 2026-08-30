"""Tests for the health endpoint."""

from typing import cast

import pytest
from django.test import Client


@pytest.mark.django_db
def test_health_endpoint_reports_database_connectivity(client: Client) -> None:
    """A healthy application reports a connected database without caching the result."""
    response = client.get("/api/v1/health/")

    assert response.status_code == 200
    payload = cast(dict[str, object], response.json())
    assert payload == {
        "status": "ok",
        "database": {
            "connected": True,
        },
    }

    cache_control = response.headers["Cache-Control"]
    assert "no-cache" in cache_control
    assert "no-store" in cache_control
    assert "must-revalidate" in cache_control
