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
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView


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
        """Return the current authentication state without caching it."""
        return Response(_session_payload(request))


@method_decorator(
    cache_control(no_cache=True, no_store=True, must_revalidate=True),
    name="dispatch",
)
class LoginView(APIView):
    """Authenticate with a username and password and start a Django session.

    CSRF is enforced explicitly (``csrf_protect``) because DRF's
    ``SessionAuthentication`` only checks CSRF for already-authenticated
    requests, and this endpoint must reject anonymous CSRF failures too.
    """

    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "login"

    @method_decorator(csrf_protect)
    def post(self, request: Request) -> Response:
        """Validate credentials, log the user in, and rotate the session and CSRF token."""
        data = request.data if isinstance(request.data, dict) else {}
        username = data.get("username")
        password = data.get("password")
        if not username or not password:
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
        else:
            # logout() only rotates the CSRF token as a side effect of
            # flushing a real session; do it explicitly for the no-op path too
            # so a stale anonymous CSRF token is never reused across logins.
            rotate_token(request)
        return Response(status=status.HTTP_204_NO_CONTENT)
