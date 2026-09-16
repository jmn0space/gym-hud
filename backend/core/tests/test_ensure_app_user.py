"""Tests for the ``ensure_app_user`` provisioning management command."""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.core.management import CommandError, call_command
from django.test import Client


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


# --- Existing-user flag safety (never silently reactivate a deactivated account) ---


@pytest.mark.django_db
def test_deactivated_user_stays_deactivated_without_reset_flags(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Re-running the command must never silently reactivate a deliberately deactivated account.

    This is the core regression this command's flag design guards against:
    a routine deploy/boot script re-running ensure_app_user must not be able
    to revive a session-stealing scenario's deactivated account.
    """
    monkeypatch.setenv("DJANGO_APP_USERNAME", "coach")
    monkeypatch.setenv("DJANGO_APP_PASSWORD", "correct-horse-battery-staple")
    call_command("ensure_app_user")
    user = get_user_model().objects.get(username="coach")
    user.is_active = False
    user.save()

    call_command("ensure_app_user")  # No --reset-flags.

    user.refresh_from_db()
    assert user.is_active is False


@pytest.mark.django_db
def test_deactivated_user_is_idempotent_no_op_without_reset_flags(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A no-flags run against a deactivated user changes nothing and does not error."""
    monkeypatch.setenv("DJANGO_APP_USERNAME", "coach")
    monkeypatch.setenv("DJANGO_APP_PASSWORD", "correct-horse-battery-staple")
    call_command("ensure_app_user")
    user_model = get_user_model()
    user = user_model.objects.get(username="coach")
    user.is_active = False
    user.is_staff = False
    user.save()
    password_hash = user.password

    call_command("ensure_app_user")
    call_command("ensure_app_user")  # Twice: still nothing changes.

    user.refresh_from_db()
    assert user.is_active is False
    assert user.is_staff is False
    assert user.password == password_hash
    assert user_model.objects.filter(username="coach").count() == 1


@pytest.mark.django_db
def test_reset_flags_reconciles_a_deactivated_user(monkeypatch: pytest.MonkeyPatch) -> None:
    """--reset-flags explicitly restores superuser/staff/active status."""
    monkeypatch.setenv("DJANGO_APP_USERNAME", "coach")
    monkeypatch.setenv("DJANGO_APP_PASSWORD", "correct-horse-battery-staple")
    call_command("ensure_app_user")
    user = get_user_model().objects.get(username="coach")
    user.is_active = False
    user.is_staff = False
    user.is_superuser = False
    user.save()

    call_command("ensure_app_user", "--reset-flags")

    user.refresh_from_db()
    assert user.is_active
    assert user.is_staff
    assert user.is_superuser


@pytest.mark.django_db
def test_reset_flags_does_not_require_or_touch_the_password(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """--reset-flags alone must not require DJANGO_APP_PASSWORD or touch the stored hash."""
    monkeypatch.setenv("DJANGO_APP_USERNAME", "coach")
    monkeypatch.setenv("DJANGO_APP_PASSWORD", "correct-horse-battery-staple")
    call_command("ensure_app_user")
    user = get_user_model().objects.get(username="coach")
    user.is_active = False
    user.save()
    password_hash = user.password

    monkeypatch.delenv("DJANGO_APP_PASSWORD", raising=False)
    call_command("ensure_app_user", "--reset-flags")  # Must not raise CommandError.

    user.refresh_from_db()
    assert user.is_active
    assert user.password == password_hash


# --- --reset-password session invalidation -----------------------------------


@pytest.mark.django_db
def test_reset_password_invalidates_existing_sessions(
    monkeypatch: pytest.MonkeyPatch, client: Client
) -> None:
    """Rotating the password invalidates sessions authenticated under the old one.

    Captures a real session cookie (via force_login) and then replays it
    with the *same* client after the rotation, proving Django's session auth
    hash check invalidates it server-side -- not just that some other client
    lost its cookie.
    """
    monkeypatch.setenv("DJANGO_APP_USERNAME", "coach")
    monkeypatch.setenv("DJANGO_APP_PASSWORD", "correct-horse-battery-staple")
    call_command("ensure_app_user")
    user = get_user_model().objects.get(username="coach")

    client.force_login(user)
    assert client.get("/api/v1/auth/session/").json()["authenticated"] is True

    monkeypatch.setenv("DJANGO_APP_PASSWORD", "a-completely-different-passphrase")
    call_command("ensure_app_user", "--reset-password")

    response = client.get("/api/v1/auth/session/")
    assert response.json() == {"authenticated": False, "username": None}
