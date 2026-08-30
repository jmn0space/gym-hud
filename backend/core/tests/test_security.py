"""Tests for the startup security auditor."""

import logging

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


def test_local_security_audit_emits_warning(caplog: pytest.LogCaptureFixture) -> None:
    """Local development explicitly warns about insecure settings."""
    with caplog.at_level(logging.WARNING, logger="security_audit"):
        audit_security(
            environment="local",
            debug=True,
            secret_key="insecure-local-development-key-do-not-use-in-production",
            allowed_hosts=["localhost"],
            database_url="sqlite:///db.sqlite3",
        )

    assert "SECURITY" in caplog.text
    assert "DEBUG=True" in caplog.text
