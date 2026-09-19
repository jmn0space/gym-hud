"""Pluggable per-store handlers for replaying outbox changes.

The engine (:mod:`apps.sync.engine`) knows nothing about any one domain. A
domain app describes each local store it owns with a :class:`StoreSpec` --
which model holds it, how deep it sits in the parent/child graph, how to read
and write one local record -- and groups them in a :class:`SyncDomain` with the
cross-record rules only it understands. It registers that domain from its own
``AppConfig.ready()``.

A store nobody registered is "unsupported": its mutations are refused as
retryable (``unsupported_store``), so a client that already writes resistance
or cardio records keeps them queued instead of losing them (docs/data-sync.md).
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field

from django.core.exceptions import ImproperlyConfigured

from apps.sync.models import SERVER_CLIENT_ID, SyncedRecord


@dataclass(frozen=True)
class ParentLink:
    """A child store's reference to its parent.

    ``field`` is both the local record's field and the model's foreign-key
    attribute (``walking_session_id``); ``store`` is the parent's store name.
    """

    field: str
    store: str


@dataclass(frozen=True)
class StoreSpec:
    """How one local store maps onto one server model.

    ``parse`` turns a local record into model field values -- everything except
    the identity and metadata the engine handles itself (``id``, ``user``,
    ``created_at``, ``updated_at``, ``deleted_at``) -- raising
    :class:`~apps.sync.protocol.Rejected` for anything unusable. Fields the
    handler does not know are ignored rather than rejected.

    ``open_field``/``is_open_value`` define "open" (an active session, an
    interval without an end): the engine uses it to order a mutation's writes
    so the database's one-open-record indexes never see a violation that the
    finished mutation does not have. ``interval`` names the record's own
    start and end fields: an end before its start is a device clock stepping
    back, which the engine clamps (the end moves up to the start) instead of
    refusing. ``check_update`` vets a put against the row it replaces, and may
    adjust the incoming ``values`` in place; it returns notes on what it
    adjusted, for the ledger.
    """

    store: str
    entity_type: str
    model: type[SyncedRecord]
    depth: int
    parent: ParentLink | None
    parse: Callable[[Mapping[str, object]], dict[str, object]]
    serialize: Callable[[SyncedRecord], dict[str, object]]
    open_field: str
    is_open_value: Callable[[object], bool]
    interval: tuple[str, str] | None = None
    check_update: Callable[[SyncedRecord, dict[str, object]], list[str]] | None = None

    def values_open(self, values: Mapping[str, object]) -> bool:
        """Whether parsed record values describe an open record."""
        return self.is_open_value(values.get(self.open_field))


@dataclass
class ApplyContext:
    """One server change in progress: who makes it, its counter value, what it noted.

    Handed to the domain hooks. ``targets`` are the ``(store, id)`` pairs the
    mutation itself names. ``notes`` collect everything the server did beyond
    applying the changes as sent -- skipped stale writes, clamped timestamps,
    superseded sessions, cascaded deletes -- and end up in the ledger's
    ``detail``. Every row the server changes on its own is saved through
    :meth:`save_derived` or :meth:`save_as_server`, which stamp it with this
    ``change_seq`` so the changes feed carries it to every device.
    """

    user_id: int
    client_id: uuid.UUID
    sequence: int
    change_seq: int
    targets: frozenset[tuple[str, uuid.UUID]] = frozenset()
    notes: list[str] = field(default_factory=list)

    def save_derived(self, row: SyncedRecord, fields: Sequence[str]) -> None:
        """Save a server-side adjustment of ``fields``, keeping the row's last writer."""
        row.change_seq = self.change_seq
        row.save(update_fields=[*fields, "change_seq", "server_updated_at"])

    def save_as_server(self, row: SyncedRecord, fields: Sequence[str]) -> None:
        """Save a change the server made on its own, recording the server as the writer.

        A device's next put to the row is then judged against no sequence of
        its own, so it is never skipped as stale: the device's record of what
        really happened replaces the server's stand-in.
        """
        row.last_client_id = SERVER_CLIENT_ID
        row.last_sequence = 0
        row.change_seq = self.change_seq
        row.save(
            update_fields=[
                *fields,
                "last_client_id",
                "last_sequence",
                "change_seq",
                "server_updated_at",
            ]
        )


@dataclass(frozen=True)
class WrittenChange:
    """One row a mutation actually wrote, handed to the end-of-mutation checks."""

    spec: StoreSpec
    row: SyncedRecord
    operation: str


@dataclass(frozen=True)
class SyncDomain:
    """A group of stores with shared cross-record rules and bootstrap data.

    ``check_mutation`` runs once per mutation, after every change is written
    and before the transaction commits, over the rows that mutation wrote. It
    clamps timestamps the domain's containment rules can repair (saving them
    through the context, with a note) and raises
    :class:`~apps.sync.protocol.Rejected` for anything else, which rolls the
    whole mutation back. ``before_put`` runs just before each put's row is
    saved, for rules that have to make room first (PAD closes a stuck ACTIVE
    session there). ``integrity_details`` names the domain's database
    constraints, so a violation the database catches is reported in the
    domain's own words. ``bootstrap`` contributes this domain's entry to
    ``GET /api/v1/sync/bootstrap/``.
    """

    name: str
    stores: tuple[StoreSpec, ...]
    check_mutation: Callable[[ApplyContext, Sequence[WrittenChange]], None]
    bootstrap: Callable[[int], dict[str, object]]
    integrity_details: Mapping[str, str]
    before_put: Callable[[ApplyContext, StoreSpec, SyncedRecord], None] | None = None


_domains: dict[str, SyncDomain] = {}
_stores: dict[str, tuple[SyncDomain, StoreSpec]] = {}


def register(domain: SyncDomain) -> None:
    """Register ``domain`` and its stores; registering the same object twice is a no-op."""
    if _domains.get(domain.name) is domain:
        return
    if domain.name in _domains:
        raise ImproperlyConfigured(f"Sync domain {domain.name!r} is already registered.")
    for spec in domain.stores:
        if spec.store in _stores:
            raise ImproperlyConfigured(f"Sync store {spec.store!r} is already registered.")
    _domains[domain.name] = domain
    for spec in domain.stores:
        _stores[spec.store] = (domain, spec)


def store_entry(store: str) -> tuple[SyncDomain, StoreSpec] | None:
    """The domain and spec handling ``store``, or ``None`` if nobody does."""
    return _stores.get(store)


def store_spec(store: str) -> StoreSpec:
    """The spec of a registered store; ``KeyError`` for an unregistered one."""
    return _stores[store][1]


def domains() -> tuple[SyncDomain, ...]:
    """Every registered domain, in registration order."""
    return tuple(_domains.values())


def all_specs() -> tuple[StoreSpec, ...]:
    """Every registered store spec, parents before children."""
    return tuple(sorted((spec for _, spec in _stores.values()), key=lambda spec: spec.depth))


def child_specs(store: str) -> tuple[StoreSpec, ...]:
    """The registered stores whose parent is ``store``."""
    return tuple(
        spec
        for _, spec in _stores.values()
        if spec.parent is not None and spec.parent.store == store
    )
