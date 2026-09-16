"""Core API views."""

from django.contrib.auth import authenticate, login, logout
from django.db import DatabaseError, connection
from django.middleware.csrf import rotate_token
from django.utils.decorators import method_decorator
from django.views.decorators.cache import cache_control
from django.views.decorators.csrf import csrf_protect, ensure_csrf_cookie
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from core.throttling import CloudflareScopedRateThrottle


def _is_nonempty_str(value: object) -> bool:
    """True only for an actual, non-empty ``str``.

    Rejects everything ``dict.get()`` might otherwise hand a password field
    from arbitrary JSON -- ``int``, ``list``, ``dict``, ``None``, and (since
    ``bool`` is an ``int`` subclass, not a ``str``) ``True``/``False`` too --
    not just the empty string.
    """
    return isinstance(value, str) and bool(value)


@method_decorator(
    cache_control(no_cache=True, no_store=True, must_revalidate=True),
    name="dispatch",
)
class HealthView(APIView):
    """Report application and database health without caching probe results."""

    permission_classes = [AllowAny]
    authentication_classes = []

    def get(self, _request: Request) -> Response:
        """Return health status, including a live database connectivity check."""
        database_connected = True

        try:
            connection.ensure_connection()
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")
                cursor.fetchone()
        except DatabaseError:
            database_connected = False

        payload = {
            "status": "ok" if database_connected else "degraded",
            "database": {
                "connected": database_connected,
            },
        }
        response_status = (
            status.HTTP_200_OK if database_connected else status.HTTP_503_SERVICE_UNAVAILABLE
        )
        return Response(payload, status=response_status)


def _session_payload(request: Request) -> dict[str, object]:
    user = request.user
    authenticated = bool(user and user.is_authenticated)
    return {
        "authenticated": authenticated,
        "username": user.get_username() if authenticated else None,
    }


@method_decorator(
    cache_control(no_cache=True, no_store=True, must_revalidate=True),
    name="dispatch",
)
class SessionView(APIView):
    """Report whether the current request carries an authenticated session.

    Always sets the ``csrftoken`` cookie so the SPA can read it and send it
    back as ``X-CSRFToken`` on the unsafe requests below, even before the user
    has ever logged in.
    """

    permission_classes = [AllowAny]

    @method_decorator(ensure_csrf_cookie)
    def get(self, request: Request) -> Response:
        """Return the current authentication state without caching it.

        For an authenticated caller, this also marks the session modified so
        Django re-saves it (``SessionMiddleware.process_response``), which
        refreshes its expiry to a fresh ``SESSION_COOKIE_AGE`` from now. In
        practice this only extends the expiry once per cold start: the
        frontend calls this endpoint at startup to confirm the session is
        alive (see docs/data-sync.md), but its `online`/focus/visibility
        recheck logic deliberately does not re-call it while already
        authenticated -- only while not yet decided either way (see
        docs/architecture.md for the actual periodicity and its
        consequence). ``SESSION_SAVE_EVERY_REQUEST`` stays ``False`` so only
        this endpoint pays the extra session write, not every request.
        """
        if request.user.is_authenticated:
            request.session.modified = True
        return Response(_session_payload(request))


@method_decorator(
    cache_control(no_cache=True, no_store=True, must_revalidate=True),
    name="dispatch",
)
@method_decorator(csrf_protect, name="dispatch")
class LoginView(APIView):
    """Authenticate with a username and password and start a Django session.

    CSRF is enforced explicitly (``csrf_protect``, applied to ``dispatch``
    rather than just ``post``) because DRF's ``SessionAuthentication`` only
    checks CSRF for already-authenticated requests, and this endpoint must
    reject anonymous CSRF failures too. Wrapping ``dispatch`` -- instead of
    just ``post`` -- runs the CSRF check *before* ``APIView.initial()`` (and
    therefore before ``check_throttles``), so an anonymous request with
    no/an invalid CSRF token is rejected without consuming a login attempt
    from the throttle below; it also still runs inside the ``cache_control``
    wrapper, so even a CSRF-failure response carries the same no-store
    headers as everything else this view returns.
    """

    permission_classes = [AllowAny]
    throttle_classes = [CloudflareScopedRateThrottle]
    throttle_scope = "login"

    def post(self, request: Request) -> Response:
        """Validate credentials, log the user in, and rotate the session and CSRF token."""
        data = request.data if isinstance(request.data, dict) else {}
        username = data.get("username")
        password = data.get("password")
        if not _is_nonempty_str(username) or not _is_nonempty_str(password):
            # Reject non-string/empty/missing fields (and non-object JSON
            # bodies, via the isinstance check above) before ever reaching
            # authenticate(): Django's ModelBackend calls set_password()/
            # check_password() with whatever was sent, and a non-string
            # password crashes the dummy hasher run for an *unknown*
            # username (500) while a known username's real check_password()
            # tends not to -- a status-code oracle for username enumeration,
            # on top of the 500 itself. Validating the type here closes both
            # at once, uniformly, before either code path is reached.
            return Response(
                {"code": "invalid_request", "detail": "Username and password are required."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        user = authenticate(request, username=username, password=password)
        if user is None:
            return Response(
                {"code": "invalid_credentials", "detail": "Incorrect username or password."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        login(request, user)  # Rotates the session key and the CSRF token.
        return Response(_session_payload(request))


@method_decorator(
    cache_control(no_cache=True, no_store=True, must_revalidate=True),
    name="dispatch",
)
class LogoutView(APIView):
    """End the current Django session, if any.

    Idempotent: an already-anonymous request still succeeds with 204, but a
    valid CSRF token is required either way (``csrf_protect``, for the same
    reason as :class:`LoginView`).
    """

    permission_classes = [AllowAny]

    @method_decorator(csrf_protect)
    def post(self, request: Request) -> Response:
        """Flush the session (if authenticated) and rotate the CSRF token."""
        if request.user.is_authenticated:
            logout(request)
        # Django's logout() does not rotate the CSRF token itself -- it only
        # sends user_logged_out, flushes the session, and resets
        # request.user to AnonymousUser. Rotate explicitly and
        # unconditionally (for both the just-logged-out and the
        # already-anonymous no-op path) so a CSRF token issued before this
        # call is never still valid afterwards.
        rotate_token(request)
        return Response(status=status.HTTP_204_NO_CONTENT)
