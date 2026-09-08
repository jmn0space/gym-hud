"""Tests for the health endpoint."""

from typing import cast
from unittest.mock import patch

import pytest
from django.conf import settings
from django.db import DatabaseError
from django.db.backends.utils import CursorWrapper
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


@pytest.mark.django_db
@pytest.mark.parametrize("with_session_cookie", [False, True])
def test_health_database_outage_ignores_session_authentication(
    client: Client, with_session_cookie: bool
) -> None:
    """Even a browser carrying a session must receive the controlled, uncached 503."""
    if with_session_cookie:
        session = client.session
        session["_auth_user_id"] = "1"
        session["_auth_user_backend"] = "django.contrib.auth.backends.ModelBackend"
        session.save()
        assert session.session_key is not None
        client.cookies[settings.SESSION_COOKIE_NAME] = session.session_key

    with patch.object(CursorWrapper, "execute", side_effect=DatabaseError("database unavailable")):
        response = client.get("/api/v1/health/")

    assert response.status_code == 503
    assert response.json() == {"status": "degraded", "database": {"connected": False}}
    assert response.headers["Content-Type"] == "application/json"
    for directive in ("no-cache", "no-store", "must-revalidate"):
        assert directive in response.headers["Cache-Control"]
