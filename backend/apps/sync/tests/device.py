"""A stand-in for one browser's local repository, producing real outbox envelopes.

Mirrors ``frontend/src/storage/repository.ts``'s ``commitAction`` -- record
stamping (``created_at`` kept, ``updated_at`` bumped, ``deleted_at`` null on a
put; the whole previous record plus ``deleted_at`` on a delete), the
per-device monotonic ``sequence``, and ``orderChanges`` (puts parent-first,
then deletes child-first) -- and the record shapes of
``frontend/src/pad/records.ts``/``actions.ts``. Tests push what a device would
push, so "the server accepts everything the frontend produces" is tested
against the frontend's shapes rather than hand-written JSON.

Pause, finish bout + rest, start next bout and pain/notes edits mirror the
frontend's own builders (`frontend/src/pad/actions.ts`, issues #18/#21).
`delete_bout` mirrors deleting a bout's children and itself, but -- unlike
`frontend/src/pad/actions.ts`'s `deleteWalkingBoutAction` (issue #22) -- does
not also renumber surviving bouts in the same mutation: existing callers only
use it to exercise the generic tombstone/cascade/undo mechanics, which do not
depend on numbering. The renumbering shape is instead proven end to end by
`frontend/src/padCorrectionsReplay.test.ts` and
`test_pad_corrections_replay.py`, which replay the frontend's own generated
envelope rather than building one here.
"""

from __future__ import annotations

import copy
import uuid
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from typing import Any

from apps.sync.protocol import format_timestamp

T0 = datetime(2026, 9, 14, 10, 0, tzinfo=UTC)

Record = dict[str, Any]
Envelope = dict[str, Any]

ENTITY_TYPES = {
    "walking_sessions": "walking_session",
    "walking_bouts": "walking_bout",
    "walking_pauses": "walking_pause",
    "walking_rests": "walking_rest",
    "resistance_sessions": "resistance_session",
}
DEPTH = {
    "walking_sessions": 0,
    "walking_bouts": 1,
    "walking_pauses": 2,
    "walking_rests": 2,
    "resistance_sessions": 0,
}
_METADATA = ("created_at", "updated_at", "deleted_at")


def at(minutes: float) -> datetime:
    """``T0`` plus ``minutes``."""
    return T0 + timedelta(minutes=minutes)


def iso(moment: datetime) -> str:
    """``Date.toISOString()`` of ``moment``."""
    return format_timestamp(moment)


def new_id() -> str:
    return str(uuid.uuid4())


def order_changes(changes: list[Record]) -> list[Record]:
    """``orderChanges``: puts shallow-first, then deletes deep-first, stable."""
    puts = sorted((c for c in changes if c["operation"] == "put"), key=lambda c: DEPTH[c["store"]])
    deletes = sorted(
        (c for c in changes if c["operation"] == "delete"), key=lambda c: -DEPTH[c["store"]]
    )
    return [*puts, *deletes]


class Device:
    """One device's local records, sequence, and client id."""

    def __init__(self, client_id: str | None = None) -> None:
        self.client_id = client_id or new_id()
        self.sequence = 0
        self.records: dict[tuple[str, str], Record] = {}

    def record(self, store: str, record_id: str) -> Record:
        """A deep copy of a local record, as the device holds it now."""
        return copy.deepcopy(self.records[(store, record_id)])

    def commit(
        self,
        now: datetime,
        puts: Iterable[tuple[str, Record]] = (),
        deletes: Iterable[tuple[str, str]] = (),
    ) -> Envelope:
        """``commitAction``: stamp, store locally, and return the outbox envelope."""
        stamp = iso(now)
        changes: list[Record] = []
        for store, submitted in puts:
            existing = self.records.get((store, submitted["id"]))
            persisted = {k: v for k, v in submitted.items() if k not in _METADATA}
            persisted["created_at"] = existing["created_at"] if existing else stamp
            persisted["updated_at"] = stamp
            persisted["deleted_at"] = None
            changes.append(
                {
                    "store": store,
                    "entity_type": ENTITY_TYPES[store],
                    "entity_id": submitted["id"],
                    "operation": "put",
                    "record": persisted,
                }
            )
        for store, record_id in deletes:
            existing = self.records[(store, record_id)]
            tombstone = {**existing, "updated_at": stamp, "deleted_at": stamp}
            changes.append(
                {
                    "store": store,
                    "entity_type": ENTITY_TYPES[store],
                    "entity_id": record_id,
                    "operation": "delete",
                    "id": record_id,
                    "record": tombstone,
                }
            )
        for change in changes:
            self.records[(change["store"], change["entity_id"])] = copy.deepcopy(change["record"])
        self.sequence += 1
        return {
            "version": 1,
            "mutation_id": new_id(),
            "sequence": self.sequence,
            "created_at": stamp,
            "changes": order_changes(changes),
        }

    def _fields(self, store: str, record_id: str, **updates: Any) -> Record:
        """A full-record replacement: the current record's fields plus ``updates``."""
        fields = {k: v for k, v in self.record(store, record_id).items() if k not in _METADATA}
        fields.update(updates)
        return fields

    def edit(self, now: datetime, store: str, record_id: str, **updates: Any) -> Envelope:
        """Put one record with some fields changed (a manual correction or pain edit)."""
        return self.commit(now, puts=[(store, self._fields(store, record_id, **updates))])

    def restore(self, now: datetime, store: str, record: Record) -> Envelope:
        """Undo: put a record back exactly as it was (resurrecting a tombstone)."""
        fields = {k: v for k, v in record.items() if k not in _METADATA}
        return self.commit(now, puts=[(store, fields)])

    # --- PAD actions --------------------------------------------------------

    def start_session(
        self,
        now: datetime,
        *,
        speed_kmh: float = 5,
        incline_pct: float = 2,
        max_bout_seconds: int = 480,
    ) -> tuple[Envelope, str]:
        """``startWalkingSessionAction``."""
        session_id = new_id()
        record = {
            "id": session_id,
            "status": "ACTIVE",
            "started_at": iso(now),
            "completed_at": None,
            "speed_kmh": speed_kmh,
            "incline_pct": incline_pct,
            "max_bout_seconds": max_bout_seconds,
            "session_notes": None,
        }
        return self.commit(now, puts=[("walking_sessions", record)]), session_id

    def _next_bout_number(self, session_id: str) -> int:
        numbers = [
            r["bout_number"]
            for (store, _), r in self.records.items()
            if store == "walking_bouts"
            and r["walking_session_id"] == session_id
            and r["deleted_at"] is None
        ]
        return max(numbers, default=0) + 1

    def _bout_record(self, session_id: str, now: datetime) -> Record:
        return {
            "id": new_id(),
            "walking_session_id": session_id,
            "bout_number": self._next_bout_number(session_id),
            "started_at": iso(now),
            "ended_at": None,
            "pain_min": None,
            "pain_max": None,
            "pain_onset_at": None,
            "stop_reason": None,
            "notes": None,
        }

    def start_bout(self, session_id: str, now: datetime) -> tuple[Envelope, str]:
        """``startWalkingBoutAction``."""
        bout = self._bout_record(session_id, now)
        return self.commit(now, puts=[("walking_bouts", bout)]), bout["id"]

    def pause(self, bout_id: str, now: datetime) -> tuple[Envelope, str]:
        pause: Record = {
            "id": new_id(),
            "walking_bout_id": bout_id,
            "started_at": iso(now),
            "ended_at": None,
        }
        return self.commit(now, puts=[("walking_pauses", pause)]), pause["id"]

    def resume(self, pause_id: str, now: datetime) -> Envelope:
        return self.edit(now, "walking_pauses", pause_id, ended_at=iso(now))

    def _open_children(self, store: str, bout_id: str) -> list[Record]:
        return [
            r
            for (s, _), r in self.records.items()
            if s == store
            and r["walking_bout_id"] == bout_id
            and r["deleted_at"] is None
            and r["ended_at"] is None
        ]

    def finish_bout(
        self, bout_id: str, now: datetime, *, stop_reason: str | None = None
    ) -> tuple[Envelope, str]:
        """FINISH BOUT: end the bout (and an open pause) and start its rest, atomically."""
        rest: Record = {
            "id": new_id(),
            "walking_bout_id": bout_id,
            "started_at": iso(now),
            "ended_at": None,
        }
        puts = [
            ("walking_pauses", {**self._fields("walking_pauses", p["id"]), "ended_at": iso(now)})
            for p in self._open_children("walking_pauses", bout_id)
        ]
        puts.append(
            (
                "walking_bouts",
                self._fields("walking_bouts", bout_id, ended_at=iso(now), stop_reason=stop_reason),
            )
        )
        puts.append(("walking_rests", rest))
        return self.commit(now, puts=puts), rest["id"]

    def start_next_bout(self, rest_id: str, now: datetime) -> tuple[Envelope, str]:
        """START NEXT BOUT: close the rest and start the next bout, atomically."""
        rest = self.record("walking_rests", rest_id)
        bout = self.record("walking_bouts", rest["walking_bout_id"])
        next_bout = self._bout_record(bout["walking_session_id"], now)
        envelope = self.commit(
            now,
            puts=[
                ("walking_rests", self._fields("walking_rests", rest_id, ended_at=iso(now))),
                ("walking_bouts", next_bout),
            ],
        )
        return envelope, next_bout["id"]

    def finish_session(
        self, session_id: str, now: datetime, *, status: str = "COMPLETED"
    ) -> Envelope:
        """``finishWalkingSessionAction``/``discard``: close every open row, then the session."""
        stamp = iso(now)
        bouts = [
            r
            for (s, _), r in self.records.items()
            if s == "walking_bouts"
            and r["walking_session_id"] == session_id
            and r["deleted_at"] is None
        ]
        puts: list[tuple[str, Record]] = []
        for store in ("walking_pauses", "walking_rests"):
            for bout in bouts:
                for child in self._open_children(store, bout["id"]):
                    puts.append((store, self._fields(store, child["id"], ended_at=stamp)))
        for bout in bouts:
            if bout["ended_at"] is None:
                puts.append(
                    ("walking_bouts", self._fields("walking_bouts", bout["id"], ended_at=stamp))
                )
        puts.append(
            (
                "walking_sessions",
                self._fields("walking_sessions", session_id, status=status, completed_at=stamp),
            )
        )
        return self.commit(now, puts=puts)

    def delete_bout(self, bout_id: str, now: datetime) -> Envelope:
        """Delete a bout with its live pauses and rest (children first)."""
        children = [
            (s, r["id"])
            for (s, _), r in self.records.items()
            if s in ("walking_pauses", "walking_rests")
            and r["walking_bout_id"] == bout_id
            and r["deleted_at"] is None
        ]
        return self.commit(now, deletes=[*children, ("walking_bouts", bout_id)])
