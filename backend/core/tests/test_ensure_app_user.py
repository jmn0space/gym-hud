"""Tests for the ``ensure_app_user`` provisioning management command."""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.core.management import CommandError, call_command


@pytest.mark.django_db
def test_creates_missing_user(monkeypatch: pytest.MonkeyPatch) -> None:
    """Running with no existing user creates one as superuser and staff."""
    monkeypatch.setenv("DJANGO_APP_USERNAME", "coach")
    monkeypatch.setenv("DJANGO_APP_PASSWORD", "correct-horse-battery-staple")

    call_command("ensure_app_user")

    user = get_user_model().objects.get(username="coach")
    assert user.is_superuser
    assert user.is_staff
    assert user.is_active
    assert user.check_password("correct-horse-battery-staple")


@pytest.mark.django_db
def test_idempotent_when_user_already_matches(monkeypatch: pytest.MonkeyPatch) -> None:
    """Running twice does not error and leaves the account usable."""
    monkeypatch.setenv("DJANGO_APP_USERNAME", "coach")
    monkeypatch.setenv("DJANGO_APP_PASSWORD", "correct-horse-battery-staple")

    call_command("ensure_app_user")
    call_command("ensure_app_user")

    assert get_user_model().objects.filter(username="coach").count() == 1


@pytest.mark.django_db
def test_does_not_reset_password_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without --reset-password, an existing user's password is left alone."""
    monkeypatch.setenv("DJANGO_APP_USERNAME", "coach")
    monkeypatch.setenv("DJANGO_APP_PASSWORD", "correct-horse-battery-staple")
    call_command("ensure_app_user")

    monkeypatch.setenv("DJANGO_APP_PASSWORD", "a-completely-different-passphrase")
    call_command("ensure_app_user")

    user = get_user_model().objects.get(username="coach")
    assert user.check_password("correct-horse-battery-staple")
    assert not user.check_password("a-completely-different-passphrase")


@pytest.mark.django_db
def test_reset_password_flag_updates_password(monkeypatch: pytest.MonkeyPatch) -> None:
    """--reset-password explicitly updates the password of an existing user."""
    monkeypatch.setenv("DJANGO_APP_USERNAME", "coach")
    monkeypatch.setenv("DJANGO_APP_PASSWORD", "correct-horse-battery-staple")
    call_command("ensure_app_user")

    monkeypatch.setenv("DJANGO_APP_PASSWORD", "a-completely-different-passphrase")
    call_command("ensure_app_user", "--reset-password")

    user = get_user_model().objects.get(username="coach")
    assert user.check_password("a-completely-different-passphrase")


@pytest.mark.django_db
def test_rejects_weak_password(monkeypatch: pytest.MonkeyPatch) -> None:
    """A password failing Django's validators is refused, and no user is created."""
    monkeypatch.setenv("DJANGO_APP_USERNAME", "coach")
    monkeypatch.setenv("DJANGO_APP_PASSWORD", "1234567")

    with pytest.raises(CommandError):
        call_command("ensure_app_user")

    assert not get_user_model().objects.filter(username="coach").exists()


@pytest.mark.django_db
def test_requires_username_and_password(monkeypatch: pytest.MonkeyPatch) -> None:
    """Missing environment variables raise a clear, non-crashing error."""
    monkeypatch.delenv("DJANGO_APP_USERNAME", raising=False)
    monkeypatch.delenv("DJANGO_APP_PASSWORD", raising=False)

    with pytest.raises(CommandError):
        call_command("ensure_app_user")
