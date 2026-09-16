"""Authentication classes for the Gym HUD API."""

from __future__ import annotations

from django.http import HttpRequest, HttpResponseBase
from rest_framework.authentication import CSRFCheck
from rest_framework.authentication import SessionAuthentication as _SessionAuthentication
from rest_framework.exceptions import PermissionDenied
from rest_framework.request import Request


class CsrfFailed(PermissionDenied):
    """A CSRF check failed for an already-authenticated session.

    DRF's own ``SessionAuthentication.enforce_csrf`` raises the generic
    ``rest_framework.exceptions.PermissionDenied`` here, which
    ``core.exceptions.exception_handler`` would report as ``{"code":
    "permission_denied", ...}`` -- inconsistent with the ``csrf_failed`` code
    an *anonymous* CSRF failure gets from ``core.csrf.csrf_failure``
    (``settings.CSRF_FAILURE_VIEW``). Subclassing ``PermissionDenied`` keeps
    the same 403 status and DRF exception-handling path, just with a code
    that matches the anonymous case.
    """

    default_code = "csrf_failed"


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

    def enforce_csrf(self, request: Request) -> None:
        """Enforce CSRF for an authenticated session, raising :class:`CsrfFailed`.

        Identical to DRF's own ``SessionAuthentication.enforce_csrf`` except
        for which exception it raises on failure. This runs inside
        ``APIView.initial()`` (via ``perform_authentication``) for *every*
        request carrying an authenticated session, on any view -- not just
        the login/logout endpoints that separately opt back into Django's
        ``csrf_protect`` for anonymous coverage -- so it is what protects a
        plain protected endpoint's unsafe methods too.
        """

        def dummy_get_response(request: HttpRequest) -> HttpResponseBase:  # pragma: no cover
            """Satisfy ``CsrfViewMiddleware.__init__``'s required argument; never called.

            Neither ``process_request`` nor ``process_view`` (DRF's
            ``CSRFCheck`` override of ``_reject`` included) invoke
            ``self.get_response`` -- that only happens via ``__call__``,
            which this code never uses. Typed against Django's own
            ``HttpRequest`` (not DRF's ``Request``) and returning
            ``HttpResponseBase`` because that is what both
            ``CsrfViewMiddleware.__init__`` and ``process_view``'s
            ``callback`` parameter require; also reused below as that
            ``callback`` argument for the same reason.
            """
            raise NotImplementedError

        check = CSRFCheck(dummy_get_response)
        # Populates request.META['CSRF_COOKIE'], used by process_view() below.
        check.process_request(request)
        reason = check.process_view(request, dummy_get_response, (), {})
        if reason:
            raise CsrfFailed(f"CSRF Failed: {reason}")
