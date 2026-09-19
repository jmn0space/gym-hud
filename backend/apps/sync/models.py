"""Synchronization bookkeeping shared by every synchronized domain.

Three pieces, all described in docs/data-sync.md ("Server synchronization
protocol"):

- :class:`SyncedRecord`, the abstract base of every server copy of a local
  domain record (PAD's walking sessions, bouts, pauses and rests today);
- :class:`SyncState`, one row per user holding that user's change counter.
  Every mutation locks it first, which serializes a user's mutations and makes
  the counter a gap-free, commit-ordered cursor for the changes feed;
- :class:`ProcessedMutation`, the processed-mutation ledger. ``mutation_id`` is
  unique at the database level, and a row is written in the same transaction as
  the mutation it records, so a mutation is applied at most once however often
  it is delivered.
"""

from __future__ import annotations

from django.conf import settings
from django.db import models


class SyncedRecord(models.Model):
    """Abstract base for the server copy of one local domain record.

    Field names mirror the local record (docs/data-sync.md, "Local action
    contract"): ``id`` is the client-generated UUID, and ``created_at``,
    ``updated_at`` and ``deleted_at`` are the timestamps the *local repository*
    stamped, stored verbatim so the changes feed hands back the record the
    device wrote. A non-null ``deleted_at`` is a tombstone: rows are never
    hard-deleted by synchronization, and a tombstone counts toward none of the
    "one active / one open" rules.

    Everything else is server bookkeeping that never appears on the wire:
    ``last_client_id``/``last_sequence`` identify the mutation that last wrote
    the row (the conflict rule's "stale write from the same device" check),
    ``change_seq`` is the owner's change counter at that write (the changes-feed
    cursor), and ``server_created_at``/``server_updated_at`` are ordinary audit
    timestamps.
    """

    id = models.UUIDField(primary_key=True, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="+",
        editable=False,
    )
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()
    deleted_at = models.DateTimeField(null=True, blank=True)
    last_client_id = models.UUIDField(editable=False)
    last_sequence = models.BigIntegerField(editable=False)
    change_seq = models.BigIntegerField(editable=False)
    server_created_at = models.DateTimeField(auto_now_add=True)
    server_updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True
        indexes = [
            models.Index(fields=["user", "change_seq"], name="%(app_label)s_%(class)s_feed"),
        ]


class SyncState(models.Model):
    """Per-user synchronization state: the change counter and the mutation lock.

    ``change_seq`` is incremented once per applied mutation, inside that
    mutation's transaction, and every row the mutation writes is stamped with
    the new value. Because each mutation starts by locking this row
    (``SELECT ... FOR UPDATE``), one user's mutations commit strictly one after
    another, so a reader that has seen counter value *N* can never later find a
    row stamped below *N* that was not already visible.
    """

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        primary_key=True,
        related_name="+",
    )
    change_seq = models.BigIntegerField(default=0)

    class Meta:
        verbose_name = "synchronization state"

    def __str__(self) -> str:
        return f"Sync state for user {self.pk} at change {self.change_seq}"


class ProcessedMutation(models.Model):
    """One processed outbox mutation: the idempotency ledger.

    Only final outcomes are recorded -- ``applied`` and permanent ``rejected``
    ones -- so a retry of the same mutation always receives the same answer,
    rebuilt from these columns. Retryable outcomes are never recorded, because
    retrying them is the point. ``envelope`` is the canonical JSON text of the
    submitted envelope (sorted keys, no whitespace) and ``fingerprint`` its
    SHA-256: the same ``mutation_id`` with a different payload is a
    ``mutation_id_conflict``, never a second application. The envelope is kept
    as text rather than ``jsonb`` so it is exactly the text that was hashed,
    and so a string holding ``\\u0000`` (which ``jsonb`` refuses) can still be
    recorded as rejected instead of failing the request forever.
    """

    class Status(models.TextChoices):
        APPLIED = "applied", "Applied"
        REJECTED = "rejected", "Rejected"

    mutation_id = models.UUIDField(unique=True, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="+",
    )
    client_id = models.UUIDField()
    sequence = models.BigIntegerField(null=True, blank=True)
    client_created_at = models.DateTimeField(null=True, blank=True)
    fingerprint = models.CharField(max_length=64)
    status = models.CharField(max_length=16, choices=Status)
    code = models.CharField(max_length=64)
    detail = models.TextField()
    change_seq = models.BigIntegerField(null=True, blank=True)
    envelope = models.TextField()
    processed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "processed mutation"
        ordering = ["-processed_at", "-id"]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(status__in=["applied", "rejected"]),
                name="sync_mutation_status_valid",
            ),
        ]
        indexes = [
            models.Index(fields=["user", "processed_at"], name="sync_mutation_user_time"),
        ]

    def __str__(self) -> str:
        return f"{self.mutation_id} ({self.status}: {self.code})"
