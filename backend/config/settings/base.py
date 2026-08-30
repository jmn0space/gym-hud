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

INSTALLED_APPS = [
    "django.contrib.admin",
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

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework.authentication.SessionAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
}

CORS_ALLOWED_ORIGINS: list[str] = [
    origin.strip() for origin in os.getenv("CORS_ALLOWED_ORIGINS", "").split(",") if origin.strip()
]
CORS_ALLOW_CREDENTIALS = True

SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SECURE = True
SESSION_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SECURE = True

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


def audit_security(
    *,
    environment: str,
    debug: bool,
    secret_key: str,
    allowed_hosts: Sequence[str],
    csrf_trusted_origins: Sequence[str],
    database_url: str,
) -> None:
    """Validate settings after environment-specific overrides are applied."""
    insecure_hosts = {"*", "localhost", "127.0.0.1", "0.0.0.0", "[::1]"}

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
            errors.append(
                "DJANGO_CSRF_TRUSTED_ORIGINS must contain only HTTPS production origins."
            )

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
