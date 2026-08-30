"""Production settings."""

from .base import *  # noqa: F403
from .base import audit_security

ENVIRONMENT = "production"
DEBUG = False

audit_security(
    environment=ENVIRONMENT,
    debug=DEBUG,
    secret_key=SECRET_KEY,  # noqa: F405
    allowed_hosts=ALLOWED_HOSTS,  # noqa: F405
    database_url=DATABASE_URL,  # noqa: F405
)
