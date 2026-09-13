"""Production settings."""

from .base import *  # noqa: F403
from .base import audit_security

ENVIRONMENT = "production"
DEBUG = False

# The only ingress is the trusted cloudflared connector on the private Docker
# network. It supplies the original scheme; never publish Gunicorn's port or
# allow untrusted peers to supply this header (see README deployment guidance).
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

audit_security(
    environment=ENVIRONMENT,
    debug=DEBUG,
    secret_key=SECRET_KEY,  # noqa: F405
    allowed_hosts=ALLOWED_HOSTS,  # noqa: F405
    csrf_trusted_origins=CSRF_TRUSTED_ORIGINS,  # noqa: F405
    database_url=DATABASE_URL,  # noqa: F405
)
