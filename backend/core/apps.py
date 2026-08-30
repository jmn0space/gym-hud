"""Core application configuration."""

from django.apps import AppConfig


class CoreConfig(AppConfig):
    """Shared Gym HUD functionality."""

    default_auto_field = "django.db.models.BigAutoField"
    name = "core"
