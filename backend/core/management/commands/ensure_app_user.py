"""Provision the single Gym HUD application account non-interactively.

Intended for automated deployment (``docker compose exec web python
manage.py ensure_app_user``), as an alternative to the interactive
``createsuperuser``. Reads the account's credentials from the environment so
no secret is ever passed on the command line or echoed back.
"""

from __future__ import annotations

import os
from typing import Any

from django.contrib.auth import get_user_model
from django.contrib.auth.models import User
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.core.management.color import no_style
from django.db import transaction


class Command(BaseCommand):
    """Create or update the single application user from environment variables."""

    help = (
        "Idempotently ensure the application's admin/staff user exists, reading "
        "DJANGO_APP_USERNAME and DJANGO_APP_PASSWORD from the environment. The "
        "password is validated but never printed or logged, and is only read or "
        "required when it will actually be used (creating the user, or "
        "--reset-password). Pass --reset-password to update the password of an "
        "existing user; without it, an existing user's password is left "
        "untouched. Pass --reset-flags to reconcile an existing user's "
        "is_active/is_staff/is_superuser back to the expected provisioned "
        "state; without it, those flags are left untouched too, so re-running "
        "this command never silently reactivates an account someone "
        "deliberately deactivated."
    )

    def add_arguments(self, parser: Any) -> None:
        """Register the ``--reset-password``/``--reset-flags`` opt-in flags."""
        parser.add_argument(
            "--reset-password",
            action="store_true",
            default=False,
            help="Update the password of an existing user to DJANGO_APP_PASSWORD.",
        )
        parser.add_argument(
            "--reset-flags",
            action="store_true",
            default=False,
            help=(
                "Reconcile an existing user's is_active/is_staff/is_superuser "
                "flags to the expected provisioned state (all True). Without "
                "this, a mismatch (e.g. a deliberately deactivated account) is "
                "reported but left unchanged."
            ),
        )

    def handle(self, *args: Any, **options: Any) -> None:
        """Create the app user if absent, or optionally update flags/password."""
        username = os.getenv("DJANGO_APP_USERNAME", "").strip()
        reset_password = bool(options.get("reset_password"))
        reset_flags = bool(options.get("reset_flags"))

        if not username:
            raise CommandError("DJANGO_APP_USERNAME must be set.")

        user_model = get_user_model()
        existing = user_model.objects.filter(**{user_model.USERNAME_FIELD: username}).first()

        with transaction.atomic():
            if existing is None:
                password = self._read_and_validate_password(
                    user_model(**{user_model.USERNAME_FIELD: username})
                )
                user_model.objects.create_superuser(username=username, password=password)
                self.style = no_style()
                self.stdout.write(
                    self.style.SUCCESS(f"Created application user {username!r} (superuser, staff).")
                )
                return

            changed = False
            messages: list[str] = []

            flags_match = existing.is_superuser and existing.is_staff and existing.is_active
            if not flags_match:
                if reset_flags:
                    existing.is_superuser = True
                    existing.is_staff = True
                    existing.is_active = True
                    changed = True
                    messages.append("flags reconciled (superuser, staff, active)")
                else:
                    self.stdout.write(
                        self.style.WARNING(
                            f"Application user {username!r} exists but is missing "
                            "superuser/staff/active status "
                            f"(is_superuser={existing.is_superuser}, "
                            f"is_staff={existing.is_staff}, is_active={existing.is_active}); "
                            "leaving it unchanged. Pass --reset-flags to reconcile it "
                            "explicitly, e.g. to restore an account after confirming a "
                            "deactivation was accidental."
                        )
                    )

            if reset_password:
                password = self._read_and_validate_password(existing)
                existing.set_password(password)
                changed = True
                messages.append("password reset")
                # Rotating the password invalidates every existing session
                # for this user as soon as it is next used: Django derives
                # each session's stored auth hash from the password hash
                # (AbstractBaseUser.get_session_auth_hash), and
                # django.contrib.auth.get_user() flushes a session whose
                # stored hash no longer matches the current one. No manual
                # session cleanup needed here.

            if changed:
                existing.save()
                summary = ", ".join(messages)
                self.stdout.write(
                    self.style.SUCCESS(f"Updated application user {username!r} ({summary}).")
                )
            else:
                self.stdout.write(f"Application user {username!r} already up to date.")

    def _read_and_validate_password(self, user_for_validation: User) -> str:
        """Read ``DJANGO_APP_PASSWORD`` and validate it, only called where it will be used.

        Kept out of ``handle()``'s main flow so a no-op or flags-only run
        never requires (or even reads) ``DJANGO_APP_PASSWORD`` -- only the
        create and ``--reset-password`` branches call this.
        """
        password = os.getenv("DJANGO_APP_PASSWORD", "")
        if not password:
            raise CommandError("DJANGO_APP_PASSWORD must be set.")
        try:
            validate_password(password, user=user_for_validation)
        except ValidationError as exc:
            raise CommandError(
                "DJANGO_APP_PASSWORD does not meet the configured password policy: "
                + " ".join(exc.messages)
            ) from exc
        return password
