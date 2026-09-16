"""Tests for the uniform JSON 404/500 handlers on /api/ paths (config.urls)."""

from __future__ import annotations

import pytest
from django.conf import settings
from django.test import Client


def test_unknown_api_path_returns_json_404_with_debug_false(client: Client) -> None:
    """A path matching no URL pattern under /api/ still gets the uniform JSON error shape.

    Every /api/v1/ error from inside a DRF view already goes through
    core.exceptions.exception_handler, but a path matching *no* pattern at
    all never reaches a view -- this is what covers that gap
    (config.urls.handler404). Only exercised when DEBUG is False (Django
    shows its own debug page instead when DEBUG is True), which is what
    config.settings.test uses.
    """
    assert settings.DEBUG is False

    response = client.get("/api/v1/this-endpoint-does-not-exist/")

    assert response.status_code == 404
    assert response["Content-Type"] == "application/json"
    assert response.json() == {"code": "not_found", "detail": "Not found."}


def test_unknown_non_api_path_still_gets_django_default_404(client: Client) -> None:
    """Everything outside /api/ keeps Django's ordinary (HTML) 404 page."""
    response = client.get("/this-page-does-not-exist/")

    assert response.status_code == 404
    assert "text/html" in response["Content-Type"]


@pytest.mark.django_db
def test_unhandled_api_error_returns_json_500_with_debug_false(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unhandled exception under /api/ gets the uniform JSON shape, not Django's HTML 500 page.

    core.exceptions.exception_handler returns None for exceptions it
    doesn't recognize (e.g. a plain RuntimeError), so DRF re-raises them;
    they then propagate out to Django's own unhandled-exception handling,
    which is exactly what config.urls.handler500 covers. Uses
    Client(raise_request_exception=False) since the test client's default
    behaviour is to re-raise instead of returning the rendered error
    response.
    """
    assert settings.DEBUG is False
    from core.views import HealthView

    def boom(self: HealthView, request: object) -> None:
        raise RuntimeError("boom")

    monkeypatch.setattr(HealthView, "get", boom)
    client = Client(raise_request_exception=False)

    response = client.get("/api/v1/health/")

    assert response.status_code == 500
    assert response["Content-Type"] == "application/json"
    assert response.json() == {"code": "server_error", "detail": "Internal server error."}
