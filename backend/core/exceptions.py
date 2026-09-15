"""Uniform JSON error shape for the Gym HUD API.

Every ``/api/v1/`` error response takes the form ``{"code": ..., "detail":
...}``. This module supplies the DRF exception handler that produces that
shape for exceptions raised inside views (authentication, permissions,
throttling, validation, ...). CSRF failures are handled separately by
:mod:`core.csrf`, since Django's CSRF middleware rejects requests before DRF's
exception handling ever runs.
"""

from __future__ import annotations

from typing import Any

from rest_framework import exceptions
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_exception_handler

_NOT_AUTHENTICATED = "not_authenticated"
_PERMISSION_DENIED = "permission_denied"
_THROTTLED = "throttled"
_VALIDATION_ERROR = "validation_error"
_NOT_FOUND = "not_found"
_METHOD_NOT_ALLOWED = "method_not_allowed"
_PARSE_ERROR = "parse_error"
_ERROR = "error"

_CODES_BY_EXCEPTION: tuple[tuple[type[exceptions.APIException], str], ...] = (
    (exceptions.NotAuthenticated, _NOT_AUTHENTICATED),
    (exceptions.AuthenticationFailed, _NOT_AUTHENTICATED),
    (exceptions.PermissionDenied, _PERMISSION_DENIED),
    (exceptions.NotFound, _NOT_FOUND),
    (exceptions.MethodNotAllowed, _METHOD_NOT_ALLOWED),
    (exceptions.Throttled, _THROTTLED),
    (exceptions.ParseError, _PARSE_ERROR),
    (exceptions.ValidationError, _VALIDATION_ERROR),
)


def _code_for(exc: Exception) -> str:
    for exc_type, code in _CODES_BY_EXCEPTION:
        if isinstance(exc, exc_type):
            return code
    return _ERROR


def _detail_text(data: Any) -> str:
    if isinstance(data, dict) and "detail" in data:
        return str(data["detail"])
    if isinstance(data, list) and data:
        return str(data[0])
    return str(data)


def exception_handler(exc: Exception, context: dict[str, Any]) -> Response | None:
    """Translate DRF's default error response into the app's ``{code, detail}`` shape."""
    response = drf_exception_handler(exc, context)
    if response is None:
        return None

    response.data = {"code": _code_for(exc), "detail": _detail_text(response.data)}
    return response
