"""Admin site wiring the shared login throttle onto ``/admin/login/``.

The single application account provisioned by ``ensure_app_user`` is also
the Django superuser (see the README's provisioning section), so
``/admin/login/`` is an equally valuable credential-guessing target as
``POST /api/v1/auth/login/`` -- but ``/admin/login/`` is a plain Django view
that never goes through DRF's throttle machinery, so it was entirely
unthrottled. This applies the same scope and client identity, via
``core.throttling.check_login_rate_limit``, so both entry points draw from
one shared rate-limit bucket. That helper -- rather than a DRF throttle
instance directly -- is what this plain Django view calls; see its
docstring for why.

Wired in as the project's default admin site via the ``ThrottledAdminConfig``
app config below (``INSTALLED_APPS`` in ``config.settings.base`` uses
``"core.admin.ThrottledAdminConfig"`` in place of the stock
``"django.contrib.admin"`` entry), which is Django's documented mechanism
for overriding ``django.contrib.admin.site`` project-wide -- so
``config.urls`` keeps using the ordinary ``admin.site.urls`` unchanged. This
app config is defined here rather than in ``core.apps`` because importing
``AdminConfig`` into that module makes Django's own "find the app's default
AppConfig" auto-detection -- used to resolve the separate bare ``"core"``
INSTALLED_APPS entry for :class:`core.apps.CoreConfig` -- see two
``default = True`` candidates (the imported ``AdminConfig`` name and this
subclass) and refuse to start.
"""

from __future__ import annotations

from typing import Any

from django.contrib import admin
from django.contrib.admin.apps import AdminConfig
from django.http import HttpRequest, HttpResponse, JsonResponse

from core.throttling import RateLimitBackendUnavailable, check_login_rate_limit


class ThrottledAdminSite(admin.AdminSite):
    """``AdminSite`` whose login view shares the API login rate limit."""

    def login(
        self,
        request: HttpRequest,
        extra_context: dict[str, Any] | None = None,
    ) -> HttpResponse:
        """Throttle credential submissions before delegating to the real login view."""
        if request.method == "POST":
            try:
                retry_after = check_login_rate_limit(request)
            except RateLimitBackendUnavailable:
                # Fail closed, but cleanly: a broken cache backend must not
                # surface as Django's generic, opaque HTML 500 page.
                response: HttpResponse = JsonResponse(
                    {
                        "code": "throttle_unavailable",
                        "detail": "Login is temporarily unavailable. Try again shortly.",
                    },
                    status=503,
                )
                response["Cache-Control"] = "no-cache, no-store, must-revalidate"
                return response
            if retry_after is not None:
                response = HttpResponse(
                    "Too many login attempts. Try again later.",
                    status=429,
                    content_type="text/plain",
                )
                response["Cache-Control"] = "no-cache, no-store, must-revalidate"
                response["Retry-After"] = str(int(retry_after) + 1)
                return response
        return super().login(request, extra_context)


class ThrottledAdminConfig(AdminConfig):
    """Admin app config pointing ``django.contrib.admin.site`` at :class:`ThrottledAdminSite`.

    ``default_site`` is Django's documented hook for swapping in a custom
    ``AdminSite`` project-wide without touching ``config.urls`` or any
    ``admin.site.register(...)`` call.
    """

    default_site = "core.admin.ThrottledAdminSite"
