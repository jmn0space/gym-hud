"""Guards that every /api/v1/ view outside the documented public allowlist requires auth.

A view added to core.urls in the future is private by default (REST_FRAMEWORK's
DEFAULT_PERMISSION_CLASSES/DEFAULT_AUTHENTICATION_CLASSES), but nothing
previously *proved* that -- a view that accidentally set permission_classes =
[AllowAny], or a future authentication_classes override, would only be caught
by manual review. This walks the real URLconf so a regression trips a test
instead.
"""

from __future__ import annotations

import pytest
from django.urls import URLPattern, URLResolver, get_resolver
from rest_framework.test import APIClient

# Kept in sync with docs/architecture.md's "Public vs. protected endpoints" list.
PUBLIC_API_PATHS = frozenset(
    {
        "/api/v1/health/",
        "/api/v1/auth/session/",
        "/api/v1/auth/login/",
        "/api/v1/auth/logout/",
    }
)

_API_V1_PREFIX = "api/v1/"


def _iter_api_v1_paths() -> list[str]:
    """Flatten every concrete (non-parameterized) URL pattern mounted under /api/v1/."""
    paths: list[str] = []

    def walk(patterns: list[URLPattern | URLResolver], prefix: str) -> None:
        for entry in patterns:
            full = prefix + str(entry.pattern)
            if isinstance(entry, URLResolver):
                walk(entry.url_patterns, full)
            elif full.startswith(_API_V1_PREFIX) and "<" not in full:
                paths.append("/" + full)

    walk(get_resolver().url_patterns, "")
    return paths


@pytest.mark.django_db
def test_public_allowlist_matches_real_urls() -> None:
    """Catches a stale allowlist entry (typo'd or for a since-removed path)."""
    paths = set(_iter_api_v1_paths())
    assert paths, "URL discovery found nothing under /api/v1/ -- check the walker."
    assert PUBLIC_API_PATHS <= paths


@pytest.mark.django_db
def test_every_undocumented_api_v1_view_requires_authentication(client: APIClient) -> None:
    """Any view under /api/v1/ not in the public allowlist must reject an anonymous GET.

    DRF's APIView.initial() runs authentication/permission checks before
    method dispatch, so an anonymous caller gets 401 even against a view
    that doesn't support GET at all -- there is no legitimate reason for a
    protected view to respond any other way here.
    """
    protected = [path for path in _iter_api_v1_paths() if path not in PUBLIC_API_PATHS]

    for path in protected:
        response = client.get(path)
        assert response.status_code == 401, (
            f"{path} is not in the documented public allowlist (PUBLIC_API_PATHS) but "
            f"responded {response.status_code} to an anonymous GET, not 401. If this view "
            "is intentionally public, add it to PUBLIC_API_PATHS here and to the allowlist "
            "in docs/architecture.md; otherwise its permission/authentication classes need "
            "fixing."
        )
        assert response.json()["code"] == "not_authenticated"
