"""PAD walking application configuration."""

from django.apps import AppConfig


class PadConfig(AppConfig):
    """PAD walking sessions, bouts, pauses, rests, and the PAD defaults."""

    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.pad"
    label = "pad"
    verbose_name = "PAD walking"

    def ready(self) -> None:
        """Register the PAD stores with the synchronization engine."""
        from apps.pad.sync import PAD_DOMAIN
        from apps.sync.registry import register

        register(PAD_DOMAIN)
