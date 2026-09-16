"""URL configuration for Gym HUD."""

from __future__ import annotations

from core.csrf import API_PATH_PREFIX
from django.contrib import admin
from django.http import HttpRequest, HttpResponse, JsonResponse
from django.urls import include, path
from django.views import defaults as django_error_views

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/v1/", include("core.urls")),
]


def handler404(request: HttpRequest, exception: Exception | None = None) -> HttpResponse:
    """JSON ``{"code": "not_found", ...}`` for unknown ``/api/`` paths.

    Every ``/api/v1/`` error from inside a DRF view already goes through
    ``core.exceptions.exception_handler``, but a path that matches *no* URL
    pattern at all (e.g. a typo, or an endpoint that was removed) never
    reaches a view, so Django's default HTML 404 page was still reachable
    under ``/api/`` -- this closes that last gap in the "every /api/
    response is JSON" contract (see docs/architecture.md). Everything
    outside ``/api/`` keeps Django's ordinary page.
    """
    if request.path.startswith(API_PATH_PREFIX):
        return JsonResponse({"code": "not_found", "detail": "Not found."}, status=404)
    return django_error_views.page_not_found(request, exception)


def handler500(request: HttpRequest) -> HttpResponse:
    """JSON ``{"code": "server_error", ...}`` for an unhandled error under ``/api/``.

    Mirrors :func:`handler404` for the 500 case: an exception a DRF view
    doesn't turn into a proper DRF exception (i.e. anything
    ``core.exceptions.exception_handler`` returns ``None`` for) would
    otherwise fall through to Django's default HTML error page even under
    ``/api/``. Deliberately gives no error detail (matching Django's own
    default 500 page), since this path is reached precisely when the error
    is unexpected.
    """
    if request.path.startswith(API_PATH_PREFIX):
        return JsonResponse(
            {"code": "server_error", "detail": "Internal server error."}, status=500
        )
    return django_error_views.server_error(request)
