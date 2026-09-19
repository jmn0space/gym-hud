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
- **Latest explicit edit wins, and a tombstone wins.** A write from the same
  device carrying a lower sequence than the one that last wrote the row is
  skipped (acknowledged as part of an ``applied`` mutation, never rejected);
  across devices the last committed mutation wins -- except that a tombstone
  can only be brought back by the device that deleted it, through a later
  mutation (an undo). A put from any other device onto a tombstone, or under a
  tombstoned parent, is skipped the same way.
- **Repaired, not refused, where the device cannot be wrong.** Clock-step
  timestamp inversions are clamped, a session stuck ``ACTIVE`` is closed to
  make room for a newer one, and a deleted parent takes its live children with
  it. Each is deterministic, lands in the same transaction with the same
  change-counter value (so the changes feed carries it), and is noted in the
  ledger's ``detail``.
- **A server fault is not the device's fault.** An unexpected exception while
  processing one mutation is logged and answered ``retry``/``server_error``
  (never recorded), ending the batch; what committed before it is still
  acknowledged.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime
from typing import cast

from django.db import (
    DatabaseError,
    DataError,
    IntegrityError,
    InterfaceError,
    OperationalError,
    connection,
    transaction,
)
from django.db.models import Max

from apps.sync.envelope import Change, Envelope, envelope_sequence, parse_envelope
from apps.sync.models import (
    MAX_LEDGER_ENVELOPE_CHARS,
    SERVER_CLIENT_ID,
    ProcessedMutation,
    SyncedRecord,
    SyncState,
)
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
    SERVER_ERROR,
    TEMPORARILY_UNAVAILABLE,
    Ack,
    Deferred,
    Rejected,
    canonical_json,
    fingerprint,
    is_canonical_uuid,
    parse_timestamp,
    printable,
)
from apps.sync.registry import (
    ApplyContext,
    StoreSpec,
    WrittenChange,
    child_specs,
    domains,
    store_spec,
)

logger = logging.getLogger(__name__)

_UNIQUE_VIOLATION = "23505"

#: How long a mutation waits for a row lock (the account's ``SyncState`` row,
#: in practice) before giving up with a retryable answer, on PostgreSQL. A
#: mutation takes milliseconds; a wait this long means something is stuck, and
#: a request should not hold a worker for it.
LOCK_TIMEOUT_MS = 5000


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
    echo = printable(raw_id) if isinstance(raw_id, str) else None
    if not is_canonical_uuid(raw_id):
        # Nothing to key a ledger row on; the answer is deterministic anyway.
        return Ack(echo, REJECTED, INVALID_ENVELOPE, "mutation_id must be a lowercase UUID.")
    mutation_id = uuid.UUID(str(raw_id))
    canonical = canonical_json(raw)
    payload_hash = fingerprint(canonical)
    try:
        with transaction.atomic():
            _bound_lock_wait()
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
        # Includes PostgreSQL's lock_timeout (LOCK_TIMEOUT_MS), a deadlock and
        # a serialization failure.
        logger.warning("Mutation %s deferred by a database error", mutation_id, exc_info=True)
        return Ack(
            str(mutation_id),
            RETRY,
            TEMPORARILY_UNAVAILABLE,
            "The server could not complete this mutation right now; retry later.",
        )
    except DatabaseError:
        raise
    except Exception:
        # Not the device's fault as far as anyone can tell: it may be a server
        # bug on perfectly valid data. Recording a rejection would strand the
        # workout on the device, so it is retryable and never recorded; the
        # batch ends here, and what committed before it is still acknowledged.
        logger.exception("Mutation %s failed with an unexpected error", mutation_id)
        return Ack(
            str(mutation_id),
            RETRY,
            SERVER_ERROR,
            "The server failed while processing this mutation; retry later.",
        )


def _bound_lock_wait() -> None:
    """Cap how long this transaction waits for a row lock (PostgreSQL only)."""
    if connection.vendor == "postgresql":
        with connection.cursor() as cursor:
            cursor.execute(f"SET LOCAL lock_timeout = {int(LOCK_TIMEOUT_MS)}")


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
    _warn_if_out_of_order(user_id, client_id, mutation_id, raw)

    record = _Recorder(user_id, client_id, raw, mutation_id, canonical, payload_hash)
    try:
        envelope = parse_envelope(raw)
    except Deferred as deferred:
        # Nothing is lost, but the device's queue is stuck behind this until
        # the server learns the store or version: make that visible.
        logger.warning(
            "Mutation %s from client %s deferred (%s): %s",
            mutation_id,
            client_id,
            deferred.code,
            deferred.detail,
        )
        return Ack(str(mutation_id), RETRY, deferred.code, deferred.detail)
    except Rejected as rejected:
        return record.rejection(rejected)

    change_seq = state.change_seq + 1
    try:
        with transaction.atomic():
            notes = _apply(user_id, client_id, envelope, change_seq)
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
    record.applied(change_seq, _applied_detail(notes))
    return Ack(str(mutation_id), APPLIED)


def _applied_detail(notes: Sequence[str]) -> str:
    """The ledger ``detail`` of an applied mutation: everything done beyond applying it as sent."""
    return "Applied." if not notes else "Applied; " + "; ".join(notes) + "."


def _warn_if_out_of_order(
    user_id: int, client_id: uuid.UUID, mutation_id: uuid.UUID, raw: object
) -> None:
    """Log a new mutation whose sequence is below what this device already sent.

    The server does not enforce contiguous or ascending sequences across
    requests -- that is the client's obligation (one drainer per device,
    ascending order; docs/data-sync.md, "Client obligations") -- but a
    violation defeats the same-device staleness rule, so it should be seen.
    """
    sequence = envelope_sequence(raw)
    if sequence is None:
        return
    highest = ProcessedMutation.objects.filter(user_id=user_id, client_id=client_id).aggregate(
        highest=Max("sequence")
    )["highest"]
    if highest is not None and sequence < highest:
        logger.warning(
            "Mutation %s from client %s has sequence %s, below the %s already processed "
            "for that device: its outbox is being drained out of order",
            mutation_id,
            client_id,
            sequence,
            highest,
        )


def apply_server_action(
    user_id: int,
    action: str,
    payload: Mapping[str, object],
    detail: str,
    apply: Callable[[ApplyContext], None],
) -> ProcessedMutation:
    """Make a change on the server's own authority, through the mutation path.

    Same account lock, same lock-wait bound, one transaction, one new
    change-counter value stamped on every row ``apply`` saves (so the changes
    feed carries it to the devices), and a ledger row -- ``code`` ``action``,
    ``client_id`` :data:`~apps.sync.models.SERVER_CLIENT_ID`, the ``payload``
    (who asked for it, and what) as its envelope. ``apply`` raises
    :class:`~apps.sync.protocol.Rejected` to refuse; nothing is then written.
    """
    SyncState.objects.get_or_create(user_id=user_id)
    canonical = canonical_json(payload)
    with transaction.atomic():
        _bound_lock_wait()
        state = SyncState.objects.select_for_update().get(user_id=user_id)
        change_seq = state.change_seq + 1
        ctx = ApplyContext(
            user_id=user_id, client_id=SERVER_CLIENT_ID, sequence=0, change_seq=change_seq
        )
        apply(ctx)
        state.change_seq = change_seq
        state.save(update_fields=["change_seq"])
        return ProcessedMutation.objects.create(
            mutation_id=uuid.uuid4(),
            user_id=user_id,
            client_id=SERVER_CLIENT_ID,
            sequence=None,
            client_created_at=None,
            fingerprint=fingerprint(canonical),
            status=ProcessedMutation.Status.APPLIED,
            code=action,
            detail=detail if not ctx.notes else f"{detail} " + "; ".join(ctx.notes) + ".",
            change_seq=change_seq,
            envelope=canonical[:MAX_LEDGER_ENVELOPE_CHARS],
            envelope_truncated=len(canonical) > MAX_LEDGER_ENVELOPE_CHARS,
        )


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
            envelope=self.canonical[:MAX_LEDGER_ENVELOPE_CHARS],
            envelope_truncated=len(self.canonical) > MAX_LEDGER_ENVELOPE_CHARS,
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


def _deleted_elsewhere(row: SyncedRecord | None, client_id: uuid.UUID) -> bool:
    """Whether ``row`` is a tombstone that only another device could bring back."""
    return row is not None and row.deleted_at is not None and row.last_client_id != client_id


def _apply(user_id: int, client_id: uuid.UUID, envelope: Envelope, change_seq: int) -> list[str]:
    """Write a parsed mutation and settle the result; returns the ledger notes."""
    ctx = ApplyContext(
        user_id=user_id,
        client_id=client_id,
        sequence=envelope.sequence,
        change_seq=change_seq,
        targets=frozenset((c.spec.store, c.entity_id) for c in envelope.changes),
    )
    written: list[tuple[Change, WrittenChange]] = []
    for change in _canonical_order(envelope.changes):
        spec = change.spec
        row = spec.model._default_manager.filter(pk=change.entity_id).first()
        if row is not None and row.user_id != user_id:
            if change.operation == DELETE:
                continue  # Nothing of this account's to delete; say nothing more.
            raise Rejected(NOT_FOUND, f"{change.label} is not available to this account.")
        if row is not None and _is_stale(row, client_id, envelope.sequence):
            ctx.notes.append(f"skipped {change.label}: superseded by a newer edit from this device")
            continue
        if change.operation == PUT and _deleted_elsewhere(row, client_id):
            ctx.notes.append(f"skipped {change.label}: deleted by another device")
            continue
        if change.operation == PUT and _deleted_elsewhere(_parent_row(user_id, change), client_id):
            ctx.notes.append(f"skipped {change.label}: its parent was deleted by another device")
            continue

        creating = row is None
        if change.operation == DELETE:
            if row is None or row.deleted_at is not None:
                continue  # Already absent: deleting it again changes nothing.
            row.updated_at = cast(datetime, change.values["updated_at"])
            row.deleted_at = cast(datetime, change.values["deleted_at"])
        else:
            _check_parent_reference(user_id, change, row)
            values = dict(change.values)
            if row is not None and spec.check_update is not None:
                try:
                    notes = spec.check_update(row, values)
                except Rejected as exc:
                    raise Rejected(exc.code, f"{change.label}: {exc.detail}") from exc
                ctx.notes.extend(f"{change.label} {note}" for note in notes)
            if row is None:
                row = spec.model(id=change.entity_id, user_id=user_id)
            for field, value in values.items():
                setattr(row, field, value)
            row.deleted_at = None
            ctx.notes.extend(change.notes)
            if change.domain.before_put is not None:
                change.domain.before_put(ctx, spec, row)

        row.last_client_id = client_id
        row.last_sequence = envelope.sequence
        row.change_seq = change_seq
        row.save(force_insert=creating)
        written.append((change, WrittenChange(spec=spec, row=row, operation=change.operation)))
        if change.operation == DELETE:
            _cascade_delete(ctx, spec, row)

    _check_structure(user_id, [item for _, item in written])
    for domain in domains():
        own = [item for change, item in written if change.domain is domain]
        if own:
            domain.check_mutation(ctx, own)
    return ctx.notes


def _parent_row(user_id: int, change: Change) -> SyncedRecord | None:
    """This account's row that a put's record names as its parent, if there is one."""
    parent = change.spec.parent
    if parent is None:
        return None
    parent_id = cast(uuid.UUID, change.values[parent.field])
    model = store_spec(parent.store).model
    return model._default_manager.filter(pk=parent_id, user_id=user_id).first()


def _cascade_delete(ctx: ApplyContext, spec: StoreSpec, row: SyncedRecord) -> None:
    """Tombstone every live descendant of a row this mutation deleted.

    The deleting device listed the children it knew about; another device may
    have added more since. Those go with their parent -- same ``deleted_at``,
    same writer (so only the deleting device can undo it), same change-counter
    value -- rather than leaving live records under a tombstone.
    """
    for child in child_specs(spec.store):
        if child.parent is None:  # pragma: no cover -- child_specs guarantees it
            continue
        live = child.model._default_manager.filter(
            **{child.parent.field: row.pk, "deleted_at__isnull": True}
        ).order_by("pk")
        for orphan in live:
            orphan.updated_at = row.updated_at
            orphan.deleted_at = row.deleted_at
            orphan.last_client_id = ctx.client_id
            orphan.last_sequence = ctx.sequence
            orphan.change_seq = ctx.change_seq
            orphan.save()
            ctx.notes.append(f"deleted {child.store}/{orphan.pk} with {spec.store}/{row.pk}")
            _cascade_delete(ctx, child, orphan)


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
    """A live record of the finished state needs a live parent, in every store.

    A tombstoned parent is as absent as a missing one. (The reverse -- live
    children under a deleted parent -- cannot happen: a delete cascades.)
    """
    for item in written:
        spec, row = item.spec, item.row
        if row.deleted_at is not None or spec.parent is None:
            continue
        parent_spec = store_spec(spec.parent.store)
        parent_id = cast(uuid.UUID, getattr(row, spec.parent.field))
        parent_live = parent_spec.model._default_manager.filter(
            pk=parent_id, user_id=user_id, deleted_at__isnull=True
        ).exists()
        if not parent_live:
            raise Rejected(
                PARENT_NOT_FOUND,
                f"{spec.store}/{row.pk}: parent {spec.parent.store}/{parent_id} is deleted.",
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
