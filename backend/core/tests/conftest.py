"""Shared fixtures for core.tests."""

from __future__ import annotations

from typing import cast

import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.models import User
from django.core.cache import cache
from rest_framework.test import APIClient

USERNAME = "coach"
PASSWORD = "correct-horse-battery-staple"  # noqa: S105


@pytest.fixture(autouse=True)
def _clear_throttle_cache() -> None:
    """Reset the shared throttle cache so login attempts do not leak between tests."""
    cache.clear()


@pytest.fixture
def user(db: None) -> User:
    """A single ordinary (non-superuser) application account for login tests."""
    return get_user_model().objects.create_user(username=USERNAME, password=PASSWORD)


@pytest.fixture
def csrf_client() -> APIClient:
    """A client that actually enforces CSRF, like a real browser would."""
    return APIClient(enforce_csrf_checks=True)


def csrf_token(client: APIClient) -> str:
    """Prime the CSRF cookie via the session endpoint and return its value."""
    response = client.get("/api/v1/auth/session/")
    assert response.status_code == 200
    token = client.cookies["csrftoken"].value
    assert token
    return cast(str, token)
