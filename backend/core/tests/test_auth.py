"""Tests for Django session login, logout, and the session-status endpoint."""

from __future__ import annotations

from typing import cast

import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.models import User
from django.core.cache import cache
from rest_framework.test import APIClient
from rest_framework.throttling import ScopedRateThrottle

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


def _csrf_token(client: APIClient) -> str:
    response = client.get("/api/v1/auth/session/")
    assert response.status_code == 200
    token = client.cookies["csrftoken"].value
    assert token
    return cast(str, token)


# --- GET /api/v1/auth/session/ -----------------------------------------------


@pytest.mark.django_db
def test_session_endpoint_anonymous(client: APIClient) -> None:
    """An anonymous request reports authenticated: false and still sets the CSRF cookie."""
    response = client.get("/api/v1/auth/session/")

    assert response.status_code == 200
    assert response.json() == {"authenticated": False, "username": None}
    assert "csrftoken" in response.cookies
    assert "no-store" in response.headers["Cache-Control"]


@pytest.mark.django_db
def test_session_endpoint_authenticated(client: APIClient, user: User) -> None:
    """A signed-in request reports authenticated: true with the username."""
    client.force_login(user)

    response = client.get("/api/v1/auth/session/")

    assert response.status_code == 200
    assert response.json() == {"authenticated": True, "username": USERNAME}


# --- POST /api/v1/auth/login/ ------------------------------------------------


@pytest.mark.django_db
def test_login_success_rotates_session_key(csrf_client: APIClient, user: User) -> None:
    """A correct login authenticates the session and rotates its session key."""
    token = _csrf_token(csrf_client)
    pre_login_key = csrf_client.session.session_key

    response = csrf_client.post(
        "/api/v1/auth/login/",
        {"username": USERNAME, "password": PASSWORD},
        format="json",
        HTTP_X_CSRFTOKEN=token,
    )

    assert response.status_code == 200
    assert response.json() == {"authenticated": True, "username": USERNAME}
    assert csrf_client.session.session_key is not None
    assert csrf_client.session.session_key != pre_login_key


@pytest.mark.django_db
def test_login_bad_credentials(csrf_client: APIClient, user: User) -> None:
    """Wrong credentials are rejected without authenticating the session."""
    token = _csrf_token(csrf_client)

    response = csrf_client.post(
        "/api/v1/auth/login/",
        {"username": USERNAME, "password": "not-the-password"},
        format="json",
        HTTP_X_CSRFTOKEN=token,
    )

    assert response.status_code == 400
    assert response.json() == {
        "code": "invalid_credentials",
        "detail": "Incorrect username or password.",
    }


@pytest.mark.django_db
def test_login_inactive_user_rejected(csrf_client: APIClient, user: User) -> None:
    """An inactive account cannot authenticate even with the right password."""
    user.is_active = False
    user.save()
    token = _csrf_token(csrf_client)

    response = csrf_client.post(
        "/api/v1/auth/login/",
        {"username": USERNAME, "password": PASSWORD},
        format="json",
        HTTP_X_CSRFTOKEN=token,
    )

    assert response.status_code == 400
    assert response.json()["code"] == "invalid_credentials"


@pytest.mark.django_db
@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"username": USERNAME},
        {"password": PASSWORD},
        {"username": "", "password": ""},
    ],
)
def test_login_missing_fields(csrf_client: APIClient, payload: dict[str, str]) -> None:
    """Missing or empty credentials are a 400 invalid_request, not invalid_credentials."""
    token = _csrf_token(csrf_client)

    response = csrf_client.post(
        "/api/v1/auth/login/", payload, format="json", HTTP_X_CSRFTOKEN=token
    )

    assert response.status_code == 400
    assert response.json()["code"] == "invalid_request"


@pytest.mark.django_db
def test_login_without_csrf_token_is_rejected(csrf_client: APIClient, user: User) -> None:
    """A login POST without a CSRF token fails closed, even though the caller is anonymous."""
    _csrf_token(csrf_client)  # Sets the cookie, but the header below is deliberately omitted.

    response = csrf_client.post(
        "/api/v1/auth/login/", {"username": USERNAME, "password": PASSWORD}, format="json"
    )

    assert response.status_code == 403
    assert response.json() == {
        "code": "csrf_failed",
        "detail": "CSRF verification failed. Request aborted.",
    }
    assert not csrf_client.session.get("_auth_user_id")


# --- POST /api/v1/auth/logout/ -----------------------------------------------


@pytest.mark.django_db
def test_logout_without_csrf_token_is_rejected(csrf_client: APIClient, user: User) -> None:
    """Logout also fails closed without a valid CSRF token."""
    _csrf_token(csrf_client)

    response = csrf_client.post("/api/v1/auth/logout/")

    assert response.status_code == 403
    assert response.json()["code"] == "csrf_failed"


@pytest.mark.django_db
def test_logout_then_protected_call_is_unauthenticated(csrf_client: APIClient, user: User) -> None:
    """After logout, a previously authenticated session can no longer reach protected APIs."""
    token = _csrf_token(csrf_client)
    login_response = csrf_client.post(
        "/api/v1/auth/login/",
        {"username": USERNAME, "password": PASSWORD},
        format="json",
        HTTP_X_CSRFTOKEN=token,
    )
    assert login_response.status_code == 200

    # login() rotates the CSRF token, so the pre-login token is now stale;
    # read the cookie the login response just set.
    rotated_token = csrf_client.cookies["csrftoken"].value
    logout_response = csrf_client.post("/api/v1/auth/logout/", HTTP_X_CSRFTOKEN=rotated_token)
    assert logout_response.status_code == 204
    assert logout_response.content == b""

    session_response = csrf_client.get("/api/v1/auth/session/")
    assert session_response.json() == {"authenticated": False, "username": None}


@pytest.mark.django_db
def test_logout_is_idempotent_for_anonymous_callers(csrf_client: APIClient) -> None:
    """Logging out while already anonymous still succeeds, given a valid CSRF token."""
    token = _csrf_token(csrf_client)

    response = csrf_client.post("/api/v1/auth/logout/", HTTP_X_CSRFTOKEN=token)

    assert response.status_code == 204


# --- Protected endpoint boundary ---------------------------------------------


@pytest.mark.django_db
@pytest.mark.urls("core.tests.test_auth_urls")
def test_anonymous_access_to_protected_endpoint_is_401(client: APIClient) -> None:
    """An unauthenticated request to a protected endpoint gets a uniform 401 error."""
    response = client.get("/api/v1/protected-ping/")

    assert response.status_code == 401
    assert response.json()["code"] == "not_authenticated"
    # No Basic-auth browser prompt: the custom authenticator advertises "Session".
    assert response.headers.get("WWW-Authenticate") == "Session"


@pytest.mark.django_db
@pytest.mark.urls("core.tests.test_auth_urls")
def test_authenticated_access_to_protected_endpoint_succeeds(client: APIClient, user: User) -> None:
    """An authenticated session can reach a protected endpoint."""
    client.force_login(user)

    response = client.get("/api/v1/protected-ping/")

    assert response.status_code == 200
    assert response.json() == {"pong": True}


@pytest.mark.django_db
@pytest.mark.urls("core.tests.test_auth_urls")
def test_expired_session_is_401_and_relogin_works(csrf_client: APIClient, user: User) -> None:
    """A session that has expired behaves like no session at all, and re-login recovers it."""
    token = _csrf_token(csrf_client)
    login_response = csrf_client.post(
        "/api/v1/auth/login/",
        {"username": USERNAME, "password": PASSWORD},
        format="json",
        HTTP_X_CSRFTOKEN=token,
    )
    assert login_response.status_code == 200

    # Force the stored session to already be expired, the same state a real
    # cookie would be in once SESSION_COOKIE_AGE has elapsed, without sleeping
    # in the test. `csrf_client.session` builds a fresh SessionStore on every
    # access, so both calls must go through the same instance.
    session = csrf_client.session
    session.set_expiry(-1)
    session.save()

    response = csrf_client.get("/api/v1/protected-ping/")
    assert response.status_code == 401
    assert response.json()["code"] == "not_authenticated"

    relogin_token = _csrf_token(csrf_client)
    relogin_response = csrf_client.post(
        "/api/v1/auth/login/",
        {"username": USERNAME, "password": PASSWORD},
        format="json",
        HTTP_X_CSRFTOKEN=relogin_token,
    )
    assert relogin_response.status_code == 200

    retry_response = csrf_client.get("/api/v1/protected-ping/")
    assert retry_response.status_code == 200


# --- Throttling ---------------------------------------------------------------


@pytest.mark.django_db
def test_login_is_throttled_after_repeated_failures(
    monkeypatch: pytest.MonkeyPatch, csrf_client: APIClient, user: User
) -> None:
    """Repeated failed logins from the same client eventually get throttled, not just rejected."""
    # DRF snapshots DEFAULT_THROTTLE_RATES into a class attribute at import
    # time, so overriding the Django setting alone would not take effect here;
    # patch the throttle class directly instead.
    monkeypatch.setattr(ScopedRateThrottle, "THROTTLE_RATES", {"login": "2/min"})

    token = _csrf_token(csrf_client)
    statuses = []
    for _ in range(3):
        response = csrf_client.post(
            "/api/v1/auth/login/",
            {"username": USERNAME, "password": "wrong"},
            format="json",
            HTTP_X_CSRFTOKEN=token,
        )
        statuses.append(response.status_code)

    assert statuses[:2] == [400, 400]
    assert statuses[2] == 429
    assert (
        csrf_client.post(
            "/api/v1/auth/login/",
            {"username": USERNAME, "password": "wrong"},
            format="json",
            HTTP_X_CSRFTOKEN=token,
        ).json()["code"]
        == "throttled"
    )
