"""Reading PAD records: strict about identity and state, tolerant of everything else."""

from __future__ import annotations

import math
import uuid
from datetime import UTC, datetime
from typing import Any

import pytest

from apps.pad.records import parse_bout_interval, parse_walking_bout, parse_walking_session
from apps.sync.protocol import Rejected

SESSION_ID = "8a4f0d0e-5d6b-4c55-9d43-1b1c4d6a0f11"
BOUT_ID = "3c2b1a09-8f7e-4d6c-b5a4-938271605f4e"


def _session(**overrides: Any) -> dict[str, Any]:
    """A ``walking_sessions`` record exactly as ``walkingSessionRecord`` writes it."""
    record: dict[str, Any] = {
        "id": SESSION_ID,
        "status": "ACTIVE",
        "started_at": "2026-09-14T10:00:00.000Z",
        "completed_at": None,
        "speed_kmh": 5,
        "incline_pct": 2,
        "max_bout_seconds": 480,
        "session_notes": None,
        "created_at": "2026-09-14T10:00:00.000Z",
        "updated_at": "2026-09-14T10:00:00.000Z",
        "deleted_at": None,
    }
    record.update(overrides)
    return record


def _bout(**overrides: Any) -> dict[str, Any]:
    """A ``walking_bouts`` record exactly as ``walkingBoutRecord`` writes it."""
    record: dict[str, Any] = {
        "id": BOUT_ID,
        "walking_session_id": SESSION_ID,
        "bout_number": 1,
        "started_at": "2026-09-14T10:01:00.000Z",
        "ended_at": None,
        "pain_min": None,
        "pain_max": None,
        "pain_onset_at": None,
        "stop_reason": None,
        "notes": None,
    }
    record.update(overrides)
    return record


def _rejected(parse: Any, record: dict[str, Any]) -> Rejected:
    with pytest.raises(Rejected) as excinfo:
        parse(record)
    return excinfo.value


# --- Sessions -----------------------------------------------------------------


def test_a_session_as_the_frontend_writes_it_parses() -> None:
    values = parse_walking_session(_session())

    assert values == {
        "status": "ACTIVE",
        "started_at": datetime(2026, 9, 14, 10, 0, tzinfo=UTC),
        "completed_at": None,
        "speed_kmh": 5.0,
        "incline_pct": 2.0,
        "max_bout_seconds": 480,
        "session_notes": None,
    }


def test_inherited_settings_are_carried_exactly() -> None:
    """``step="any"`` inputs: 5.65 km/h and 445 s must not be rounded or refused."""
    values = parse_walking_session(_session(speed_kmh=5.65, incline_pct=0, max_bout_seconds=445))

    assert (values["speed_kmh"], values["incline_pct"], values["max_bout_seconds"]) == (
        5.65,
        0.0,
        445,
    )


def test_unknown_fields_and_absent_optional_fields_are_tolerated() -> None:
    record = _session(something_new=True)
    del record["completed_at"]
    del record["session_notes"]

    values = parse_walking_session(record)

    assert values["completed_at"] is None
    assert values["session_notes"] is None
    assert "something_new" not in values


def test_a_finished_session_parses_with_its_completion_time() -> None:
    values = parse_walking_session(
        _session(status="COMPLETED", completed_at="2026-09-14T10:40:00.000Z")
    )

    assert values["completed_at"] == datetime(2026, 9, 14, 10, 40, tzinfo=UTC)


def test_other_offsets_are_normalized_to_utc() -> None:
    values = parse_walking_session(_session(started_at="2026-09-14T12:00:00+02:00"))

    assert values["started_at"] == datetime(2026, 9, 14, 10, 0, tzinfo=UTC)


@pytest.mark.parametrize(
    ("overrides", "code", "field"),
    [
        ({"status": "PAUSED"}, "invalid_record", "status"),
        ({"status": None}, "invalid_record", "status"),
        ({"started_at": None}, "invalid_record", "started_at"),
        ({"started_at": "2026-09-14T10:00:00"}, "invalid_record", "started_at"),  # naive
        ({"started_at": "not a time"}, "invalid_record", "started_at"),
        ({"started_at": 1757844000000}, "invalid_record", "started_at"),
        ({"completed_at": "2026-09-14T10:40:00.000Z"}, "invalid_record", "completed_at"),
        ({"status": "COMPLETED"}, "invalid_record", "completed_at"),
        # Valid literals whose UTC instant falls outside what a datetime holds.
        ({"started_at": "0001-01-01T00:00:00+01:00"}, "invalid_record", "started_at"),
        ({"started_at": "9999-12-31T23:00:00-05:00"}, "invalid_record", "started_at"),
        ({"speed_kmh": 0}, "invalid_record", "speed_kmh"),
        ({"speed_kmh": -5}, "invalid_record", "speed_kmh"),
        ({"speed_kmh": "5"}, "invalid_record", "speed_kmh"),
        ({"speed_kmh": True}, "invalid_record", "speed_kmh"),
        ({"speed_kmh": math.inf}, "invalid_record", "speed_kmh"),
        ({"speed_kmh": 10**400}, "invalid_record", "speed_kmh"),  # beyond any double
        ({"incline_pct": -0.5}, "invalid_record", "incline_pct"),
        ({"max_bout_seconds": 0}, "invalid_record", "max_bout_seconds"),
        ({"max_bout_seconds": 480.5}, "invalid_record", "max_bout_seconds"),
        ({"max_bout_seconds": 2**53}, "invalid_record", "max_bout_seconds"),
        ({"session_notes": 42}, "invalid_record", "session_notes"),
    ],
)
def test_invalid_session_state_is_rejected(
    overrides: dict[str, Any], code: str, field: str
) -> None:
    rejected = _rejected(parse_walking_session, _session(**overrides))

    assert rejected.code == code
    assert field in rejected.detail


def test_an_integral_float_counts_as_an_integer() -> None:
    assert parse_walking_session(_session(max_bout_seconds=480.0))["max_bout_seconds"] == 480


# --- Bouts ----------------------------------------------------------------------


def test_a_bout_as_the_frontend_writes_it_parses() -> None:
    values = parse_walking_bout(_bout())

    assert values["walking_session_id"] == uuid.UUID(SESSION_ID)
    assert values["bout_number"] == 1
    assert values["ended_at"] is None
    assert (values["pain_min"], values["pain_max"], values["stop_reason"]) == (None, None, None)


def test_an_absent_end_means_open_as_it_does_locally() -> None:
    record = _bout()
    del record["ended_at"]

    assert parse_walking_bout(record)["ended_at"] is None


@pytest.mark.parametrize(("pain_min", "pain_max"), [(1, 1), (2, 3), (4, 5), (5, 5)])
def test_one_pain_value_or_two_adjacent_values_are_accepted(pain_min: int, pain_max: int) -> None:
    values = parse_walking_bout(_bout(pain_min=pain_min, pain_max=pain_max))

    assert (values["pain_min"], values["pain_max"]) == (pain_min, pain_max)


@pytest.mark.parametrize(
    ("pain_min", "pain_max"),
    [(1, 4), (3, 2), (2, None), (None, 3), (0, 1), (5, 6), (2.5, 3), (True, True)],
)
def test_invalid_pain_is_rejected(pain_min: Any, pain_max: Any) -> None:
    rejected = _rejected(parse_walking_bout, _bout(pain_min=pain_min, pain_max=pain_max))

    assert rejected.code == "invalid_record"
    assert "pain" in rejected.detail


@pytest.mark.parametrize(
    "reason", ["MAX_DURATION", "CLAUDICATION", "FOOT_NUMBNESS", "SUDDEN_SWELLING", "OTHER"]
)
def test_every_stop_reason_is_accepted(reason: str) -> None:
    assert parse_walking_bout(_bout(stop_reason=reason))["stop_reason"] == reason


@pytest.mark.parametrize(
    ("overrides", "code", "field"),
    [
        ({"stop_reason": "TIRED"}, "invalid_record", "stop_reason"),
        ({"stop_reason": "claudication"}, "invalid_record", "stop_reason"),
        ({"walking_session_id": None}, "invalid_record", "walking_session_id"),
        ({"walking_session_id": SESSION_ID.upper()}, "invalid_record", "walking_session_id"),
        ({"walking_session_id": "{" + SESSION_ID + "}"}, "invalid_record", "walking_session_id"),
        ({"bout_number": 0}, "invalid_record", "bout_number"),
        ({"bout_number": 2**31}, "invalid_record", "bout_number"),
        ({"bout_number": None}, "invalid_record", "bout_number"),
        ({"notes": ["not", "text"]}, "invalid_record", "notes"),
    ],
)
def test_invalid_bout_state_is_rejected(overrides: dict[str, Any], code: str, field: str) -> None:
    rejected = _rejected(parse_walking_bout, _bout(**overrides))

    assert rejected.code == code
    assert field in rejected.detail


def test_free_text_is_made_storable_rather_than_refused() -> None:
    """NUL is dropped and a lone surrogate becomes U+FFFD: the notes survive either way."""
    values = parse_walking_session(_session(session_notes="nul\x00byte \ud800 ok"))

    assert values["session_notes"] == "nulbyte \ufffd ok"
    assert parse_walking_bout(_bout(notes="\x00"))["notes"] == ""


def test_an_end_before_its_start_is_left_for_the_engine_to_clamp() -> None:
    """A clock step is not a parse error; ``StoreSpec.interval`` clamps it."""
    values = parse_walking_bout(_bout(ended_at="2026-09-14T10:00:59.999Z"))

    ended_at, started_at = values["ended_at"], values["started_at"]
    assert isinstance(ended_at, datetime) and isinstance(started_at, datetime)
    assert ended_at < started_at


@pytest.mark.parametrize(
    "pain_onset_at",
    [
        "2026-09-14T10:01:00.000Z",  # the instant the bout started
        "2026-09-14T10:03:00.000Z",  # inside it
        "2026-09-14T10:09:00.000Z",  # the instant it ended
    ],
)
def test_a_pain_onset_inside_its_bout_parses(pain_onset_at: str) -> None:
    values = parse_walking_bout(
        _bout(ended_at="2026-09-14T10:09:00.000Z", pain_onset_at=pain_onset_at)
    )

    assert values["pain_onset_at"] == datetime.fromisoformat(pain_onset_at.replace("Z", "+00:00"))


def test_an_absent_or_null_pain_onset_means_none_was_recorded() -> None:
    record = _bout()
    del record["pain_onset_at"]

    assert parse_walking_bout(record)["pain_onset_at"] is None
    assert parse_walking_bout(_bout(pain_onset_at=None))["pain_onset_at"] is None


@pytest.mark.parametrize(
    "overrides",
    [
        {"pain_onset_at": "2026-09-14T10:00:59.999Z"},  # before the bout started
        {"ended_at": "2026-09-14T10:09:00.000Z", "pain_onset_at": "2026-09-14T10:09:00.001Z"},
    ],
)
def test_a_pain_onset_outside_its_bout_is_rejected(overrides: dict[str, Any]) -> None:
    """No clock step produces one: the device stamps it monotonically inside the bout."""
    rejected = _rejected(parse_walking_bout, _bout(**overrides))

    assert rejected.code == "invalid_record"
    assert "pain_onset_at" in rejected.detail


def test_a_pain_onset_is_judged_against_the_end_the_engine_will_store() -> None:
    """An end before its own start is clamped up to the start, so the onset holds."""
    values = parse_walking_bout(
        _bout(
            ended_at="2026-09-14T10:00:30.000Z",  # a clock step back
            pain_onset_at="2026-09-14T10:01:00.000Z",
        )
    )

    assert values["pain_onset_at"] == values["started_at"]


def test_an_instant_bout_is_valid() -> None:
    """``ended_at == started_at`` is allowed: START NEXT BOUT stamps both ends alike."""
    values = parse_walking_bout(_bout(ended_at="2026-09-14T10:01:00.000Z"))

    assert values["ended_at"] == values["started_at"]


# --- Pauses and rests -------------------------------------------------------------


def test_a_pause_or_rest_parses() -> None:
    values = parse_bout_interval(
        {
            "id": "0f0e0d0c-0b0a-4908-8706-050403020100",
            "walking_bout_id": BOUT_ID,
            "started_at": "2026-09-14T10:03:00.000Z",
            "ended_at": "2026-09-14T10:05:00.000Z",
        }
    )

    assert values == {
        "walking_bout_id": uuid.UUID(BOUT_ID),
        "started_at": datetime(2026, 9, 14, 10, 3, tzinfo=UTC),
        "ended_at": datetime(2026, 9, 14, 10, 5, tzinfo=UTC),
    }


@pytest.mark.parametrize(
    ("overrides", "code"),
    [
        ({"walking_bout_id": "nope"}, "invalid_record"),
        ({"started_at": None}, "invalid_record"),
    ],
)
def test_an_invalid_pause_or_rest_is_rejected(overrides: dict[str, Any], code: str) -> None:
    record = {
        "walking_bout_id": BOUT_ID,
        "started_at": "2026-09-14T10:03:00.000Z",
        "ended_at": None,
        **overrides,
    }

    assert _rejected(parse_bout_interval, record).code == code
