"""Parsing of the push request and of each outbox envelope in it.

Two levels, with different failure modes (docs/data-sync.md, "Server
synchronization protocol"):

- the *request* (``client_id`` plus the ``mutations`` list) is checked by
  :func:`parse_batch`; a malformed request is a client bug, answered with
  ``400 invalid_request`` and nothing processed;
- each *mutation* is checked by :func:`parse_envelope`, which raises
  :class:`~apps.sync.protocol.Rejected` (permanent, recorded) or
  :class:`~apps.sync.protocol.Deferred` (retryable) for that mutation alone.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime

from apps.sync.protocol import (
    DELETE,
    INVALID_ENVELOPE,
    INVALID_RECORD,
    MAX_CHANGES_PER_MUTATION,
    MAX_MUTATIONS_PER_REQUEST,
    MAX_SAFE_INTEGER,
    PROTOCOL_VERSION,
    PUT,
    UNSUPPORTED_STORE,
    UNSUPPORTED_VERSION,
    Deferred,
    Rejected,
    is_canonical_uuid,
    parse_integer,
    parse_timestamp,
    read_timestamp,
)
from apps.sync.registry import StoreSpec, SyncDomain, store_entry


class InvalidRequest(Exception):
    """The push request itself is malformed; nothing in it is processed."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


@dataclass(frozen=True)
class Batch:
    """A well-formed push request. ``mutations`` are still unparsed envelopes."""

    client_id: uuid.UUID
    mutations: Sequence[object]


@dataclass(frozen=True)
class Change:
    """One parsed change of a mutation.

    For a put, ``values`` holds every model field to write (the handler's
    parsed fields plus the record's ``created_at``/``updated_at``); for a
    delete, only the tombstone's ``updated_at`` and ``deleted_at``.
    """

    domain: SyncDomain
    spec: StoreSpec
    entity_id: uuid.UUID
    operation: str
    values: Mapping[str, object]

    @property
    def label(self) -> str:
        """``store/entity_id``, used to name this change in rejection details."""
        return f"{self.spec.store}/{self.entity_id}"


@dataclass(frozen=True)
class Envelope:
    """A parsed outbox envelope, ready to apply."""

    mutation_id: uuid.UUID
    sequence: int
    created_at: datetime
    changes: tuple[Change, ...]


def envelope_sequence(raw: object) -> int | None:
    """The envelope's ``sequence`` if it is a usable one, else ``None``."""
    if not isinstance(raw, Mapping):
        return None
    sequence = parse_integer(raw.get("sequence"))
    return sequence if sequence is not None and 1 <= sequence <= MAX_SAFE_INTEGER else None


def parse_batch(data: object) -> Batch:
    """Validate the request body's outer shape.

    Items are not validated here beyond their order: a broken envelope is that
    mutation's own (recorded) rejection, so one corrupt outbox entry cannot
    wedge every request behind it. The ascending-``sequence`` check only looks
    at items whose sequence is usable.
    """
    if not isinstance(data, Mapping):
        raise InvalidRequest("The request body must be a JSON object.")
    client_id = data.get("client_id")
    if not is_canonical_uuid(client_id):
        raise InvalidRequest("client_id must be a lowercase UUID.")
    mutations = data.get("mutations")
    if not isinstance(mutations, list) or not mutations:
        raise InvalidRequest("mutations must be a non-empty list.")
    if len(mutations) > MAX_MUTATIONS_PER_REQUEST:
        raise InvalidRequest(
            f"A request may carry at most {MAX_MUTATIONS_PER_REQUEST} mutations; "
            "send the rest in a later request."
        )
    previous = 0
    for raw in mutations:
        sequence = envelope_sequence(raw)
        if sequence is None:
            continue
        if sequence <= previous:
            raise InvalidRequest("mutations must be listed in strictly ascending sequence order.")
        previous = sequence
    return Batch(client_id=uuid.UUID(str(client_id)), mutations=mutations)


def _envelope_error(detail: str) -> Rejected:
    return Rejected(INVALID_ENVELOPE, detail)


def parse_envelope(raw: object) -> Envelope:
    """Parse and validate one outbox envelope.

    Checked in this order, so the outcome for a given envelope is always the
    same: the envelope's own fields; then whether every change's ``store`` is
    one this server handles (retryable ``unsupported_store`` if not -- checked
    before the records, because a future server may accept the whole thing);
    then every change and its record. A newer envelope ``version`` is
    retryable for the same reason.
    """
    if not isinstance(raw, Mapping):
        raise _envelope_error("A mutation must be a JSON object.")
    mutation_id = raw.get("mutation_id")
    if not is_canonical_uuid(mutation_id):
        raise _envelope_error("mutation_id must be a lowercase UUID.")
    version = parse_integer(raw.get("version"))
    if version is None or version < 1:
        raise _envelope_error("version must be a positive integer.")
    if version != PROTOCOL_VERSION:
        raise Deferred(
            UNSUPPORTED_VERSION,
            f"This server applies envelope version {PROTOCOL_VERSION}, not {version}.",
        )
    sequence = envelope_sequence(raw)
    if sequence is None:
        raise _envelope_error(f"sequence must be an integer from 1 to {MAX_SAFE_INTEGER}.")
    created_at = parse_timestamp(raw.get("created_at"))
    if created_at is None:
        raise _envelope_error("created_at must be an ISO 8601 timestamp with a time zone.")
    changes = raw.get("changes")
    if not isinstance(changes, list) or not changes:
        raise _envelope_error("changes must be a non-empty list.")
    if len(changes) > MAX_CHANGES_PER_MUTATION:
        raise _envelope_error(f"A mutation may hold at most {MAX_CHANGES_PER_MUTATION} changes.")

    unsupported: set[str] = set()
    for index, change in enumerate(changes):
        if not isinstance(change, Mapping):
            raise _envelope_error(f"changes[{index}] must be a JSON object.")
        store = change.get("store")
        if not isinstance(store, str) or not store:
            raise _envelope_error(f"changes[{index}].store must be a non-empty string.")
        if store_entry(store) is None:
            unsupported.add(store)
    if unsupported:
        raise Deferred(
            UNSUPPORTED_STORE,
            "This server does not synchronize "
            + ", ".join(sorted(unsupported))
            + " yet; keep the mutation queued.",
        )

    parsed: list[Change] = []
    targets: set[tuple[str, uuid.UUID]] = set()
    for index, change in enumerate(changes):
        item = _parse_change(index, change)
        target = (item.spec.store, item.entity_id)
        if target in targets:
            raise _envelope_error(f"{item.label} is changed more than once in one mutation.")
        targets.add(target)
        parsed.append(item)

    return Envelope(
        mutation_id=uuid.UUID(str(mutation_id)),
        sequence=sequence,
        created_at=created_at,
        changes=tuple(parsed),
    )


def _parse_change(index: int, change: Mapping[str, object]) -> Change:
    """Parse ``changes[index]``; its store is already known to be registered."""
    entry = store_entry(str(change.get("store")))
    if entry is None:  # pragma: no cover -- parse_envelope checked every store first
        raise _envelope_error(f"changes[{index}].store is not supported.")
    domain, spec = entry
    where = f"changes[{index}]"
    if change.get("entity_type") != spec.entity_type:
        raise _envelope_error(f"{where}.entity_type must be {spec.entity_type!r} for {spec.store}.")
    entity_id = change.get("entity_id")
    if not is_canonical_uuid(entity_id):
        raise _envelope_error(f"{where}.entity_id must be a lowercase UUID.")
    operation = change.get("operation")
    if operation not in (PUT, DELETE):
        raise _envelope_error(f"{where}.operation must be 'put' or 'delete'.")
    record = change.get("record")
    if not isinstance(record, Mapping):
        raise _envelope_error(f"{where}.record must be a JSON object.")
    if record.get("id") != entity_id:
        raise _envelope_error(f"{where}.record.id must equal entity_id.")
    if operation == DELETE and change.get("id") != entity_id:
        raise _envelope_error(f"{where}.id must equal entity_id.")

    label = f"{spec.store}/{entity_id}"
    try:
        values = _record_values(spec, str(operation), record)
    except Rejected as exc:
        raise Rejected(exc.code, f"{label}: {exc.detail}") from exc
    return Change(
        domain=domain,
        spec=spec,
        entity_id=uuid.UUID(str(entity_id)),
        operation=str(operation),
        values=values,
    )


def _record_values(
    spec: StoreSpec, operation: str, record: Mapping[str, object]
) -> dict[str, object]:
    """The values a change writes: a delete's tombstone stamps, or a put's whole record."""
    if operation == DELETE:
        deleted_at = parse_timestamp(record.get("deleted_at"))
        if deleted_at is None:
            raise Rejected(INVALID_RECORD, "a delete's tombstone must carry deleted_at.")
        return {"updated_at": read_timestamp(record, "updated_at"), "deleted_at": deleted_at}
    if record.get("deleted_at") is not None:
        raise Rejected(INVALID_RECORD, "deleted_at must be null on a put.")
    values = spec.parse(record)
    values["created_at"] = read_timestamp(record, "created_at")
    values["updated_at"] = read_timestamp(record, "updated_at")
    return values
