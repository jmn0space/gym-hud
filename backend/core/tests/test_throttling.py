"""Regression tests for the shared "login" rate-limit bucket.

Covers CloudflareScopedRateThrottle's client-identity resolution (used by
POST /api/v1/auth/login/) and core.throttling.check_login_rate_limit (used
by POST /admin/login/, via core.admin.ThrottledAdminSite), including that
the two share one bucket per client identity.
"""

from __future__ import annotations

import time
from typing import Any

import pytest
from django.contrib.auth.models import User
from django.core.cache import cache as default_cache
from django.http import HttpRequest
from rest_framework.test import APIClient
from rest_framework.throttling import ScopedRateThrottle

from core.tests.conftest import PASSWORD, USERNAME, csrf_token
from core.throttling import LOGIN_THROTTLE_SCOPE, check_login_rate_limit


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


# --- A bucket wider than a newly lowered cap must still deny -----------------


def test_check_login_rate_limit_denies_when_history_exceeds_a_lowered_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A bucket seeded under a looser rate must still deny once the rate is lowered.

    Simulates an operator tightening DJANGO_LOGIN_THROTTLE_RATE (e.g.
    10/min -> 3/min) while a client's bucket, recorded under the old rate,
    is still live in the cache (up to a full hour for a "/hour" rate): once
    that happens, len(history) exceeds the new num_requests. That used to
    make `available_requests = num_requests - len(history) + 1` negative,
    which fell into the `... if available_requests > 0 else None` branch --
    `None` is this function's "allowed" sentinel (see its docstring), so the
    caller was let through completely unthrottled, and the early return
    meant the attempt was not even recorded, leaving the client unlimited
    for the rest of the window.
    """
    monkeypatch.setattr(ScopedRateThrottle, "THROTTLE_RATES", {"login": "3/min"})
    ident = "203.0.113.55"
    key = ScopedRateThrottle.cache_format % {"scope": LOGIN_THROTTLE_SCOPE, "ident": ident}
    now = time.time()
    default_cache.set(key, [now - i for i in range(10)], 60)  # 10 already exceeds the cap of 3.

    request = HttpRequest()
    request.META["REMOTE_ADDR"] = ident

    for _ in range(5):
        wait = check_login_rate_limit(request)
        assert wait is not None, "an over-cap bucket must deny, not return the 'allowed' sentinel"
        assert wait > 0


@pytest.mark.django_db
def test_admin_and_api_login_agree_when_a_bucket_predates_a_lowered_rate(
    monkeypatch: pytest.MonkeyPatch, user: User
) -> None:
    """The DRF path and the admin path must agree even when a bucket predates a rate change.

    Seeds a bucket, via ScopedRateThrottle's own cache-key format, with more
    history than a newly lowered cap allows -- the state an old, looser rate
    would leave behind -- then confirms both POST /api/v1/auth/login/ (a
    real DRF ScopedRateThrottle, whose throttle_failure() denies
    unconditionally regardless of the analogous wait() computation) and
    POST /admin/login/ (check_login_rate_limit) deny, rather than the two
    "shared bucket" entry points disagreeing.
    """
    monkeypatch.setattr(ScopedRateThrottle, "THROTTLE_RATES", {"login": "3/min"})
    ident = "127.0.0.1"  # Django's test client's default REMOTE_ADDR.
    key = ScopedRateThrottle.cache_format % {"scope": LOGIN_THROTTLE_SCOPE, "ident": ident}
    now = time.time()
    default_cache.set(key, [now - i for i in range(10)], 60)

    api_client = APIClient()
    token = csrf_token(api_client)

    assert _attempt_api_login(api_client, token) == 429
    assert _attempt_admin_login(APIClient()) == 429


# --- A raising cache must fail closed cleanly, not as an opaque 500 ----------


@pytest.mark.django_db
def test_admin_login_fails_closed_with_a_clean_503_when_the_cache_backend_raises(
    monkeypatch: pytest.MonkeyPatch, user: User
) -> None:
    """A cache backend failure (e.g. a Neon outage) must not surface as an opaque 500.

    core.throttling.check_login_rate_limit's cache reads/writes are wrapped
    to raise RateLimitBackendUnavailable instead of letting a raw backend
    exception escape; core.admin.ThrottledAdminSite.login turns that into a
    deliberate, uniformly-shaped 503 rather than the generic HTML error page
    Django would otherwise render (/admin/login/ is outside
    core.csrf.API_PATH_PREFIX, so config.urls.handler500's JSON shape does
    not apply to it either).
    """

    def boom(*_args: object, **_kwargs: object) -> None:
        raise ConnectionError("cache backend unreachable")

    monkeypatch.setattr(default_cache, "get", boom)

    response = APIClient().post(
        "/admin/login/", {"username": USERNAME, "password": "wrong", "next": "/admin/"}
    )

    assert response.status_code == 503
    assert response.json() == {
        "code": "throttle_unavailable",
        "detail": "Login is temporarily unavailable. Try again shortly.",
    }
