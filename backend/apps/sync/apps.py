"""Server-side synchronization application configuration."""

from django.apps import AppConfig


class SyncConfig(AppConfig):
    """Replays local outbox mutations and serves the synchronization reads.

    Domain apps (PAD today) register their stores with :mod:`apps.sync.registry`
    from their own ``AppConfig.ready()``; this app never imports them.
    """

    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.sync"
    label = "sync"
    verbose_name = "Synchronization"
