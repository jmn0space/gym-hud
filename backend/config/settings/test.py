"""Fast, isolated settings for automated tests."""

import dj_database_url

from .base import *  # noqa: F403

ENVIRONMENT = "test"
DEBUG = False

DATABASES["default"] = dj_database_url.parse("sqlite:///:memory:")  # noqa: F405

PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.MD5PasswordHasher",
]

SESSION_COOKIE_SECURE = False
CSRF_COOKIE_SECURE = False
SECURE_SSL_REDIRECT = False
SECURE_HSTS_SECONDS = 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = False
SECURE_HSTS_PRELOAD = False
