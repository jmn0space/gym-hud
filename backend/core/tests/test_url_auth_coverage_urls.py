"""A deliberately wide-open parameterized view.

Exists solely so ``core.tests.test_url_auth_coverage`` can prove its guard
actually inspects parameterized routes (``<int:pk>/`` and friends), not just
literal ones. Mirrors ``core.tests.test_auth_urls``'s pattern: the real API
root (``api/v1/``, including the real auth endpoints) plus one extra route
shaped exactly like a plausible future endpoint (a detail view keyed by
``<int:pk>``) that accidentally opts out of authentication entirely.
Activate with ``@pytest.mark.urls(__name__)``.
"""

from __future__ import annotations

from django.urls import include, path
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from core.urls import urlpatterns as core_urlpatterns


class LeakyDetailView(APIView):
    """A parameterized detail view that (accidentally) allows anonymous access.

    Before the fix, ``core.tests.test_url_auth_coverage``'s URL walker
    filtered out every pattern containing ``"<"``, so a route shaped exactly
    like this one was invisible to the coverage guard: ``protected`` came
    back without it, the guard test passed, and an anonymous request reached
    this view's payload.
    """

    permission_classes = [AllowAny]
    authentication_classes = []

    def get(self, _request: Request, pk: int) -> Response:
        """Echo the looked-up id; reaching this at all is the leak being proven."""
        return Response({"pk": pk})


# Mirror the real API root (api/v1/, including the real auth endpoints) plus
# one extra, deliberately unprotected parameterized route.
urlpatterns = [
    path(
        "api/v1/",
        include(
            [
                *core_urlpatterns,
                path("workouts/<int:pk>/", LeakyDetailView.as_view(), name="leaky-workout-detail"),
            ]
        ),
    ),
]
