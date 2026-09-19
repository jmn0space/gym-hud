"""Shared fixtures and helpers for the synchronization tests."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.models import User
from django.core.cache import cache
from rest_framework.test import APIClient

from apps.sync.tests.device import Device

if TYPE_CHECKING:
    from rest_framework.response import _MonkeyPatchedResponse as Response

MUTATIONS_URL = "/api/v1/sync/mutations/"
BOOTSTRAP_URL = "/api/v1/sync/bootstrap/"
CHANGES_URL = "/api/v1/sync/changes/"


@pytest.fixture(autouse=True)
def _clear_throttle_cache() -> None:
    """Reset the throttle cache so the per-user sync budget never leaks between tests."""
    cache.clear()


@pytest.fixture
def user(db: None) -> User:
    return get_user_model().objects.create_user(username="walker", password="unused-password")


@pytest.fixture
def other_user(db: None) -> User:
    return get_user_model().objects.create_user(username="someone-else", password="unused-password")


@pytest.fixture
def api(user: User) -> APIClient:
    """A client signed in as ``user`` (CSRF is covered separately)."""
    client = APIClient()
    client.force_login(user)
    return client


@pytest.fixture
def other_api(other_user: User) -> APIClient:
    client = APIClient()
    client.force_login(other_user)
    return client


@pytest.fixture
def device() -> Device:
    return Device()


def push(
    client: APIClient, device: Device, *envelopes: dict[str, Any], client_id: str | None = None
) -> Response:
    """POST ``envelopes`` as one batch from ``device``."""
    return client.post(
        MUTATIONS_URL,
        {"client_id": client_id or device.client_id, "mutations": list(envelopes)},
        format="json",
    )


def results(response: Response) -> list[dict[str, Any]]:
    """The acknowledgement list of a successful push."""
    assert response.status_code == 200, response.content
    body: dict[str, Any] = response.json()
    assert set(body) == {"results"}
    items: list[dict[str, Any]] = body["results"]
    return items


def statuses(response: Response) -> list[str]:
    return [item["status"] for item in results(response)]


def codes(response: Response) -> list[str | None]:
    return [item.get("code") for item in results(response)]
