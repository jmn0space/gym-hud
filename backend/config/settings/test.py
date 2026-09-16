"""Fast, isolated settings for automated tests."""

import os

import dj_database_url

from .base import *  # noqa: F403

ENVIRONMENT = "test"
DEBUG = False

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL", "sqlite:///:memory:")
DATABASES["default"] = dj_database_url.parse(TEST_DATABASE_URL, conn_max_age=0)  # noqa: F405

PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.MD5PasswordHasher",
]

SESSION_COOKIE_SECURE = False
CSRF_COOKIE_SECURE = False
SECURE_SSL_REDIRECT = False
SECURE_HSTS_SECONDS = 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = False
SECURE_HSTS_PRELOAD = False

# The production/base WhiteNoise manifest storage requires a manifest built
# by `collectstatic`, which the test suite never runs; without this
# override, rendering any real Django page that uses the `{% static %}`
# template tag (e.g. the /admin/login/ form exercised by
# core.tests.test_throttling) fails with "Missing staticfiles manifest
# entry". Plain StaticFilesStorage resolves files straight from the
# staticfiles finders (django.contrib.staticfiles is in INSTALLED_APPS),
# no manifest needed -- fine for tests, which never serve static assets for
# real.
STORAGES = {  # noqa: F405
    **STORAGES,  # noqa: F405
    "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
}
