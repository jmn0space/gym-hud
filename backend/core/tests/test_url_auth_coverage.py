"""Guards that every /api/v1/ view outside the documented public allowlist requires auth.

A view added to core.urls in the future is private by default (REST_FRAMEWORK's
DEFAULT_PERMISSION_CLASSES/DEFAULT_AUTHENTICATION_CLASSES), but nothing
previously *proved* that -- a view that accidentally set permission_classes =
[AllowAny], or a future authentication_classes override, would only be caught
by manual review. This walks the real URLconf so a regression trips a test
instead.

Includes parameterized routes (e.g. ``workouts/<int:pk>/``): a future
endpoint keyed by an id is the common case, not the exception, so a guard
blind to those would be blind to most of what it exists for. _concretize
substitutes a real value per URL converter so the walker's requests actually
resolve, rather than skipping every pattern containing "<".
``core.tests.test_url_auth_coverage_urls`` is a negative-control fixture that
proves this guard actually flags a deliberately wide-open parameterized view.
"""

from __future__ import annotations

import re
from re import Match

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

#: One concrete value per built-in Django path converter (int/str/slug/uuid/path),
#: substituted into a parameterized route before requesting it -- see _concretize.
_PLACEHOLDER_BY_CONVERTER = {
    "int": "1",
    "str": "placeholder",
    "slug": "placeholder-slug",
    "uuid": "00000000-0000-4000-8000-000000000000",
    "path": "placeholder/path",
}
_CONVERTER_GROUP = re.compile(r"<(?:(?P<converter>\w+):)?(?P<name>\w+)>")


def _concretize(route: str) -> str:
    """Replace each ``<converter:name>`` (bare ``<name>`` defaults to ``str``) with a placeholder.

    Lets an anonymous request actually reach a parameterized view's
    permission/authentication checks -- which DRF's ``APIView.initial()``
    runs before method dispatch, regardless of whether the placeholder
    resolves to a real object -- instead of that route being silently
    skipped by URL discovery.
    """

    def replace(match: Match[str]) -> str:
        converter = match.group("converter") or "str"
        return _PLACEHOLDER_BY_CONVERTER.get(converter, "placeholder")

    return _CONVERTER_GROUP.sub(replace, route)


def _iter_api_v1_paths() -> list[str]:
    """Flatten every URL pattern mounted under /api/v1/, parameterized or not."""
    paths: list[str] = []

    def walk(patterns: list[URLPattern | URLResolver], prefix: str) -> None:
        for entry in patterns:
            full = prefix + str(entry.pattern)
            if isinstance(entry, URLResolver):
                walk(entry.url_patterns, full)
            elif full.startswith(_API_V1_PREFIX):
                paths.append("/" + full)

    walk(get_resolver().url_patterns, "")
    return paths


def _anonymous_auth_violations(client: APIClient) -> list[str]:
    """Return every protected-looking /api/v1/ path an anonymous GET can actually reach.

    Shared by the real-urlconf guard test below and
    core.tests.test_url_auth_coverage_urls's negative control, so the exact
    logic proven to pass against the real URLconf is, in the same test run,
    also proven capable of flagging a deliberately wide-open parameterized
    view -- rather than the guard's correctness resting only on the real
    URLconf currently having nothing to catch.
    """
    protected = [path for path in _iter_api_v1_paths() if path not in PUBLIC_API_PATHS]
    violations = []
    for path in protected:
        response = client.get(_concretize(path))
        if response.status_code != 401 or response.json().get("code") != "not_authenticated":
            violations.append(path)
    return violations


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
    that doesn't support GET at all, or a parameterized view whose
    placeholder id/uuid doesn't correspond to a real object -- there is no
    legitimate reason for a protected view to respond any other way here.
    """
    violations = _anonymous_auth_violations(client)
    assert violations == [], (
        f"{violations} are not in the documented public allowlist (PUBLIC_API_PATHS) but did "
        "not reject an anonymous GET with 401 {'code': 'not_authenticated'}. If a path here is "
        "intentionally public, add it to PUBLIC_API_PATHS here and to the allowlist in "
        "docs/architecture.md; otherwise its permission/authentication classes need fixing."
    )


@pytest.mark.django_db
@pytest.mark.urls("core.tests.test_url_auth_coverage_urls")
def test_guard_flags_a_wide_open_parameterized_view(client: APIClient) -> None:
    """Negative control: _anonymous_auth_violations must flag a leaky parameterized route.

    Proves the fix for a real regression: before _iter_api_v1_paths stopped
    filtering out every pattern containing "<", a URLconf shaped exactly
    like core.tests.test_url_auth_coverage_urls (a `workouts/<int:pk>/`
    route whose view sets permission_classes=[AllowAny],
    authentication_classes=[]) was invisible to this guard -- `protected`
    came back without it, the guard test passed, and an anonymous `GET
    /api/v1/workouts/7/` returned 200 with the payload. Run against that
    fixture URLconf, the guard must now flag exactly that route.
    """
    violations = _anonymous_auth_violations(client)

    assert violations == ["/api/v1/workouts/<int:pk>/"]
