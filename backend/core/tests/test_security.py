"""Tests for the startup security auditor."""

from unittest.mock import patch

import pytest
from config.settings.base import audit_security
from django.core.exceptions import ImproperlyConfigured


def test_production_security_audit_rejects_insecure_settings() -> None:
    """Production refuses to start with development security values."""
    with pytest.raises(ImproperlyConfigured, match="SECURITY"):
        audit_security(
            environment="production",
            debug=True,
            secret_key="short",
            allowed_hosts=["localhost"],
            database_url="sqlite:///db.sqlite3",
        )


@pytest.mark.parametrize(
    "database_url",
    [
        "",
        "sqlite:///db.sqlite3",
        "mysql://gymhud:password@db/gymhud",
    ],
)
def test_production_security_audit_requires_postgresql(database_url: str) -> None:
    """Production rejects missing and non-PostgreSQL database URLs."""
    with pytest.raises(ImproperlyConfigured, match="DATABASE_URL must point to PostgreSQL"):
        audit_security(
            environment="production",
            debug=False,
            secret_key="x" * 50,
            allowed_hosts=["gym.example.com"],
            database_url=database_url,
        )


@pytest.mark.parametrize(
    "database_url",
    [
        "postgres://gymhud:password@db/gymhud",
        "postgresql://gymhud:password@db/gymhud",
    ],
)
def test_production_security_audit_accepts_postgresql(database_url: str) -> None:
    """Production accepts both supported PostgreSQL URL schemes."""
    audit_security(
        environment="production",
        debug=False,
        secret_key="x" * 50,
        allowed_hosts=["gym.example.com"],
        database_url=database_url,
    )


def test_local_security_audit_emits_warning() -> None:
    """Local development explicitly warns about insecure settings."""
    with patch("config.settings.base.logger.warning") as warning:
        audit_security(
            environment="local",
            debug=True,
            secret_key="insecure-local-development-key-do-not-use-in-production",
            allowed_hosts=["localhost"],
            database_url="sqlite:///db.sqlite3",
        )

    messages = " ".join(str(call) for call in warning.call_args_list)
    assert "SECURITY" in messages
    assert "DEBUG=True" in messages
