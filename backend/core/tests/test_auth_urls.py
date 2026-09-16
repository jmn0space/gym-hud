"""A minimal protected URLconf used only by the auth boundary tests.

This exists purely so the tests can exercise "an authenticated-only API
endpoint" without adding an unrelated real feature to the production URL
config. Activate it in a test with ``@pytest.mark.urls(__name__)``.
"""

from __future__ import annotations

from django.urls import include, path
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from core.urls import urlpatterns as core_urlpatterns


class ProtectedPingView(APIView):
    """Trivial view that requires the default authentication/permission classes."""

    def get(self, _request: Request) -> Response:
        """Return a static payload; reaching this at all proves authentication passed."""
        return Response({"pong": True})

    def post(self, _request: Request) -> Response:
        """An unsafe method, so that CSRF enforcement on a plain protected endpoint is testable.

        This view does not opt into ``csrf_protect`` itself -- unlike
        ``LoginView``/``LogoutView`` -- so reaching this at all for an
        authenticated caller exercises only the default
        ``core.authentication.SessionAuthentication.enforce_csrf`` path.
        """
        return Response({"pong": True})


# Mirror the real API root (api/v1/, including the real auth endpoints) plus
# one extra protected-only route, so tests can exercise the auth boundary
# against a real protected endpoint without adding one to production urls.
urlpatterns = [
    path(
        "api/v1/",
        include(
            [
                *core_urlpatterns,
                path("protected-ping/", ProtectedPingView.as_view(), name="protected-ping"),
            ]
        ),
    ),
]
