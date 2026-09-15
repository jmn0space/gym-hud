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
        "password is validated but never printed or logged. Pass --reset-password "
        "to update the password of an existing user; without it, an existing "
        "user's password is left untouched."
    )

    def add_arguments(self, parser: Any) -> None:
        """Register the ``--reset-password`` opt-in flag."""
        parser.add_argument(
            "--reset-password",
            action="store_true",
            default=False,
            help="Update the password of an existing user to DJANGO_APP_PASSWORD.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        """Create the app user if absent, or optionally reset its password."""
        username = os.getenv("DJANGO_APP_USERNAME", "").strip()
        password = os.getenv("DJANGO_APP_PASSWORD", "")
        reset_password = bool(options.get("reset_password"))

        if not username:
            raise CommandError("DJANGO_APP_USERNAME must be set.")
        if not password:
            raise CommandError("DJANGO_APP_PASSWORD must be set.")

        user_model = get_user_model()

        try:
            existing = user_model.objects.filter(**{user_model.USERNAME_FIELD: username}).first()
            validate_password(
                password,
                user=existing
                if existing is not None
                else user_model(**{user_model.USERNAME_FIELD: username}),
            )
        except ValidationError as exc:
            raise CommandError(
                "DJANGO_APP_PASSWORD does not meet the configured password policy: "
                + " ".join(exc.messages)
            ) from exc

        with transaction.atomic():
            if existing is None:
                user_model.objects.create_superuser(username=username, password=password)
                self.style = no_style()
                self.stdout.write(
                    self.style.SUCCESS(f"Created application user {username!r} (superuser, staff).")
                )
                return

            changed = False
            if not existing.is_superuser or not existing.is_staff or not existing.is_active:
                existing.is_superuser = True
                existing.is_staff = True
                existing.is_active = True
                changed = True

            if reset_password:
                existing.set_password(password)
                changed = True

            if changed:
                existing.save()
                self.stdout.write(
                    self.style.SUCCESS(
                        f"Updated application user {username!r}"
                        + (" (password reset)." if reset_password else ".")
                    )
                )
            else:
                self.stdout.write(f"Application user {username!r} already up to date.")
