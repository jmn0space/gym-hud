"""Local development settings."""

from .base import *  # noqa: F403
from .base import (
    CORS_ALLOWED_ORIGINS,
    audit_security,
)

ENVIRONMENT = "local"
DEBUG = True

ALLOWED_HOSTS = ["localhost", "127.0.0.1", "[::1]"]
CORS_ALLOWED_ORIGINS = [*CORS_ALLOWED_ORIGINS, "http://localhost:5173"]

SESSION_COOKIE_SECURE = False
CSRF_COOKIE_SECURE = False

SECURE_SSL_REDIRECT = False
SECURE_HSTS_SECONDS = 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = False
SECURE_HSTS_PRELOAD = False

audit_security(
    environment=ENVIRONMENT,
    debug=DEBUG,
    secret_key=SECRET_KEY,  # noqa: F405
    allowed_hosts=ALLOWED_HOSTS,
    database_url=DATABASE_URL,  # noqa: F405
)
