"""Shared abstract models."""

from django.db import models


class TimeStampedModel(models.Model):
    """Abstract model that records creation and modification timestamps."""

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True
