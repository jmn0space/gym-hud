"""Production settings."""

from .base import *  # noqa: F403
from .base import audit_security

ENVIRONMENT = "production"
DEBUG = False

# The only ingress is the trusted cloudflared connector on the private Docker
# network. It supplies the original scheme; never publish Gunicorn's port or
# allow untrusted peers to supply this header (see README deployment guidance).
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

# Gunicorn runs multiple worker processes (GUNICORN_WORKERS), each with its
# own memory; the default LocMemCache would give every worker an
# independent login-throttle counter, so a client could regain throttle
# budget just by landing on a different worker. A DatabaseCache is visible
# to every worker. deploy/entrypoint.sh runs `createcachetable` (idempotent)
# before Gunicorn starts so this table always exists first.
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.db.DatabaseCache",
        "LOCATION": "django_cache",
    }
}

audit_security(
    environment=ENVIRONMENT,
    debug=DEBUG,
    secret_key=SECRET_KEY,  # noqa: F405
    allowed_hosts=ALLOWED_HOSTS,  # noqa: F405
    csrf_trusted_origins=CSRF_TRUSTED_ORIGINS,  # noqa: F405
    database_url=DATABASE_URL,  # noqa: F405
    login_throttle_rate=LOGIN_THROTTLE_RATE,  # noqa: F405
    sync_throttle_rate=SYNC_THROTTLE_RATE,  # noqa: F405
)
