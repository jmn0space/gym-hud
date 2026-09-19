"""Django Admin for PAD: editable defaults, read-only workout records.

The defaults are configuration, and "server configuration wins"
(docs/data-sync.md), so they are the one PAD thing edited here. Walking
sessions and their bouts, pauses and rests are the user's own synchronized
data: the device is the source of every edit, so the admin only shows them.
An admin edit would change a row without a mutation -- no ledger entry, no
change-counter bump, invisible to the changes feed -- and the next edit from
the device would silently overwrite it.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from django.contrib import admin
from django.db.models import Model
from django.http import HttpRequest

from apps.pad.models import PadDefaults, WalkingBout, WalkingBoutPause, WalkingRest, WalkingSession

if TYPE_CHECKING:
    _DefaultsAdmin = admin.ModelAdmin[PadDefaults]
    _SessionAdmin = admin.ModelAdmin[WalkingSession]
    _BoutAdmin = admin.ModelAdmin[WalkingBout]
    _BoutInline = admin.TabularInline[WalkingBout, WalkingSession]
    _PauseInline = admin.TabularInline[WalkingBoutPause, WalkingBout]
    _RestInline = admin.TabularInline[WalkingRest, WalkingBout]
else:
    _DefaultsAdmin = _SessionAdmin = _BoutAdmin = admin.ModelAdmin
    _BoutInline = _PauseInline = _RestInline = admin.TabularInline

_SYNC_FIELDS = ("created_at", "updated_at", "deleted_at", "change_seq")


class _ReadOnlyAdmin:
    """View-only model admin: no add, change, or delete."""

    def has_add_permission(self, request: HttpRequest) -> bool:
        return False

    def has_change_permission(self, request: HttpRequest, obj: Model | None = None) -> bool:
        return False

    def has_delete_permission(self, request: HttpRequest, obj: Model | None = None) -> bool:
        return False


class _ReadOnlyInline:
    """View-only inline: no add, change, or delete."""

    extra = 0
    can_delete = False
    show_change_link = True

    def has_add_permission(self, request: HttpRequest, obj: Model | None = None) -> bool:
        return False

    def has_change_permission(self, request: HttpRequest, obj: Model | None = None) -> bool:
        return False

    def has_delete_permission(self, request: HttpRequest, obj: Model | None = None) -> bool:
        return False


@admin.register(PadDefaults)
class PadDefaultsAdmin(_DefaultsAdmin):
    """The PAD defaults singleton: addable once, never deleted."""

    list_display = ("__str__", "speed_kmh", "incline_pct", "max_bout_seconds", "updated_at")
    readonly_fields = ("updated_at",)

    def has_add_permission(self, request: HttpRequest) -> bool:
        return super().has_add_permission(request) and not PadDefaults.objects.exists()

    def has_delete_permission(self, request: HttpRequest, obj: PadDefaults | None = None) -> bool:
        return False


class WalkingBoutInline(_ReadOnlyInline, _BoutInline):
    model = WalkingBout
    fk_name = "walking_session"
    fields = (
        "bout_number",
        "started_at",
        "ended_at",
        "pain_min",
        "pain_max",
        "stop_reason",
        "notes",
        "deleted_at",
    )
    ordering = ("started_at",)


class WalkingBoutPauseInline(_ReadOnlyInline, _PauseInline):
    model = WalkingBoutPause
    fields = ("started_at", "ended_at", "deleted_at")
    ordering = ("started_at",)
    show_change_link = False


class WalkingRestInline(_ReadOnlyInline, _RestInline):
    model = WalkingRest
    fields = ("started_at", "ended_at", "deleted_at")
    ordering = ("started_at",)
    show_change_link = False


@admin.register(WalkingSession)
class WalkingSessionAdmin(_ReadOnlyAdmin, _SessionAdmin):
    list_display = (
        "started_at",
        "status",
        "user",
        "speed_kmh",
        "incline_pct",
        "max_bout_seconds",
        "completed_at",
        "deleted_at",
    )
    list_filter = ("status", ("deleted_at", admin.EmptyFieldListFilter))
    search_fields = ("id",)
    date_hierarchy = "started_at"
    ordering = ("-started_at",)
    fields = (
        "id",
        "user",
        "status",
        "started_at",
        "completed_at",
        "speed_kmh",
        "incline_pct",
        "max_bout_seconds",
        "session_notes",
        *_SYNC_FIELDS,
    )
    inlines = (WalkingBoutInline,)


@admin.register(WalkingBout)
class WalkingBoutAdmin(_ReadOnlyAdmin, _BoutAdmin):
    list_display = (
        "started_at",
        "bout_number",
        "walking_session",
        "ended_at",
        "pain_min",
        "pain_max",
        "stop_reason",
        "deleted_at",
    )
    list_filter = ("stop_reason", ("deleted_at", admin.EmptyFieldListFilter))
    search_fields = ("id", "walking_session__id")
    ordering = ("-started_at",)
    fields = (
        "id",
        "user",
        "walking_session",
        "bout_number",
        "started_at",
        "ended_at",
        "pain_min",
        "pain_max",
        "stop_reason",
        "notes",
        *_SYNC_FIELDS,
    )
    inlines = (WalkingBoutPauseInline, WalkingRestInline)
