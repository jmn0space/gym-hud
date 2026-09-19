"""Reading and writing PAD records in the local record shape.

The server-side counterpart of ``frontend/src/pad/records.ts``. The two
directions differ on purpose:

- **Reading** (outbox record -> model values) is *strict* about everything that
  decides identity and state -- UUIDs, parents, timestamps, status, pain, stop
  reason, the treadmill settings -- because a value stored here is what every
  other device reconstructs from. It is *tolerant* of anything else: fields it
  does not know are ignored, and optional fields may be absent or ``null``.
  Every value the current frontend can produce is accepted (see the numeric
  notes on :class:`~apps.pad.models.WalkingSession`).
- **Writing** (model -> record) produces exactly the fields the local record
  has, timestamps in ``Date.toISOString()`` form, so a device can store what
  the changes feed returns as-is.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import cast

from apps.pad.models import (
    MAX_BOUT_NUMBER,
    WalkingBout,
    WalkingBoutPause,
    WalkingRest,
    WalkingSession,
    WalkingSessionStatus,
    WalkingStopReason,
)
from apps.sync.models import SyncedRecord
from apps.sync.protocol import (
    INVALID_RECORD,
    INVALID_TIMING,
    Rejected,
    format_timestamp,
    read_choice,
    read_integer,
    read_number,
    read_optional_choice,
    read_optional_integer,
    read_optional_text,
    read_optional_timestamp,
    read_timestamp,
    read_uuid,
)

SESSION_STATUSES: list[str] = list(WalkingSessionStatus.values)
STOP_REASONS: list[str] = list(WalkingStopReason.values)


def parse_walking_session(record: Mapping[str, object]) -> dict[str, object]:
    """Model values for a ``walking_sessions`` record."""
    status = read_choice(record, "status", SESSION_STATUSES)
    started_at = read_timestamp(record, "started_at")
    completed_at = read_optional_timestamp(record, "completed_at")
    if status == WalkingSessionStatus.ACTIVE and completed_at is not None:
        raise Rejected(INVALID_RECORD, "completed_at must be null while the session is ACTIVE.")
    if status != WalkingSessionStatus.ACTIVE and completed_at is None:
        raise Rejected(INVALID_RECORD, f"completed_at is required for a {status} session.")
    if completed_at is not None and completed_at < started_at:
        raise Rejected(INVALID_TIMING, "completed_at must not be before started_at.")
    return {
        "status": status,
        "started_at": started_at,
        "completed_at": completed_at,
        "speed_kmh": read_number(record, "speed_kmh", minimum=0, exclusive=True),
        "incline_pct": read_number(record, "incline_pct", minimum=0, exclusive=False),
        "max_bout_seconds": read_integer(record, "max_bout_seconds", minimum=1),
        "session_notes": read_optional_text(record, "session_notes"),
    }


def _interval(record: Mapping[str, object]) -> tuple[datetime, datetime | None]:
    """``started_at`` and ``ended_at``; an absent ``ended_at`` means open, as locally."""
    started_at = read_timestamp(record, "started_at")
    ended_at = read_optional_timestamp(record, "ended_at")
    if ended_at is not None and ended_at < started_at:
        raise Rejected(INVALID_TIMING, "ended_at must not be before started_at.")
    return started_at, ended_at


def parse_walking_bout(record: Mapping[str, object]) -> dict[str, object]:
    """Model values for a ``walking_bouts`` record.

    Pain is one value (``pain_min == pain_max``) or two adjacent ones
    (``pain_max == pain_min + 1``), both from 1 to 5, or both null
    (docs/pad-walking.md, "Pain input").
    """
    started_at, ended_at = _interval(record)
    pain_min = read_optional_integer(record, "pain_min", minimum=1, maximum=5)
    pain_max = read_optional_integer(record, "pain_max", minimum=1, maximum=5)
    if (pain_min is None) != (pain_max is None):
        raise Rejected(INVALID_RECORD, "pain_min and pain_max must both be set or both be null.")
    if pain_min is not None and pain_max is not None and not pain_min <= pain_max <= pain_min + 1:
        raise Rejected(
            INVALID_RECORD, "pain must be one value or two adjacent values (for example 2 or 2-3)."
        )
    return {
        "walking_session_id": read_uuid(record, "walking_session_id"),
        "bout_number": read_integer(record, "bout_number", minimum=1, maximum=MAX_BOUT_NUMBER),
        "started_at": started_at,
        "ended_at": ended_at,
        "pain_min": pain_min,
        "pain_max": pain_max,
        "stop_reason": read_optional_choice(record, "stop_reason", STOP_REASONS),
        "notes": read_optional_text(record, "notes"),
    }


def parse_bout_interval(record: Mapping[str, object]) -> dict[str, object]:
    """Model values for a ``walking_pauses`` or ``walking_rests`` record."""
    started_at, ended_at = _interval(record)
    return {
        "walking_bout_id": read_uuid(record, "walking_bout_id"),
        "started_at": started_at,
        "ended_at": ended_at,
    }


def _timestamp(value: datetime | None) -> str | None:
    return None if value is None else format_timestamp(value)


def _metadata(row: SyncedRecord) -> dict[str, object]:
    return {
        "created_at": format_timestamp(row.created_at),
        "updated_at": format_timestamp(row.updated_at),
        "deleted_at": _timestamp(row.deleted_at),
    }


def serialize_walking_session(row: SyncedRecord) -> dict[str, object]:
    """A ``walking_sessions`` record, tombstone included."""
    session = cast(WalkingSession, row)
    return {
        "id": str(session.pk),
        "status": session.status,
        "started_at": format_timestamp(session.started_at),
        "completed_at": _timestamp(session.completed_at),
        "speed_kmh": session.speed_kmh,
        "incline_pct": session.incline_pct,
        "max_bout_seconds": session.max_bout_seconds,
        "session_notes": session.session_notes,
        **_metadata(session),
    }


def serialize_walking_bout(row: SyncedRecord) -> dict[str, object]:
    """A ``walking_bouts`` record, tombstone included."""
    bout = cast(WalkingBout, row)
    return {
        "id": str(bout.pk),
        "walking_session_id": str(bout.walking_session_id),
        "bout_number": bout.bout_number,
        "started_at": format_timestamp(bout.started_at),
        "ended_at": _timestamp(bout.ended_at),
        "pain_min": bout.pain_min,
        "pain_max": bout.pain_max,
        "stop_reason": bout.stop_reason,
        "notes": bout.notes,
        **_metadata(bout),
    }


def serialize_bout_interval(row: SyncedRecord) -> dict[str, object]:
    """A ``walking_pauses`` or ``walking_rests`` record, tombstone included."""
    interval = cast(WalkingBoutPause | WalkingRest, row)
    return {
        "id": str(interval.pk),
        "walking_bout_id": str(interval.walking_bout_id),
        "started_at": format_timestamp(interval.started_at),
        "ended_at": _timestamp(interval.ended_at),
        **_metadata(interval),
    }
