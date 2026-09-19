"""Read-only Django Admin for the processed-mutation ledger.

The ledger is what makes replay idempotent: editing or deleting a row would let
an already-applied mutation apply again, or change the answer a retry receives.
It is therefore viewable only -- useful for seeing why a mutation was rejected
(``code``, ``detail``, and the exact ``envelope`` that was hashed).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from django.contrib import admin
from django.http import HttpRequest

from apps.sync.models import ProcessedMutation

if TYPE_CHECKING:
    _LedgerAdmin = admin.ModelAdmin[ProcessedMutation]
else:
    _LedgerAdmin = admin.ModelAdmin


@admin.register(ProcessedMutation)
class ProcessedMutationAdmin(_LedgerAdmin):
    list_display = (
        "processed_at",
        "status",
        "code",
        "mutation_id",
        "user",
        "client_id",
        "sequence",
    )
    list_filter = ("status", "code")
    search_fields = ("mutation_id", "client_id")
    date_hierarchy = "processed_at"
    fields = (
        "mutation_id",
        "user",
        "client_id",
        "sequence",
        "client_created_at",
        "processed_at",
        "status",
        "code",
        "detail",
        "change_seq",
        "fingerprint",
        "envelope",
    )

    def has_add_permission(self, request: HttpRequest) -> bool:
        return False

    def has_change_permission(
        self, request: HttpRequest, obj: ProcessedMutation | None = None
    ) -> bool:
        return False

    def has_delete_permission(
        self, request: HttpRequest, obj: ProcessedMutation | None = None
    ) -> bool:
        return False
