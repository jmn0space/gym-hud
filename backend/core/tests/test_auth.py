"""Tests for Django session login, logout, and the session-status endpoint."""

from __future__ import annotations

from typing import Any

import pytest
from django.conf import settings
from django.contrib.auth.models import User
from django.contrib.sessions.models import Session
from rest_framework.test import APIClient
from rest_framework.throttling import ScopedRateThrottle

from core.tests.conftest import PASSWORD, USERNAME, csrf_token

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


@pytest.mark.django_db
def test_session_check_refreshes_expiry_for_authenticated_caller(
    csrf_client: APIClient, user: User
) -> None:
    """GET /auth/session/ while authenticated pushes the *persisted* session's expiry further out.

    This is what makes SESSION_COOKIE_AGE "30 days since the app last
    confirmed the session with the server" rather than a hard 30 days from
    login (see docs/architecture.md), so a daily user is never signed out
    mid-use.

    Asserts on the actual `django_session` row via
    `django.contrib.sessions.models.Session`, not
    `csrf_client.session.get_expiry_date()`: Django's test client builds a
    *fresh* `SessionStore` on every `.session` access, and
    `SessionBase.get_expiry_date()` computes `timezone.now() +
    SESSION_COOKIE_AGE` at call time whenever `_session_expiry` was never
    explicitly set (true here -- nothing in this flow calls `set_expiry()`).
    That means two back-to-back `.session.get_expiry_date()` calls are
    already strictly increasing with no request in between, so that
    assertion would still pass even with `SessionView.get`'s
    `request.session.modified = True` removed -- proving nothing about
    whether the server actually re-saved the session. The persisted
    `expire_date` only moves when `SessionMiddleware.process_response`
    actually calls `request.session.save()`, which happens precisely when
    `request.session.modified` (or `SESSION_SAVE_EVERY_REQUEST`) is true.
    """
    token = csrf_token(csrf_client)
    login_response = csrf_client.post(
        "/api/v1/auth/login/",
        {"username": USERNAME, "password": PASSWORD},
        format="json",
        HTTP_X_CSRFTOKEN=token,
    )
    assert login_response.status_code == 200
    session_key = csrf_client.session.session_key
    assert session_key is not None
    expiry_at_login = Session.objects.get(session_key=session_key).expire_date

    response = csrf_client.get("/api/v1/auth/session/")

    assert response.status_code == 200
    expiry_after_check = Session.objects.get(session_key=session_key).expire_date
    assert expiry_after_check > expiry_at_login


@pytest.mark.django_db
def test_session_check_does_not_create_a_session_for_anonymous_caller(
    csrf_client: APIClient,
) -> None:
    """An anonymous session check has no authenticated session to extend, and creates none.

    Checks the response's own Set-Cookie rather than the test client's
    `.session` property: merely accessing that property creates and saves a
    blank session as a side effect (Django's own test Client does this so
    it can always hand back a usable SessionStore), which would make this
    assertion pass regardless of what the server did. Also checks the
    `django_session` table directly (the negative control for the
    authenticated-refresh test above): with no authenticated session to
    extend, none should be created or persisted just from checking.
    """
    assert Session.objects.count() == 0

    response = csrf_client.get("/api/v1/auth/session/")

    assert response.status_code == 200
    assert response.json() == {"authenticated": False, "username": None}
    assert settings.SESSION_COOKIE_NAME not in response.cookies
    assert Session.objects.count() == 0


# --- POST /api/v1/auth/login/ ------------------------------------------------


@pytest.mark.django_db
def test_login_success_rotates_session_key(csrf_client: APIClient, user: User) -> None:
    """A correct login authenticates the session and rotates its session key."""
    token = csrf_token(csrf_client)
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
    token = csrf_token(csrf_client)

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
    token = csrf_token(csrf_client)

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
    token = csrf_token(csrf_client)

    response = csrf_client.post(
        "/api/v1/auth/login/", payload, format="json", HTTP_X_CSRFTOKEN=token
    )

    assert response.status_code == 400
    assert response.json()["code"] == "invalid_request"


@pytest.mark.django_db
@pytest.mark.parametrize(
    "payload",
    [
        {"username": USERNAME, "password": 1},
        {"username": "unknown-user", "password": 1},
        {"username": USERNAME, "password": ["a", "list"]},
        {"username": USERNAME, "password": None},
        {"username": USERNAME, "password": True},
        {"username": USERNAME, "password": {"nested": "dict"}},
        {"username": 1, "password": PASSWORD},
        {"username": ["a", "list"], "password": PASSWORD},
        {"username": None, "password": PASSWORD},
    ],
    ids=[
        "known-user-int-password",
        "unknown-user-int-password",
        "list-password",
        "null-password",
        "bool-password",
        "dict-password",
        "int-username",
        "list-username",
        "null-username",
    ],
)
def test_login_non_string_fields_are_uniformly_invalid_request(
    csrf_client: APIClient, user: User, payload: dict[str, object]
) -> None:
    """A non-string username/password is rejected identically for known and unknown users.

    Before this validation, an unknown username with a non-string password
    crashed ModelBackend's dummy-hasher run (500), while a known username's
    real check_password() tended not to -- a status-code oracle for
    username enumeration, on top of the 500 itself. Every case here must
    produce the same 400 invalid_request regardless of whether `username`
    happens to exist.
    """
    token = csrf_token(csrf_client)

    response = csrf_client.post(
        "/api/v1/auth/login/", payload, format="json", HTTP_X_CSRFTOKEN=token
    )

    assert response.status_code == 400
    assert response.json()["code"] == "invalid_request"


@pytest.mark.django_db
def test_login_non_object_body_is_invalid_request(csrf_client: APIClient) -> None:
    """A JSON body that isn't an object (e.g. a bare list) is rejected cleanly, not a 500."""
    token = csrf_token(csrf_client)

    response = csrf_client.post(
        "/api/v1/auth/login/",
        ["not", "an", "object"],
        format="json",
        HTTP_X_CSRFTOKEN=token,
    )

    assert response.status_code == 400
    assert response.json()["code"] == "invalid_request"


@pytest.mark.django_db
def test_login_without_csrf_token_is_rejected(csrf_client: APIClient, user: User) -> None:
    """A login POST without a CSRF token fails closed, even though the caller is anonymous."""
    csrf_token(csrf_client)  # Sets the cookie, but the header below is deliberately omitted.

    response = csrf_client.post(
        "/api/v1/auth/login/", {"username": USERNAME, "password": PASSWORD}, format="json"
    )

    assert response.status_code == 403
    assert response.json() == {
        "code": "csrf_failed",
        "detail": "CSRF verification failed. Request aborted.",
    }
    assert not csrf_client.session.get("_auth_user_id")


@pytest.mark.django_db
@pytest.mark.parametrize("bad_token", [None, "not-the-real-token"], ids=["missing", "bad"])
def test_login_while_already_authenticated_still_requires_valid_csrf(
    csrf_client: APIClient, user: User, bad_token: str | None
) -> None:
    """An already-authenticated re-post to /login/ still gets csrf_failed, not permission_denied."""
    token = csrf_token(csrf_client)
    login_response = csrf_client.post(
        "/api/v1/auth/login/",
        {"username": USERNAME, "password": PASSWORD},
        format="json",
        HTTP_X_CSRFTOKEN=token,
    )
    assert login_response.status_code == 200

    kwargs: dict[str, Any] = {} if bad_token is None else {"HTTP_X_CSRFTOKEN": bad_token}
    response = csrf_client.post(
        "/api/v1/auth/login/",
        {"username": USERNAME, "password": PASSWORD},
        format="json",
        **kwargs,
    )

    assert response.status_code == 403
    assert response.json()["code"] == "csrf_failed"


# --- POST /api/v1/auth/logout/ -----------------------------------------------


@pytest.mark.django_db
def test_logout_without_csrf_token_is_rejected(csrf_client: APIClient, user: User) -> None:
    """Logout also fails closed without a valid CSRF token."""
    csrf_token(csrf_client)

    response = csrf_client.post("/api/v1/auth/logout/")

    assert response.status_code == 403
    assert response.json()["code"] == "csrf_failed"


@pytest.mark.django_db
def test_logout_is_idempotent_for_anonymous_callers(csrf_client: APIClient) -> None:
    """Logging out while already anonymous still succeeds, given a valid CSRF token."""
    token = csrf_token(csrf_client)

    response = csrf_client.post("/api/v1/auth/logout/", HTTP_X_CSRFTOKEN=token)

    assert response.status_code == 204


@pytest.mark.django_db
@pytest.mark.parametrize("bad_token", [None, "not-the-real-token"], ids=["missing", "bad"])
def test_logout_authenticated_without_valid_csrf_is_csrf_failed(
    csrf_client: APIClient, user: User, bad_token: str | None
) -> None:
    """An authenticated logout with a missing/bad CSRF token gets csrf_failed.

    Not permission_denied: DRF's stock SessionAuthentication.enforce_csrf raises the generic
    PermissionDenied here, which core.exceptions.exception_handler would
    report as permission_denied -- inconsistent with the anonymous CSRF
    failure below. core.authentication.SessionAuthentication.enforce_csrf
    (and the CsrfFailed/exception_handler wiring) exists specifically to
    close that gap; this asserts the outcome directly. Because
    initial()/perform_authentication runs before LogoutView.post's own
    csrf_protect decorator, this is the code path actually exercised for an
    authenticated caller.
    """
    token = csrf_token(csrf_client)
    login_response = csrf_client.post(
        "/api/v1/auth/login/",
        {"username": USERNAME, "password": PASSWORD},
        format="json",
        HTTP_X_CSRFTOKEN=token,
    )
    assert login_response.status_code == 200

    kwargs: dict[str, Any] = {} if bad_token is None else {"HTTP_X_CSRFTOKEN": bad_token}
    response = csrf_client.post("/api/v1/auth/logout/", **kwargs)

    assert response.status_code == 403
    assert response.json()["code"] == "csrf_failed"
    # The session must still be alive: a bad CSRF token must not itself log
    # the user out.
    assert csrf_client.session.get("_auth_user_id") is not None


@pytest.mark.django_db
@pytest.mark.urls("core.tests.test_auth_urls")
def test_logout_invalidates_the_session_and_rotates_the_csrf_token(
    csrf_client: APIClient, user: User
) -> None:
    """Logout invalidates the session server-side and rotates the CSRF token.

    Replays the captured pre-logout session cookie against a real protected
    endpoint (rather than re-reading /auth/session/ with the *same* client,
    whose cookie jar Django's test client already moved on from) to prove
    the old session id is rejected server-side, not just that this client's
    own cookie jar changed. Also confirms Django's logout() does not itself
    rotate the CSRF token (contrary to a stale comment this test used to
    rely on) by checking the token changes both after login and after
    logout.
    """
    pre_login_token = csrf_token(csrf_client)
    login_response = csrf_client.post(
        "/api/v1/auth/login/",
        {"username": USERNAME, "password": PASSWORD},
        format="json",
        HTTP_X_CSRFTOKEN=pre_login_token,
    )
    assert login_response.status_code == 200
    post_login_token = csrf_client.cookies["csrftoken"].value
    assert post_login_token != pre_login_token  # login() rotates the CSRF token.

    pre_logout_session_key = csrf_client.session.session_key
    assert pre_logout_session_key is not None

    logout_response = csrf_client.post("/api/v1/auth/logout/", HTTP_X_CSRFTOKEN=post_login_token)
    assert logout_response.status_code == 204
    assert logout_response.content == b""

    post_logout_token = csrf_client.cookies["csrftoken"].value
    assert post_logout_token != post_login_token  # logout() also rotates it.

    replay_client = APIClient()
    replay_client.cookies[settings.SESSION_COOKIE_NAME] = pre_logout_session_key
    response = replay_client.get("/api/v1/protected-ping/")
    assert response.status_code == 401
    assert response.json()["code"] == "not_authenticated"


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
@pytest.mark.parametrize("bad_token", [None, "not-the-real-token"], ids=["missing", "bad"])
def test_authenticated_unsafe_method_without_valid_csrf_is_csrf_failed(
    csrf_client: APIClient, user: User, bad_token: str | None
) -> None:
    """An unsafe request on an ordinary protected endpoint enforces CSRF too, uniformly.

    Unlike login/logout, ProtectedPingView does not opt into csrf_protect
    itself -- this exercises only
    core.authentication.SessionAuthentication.enforce_csrf, the general fix
    for finding 1 (as opposed to the login/logout-specific csrf_protect
    decorators).
    """
    token = csrf_token(csrf_client)
    login_response = csrf_client.post(
        "/api/v1/auth/login/",
        {"username": USERNAME, "password": PASSWORD},
        format="json",
        HTTP_X_CSRFTOKEN=token,
    )
    assert login_response.status_code == 200

    kwargs: dict[str, Any] = {} if bad_token is None else {"HTTP_X_CSRFTOKEN": bad_token}
    response = csrf_client.post("/api/v1/protected-ping/", **kwargs)

    assert response.status_code == 403
    assert response.json()["code"] == "csrf_failed"


@pytest.mark.django_db
@pytest.mark.urls("core.tests.test_auth_urls")
def test_expired_session_is_401_and_relogin_works(csrf_client: APIClient, user: User) -> None:
    """A session that has expired behaves like no session at all, and re-login recovers it."""
    token = csrf_token(csrf_client)
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

    relogin_token = csrf_token(csrf_client)
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

    token = csrf_token(csrf_client)
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
