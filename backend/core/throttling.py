"""Throttling that resolves the real client IP behind Cloudflare Tunnel."""

from __future__ import annotations

import time

from django.core.cache import cache as default_cache
from django.http import HttpRequest
from rest_framework.request import Request
from rest_framework.throttling import ScopedRateThrottle

#: DRF throttle scope shared by POST /api/v1/auth/login/ (CloudflareScopedRateThrottle,
#: below) and POST /admin/login/ (check_login_rate_limit, below).
LOGIN_THROTTLE_SCOPE = "login"


class RateLimitBackendUnavailable(Exception):
    """The cache backend raised while :func:`check_login_rate_limit` used it.

    Deliberately fails closed (the caller must treat this the same as "deny")
    rather than let a Neon outage or a missing ``django_cache`` table (see
    ``config.settings.production``'s ``CACHES`` comment) propagate as an
    unhandled exception: for ``/admin/login/`` (a plain Django view, outside
    ``core.csrf.API_PATH_PREFIX``) that would otherwise surface as Django's
    generic HTML 500 page instead of a clean, deliberate response.
    ``core.admin.ThrottledAdminSite.login`` is the only caller and is what
    turns this into that response.
    """


def get_client_ident(request: HttpRequest) -> str:
    """Return the Cloudflare-supplied client IP, or ``REMOTE_ADDR``.

    The only ingress to this application is the trusted ``cloudflared``
    connector on the private Docker network -- the same trust boundary
    ``config.settings.production.SECURE_PROXY_SSL_HEADER`` relies on for the
    request scheme. Cloudflare's edge sets ``CF-Connecting-IP`` to the real
    client IP on every request it forwards, and since Gunicorn's port is
    never published, nothing except that trusted connector can set the
    header Django actually reads. That makes it safe to trust directly,
    unlike ``X-Forwarded-For``: DRF's default ``get_ident`` uses the whole
    ``X-Forwarded-For`` string unless ``NUM_PROXIES`` is configured, which an
    external client can freely prepend to (see the regression tests in
    ``core.tests.test_throttling``), and cloudflared's own connection to
    Django otherwise leaves every visitor sharing one ``REMOTE_ADDR`` bucket.

    Falls back to ``REMOTE_ADDR`` -- never to ``X-Forwarded-For`` -- when the
    header is absent, e.g. local development without the tunnel in front,
    and to ``""`` on the (practically impossible under WSGI) chance neither
    is present, so callers always get a plain, hashable ``str``.

    Shared by :class:`CloudflareScopedRateThrottle` (a real DRF throttle,
    used by ``LoginView``) and :func:`check_login_rate_limit` (used by
    ``core.admin.ThrottledAdminSite``, a plain Django view) so both entry
    points identify a client the same way.
    """
    cf_connecting_ip = request.META.get("HTTP_CF_CONNECTING_IP", "").strip()
    return cf_connecting_ip or request.META.get("REMOTE_ADDR") or ""


class CloudflareScopedRateThrottle(ScopedRateThrottle):
    """``ScopedRateThrottle`` keyed on the Cloudflare-verified client IP.

    Used directly by ``LoginView`` (``throttle_classes =
    [CloudflareScopedRateThrottle]``, ``throttle_scope = "login"``), which
    DRF drives through the normal ``BaseThrottle.allow_request(request,
    view)`` contract (a real DRF ``Request``/``APIView``).
    ``core.admin.ThrottledAdminSite`` (``/admin/login/``) shares the same
    bucket via :func:`check_login_rate_limit` instead of this class,
    because it only ever has a plain Django ``HttpRequest`` and
    ``AdminSite`` -- see that function's docstring for why fabricating a
    fake ``Request``/``APIView`` for it would be worse than a second entry
    point.
    """

    def get_ident(self, request: Request) -> str:
        """Return the Cloudflare-supplied client IP, or ``REMOTE_ADDR``."""
        return get_client_ident(request)


def check_login_rate_limit(request: HttpRequest) -> float | None:
    """Consume one ``"login"``-scope attempt for ``request``'s client identity.

    Returns ``None`` if the attempt is allowed (and records it in the shared
    cache), or the number of seconds the caller should wait before retrying
    if the bucket is already full.

    ``core.admin.ThrottledAdminSite.login`` calls this to share one
    rate-limit bucket with :class:`CloudflareScopedRateThrottle` above
    (used by the DRF-based ``POST /api/v1/auth/login/``), without
    fabricating a fake DRF ``Request``/``APIView`` to hand to a real
    throttle instance. That alternative was considered and rejected:
    constructing a bare ``rest_framework.request.Request(request)`` with no
    authenticators configured makes its ``.user`` resolve to
    ``AnonymousUser`` unconditionally (``Request._not_authenticated``),
    instead of the real session user DRF's own ``SessionAuthentication``
    would report (it just reads the underlying Django request's
    already-middleware-resolved ``.user`` -- see
    ``SessionAuthentication.authenticate``). ``ScopedRateThrottle`` keys an
    *authenticated* caller by user id rather than IP, so that substitution
    would silently be a correctness bug, not just a typing inconvenience.

    Reimplements just the cache-bucket sliding-window algorithm from
    ``rest_framework.throttling.SimpleRateThrottle.allow_request`` against a
    plain ``HttpRequest`` and the module-level ``LOGIN_THROTTLE_SCOPE``,
    reusing DRF's own rate configuration (``ScopedRateThrottle.
    THROTTLE_RATES`` -- the same class attribute
    ``core.tests.test_throttling`` monkeypatches, so both entry points stay
    controllable from one place), cache, and cache-key format, so the two
    entry points draw from exactly one bucket per client identity.
    """
    rate = ScopedRateThrottle.THROTTLE_RATES.get(LOGIN_THROTTLE_SCOPE)
    num_requests, duration = ScopedRateThrottle().parse_rate(rate)
    if num_requests is None or duration is None:
        return None  # No rate configured for this scope: never throttle.

    ident = get_client_ident(request)
    key = ScopedRateThrottle.cache_format % {"scope": LOGIN_THROTTLE_SCOPE, "ident": ident}
    try:
        history: list[float] = default_cache.get(key, [])
    except Exception as exc:
        # Fail closed on a broken cache backend (a Neon outage, a missing
        # django_cache table, ...) rather than let the exception propagate
        # out of this plain Django view as an opaque, unhandled 500 -- see
        # RateLimitBackendUnavailable.
        raise RateLimitBackendUnavailable(str(exc)) from exc
    now = time.time()
    while history and history[-1] <= now - duration:
        history.pop()

    if len(history) >= num_requests:
        # DRF's own SimpleRateThrottle.throttle_failure() denies unconditionally,
        # regardless of what the analogous wait() computation returns -- wait()
        # only ever feeds a Retry-After header on a response that is *already*
        # a denial. `available_requests` going to zero or negative here (e.g. an
        # operator lowers DJANGO_LOGIN_THROTTLE_RATE while a bucket recorded
        # under the old, looser rate is still live in the cache, so len(history)
        # now exceeds num_requests) must still deny -- clamping to 1 keeps the
        # result a positive wait instead of the "no rate configured" `None`
        # sentinel this function uses for "allowed", which would otherwise both
        # let the request through *and*, via this early return, never record it,
        # leaving the client unlimited for the rest of the window.
        available_requests = max(num_requests - len(history) + 1, 1)
        remaining_duration = duration - (now - history[-1])
        return remaining_duration / float(available_requests)

    history.insert(0, now)
    try:
        default_cache.set(key, history, duration)
    except Exception as exc:
        raise RateLimitBackendUnavailable(str(exc)) from exc
    return None
