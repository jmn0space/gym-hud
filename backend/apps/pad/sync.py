"""The PAD synchronization domain: stores, cross-record rules, bootstrap data.

Registered with :mod:`apps.sync.registry` by :class:`apps.pad.apps.PadConfig`.
The rules here are the PAD part of the v1 server contract (docs/data-sync.md,
"PAD validation"); the local repository must mirror them so a device never
queues a mutation the server will refuse.

Cross-record rules are validated over the *finished* state of every walking
session a mutation touched -- the whole session tree, after every change of the
mutation is written -- never change by change. That is what lets one mutation
move several related timestamps at once (a manual time correction, say): only
the consistent end result is judged.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
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
from apps.sync.models import SyncedRecord
from apps.sync.protocol import INVALID_TIMING, INVALID_TRANSITION, Rejected
from apps.sync.registry import ParentLink, StoreSpec, SyncDomain, WrittenChange


def _is_active(value: object) -> bool:
    return value == WalkingSessionStatus.ACTIVE


def _is_unended(value: object) -> bool:
    return value is None


def check_session_update(row: SyncedRecord, values: Mapping[str, object]) -> None:
    """A finished session stays finished.

    ``ACTIVE`` may become ``COMPLETED`` or ``DISCARDED``; ``COMPLETED`` and
    ``DISCARDED`` are final (their other fields stay editable). The spec's undo
    list does not include finishing a session, so there is no reopen path.
    """
    session = cast(WalkingSession, row)
    status = values["status"]
    if session.status != WalkingSessionStatus.ACTIVE and status != session.status:
        raise Rejected(
            INVALID_TRANSITION,
            f"status cannot change from {session.status} to {status}; "
            "a finished session stays finished.",
        )


SESSION_SPEC = StoreSpec(
    store="walking_sessions",
    entity_type="walking_session",
    model=WalkingSession,
    depth=0,
    parent=None,
    parse=parse_walking_session,
    serialize=serialize_walking_session,
    open_field="status",
    is_open_value=_is_active,
    check_update=check_session_update,
)
BOUT_SPEC = StoreSpec(
    store="walking_bouts",
    entity_type="walking_bout",
    model=WalkingBout,
    depth=1,
    parent=ParentLink(field="walking_session_id", store="walking_sessions"),
    parse=parse_walking_bout,
    serialize=serialize_walking_bout,
    open_field="ended_at",
    is_open_value=_is_unended,
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


def _timing(label: str, detail: str) -> Rejected:
    return Rejected(INVALID_TIMING, f"{label} {detail}")


def validate_session_tree(session: WalkingSession) -> None:
    """Check one live session and its live descendants, as they stand now.

    Timestamp containment (docs/data-sync.md, "PAD validation"):

    - a bout starts at or after its session started;
    - a pause starts at or after its bout started, and once the bout has
      ended, the pause has ended too, at or before the bout's end;
    - a rest belongs to an ended bout and starts at or after that end;
    - once the session is closed (``COMPLETED``/``DISCARDED``), every bout and
      rest has ended, at or before ``completed_at`` (pauses follow from their bout).

    Rest integrity (PAD-06): a session never has an open bout while one of its
    rests is open -- ``START NEXT BOUT`` closes the rest in the same mutation.

    Tombstoned rows are logically absent and are not checked.
    """
    bouts = list(
        WalkingBout.objects.filter(walking_session=session, deleted_at__isnull=True).order_by(
            "started_at", "id"
        )
    )
    by_id = {bout.pk: bout for bout in bouts}
    pauses = list(
        WalkingBoutPause.objects.filter(walking_bout__in=bouts, deleted_at__isnull=True).order_by(
            "started_at", "id"
        )
    )
    rests = list(
        WalkingRest.objects.filter(walking_bout__in=bouts, deleted_at__isnull=True).order_by(
            "started_at", "id"
        )
    )
    closed_at = session.completed_at if session.status != WalkingSessionStatus.ACTIVE else None

    for bout in bouts:
        label = f"walking_bouts/{bout.pk}"
        if bout.started_at < session.started_at:
            raise _timing(label, "starts before its session started.")
        if closed_at is not None:
            if bout.ended_at is None:
                raise _timing(label, f"is still open, but its session is {session.status}.")
            if bout.ended_at > closed_at:
                raise _timing(label, "ends after its session's completed_at.")

    for pause in pauses:
        label = f"walking_pauses/{pause.pk}"
        bout = by_id[pause.walking_bout_id]
        if pause.started_at < bout.started_at:
            raise _timing(label, "starts before its bout started.")
        if bout.ended_at is not None:
            if pause.ended_at is None:
                raise _timing(label, "is still open, but its bout has ended.")
            if pause.ended_at > bout.ended_at:
                raise _timing(label, "ends after its bout ended.")

    for rest in rests:
        label = f"walking_rests/{rest.pk}"
        bout = by_id[rest.walking_bout_id]
        if bout.ended_at is None:
            raise _timing(label, "belongs to a bout that has not ended.")
        if rest.started_at < bout.ended_at:
            raise _timing(label, "starts before its bout ended.")
        if closed_at is not None:
            if rest.ended_at is None:
                raise _timing(label, f"is still open, but its session is {session.status}.")
            if rest.ended_at > closed_at:
                raise _timing(label, "ends after its session's completed_at.")

    open_bout = next((bout for bout in bouts if bout.ended_at is None), None)
    open_rest = next((rest for rest in rests if rest.ended_at is None), None)
    if open_bout is not None and open_rest is not None:
        raise Rejected(
            INVALID_TRANSITION,
            f"walking_bouts/{open_bout.pk} cannot be walking while walking_rests/{open_rest.pk} "
            "is still open (PAD-06); close the rest in the same mutation, as START NEXT BOUT does.",
        )


def check_pad_mutation(written: Sequence[WrittenChange]) -> None:
    """Validate the finished state of every walking session the mutation touched."""
    for session_id in _touched_session_ids(written):
        session = WalkingSession.objects.get(pk=session_id)
        if session.deleted_at is None:
            validate_session_tree(session)


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
    bootstrap=pad_bootstrap,
    integrity_details={
        "pad_one_active_session_per_user": "Another walking session is already ACTIVE.",
        "pad_one_open_bout_per_session": "This walking session already has an open bout.",
        "pad_one_open_pause_per_bout": "This bout already has an open pause.",
        "pad_one_rest_per_bout": "This bout already has a rest.",
    },
)
