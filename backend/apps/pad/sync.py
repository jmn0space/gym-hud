"""The PAD synchronization domain: stores, cross-record rules, bootstrap data.

Registered with :mod:`apps.sync.registry` by :class:`apps.pad.apps.PadConfig`.
The rules here are the PAD part of the v1 server contract (docs/data-sync.md,
"PAD validation"); the local repository must mirror them so a device never
queues a mutation the server will refuse.

Cross-record rules are settled over the *finished* state of every walking
session a mutation touched -- the whole session tree, after every change of the
mutation is written -- never change by change. That is what lets one mutation
move several related timestamps at once (a manual time correction, say): only
the consistent end result is judged.

Timestamps are clamped, never refused (docs/data-sync.md, "PAD validation"): an
inversion only ever comes from a device clock stepping back, and refusing it
would strand real workout data on the device. Every clamp moves a timestamp to
the nearest boundary its parent allows, deterministically, and is noted in the
ledger.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from typing import cast
from uuid import UUID

from apps.pad.models import (
    PadDefaults,
    WalkingBout,
    WalkingBoutPause,
    WalkingRest,
    WalkingSession,
    WalkingSessionStatus,
)
from apps.pad.records import (
    parse_bout_interval,
    parse_walking_bout,
    parse_walking_session,
    serialize_bout_interval,
    serialize_walking_bout,
    serialize_walking_session,
)
from apps.sync.engine import apply_server_action
from apps.sync.models import SERVER_CLIENT_ID, ProcessedMutation, SyncedRecord
from apps.sync.protocol import INVALID_TRANSITION, Rejected, format_timestamp
from apps.sync.registry import ApplyContext, ParentLink, StoreSpec, SyncDomain, WrittenChange

SESSION_STORE = "walking_sessions"


def _is_active(value: object) -> bool:
    return value == WalkingSessionStatus.ACTIVE


def _is_unended(value: object) -> bool:
    return value is None


def check_session_update(row: SyncedRecord, values: dict[str, object]) -> list[str]:
    """A finished session stays finished.

    ``ACTIVE`` may become ``COMPLETED`` or ``DISCARDED``. A put that still says
    ``ACTIVE`` for a session that is already finished -- another device, or
    the server, closed it meanwhile -- keeps the closure and applies the rest
    of the record (notes, settings): the edit is not lost, and the session is
    not reopened. ``COMPLETED`` and ``DISCARDED`` do not turn into each other,
    except where the server wrote the closure itself (a supersede or an
    administrator's discard): the device's own account of how it ended wins.
    """
    session = cast(WalkingSession, row)
    status = values["status"]
    if session.status == WalkingSessionStatus.ACTIVE or status == session.status:
        return []
    if status == WalkingSessionStatus.ACTIVE:
        started_at = cast(datetime, values["started_at"])
        completed_at = cast(datetime, session.completed_at)
        values["status"] = session.status
        values["completed_at"] = max(completed_at, started_at)
        return [f"kept {session.status} (a finished session is not reopened)"]
    if session.last_client_id != SERVER_CLIENT_ID:
        raise Rejected(
            INVALID_TRANSITION,
            f"status cannot change from {session.status} to {status}; "
            "a finished session stays finished.",
        )
    return []


SESSION_SPEC = StoreSpec(
    store=SESSION_STORE,
    entity_type="walking_session",
    model=WalkingSession,
    depth=0,
    parent=None,
    parse=parse_walking_session,
    serialize=serialize_walking_session,
    open_field="status",
    is_open_value=_is_active,
    interval=("started_at", "completed_at"),
    check_update=check_session_update,
)
BOUT_SPEC = StoreSpec(
    store="walking_bouts",
    entity_type="walking_bout",
    model=WalkingBout,
    depth=1,
    parent=ParentLink(field="walking_session_id", store=SESSION_STORE),
    parse=parse_walking_bout,
    serialize=serialize_walking_bout,
    open_field="ended_at",
    is_open_value=_is_unended,
    interval=("started_at", "ended_at"),
)
PAUSE_SPEC = StoreSpec(
    store="walking_pauses",
    entity_type="walking_pause",
    model=WalkingBoutPause,
    depth=2,
    parent=ParentLink(field="walking_bout_id", store="walking_bouts"),
    parse=parse_bout_interval,
    serialize=serialize_bout_interval,
    open_field="ended_at",
    is_open_value=_is_unended,
    interval=("started_at", "ended_at"),
)
REST_SPEC = StoreSpec(
    store="walking_rests",
    entity_type="walking_rest",
    model=WalkingRest,
    depth=2,
    parent=ParentLink(field="walking_bout_id", store="walking_bouts"),
    parse=parse_bout_interval,
    serialize=serialize_bout_interval,
    open_field="ended_at",
    is_open_value=_is_unended,
    interval=("started_at", "ended_at"),
)


def _touched_session_ids(written: Sequence[WrittenChange]) -> list[UUID]:
    session_ids: set[UUID] = set()
    bout_ids: set[UUID] = set()
    for item in written:
        row = item.row
        if isinstance(row, WalkingSession):
            session_ids.add(row.pk)
        elif isinstance(row, WalkingBout):
            session_ids.add(row.walking_session_id)
        elif isinstance(row, WalkingBoutPause | WalkingRest):
            bout_ids.add(row.walking_bout_id)
    session_ids.update(
        WalkingBout.objects.filter(pk__in=bout_ids).values_list("walking_session_id", flat=True)
    )
    return sorted(session_ids)


class _SessionTree:
    """One live session and its live descendants, loaded once, in a fixed order."""

    def __init__(self, session: WalkingSession) -> None:
        self.session = session
        self.bouts = list(
            WalkingBout.objects.filter(walking_session=session, deleted_at__isnull=True).order_by(
                "started_at", "id"
            )
        )
        self.pauses = list(
            WalkingBoutPause.objects.filter(
                walking_bout__in=self.bouts, deleted_at__isnull=True
            ).order_by("started_at", "id")
        )
        self.rests = list(
            WalkingRest.objects.filter(
                walking_bout__in=self.bouts, deleted_at__isnull=True
            ).order_by("started_at", "id")
        )
        self.bout_by_id = {bout.pk: bout for bout in self.bouts}

    def latest_timestamp(self) -> datetime:
        """The latest moment anything in the session records: its last sign of life."""
        moments = [self.session.started_at]
        intervals: list[WalkingBout | WalkingBoutPause | WalkingRest] = [
            *self.bouts,
            *self.pauses,
            *self.rests,
        ]
        for row in intervals:
            moments.append(row.started_at)
            if row.ended_at is not None:
                moments.append(row.ended_at)
        return max(moments)


class _Clamps:
    """Timestamp adjustments to one session tree, saved and noted together."""

    def __init__(self, ctx: ApplyContext) -> None:
        self.ctx = ctx
        self.changed: dict[tuple[str, UUID], tuple[SyncedRecord, set[str]]] = {}

    def set(self, store: str, row: SyncedRecord, field: str, value: datetime, why: str) -> None:
        old = cast(datetime | None, getattr(row, field))
        if old == value:
            return
        setattr(row, field, value)
        self.changed.setdefault((store, row.pk), (row, set()))[1].add(field)
        was = "open" if old is None else format_timestamp(old)
        self.ctx.notes.append(
            f"{store}/{row.pk} {field} {was} clamped to {format_timestamp(value)} ({why})"
        )

    def interval(
        self,
        store: str,
        row: WalkingBout | WalkingBoutPause | WalkingRest,
        low: datetime,
        high: datetime | None,
        parent: str,
    ) -> None:
        """Keep ``row`` in ``[low, high]``; an open row under a closed parent ends at ``high``."""
        started_at = row.started_at
        if started_at < low:
            self.set(store, row, "started_at", low, f"before its {parent} started")
        elif high is not None and started_at > high:
            self.set(store, row, "started_at", high, f"after its {parent} ended")
        if high is not None and row.ended_at is None:
            self.set(store, row, "ended_at", high, f"still open when its {parent} ended")
        elif high is not None and row.ended_at is not None and row.ended_at > high:
            self.set(store, row, "ended_at", high, f"after its {parent} ended")
        if row.ended_at is not None and row.ended_at < row.started_at:
            # Only after the start itself moved up to ``low``.
            self.set(store, row, "ended_at", row.started_at, f"before its {parent} started")

    def save(self) -> None:
        for row, fields in self.changed.values():
            self.ctx.save_derived(row, sorted(fields))


def settle_session_tree(ctx: ApplyContext, session: WalkingSession) -> None:
    """Clamp one live session's descendants into it, then check what clamping cannot fix.

    Containment (docs/data-sync.md, "PAD validation"), each enforced by moving
    the offending timestamp to the boundary:

    - a bout lies within its session: it starts at or after the session
      started, and once the session is closed (``COMPLETED``/``DISCARDED``) it
      has ended, at or before ``completed_at``;
    - a pause lies within its bout (and has ended once the bout has);
    - a rest starts at or after its bout ended and, once the session is
      closed, has ended by ``completed_at``.

    Parents are settled before their children, so every bound is final when
    it is used and every clamp lands inside the database constraints.

    Still refused, because no clock step produces them: a rest under a bout
    that has not ended, and PAD-06 -- an open bout while one of the session's
    rests is open (``START NEXT BOUT`` closes the rest in the same mutation).
    """
    tree = _SessionTree(session)
    clamps = _Clamps(ctx)
    closed_at = session.completed_at if session.status != WalkingSessionStatus.ACTIVE else None

    for bout in tree.bouts:
        clamps.interval("walking_bouts", bout, session.started_at, closed_at, "session")
    for pause in tree.pauses:
        bout = tree.bout_by_id[pause.walking_bout_id]
        clamps.interval("walking_pauses", pause, bout.started_at, bout.ended_at, "bout")
    for rest in tree.rests:
        bout = tree.bout_by_id[rest.walking_bout_id]
        if bout.ended_at is None:
            raise Rejected(
                INVALID_TRANSITION,
                f"walking_rests/{rest.pk} belongs to walking_bouts/{bout.pk}, which has not ended.",
            )
        clamps.interval("walking_rests", rest, bout.ended_at, closed_at, "session")
    clamps.save()

    open_bout = next((bout for bout in tree.bouts if bout.ended_at is None), None)
    open_rest = next((rest for rest in tree.rests if rest.ended_at is None), None)
    if open_bout is not None and open_rest is not None:
        raise Rejected(
            INVALID_TRANSITION,
            f"walking_bouts/{open_bout.pk} cannot be walking while walking_rests/{open_rest.pk} "
            "is still open (PAD-06); close the rest in the same mutation, as START NEXT BOUT does.",
        )


def check_pad_mutation(ctx: ApplyContext, written: Sequence[WrittenChange]) -> None:
    """Settle the finished state of every walking session the mutation touched."""
    for session_id in _touched_session_ids(written):
        session = WalkingSession.objects.get(pk=session_id)
        if session.deleted_at is None:
            settle_session_tree(ctx, session)


def close_session(ctx: ApplyContext, session: WalkingSession, status: str) -> datetime:
    """Close ``session`` as ``status`` on the server's own authority; returns ``completed_at``.

    Used for a stuck ``ACTIVE`` session: superseded by a newer one, or
    discarded by an administrator. It closes at its latest recorded moment,
    and so does everything still open in it, so the result satisfies every
    containment rule without a clamp. Rows are saved as the server's writes
    (:meth:`~apps.sync.registry.ApplyContext.save_as_server`): if the device
    that owns the session syncs its own finish later, that replaces this.
    """
    tree = _SessionTree(session)
    closed_at = tree.latest_timestamp()
    intervals: list[WalkingBout | WalkingBoutPause | WalkingRest] = [
        *tree.pauses,
        *tree.rests,
        *tree.bouts,
    ]
    for row in intervals:
        if row.ended_at is None:
            row.ended_at = closed_at
            ctx.save_as_server(row, ["ended_at"])
    session.status = status
    session.completed_at = closed_at
    ctx.save_as_server(session, ["status", "completed_at"])
    return closed_at


def supersede_active_sessions(ctx: ApplyContext, spec: StoreSpec, row: SyncedRecord) -> None:
    """Before a session is saved ACTIVE, close any other ACTIVE session of the account.

    One ACTIVE session per account is the rule; a second one arriving means
    the first is stuck -- its device finished it offline and has not synced,
    or never will. Refusing the new session (``active_conflict``) would strand
    it on its device instead, so the older one is closed as ``COMPLETED`` at
    its latest recorded moment, in the same transaction, and noted.

    Sessions the mutation itself names are left alone: two ACTIVE sessions in
    one mutation are that mutation's own contradiction, which the database's
    one-active index answers with ``active_conflict``.
    """
    if spec.store != SESSION_STORE or not _is_active(cast(WalkingSession, row).status):
        return
    others = WalkingSession.objects.filter(
        user_id=ctx.user_id, status=WalkingSessionStatus.ACTIVE, deleted_at__isnull=True
    ).exclude(pk=row.pk)
    for other in others.order_by("started_at", "id"):
        if (SESSION_STORE, other.pk) in ctx.targets:
            continue
        closed_at = close_session(ctx, other, WalkingSessionStatus.COMPLETED)
        ctx.notes.append(
            f"superseded {SESSION_STORE}/{other.pk}: closed as COMPLETED at "
            f"{format_timestamp(closed_at)} to make room for {SESSION_STORE}/{row.pk}"
        )


#: Ledger ``code`` of an administrator's discard (docs/data-sync.md, "Server model
#: and administration").
ADMIN_DISCARD = "admin_discard"


def discard_stuck_session(session_id: UUID, actor: str) -> ProcessedMutation:
    """Close a stuck ``ACTIVE`` session as ``DISCARDED``, on an administrator's word.

    Goes through :func:`~apps.sync.engine.apply_server_action` -- the account
    lock, one transaction, a change-counter bump the changes feed carries to
    the devices, and a ledger row naming ``actor``. Refuses
    (:class:`~apps.sync.protocol.Rejected`) unless the session is still a live
    ``ACTIVE`` one when the lock is held.
    """
    owner = WalkingSession.objects.values_list("user_id", flat=True).get(pk=session_id)

    def discard(ctx: ApplyContext) -> None:
        session = WalkingSession.objects.filter(
            pk=session_id, status=WalkingSessionStatus.ACTIVE, deleted_at__isnull=True
        ).first()
        if session is None:
            raise Rejected(INVALID_TRANSITION, f"{SESSION_STORE}/{session_id} is not ACTIVE.")
        closed_at = close_session(ctx, session, WalkingSessionStatus.DISCARDED)
        ctx.notes.append(
            f"{SESSION_STORE}/{session_id} closed as DISCARDED at {format_timestamp(closed_at)}"
        )

    return apply_server_action(
        owner,
        ADMIN_DISCARD,
        {"action": ADMIN_DISCARD, "walking_session_id": str(session_id), "actor": actor},
        f"Discarded a stuck session in Django Admin (by {actor}):",
        discard,
    )


def next_session_settings(user_id: int, defaults: PadDefaults) -> dict[str, object]:
    """The settings a new session starts from (docs/pad-walking.md, "Settings inheritance").

    The most recently completed live session's settings, else the defaults.
    ``DISCARDED`` sessions are never inherited from.
    """
    previous = (
        WalkingSession.objects.filter(
            user_id=user_id,
            status=WalkingSessionStatus.COMPLETED,
            deleted_at__isnull=True,
        )
        .order_by("-completed_at", "-started_at", "-id")
        .first()
    )
    if previous is None:
        return {"source": "defaults", "walking_session_id": None, **_defaults_payload(defaults)}
    return {
        "source": "previous_session",
        "walking_session_id": str(previous.pk),
        "speed_kmh": previous.speed_kmh,
        "incline_pct": previous.incline_pct,
        "max_bout_seconds": previous.max_bout_seconds,
    }


def _defaults_payload(defaults: PadDefaults) -> dict[str, object]:
    return {
        "speed_kmh": float(defaults.speed_kmh),
        "incline_pct": float(defaults.incline_pct),
        "max_bout_seconds": defaults.max_bout_seconds,
    }


def pad_bootstrap(user_id: int) -> dict[str, object]:
    """PAD's entry in ``GET /api/v1/sync/bootstrap/``."""
    defaults = PadDefaults.current()
    return {
        "defaults": _defaults_payload(defaults),
        "next_session_settings": next_session_settings(user_id, defaults),
    }


PAD_DOMAIN = SyncDomain(
    name="pad",
    stores=(SESSION_SPEC, BOUT_SPEC, PAUSE_SPEC, REST_SPEC),
    check_mutation=check_pad_mutation,
    before_put=supersede_active_sessions,
    bootstrap=pad_bootstrap,
    integrity_details={
        "pad_one_active_session_per_user": "Another walking session is already ACTIVE.",
        "pad_one_open_bout_per_session": "This walking session already has an open bout.",
        "pad_one_open_pause_per_bout": "This bout already has an open pause.",
        "pad_one_rest_per_bout": "This bout already has a rest.",
    },
)
