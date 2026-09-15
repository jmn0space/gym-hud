"""Authentication classes for the Gym HUD API."""

from __future__ import annotations

from rest_framework.authentication import SessionAuthentication as _SessionAuthentication
from rest_framework.request import Request


class SessionAuthentication(_SessionAuthentication):
    """DRF's :class:`SessionAuthentication` with a non-Basic auth header.

    DRF's default implementation returns ``None`` from ``authenticate_header``,
    which makes unauthenticated requests fail with ``403 Forbidden`` instead of
    ``401 Unauthorized`` (DRF only emits 401 when an authenticator advertises a
    ``WWW-Authenticate`` scheme). Advertising ``Basic`` would also make browsers
    pop up a native credential prompt on a 401, which this app does not want
    since authentication happens through the JSON login endpoint. Advertising a
    non-``Basic`` scheme name restores the correct 401 status without
    triggering that prompt.
    """

    def authenticate_header(self, request: Request) -> str:
        """Return a scheme name that yields 401s without a browser auth prompt."""
        return "Session"
