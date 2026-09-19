"""Transactional, idempotent replay of outbox mutations.

The rules implemented here are the v1 server contract in docs/data-sync.md
("Server synchronization protocol"). In short:

- **One transaction per mutation.** A mutation's changes and its ledger row
  commit together or not at all. Every mutation first locks the user's
  :class:`~apps.sync.models.SyncState` row, which serializes one user's
  mutations: a concurrent delivery of the same mutation waits, then finds the
  ledger row and is answered ``duplicate``. The ledger's unique
  ``mutation_id`` index is the last line of defense (it is what resolves a
  race between two *accounts* using one id).
- **Final outcomes are recorded.** ``applied`` and permanent ``rejected``
  outcomes are written to the ledger with the payload fingerprint, so every
  retry gets the same answer; retryable outcomes are not, and they end the batch.
- **Validated as a whole.** Every change is parsed before anything is written;
  changes are then written in dependency order and the finished state of
  everything the mutation touched is validated before commit. Any failure
  rolls the whole mutation back.
- **Latest explicit edit wins.** A write from the same device carrying a lower
  sequence than the one that last wrote the row is skipped (acknowledged as
  part of an ``applied`` mutation, never rejected); across devices the last
  committed mutation wins. A tombstone therefore only comes back to life
  through a newer put -- an explicit undo -- never through a stale replay.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import cast

from django.db import DataError, IntegrityError, InterfaceError, OperationalError, transaction

from apps.sync.envelope import Change, Envelope, envelope_sequence, parse_envelope
from apps.sync.models import ProcessedMutation, SyncedRecord, SyncState
from apps.sync.protocol import (
    ACTIVE_CONFLICT,
    APPLIED,
    DELETE,
    DUPLICATE,
    INVALID_ENVELOPE,
    INVALID_RECORD,
    INVALID_TRANSITION,
    MUTATION_ID_CONFLICT,
    NOT_FOUND,
    PARENT_NOT_FOUND,
    PUT,
    REJECTED,
    RETRY,
    TEMPORARILY_UNAVAILABLE,
    Ack,
    Deferred,
    Rejected,
    canonical_json,
    fingerprint,
    is_canonical_uuid,
    parse_timestamp,
)
from apps.sync.registry import WrittenChange, child_specs, domains, store_spec

logger = logging.getLogger(__name__)

_UNIQUE_VIOLATION = "23505"


def process_batch(user_id: int, client_id: uuid.UUID, mutations: Sequence[object]) -> list[Ack]:
    """Process a request's mutations in order and return their acknowledgements.

    Stops at the first ``retry`` outcome: the mutations after it are neither
    processed nor listed, so nothing is applied ahead of a mutation the client
    will send again. A permanent rejection does not stop the batch; a later
    mutation that depended on it fails its own validation (a missing parent,
    say) and is rejected in turn.
    """
    SyncState.objects.get_or_create(user_id=user_id)
    results: list[Ack] = []
    for raw in mutations:
        ack = process_mutation(user_id, client_id, raw)
        results.append(ack)
        if ack.status == RETRY:
            break
    return results


def process_mutation(user_id: int, client_id: uuid.UUID, raw: object) -> Ack:
    """Apply one outbox envelope exactly once, or explain why not."""
    raw_id = raw.get("mutation_id") if isinstance(raw, Mapping) else None
    echo = raw_id if isinstance(raw_id, str) else None
    if not is_canonical_uuid(raw_id):
        # Nothing to key a ledger row on; the answer is deterministic anyway.
        return Ack(echo, REJECTED, INVALID_ENVELOPE, "mutation_id must be a lowercase UUID.")
    mutation_id = uuid.UUID(str(raw_id))
    canonical = canonical_json(raw)
    payload_hash = fingerprint(canonical)
    try:
        with transaction.atomic():
            return _process_locked(user_id, client_id, raw, mutation_id, canonical, payload_hash)
    except IntegrityError:
        # The ledger insert lost a race to another transaction that committed
        # this mutation_id first. Same-user duplicates never get here -- they
        # queue on the SyncState lock and find the ledger row -- so this is
        # another account reusing the id, answered as a conflict.
        prior = ProcessedMutation.objects.filter(mutation_id=mutation_id).first()
        if prior is None:
            raise
        return _replay(prior, user_id, payload_hash)
    except (OperationalError, InterfaceError):
        logger.warning("Mutation %s deferred by a database error", mutation_id, exc_info=True)
        return Ack(
            str(mutation_id),
            RETRY,
            TEMPORARILY_UNAVAILABLE,
            "The server could not complete this mutation right now; retry later.",
        )


def _process_locked(
    user_id: int,
    client_id: uuid.UUID,
    raw: object,
    mutation_id: uuid.UUID,
    canonical: str,
    payload_hash: str,
) -> Ack:
    state = SyncState.objects.select_for_update().get(user_id=user_id)
    prior = ProcessedMutation.objects.filter(mutation_id=mutation_id).first()
    if prior is not None:
        return _replay(prior, user_id, payload_hash)

    record = _Recorder(user_id, client_id, raw, mutation_id, canonical, payload_hash)
    try:
        envelope = parse_envelope(raw)
    except Deferred as deferred:
        return Ack(str(mutation_id), RETRY, deferred.code, deferred.detail)
    except Rejected as rejected:
        return record.rejection(rejected)

    change_seq = state.change_seq + 1
    try:
        with transaction.atomic():
            skipped = _apply(user_id, client_id, envelope, change_seq)
    except Rejected as rejected:
        return record.rejection(rejected)
    except IntegrityError as error:
        return record.rejection(_integrity_rejection(error))
    except DataError:
        return record.rejection(
            Rejected(INVALID_RECORD, "A value in this mutation cannot be stored.")
        )

    state.change_seq = change_seq
    state.save(update_fields=["change_seq"])
    detail = "Applied."
    if skipped:
        detail = (
            "Applied; skipped as superseded by a newer edit from this device: "
            + ", ".join(skipped)
            + "."
        )
    record.applied(change_seq, detail)
    return Ack(str(mutation_id), APPLIED)


def _replay(prior: ProcessedMutation, user_id: int, payload_hash: str) -> Ack:
    """The answer for a mutation_id the ledger already holds."""
    mutation_id = str(prior.mutation_id)
    if prior.user_id != user_id or prior.fingerprint != payload_hash:
        # Deliberately one answer for both cases: another account's use of the
        # id is not distinguishable from this account reusing it.
        return Ack(
            mutation_id,
            REJECTED,
            MUTATION_ID_CONFLICT,
            "This mutation_id was already used with a different payload.",
        )
    if prior.status == ProcessedMutation.Status.APPLIED:
        return Ack(mutation_id, DUPLICATE)
    return Ack(mutation_id, REJECTED, prior.code, prior.detail)


class _Recorder:
    """Writes a mutation's final outcome to the ledger, inside its transaction."""

    def __init__(
        self,
        user_id: int,
        client_id: uuid.UUID,
        raw: object,
        mutation_id: uuid.UUID,
        canonical: str,
        payload_hash: str,
    ) -> None:
        self.user_id = user_id
        self.client_id = client_id
        self.raw = raw
        self.mutation_id = mutation_id
        self.canonical = canonical
        self.payload_hash = payload_hash

    def _create(self, status: str, code: str, detail: str, change_seq: int | None) -> None:
        created_at = self.raw.get("created_at") if isinstance(self.raw, Mapping) else None
        ProcessedMutation.objects.create(
            mutation_id=self.mutation_id,
            user_id=self.user_id,
            client_id=self.client_id,
            sequence=envelope_sequence(self.raw),
            client_created_at=parse_timestamp(created_at),
            fingerprint=self.payload_hash,
            status=status,
            code=code,
            detail=detail,
            change_seq=change_seq,
            envelope=self.canonical,
        )

    def applied(self, change_seq: int, detail: str) -> None:
        self._create(ProcessedMutation.Status.APPLIED, APPLIED, detail, change_seq)

    def rejection(self, rejected: Rejected) -> Ack:
        self._create(ProcessedMutation.Status.REJECTED, rejected.code, rejected.detail, None)
        return Ack(str(self.mutation_id), REJECTED, rejected.code, rejected.detail)


def _canonical_order(changes: Sequence[Change]) -> list[Change]:
    """Deletes deepest-first, then puts parent-first, closing before opening.

    Every change targets a different record, so the order cannot change the
    finished state -- it only has to keep each intermediate state inside the
    database's constraints. Deletes only ever free a "one open record" slot and
    closing puts never take one, so doing both before any opening put means
    the partial unique indexes never see more open records than the finished
    mutation has. Parents are written before children so a child's parent
    exists by the time it is checked. The envelope's own order (the local
    contract's) is therefore not relied on.
    """
    deletes = sorted((c for c in changes if c.operation == DELETE), key=lambda c: -c.spec.depth)
    puts = sorted(
        (c for c in changes if c.operation == PUT),
        key=lambda c: (c.spec.depth, c.spec.values_open(c.values)),
    )
    return [*deletes, *puts]


def _is_stale(row: SyncedRecord, client_id: uuid.UUID, sequence: int) -> bool:
    """Whether this device already wrote the row from a later outbox entry."""
    return row.last_client_id == client_id and row.last_sequence > sequence


def _apply(user_id: int, client_id: uuid.UUID, envelope: Envelope, change_seq: int) -> list[str]:
    """Write a parsed mutation and validate the result; returns stale-skipped labels."""
    written: list[tuple[Change, WrittenChange]] = []
    skipped: list[str] = []
    for change in _canonical_order(envelope.changes):
        spec = change.spec
        row = spec.model._default_manager.filter(pk=change.entity_id).first()
        if row is not None and row.user_id != user_id:
            if change.operation == DELETE:
                continue  # Nothing of this account's to delete; say nothing more.
            raise Rejected(NOT_FOUND, f"{change.label} is not available to this account.")
        if row is not None and _is_stale(row, client_id, envelope.sequence):
            skipped.append(change.label)
            continue

        creating = row is None
        if change.operation == DELETE:
            if row is None or row.deleted_at is not None:
                continue  # Already absent: deleting it again changes nothing.
            row.updated_at = cast(datetime, change.values["updated_at"])
            row.deleted_at = cast(datetime, change.values["deleted_at"])
        else:
            _check_parent_reference(user_id, change, row)
            if row is not None and spec.check_update is not None:
                try:
                    spec.check_update(row, change.values)
                except Rejected as exc:
                    raise Rejected(exc.code, f"{change.label}: {exc.detail}") from exc
            if row is None:
                row = spec.model(id=change.entity_id, user_id=user_id)
            for field, value in change.values.items():
                setattr(row, field, value)
            row.deleted_at = None

        row.last_client_id = client_id
        row.last_sequence = envelope.sequence
        row.change_seq = change_seq
        row.save(force_insert=creating)
        written.append((change, WrittenChange(spec=spec, row=row, operation=change.operation)))

    _check_structure(user_id, [item for _, item in written])
    for domain in domains():
        own = [item for change, item in written if change.domain is domain]
        if own:
            domain.check_mutation(own)
    return skipped


def _check_parent_reference(user_id: int, change: Change, row: SyncedRecord | None) -> None:
    """A put's parent must be this account's, and must not change once set."""
    parent = change.spec.parent
    if parent is None:
        return
    parent_id = cast(uuid.UUID, change.values[parent.field])
    if row is not None and getattr(row, parent.field) != parent_id:
        raise Rejected(
            INVALID_TRANSITION,
            f"{change.label}: {parent.field} cannot change once the record exists.",
        )
    parent_model = store_spec(parent.store).model
    if not parent_model._default_manager.filter(pk=parent_id, user_id=user_id).exists():
        raise Rejected(
            PARENT_NOT_FOUND,
            f"{change.label}: parent {parent.store}/{parent_id} is not available.",
        )


def _check_structure(user_id: int, written: Sequence[WrittenChange]) -> None:
    """Parent/child liveness of the finished state, for every store.

    A live record needs a live parent (a tombstoned parent is as absent as a
    missing one), and a record may only be deleted together with its live
    children -- the local contract orders those child deletes first.
    """
    for item in written:
        spec, row = item.spec, item.row
        label = f"{spec.store}/{row.pk}"
        if row.deleted_at is None and spec.parent is not None:
            parent_spec = store_spec(spec.parent.store)
            parent_id = cast(uuid.UUID, getattr(row, spec.parent.field))
            parent_live = parent_spec.model._default_manager.filter(
                pk=parent_id, user_id=user_id, deleted_at__isnull=True
            ).exists()
            if not parent_live:
                raise Rejected(
                    PARENT_NOT_FOUND,
                    f"{label}: parent {spec.parent.store}/{parent_id} is deleted.",
                )
        if row.deleted_at is not None:
            for child in child_specs(spec.store):
                if child.parent is None:  # pragma: no cover -- child_specs guarantees it
                    continue
                live_children = child.model._default_manager.filter(
                    **{child.parent.field: row.pk, "deleted_at__isnull": True}
                )
                if live_children.exists():
                    raise Rejected(
                        INVALID_TRANSITION,
                        f"{label} cannot be deleted while it has live {child.store}; "
                        "delete them in the same mutation.",
                    )


def _integrity_rejection(error: IntegrityError) -> Rejected:
    """Name a constraint violation the database caught, in the domain's words.

    Every check constraint is mirrored by the handlers' own validation, so in
    practice this is one of the "only one open/active record" indexes.
    """
    cause = error.__cause__
    constraint = getattr(getattr(cause, "diag", None), "constraint_name", None)
    unique = getattr(cause, "sqlstate", None) == _UNIQUE_VIOLATION or (
        "UNIQUE constraint failed" in str(error)
    )
    detail = None
    for domain in domains():
        if isinstance(constraint, str) and constraint in domain.integrity_details:
            detail = domain.integrity_details[constraint]
    if unique and isinstance(constraint, str) and constraint.endswith("_pkey"):
        return Rejected(NOT_FOUND, "A record in this mutation is not available to this account.")
    if unique:
        return Rejected(
            ACTIVE_CONFLICT, detail or "Another active or open record already holds this place."
        )
    return Rejected(INVALID_RECORD, detail or "A record violates a database constraint.")
