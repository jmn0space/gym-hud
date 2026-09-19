"""Synchronization API routes, mounted under ``/api/v1/``."""

from django.urls import path

from apps.sync.views import BootstrapView, ChangesView, MutationsView

urlpatterns = [
    path("sync/mutations/", MutationsView.as_view(), name="sync-mutations"),
    path("sync/bootstrap/", BootstrapView.as_view(), name="sync-bootstrap"),
    path("sync/changes/", ChangesView.as_view(), name="sync-changes"),
]
