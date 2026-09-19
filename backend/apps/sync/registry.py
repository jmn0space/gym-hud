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

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass

from django.core.exceptions import ImproperlyConfigured

from apps.sync.models import SyncedRecord


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
    finished mutation does not have. ``check_update`` vets a put against the
    row it replaces (a finished session cannot be reopened, for example).
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
    check_update: Callable[[SyncedRecord, Mapping[str, object]], None] | None = None

    def values_open(self, values: Mapping[str, object]) -> bool:
        """Whether parsed record values describe an open record."""
        return self.is_open_value(values.get(self.open_field))


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
    and before the transaction commits, over the rows that mutation wrote; it
    raises :class:`~apps.sync.protocol.Rejected` to roll the whole mutation
    back. ``integrity_details`` names the domain's database constraints, so a
    violation the database catches is reported in the domain's own words.
    ``bootstrap`` contributes this domain's entry to ``GET /api/v1/sync/bootstrap/``.
    """

    name: str
    stores: tuple[StoreSpec, ...]
    check_mutation: Callable[[Sequence[WrittenChange]], None]
    bootstrap: Callable[[int], dict[str, object]]
    integrity_details: Mapping[str, str]


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
