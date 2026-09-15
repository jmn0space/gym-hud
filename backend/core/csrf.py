"""Custom CSRF failure handling.

DRF's ``APIView`` normally exempts itself from Django's ``CsrfViewMiddleware``
and enforces CSRF only through ``SessionAuthentication`` (and only for
authenticated requests). The login and logout views explicitly opt back into
middleware-level CSRF checking (via ``django.views.decorators.csrf.csrf_protect``)
so that anonymous requests are covered too. When that check fails, Django's
``CsrfViewMiddleware`` renders ``settings.CSRF_FAILURE_VIEW`` instead of going
through DRF's exception handling. This view keeps that failure response JSON
and on-contract for API paths, while leaving Django's default HTML failure
page for everything else (e.g. the admin login form).
"""

from __future__ import annotations

from django.http import HttpRequest, HttpResponse, JsonResponse
from django.views.csrf import csrf_failure as django_csrf_failure

API_PATH_PREFIX = "/api/"


def csrf_failure(request: HttpRequest, reason: str = "") -> HttpResponse:
    """Return a JSON ``csrf_failed`` error for API paths; Django's default page otherwise."""
    if request.path.startswith(API_PATH_PREFIX):
        return JsonResponse(
            {"code": "csrf_failed", "detail": "CSRF verification failed. Request aborted."},
            status=403,
        )
    return django_csrf_failure(request, reason=reason)
