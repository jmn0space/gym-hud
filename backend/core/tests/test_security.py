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
            csrf_trusted_origins=[],
            database_url="sqlite:///db.sqlite3",
            login_throttle_rate="10/min",
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
            csrf_trusted_origins=["https://gym.example.com"],
            database_url=database_url,
            login_throttle_rate="10/min",
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
        csrf_trusted_origins=["https://gym.example.com"],
        database_url=database_url,
        login_throttle_rate="10/min",
    )


@pytest.mark.parametrize(
    "csrf_trusted_origins",
    [
        [],
        ["http://gym.example.com"],
        ["https://localhost:5173"],
    ],
)
def test_production_security_audit_requires_secure_csrf_origins(
    csrf_trusted_origins: list[str],
) -> None:
    """Production requires explicit HTTPS non-local CSRF origins."""
    with pytest.raises(ImproperlyConfigured, match="DJANGO_CSRF_TRUSTED_ORIGINS"):
        audit_security(
            environment="production",
            debug=False,
            secret_key="x" * 50,
            allowed_hosts=["gym.example.com"],
            csrf_trusted_origins=csrf_trusted_origins,
            database_url="postgresql://gymhud:password@db/gymhud",
            login_throttle_rate="10/min",
        )


def test_local_security_audit_emits_warning() -> None:
    """Local development explicitly warns about insecure settings."""
    with patch("config.settings.base.logger.warning") as warning:
        audit_security(
            environment="local",
            debug=True,
            secret_key="insecure-local-development-key-do-not-use-in-production",
            allowed_hosts=["localhost"],
            csrf_trusted_origins=["http://localhost:5173"],
            database_url="sqlite:///db.sqlite3",
            login_throttle_rate="10/min",
        )

    messages = " ".join(str(call) for call in warning.call_args_list)
    assert "SECURITY" in messages
    assert "DEBUG=True" in messages


# --- A malformed DJANGO_LOGIN_THROTTLE_RATE must fail at startup -------------


@pytest.mark.parametrize(
    "rate",
    ["", "abc", "10", "10/", "10/fortnight", "0/min", "-5/min"],
    ids=[
        "empty",
        "not-a-rate",
        "no-period",
        "empty-period",
        "unknown-period",
        "zero-requests",
        "negative-requests",
    ],
)
def test_audit_security_rejects_a_malformed_login_throttle_rate(rate: str) -> None:
    """Every malformed DJANGO_LOGIN_THROTTLE_RATE shape must fail at startup, not at request time.

    Without this, core.throttling.check_login_rate_limit and DRF's own
    ScopedRateThrottle only discover a bad rate the first time a request
    needs to parse it: manage.py check reports no issues, the health probe
    passes, and then every login (API and /admin/) 500s. See
    config.settings.base._validate_throttle_rate's docstring for the
    exact exception each of these shapes raises downstream.
    """
    with pytest.raises(ImproperlyConfigured, match="DJANGO_LOGIN_THROTTLE_RATE"):
        audit_security(
            environment="local",
            debug=True,
            secret_key="insecure-local-development-key-do-not-use-in-production",
            allowed_hosts=["localhost"],
            csrf_trusted_origins=["http://localhost:5173"],
            database_url="sqlite:///db.sqlite3",
            login_throttle_rate=rate,
        )


@pytest.mark.parametrize("rate", ["10/min", "3/s", "1000/day"])
def test_audit_security_accepts_a_well_formed_login_throttle_rate(rate: str) -> None:
    """A syntactically valid, positive rate must not be rejected."""
    audit_security(
        environment="local",
        debug=True,
        secret_key="insecure-local-development-key-do-not-use-in-production",
        allowed_hosts=["localhost"],
        csrf_trusted_origins=["http://localhost:5173"],
        database_url="sqlite:///db.sqlite3",
        login_throttle_rate=rate,
    )


# --- DJANGO_SYNC_THROTTLE_RATE gets the same startup check -------------------


@pytest.mark.parametrize("rate", ["", "10", "10/fortnight", "0/min"])
def test_audit_security_rejects_a_malformed_sync_throttle_rate(rate: str) -> None:
    """A bad sync rate would 500 every /api/v1/sync/ request; it must fail at startup instead."""
    with pytest.raises(ImproperlyConfigured, match="DJANGO_SYNC_THROTTLE_RATE"):
        audit_security(
            environment="local",
            debug=True,
            secret_key="insecure-local-development-key-do-not-use-in-production",
            allowed_hosts=["localhost"],
            csrf_trusted_origins=["http://localhost:5173"],
            database_url="sqlite:///db.sqlite3",
            login_throttle_rate="10/min",
            sync_throttle_rate=rate,
        )


def test_audit_security_accepts_the_default_sync_throttle_rate() -> None:
    audit_security(
        environment="local",
        debug=True,
        secret_key="insecure-local-development-key-do-not-use-in-production",
        allowed_hosts=["localhost"],
        csrf_trusted_origins=["http://localhost:5173"],
        database_url="sqlite:///db.sqlite3",
        login_throttle_rate="10/min",
        sync_throttle_rate="120/min",
    )
