"""Synchronization API views.

All three endpoints are authenticated like every non-public ``/api/v1/`` view
(the ``REST_FRAMEWORK`` defaults: Django session authentication, CSRF enforced
on the unsafe method through ``core.authentication.SessionAuthentication``),
never cached, and share one per-user ``"sync"`` rate limit. Request-level
failures use the uniform ``{"code", "detail"}`` error shape; per-mutation
outcomes are acknowledgements inside a ``200`` response. See
docs/data-sync.md, "Server synchronization protocol".
"""

from __future__ import annotations

from core.throttling import CloudflareScopedRateThrottle
from django.conf import settings
from django.utils.decorators import method_decorator
from django.views.decorators.cache import cache_control
from rest_framework import status
from rest_framework.exceptions import NotAuthenticated
from rest_framework.parsers import JSONParser
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.sync.engine import process_batch
from apps.sync.envelope import InvalidRequest, parse_batch
from apps.sync.feed import bootstrap, changes_since
from apps.sync.protocol import DEFAULT_CHANGES_PAGE_SIZE, MAX_CHANGES_PAGE_SIZE

#: DRF throttle scope shared by every synchronization endpoint.
SYNC_THROTTLE_SCOPE = "sync"


def _invalid_request(detail: str) -> Response:
    return Response(
        {"code": "invalid_request", "detail": detail}, status=status.HTTP_400_BAD_REQUEST
    )


def _user_id(request: Request) -> int:
    """The authenticated user's id (the permission check has already run)."""
    user = request.user
    if not user.is_authenticated:  # pragma: no cover -- IsAuthenticated runs first
        raise NotAuthenticated()
    return int(user.pk)


@method_decorator(
    cache_control(no_cache=True, no_store=True, must_revalidate=True),
    name="dispatch",
)
class _SyncView(APIView):
    throttle_classes = [CloudflareScopedRateThrottle]
    throttle_scope = SYNC_THROTTLE_SCOPE


class MutationsView(_SyncView):
    """``POST /api/v1/sync/mutations/``: replay a batch of outbox envelopes."""

    parser_classes = [JSONParser]

    def post(self, request: Request) -> Response:
        """Apply each mutation in its own transaction and acknowledge it."""
        limit = settings.DATA_UPLOAD_MAX_MEMORY_SIZE
        try:
            size = int(request.META.get("CONTENT_LENGTH") or 0)
        except ValueError:
            size = 0
        if limit is not None and size > limit:
            # Checked before the body is read: DRF streams it into the JSON
            # parser, which Django's own upload limit never sees.
            return Response(
                {
                    "code": "request_too_large",
                    "detail": f"The request body may be at most {limit} bytes; "
                    "send fewer mutations per request.",
                },
                status=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            )
        try:
            batch = parse_batch(request.data)
        except InvalidRequest as exc:
            return _invalid_request(exc.detail)
        acks = process_batch(_user_id(request), batch.client_id, batch.mutations)
        return Response({"results": [ack.as_dict() for ack in acks]})


class BootstrapView(_SyncView):
    """``GET /api/v1/sync/bootstrap/``: PAD defaults, inherited settings, the cursor."""

    def get(self, request: Request) -> Response:
        """Return the data a device needs before its first pull or session."""
        return Response(bootstrap(_user_id(request)))


def _query_integer(request: Request, name: str, default: int, minimum: int, maximum: int) -> int:
    raw = request.query_params.get(name)
    if raw is None or raw == "":
        return default
    if not raw.isascii() or not raw.isdigit() or not minimum <= int(raw) <= maximum:
        raise InvalidRequest(f"{name} must be an integer from {minimum} to {maximum}.")
    return int(raw)


class ChangesView(_SyncView):
    """``GET /api/v1/sync/changes/?since=<cursor>&limit=<n>``: the paged changes feed."""

    def get(self, request: Request) -> Response:
        """Return one page of the user's records changed after ``since``, tombstones included."""
        try:
            since = _query_integer(request, "since", 0, 0, 2**63 - 1)
            limit = _query_integer(
                request, "limit", DEFAULT_CHANGES_PAGE_SIZE, 1, MAX_CHANGES_PAGE_SIZE
            )
        except InvalidRequest as exc:
            return _invalid_request(exc.detail)
        return Response(changes_since(_user_id(request), since, limit))
