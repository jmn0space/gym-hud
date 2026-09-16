"""Shared Django settings for Gym HUD."""

from __future__ import annotations

import logging
import os
from collections.abc import Sequence
from pathlib import Path

import dj_database_url
from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parents[2]
PROJECT_ROOT = BASE_DIR.parent

logger = logging.getLogger("security_audit")

ENVIRONMENT = os.getenv("DJANGO_ENV", "local").strip().lower()
DEBUG = False


def _env_str(name: str, default: str) -> str:
    """Read a string env var, treating unset *or empty* as "use the default".

    Plain ``os.getenv(name, default)`` only falls back when the variable is
    entirely unset; an explicitly-empty value (e.g. an unfilled ``VAR=`` line
    reaching the process environment) passes straight through instead of
    falling back, which is rarely what's wanted for an "optional, defaulted"
    setting.
    """
    return os.getenv(name, "").strip() or default


def _env_int(name: str, default: int) -> int:
    """Read an integer env var the same empty-is-unset way as :func:`_env_str`.

    Without this, ``int(os.getenv(name, default))`` crashes on an
    explicitly-empty value instead of using the default, since ``int("")``
    raises ``ValueError``.
    """
    return int(_env_str(name, str(default)))


_DEFAULT_LOCAL_SECRET = "insecure-local-development-key-do-not-use-in-production"  # noqa: S105
SECRET_KEY = os.getenv("DJANGO_SECRET_KEY", _DEFAULT_LOCAL_SECRET)

ALLOWED_HOSTS: list[str] = [
    host.strip() for host in os.getenv("DJANGO_ALLOWED_HOSTS", "").split(",") if host.strip()
]

CSRF_TRUSTED_ORIGINS: list[str] = [
    origin.strip()
    for origin in os.getenv("DJANGO_CSRF_TRUSTED_ORIGINS", "").split(",")
    if origin.strip()
]

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    f"sqlite:///{BASE_DIR / 'db.sqlite3'}",
)
DATABASES = {
    "default": dj_database_url.parse(
        DATABASE_URL,
        conn_max_age=60,
    )
}
# Neon uses transaction pooling: named cursors cannot survive backend switches.
DATABASES["default"]["DISABLE_SERVER_SIDE_CURSORS"] = True

INSTALLED_APPS = [
    # Points django.contrib.admin.site at core.admin.ThrottledAdminSite so
    # /admin/login/ shares the API login throttle; see core.admin.
    "core.admin.ThrottledAdminConfig",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "corsheaders",
    "rest_framework",
    "core",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

AUTH_PASSWORD_VALIDATORS = [
    {
        "NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.CommonPasswordValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.NumericPasswordValidator",
    },
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "Europe/Amsterdam"
USE_I18N = True
USE_TZ = True

STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STORAGES = {
    "default": {
        "BACKEND": "django.core.files.storage.FileSystemStorage",
    },
    "staticfiles": {
        "BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage",
    },
}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# Only the login endpoint (and, via core.admin.ThrottledAdminSite,
# /admin/login/) declares the "login" throttle scope; every other view is
# unaffected. Overridable per deployment to tune brute-force resistance
# without a code change. Pulled out to its own (plainly `str`-typed) name,
# rather than indexed back out of REST_FRAMEWORK below, so both
# config.settings.local and config.settings.production can pass it to
# audit_security() -- which validates it at startup, so a malformed value
# fails loudly there instead of the first time a login request needs it --
# without mypy widening the lookup through REST_FRAMEWORK's heterogeneous
# (str | list[str] | dict[str, str]) value type.
LOGIN_THROTTLE_RATE = _env_str("DJANGO_LOGIN_THROTTLE_RATE", "10/min")

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "core.authentication.SessionAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
    "EXCEPTION_HANDLER": "core.exceptions.exception_handler",
    "DEFAULT_THROTTLE_RATES": {
        "login": LOGIN_THROTTLE_RATE,
    },
}

CORS_ALLOWED_ORIGINS: list[str] = [
    origin.strip() for origin in os.getenv("CORS_ALLOWED_ORIGINS", "").split(",") if origin.strip()
]
CORS_ALLOW_CREDENTIALS = True

SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SECURE = True
SESSION_COOKIE_SAMESITE = "Lax"
# Env-overridable so a deployment can shorten/lengthen how long a signed-in
# session survives without a new login; defaults to 30 days to support the
# "reopen the app after being offline for a while" continuity requirement.
# core.views.SessionView refreshes this on every authenticated session
# check, so in practice it is 30 days since the last check-in, not since
# login; see docs/architecture.md.
SESSION_COOKIE_AGE = _env_int("DJANGO_SESSION_COOKIE_AGE", 60 * 60 * 24 * 30)

CSRF_COOKIE_SECURE = True
# The SPA reads the csrftoken cookie in JavaScript and echoes it back as the
# X-CSRFToken header (Django's documented "AJAX" CSRF pattern), so this
# cookie must stay readable from script. It carries no session/authentication
# data by itself, so this does not weaken the session cookie's own HttpOnly
# protection.
CSRF_COOKIE_HTTPONLY = False
# Render a JSON {"code": "csrf_failed", ...} error for /api/ paths instead of
# Django's default HTML failure page; see core.csrf.csrf_failure.
CSRF_FAILURE_VIEW = "core.csrf.csrf_failure"

SECURE_SSL_REDIRECT = True
SECURE_HSTS_SECONDS = 31_536_000
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = True
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
X_FRAME_OPTIONS = "DENY"

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
        },
    },
    "loggers": {
        "security_audit": {
            "handlers": ["console"],
            "level": "WARNING",
            "propagate": False,
        },
    },
}

_YELLOW = "\033[33m"
_RESET = "\033[0m"


def _validate_login_throttle_rate(rate: str) -> None:
    """Raise ``ImproperlyConfigured`` if ``rate`` is not a usable DRF throttle rate.

    ``core.throttling.check_login_rate_limit`` and DRF's own
    ``ScopedRateThrottle`` both parse ``DJANGO_LOGIN_THROTTLE_RATE`` lazily,
    per request, via ``rest_framework.throttling.SimpleRateThrottle.
    parse_rate`` -- never at startup or during ``manage.py check``. A
    malformed value raises there: ``ValueError`` for ``""``, ``"abc"``, or a
    bare ``"10"`` with no ``"/period"``; ``IndexError`` for ``"10/"`` (an
    empty period); ``KeyError`` for an unrecognised period such as
    ``"10/fortnight"``. A syntactically valid but non-positive count (e.g.
    ``"0/min"`` or ``"-5/min"``) parses without error but is equally fatal:
    ``check_login_rate_limit`` treats an already "full" (or over-full)
    bucket as a denial and indexes into its (possibly empty) history to
    compute a wait time. Either way, a typo reaches production, passes the
    health probe, and turns every login -- ``POST /api/v1/auth/login/``
    *and* ``POST /admin/login/`` -- into a 500 the first time a request
    needs it. Calling this from :func:`audit_security` turns all of that
    into a startup-time ``ImproperlyConfigured`` instead.

    Deliberately reimplements DRF's tiny ``parse_rate`` algorithm below
    rather than importing ``rest_framework.throttling`` into this module:
    this file *is* the Django settings module, still being assembled when
    it runs (this function is called from here, and from
    ``config.settings.local``/``production``, while each is still
    executing). ``rest_framework.throttling.SimpleRateThrottle`` snapshots
    ``REST_FRAMEWORK`` out of ``django.conf.settings`` into a class
    attribute the first time *anything* imports it, process-wide; importing
    it from here, before this module finishes defining ``REST_FRAMEWORK``
    below, would freeze that snapshot to an incomplete (or entirely
    missing) ``settings.REST_FRAMEWORK``, silently breaking the real
    throttle for the rest of the process -- not a hypothetical: this is
    exactly what happened during development of this function, caught by
    ``core.tests.test_auth.test_login_is_throttled_after_repeated_failures``
    failing only when the whole suite ran together.
    """
    try:
        num, period = rate.split("/")
        num_requests = int(num)
        _duration = {"s": 1, "m": 60, "h": 3600, "d": 86400}[period[0]]
    except (ValueError, IndexError, KeyError) as exc:
        raise ImproperlyConfigured(
            f"🚨 SECURITY: DJANGO_LOGIN_THROTTLE_RATE={rate!r} is not a valid DRF rate "
            '("<count>/<second|minute|hour|day>", e.g. "10/min").'
        ) from exc
    if num_requests < 1:
        raise ImproperlyConfigured(
            f"🚨 SECURITY: DJANGO_LOGIN_THROTTLE_RATE={rate!r} must allow at least 1 request."
        )


def audit_security(
    *,
    environment: str,
    debug: bool,
    secret_key: str,
    allowed_hosts: Sequence[str],
    csrf_trusted_origins: Sequence[str],
    database_url: str,
    login_throttle_rate: str,
) -> None:
    """Validate settings after environment-specific overrides are applied."""
    _validate_login_throttle_rate(login_throttle_rate)
    insecure_hosts = {"*", "localhost", "127.0.0.1", "0.0.0.0", "[::1]"}  # noqa: S104

    if environment == "production":
        errors: list[str] = []

        if debug:
            errors.append("DEBUG must be False in production.")

        if not secret_key or secret_key == _DEFAULT_LOCAL_SECRET or len(secret_key) < 50:
            errors.append(
                "DJANGO_SECRET_KEY must be set to a strong value of at least 50 characters."
            )

        database_scheme = database_url.partition(":")[0].lower()
        if database_scheme not in {"postgres", "postgresql"}:
            errors.append("DATABASE_URL must point to PostgreSQL in production.")

        if not allowed_hosts:
            errors.append("DJANGO_ALLOWED_HOSTS must contain at least one production host.")
        elif any(
            host.lower() in insecure_hosts or host.lower().endswith(".localhost")
            for host in allowed_hosts
        ):
            errors.append("DJANGO_ALLOWED_HOSTS must not contain wildcard or localhost values.")

        if not csrf_trusted_origins:
            errors.append(
                "DJANGO_CSRF_TRUSTED_ORIGINS must contain at least one production origin."
            )
        elif any(
            not origin.lower().startswith("https://")
            or "localhost" in origin.lower()
            or "127.0.0.1" in origin
            for origin in csrf_trusted_origins
        ):
            errors.append("DJANGO_CSRF_TRUSTED_ORIGINS must contain only HTTPS production origins.")

        if errors:
            details = " ".join(errors)
            raise ImproperlyConfigured(f"🚨 SECURITY: {details}")

        return

    warnings: list[str] = []
    if debug:
        warnings.append("Running with DEBUG=True. Do not use this configuration in production.")
    if secret_key == _DEFAULT_LOCAL_SECRET:
        warnings.append("Using the built-in development secret key.")
    if any(host.lower() in insecure_hosts for host in allowed_hosts):
        warnings.append("Localhost/wildcard hosts are enabled for development.")

    for warning in warnings:
        logger.warning("%s⚠️ SECURITY: %s%s", _YELLOW, warning, _RESET)
