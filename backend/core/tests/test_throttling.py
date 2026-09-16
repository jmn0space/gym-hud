"""Regression tests for the shared "login" rate-limit bucket.

Covers CloudflareScopedRateThrottle's client-identity resolution (used by
POST /api/v1/auth/login/) and core.throttling.check_login_rate_limit (used
by POST /admin/login/, via core.admin.ThrottledAdminSite), including that
the two share one bucket per client identity.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.contrib.auth.models import User
from rest_framework.test import APIClient
from rest_framework.throttling import ScopedRateThrottle

from core.tests.conftest import PASSWORD, USERNAME, csrf_token


@pytest.fixture(autouse=True)
def _low_login_rate(monkeypatch: pytest.MonkeyPatch) -> None:
    """A tiny rate so tests can trip the limit in a couple of requests.

    Patches the class attribute DRF snapshots DEFAULT_THROTTLE_RATES into
    (see core.tests.test_auth.test_login_is_throttled_after_repeated_failures),
    which is also what core.throttling.check_login_rate_limit reads, so this
    one patch controls both entry points.
    """
    monkeypatch.setattr(ScopedRateThrottle, "THROTTLE_RATES", {"login": "2/min"})


def _attempt_api_login(client: APIClient, token: str, **extra: Any) -> int:
    return client.post(
        "/api/v1/auth/login/",
        {"username": USERNAME, "password": "wrong"},
        format="json",
        HTTP_X_CSRFTOKEN=token,
        **extra,
    ).status_code


def _attempt_admin_login(client: APIClient, **extra: Any) -> int:
    return client.post(
        "/admin/login/",
        {"username": USERNAME, "password": "wrong", "next": "/admin/"},
        **extra,
    ).status_code


# --- CloudflareScopedRateThrottle client identity ----------------------------


@pytest.mark.django_db
def test_rotating_x_forwarded_for_does_not_bypass_the_limit(
    csrf_client: APIClient, user: User
) -> None:
    """A spoofable X-Forwarded-For header must not reset the bucket per request.

    DRF's default ScopedRateThrottle.get_ident would key on the whole
    X-Forwarded-For string (absent NUM_PROXIES), which an external client
    can set to anything it likes.
    """
    token = csrf_token(csrf_client)

    statuses = [
        _attempt_api_login(csrf_client, token, HTTP_X_FORWARDED_FOR=f"10.0.0.{i}") for i in range(3)
    ]

    assert statuses == [400, 400, 429]


@pytest.mark.django_db
def test_different_cf_connecting_ip_values_get_separate_buckets(
    csrf_client: APIClient, user: User
) -> None:
    """Two distinct real clients (per CF-Connecting-IP) are throttled independently."""
    token = csrf_token(csrf_client)

    def attempt(ip: str) -> int:
        return _attempt_api_login(csrf_client, token, HTTP_CF_CONNECTING_IP=ip)

    assert [attempt("203.0.113.1") for _ in range(2)] == [400, 400]
    assert attempt("203.0.113.1") == 429  # This client is now throttled...
    assert attempt("203.0.113.2") == 400  # ...but a different client is unaffected.


@pytest.mark.django_db
def test_missing_cf_connecting_ip_falls_back_to_remote_addr(
    csrf_client: APIClient, user: User
) -> None:
    """With no CF-Connecting-IP header at all (e.g. local dev), REMOTE_ADDR is still used."""
    token = csrf_token(csrf_client)

    statuses = [_attempt_api_login(csrf_client, token) for _ in range(3)]

    assert statuses == [400, 400, 429]


@pytest.mark.django_db
def test_csrf_failed_requests_do_not_consume_the_throttle_bucket(
    csrf_client: APIClient, user: User
) -> None:
    """A request rejected for CSRF must not use up a login attempt."""
    csrf_token(csrf_client)  # Sets the cookie; the header is deliberately omitted below.

    for _ in range(5):
        response = csrf_client.post(
            "/api/v1/auth/login/", {"username": USERNAME, "password": "wrong"}, format="json"
        )
        assert response.status_code == 403
        assert response.json()["code"] == "csrf_failed"

    # The bucket is still fresh: a real (CSRF-valid) attempt still gets through.
    token = csrf_token(csrf_client)
    response = csrf_client.post(
        "/api/v1/auth/login/",
        {"username": USERNAME, "password": PASSWORD},
        format="json",
        HTTP_X_CSRFTOKEN=token,
    )
    assert response.status_code == 200


@pytest.mark.django_db
def test_login_throttled_response_has_expected_shape(csrf_client: APIClient, user: User) -> None:
    """A throttled login gets 429 {"code": "throttled"}, matching the uniform error contract."""
    token = csrf_token(csrf_client)
    for _ in range(2):
        _attempt_api_login(csrf_client, token)

    response = csrf_client.post(
        "/api/v1/auth/login/",
        {"username": USERNAME, "password": "wrong"},
        format="json",
        HTTP_X_CSRFTOKEN=token,
    )

    assert response.status_code == 429
    assert response.json()["code"] == "throttled"


# --- /admin/login/ shares the bucket ------------------------------------------


@pytest.mark.django_db
def test_admin_login_is_rate_limited(user: User) -> None:
    """Repeated bad admin logins get limited, just like the API login.

    /admin/login/ is a plain Django view with no DRF exception handling, so
    a throttled response here is the plain-text 429 core.admin.
    ThrottledAdminSite.login returns directly, not the {"code": "throttled"}
    JSON shape (that shape is specific to /api/v1/ per
    core.exceptions.exception_handler).
    """
    client = APIClient()

    statuses = [_attempt_admin_login(client) for _ in range(3)]

    assert statuses[:2] == [200, 200]  # Django re-renders the login form with an error.
    assert statuses[2] == 429


@pytest.mark.django_db
def test_admin_and_api_login_share_one_throttle_bucket(user: User) -> None:
    """A client throttled via /admin/login/ is also throttled on the API login."""
    client = APIClient()

    for _ in range(2):
        _attempt_admin_login(client)

    token = csrf_token(client)  # Same test client => same REMOTE_ADDR as the admin attempts.
    response = client.post(
        "/api/v1/auth/login/",
        {"username": USERNAME, "password": "wrong"},
        format="json",
        HTTP_X_CSRFTOKEN=token,
    )

    assert response.status_code == 429
    assert response.json()["code"] == "throttled"


@pytest.mark.django_db
def test_api_login_throttling_also_limits_admin_login(user: User) -> None:
    """The sharing works in the other direction too: API attempts count against admin login."""
    client = APIClient()
    token = csrf_token(client)

    for _ in range(2):
        _attempt_api_login(client, token)

    assert _attempt_admin_login(client) == 429


@pytest.mark.django_db
def test_admin_login_csrf_rejection_does_not_consume_the_bucket(user: User) -> None:
    """A CSRF-rejected admin login must not consume a login attempt either.

    Unlike the API's LoginView (which opts back into csrf_protect since DRF
    APIViews are otherwise CSRF-exempt), /admin/login/ is an ordinary
    Django view: Django's global CsrfViewMiddleware enforces CSRF via
    process_view, which always runs before the URL's view function (here,
    ThrottledAdminSite.login) -- so a CSRF failure here never even reaches
    the throttle check, for free.
    """
    client = APIClient(enforce_csrf_checks=True)

    for _ in range(5):
        response = client.post(
            "/admin/login/", {"username": USERNAME, "password": "wrong", "next": "/admin/"}
        )
        assert response.status_code == 403

    assert _attempt_admin_login(APIClient()) == 200
