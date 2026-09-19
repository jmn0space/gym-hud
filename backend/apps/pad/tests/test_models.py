"""The database's own guarantees, independent of the handlers that normally run first.

The sync engine validates every value before writing, so these constraints are a
backstop -- but they are what holds if a future code path (a data migration, a
shell session, a bug) writes rows directly.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from django.contrib.auth.models import User
from django.db import IntegrityError, transaction

from apps.pad.models import PadDefaults, WalkingBout, WalkingBoutPause, WalkingRest, WalkingSession

pytestmark = pytest.mark.django_db

T0 = datetime(2026, 9, 14, 10, 0, tzinfo=UTC)


def _sync_fields(user: User) -> dict[str, Any]:
    return {
        "user": user,
        "created_at": T0,
        "updated_at": T0,
        "last_client_id": uuid.uuid4(),
        "last_sequence": 1,
        "change_seq": 1,
    }


def _session(user: User, **overrides: Any) -> WalkingSession:
    fields: dict[str, Any] = {
        "id": uuid.uuid4(),
        "status": "ACTIVE",
        "started_at": T0,
        "speed_kmh": 5.0,
        "incline_pct": 2.0,
        "max_bout_seconds": 480,
        **_sync_fields(user),
    }
    fields.update(overrides)
    return WalkingSession.objects.create(**fields)


def _bout(session: WalkingSession, **overrides: Any) -> WalkingBout:
    fields: dict[str, Any] = {
        "id": uuid.uuid4(),
        "walking_session": session,
        "bout_number": 1,
        "started_at": T0,
        **_sync_fields(session.user),
    }
    fields.update(overrides)
    return WalkingBout.objects.create(**fields)


def _interval(
    model: type[WalkingBoutPause | WalkingRest], bout: WalkingBout, **overrides: Any
) -> Any:
    fields: dict[str, Any] = {
        "id": uuid.uuid4(),
        "walking_bout": bout,
        "started_at": T0,
        **_sync_fields(bout.user),
    }
    fields.update(overrides)
    return model.objects.create(**fields)


def _refused(create: Any) -> None:
    with pytest.raises(IntegrityError), transaction.atomic():
        create()


@pytest.fixture
def user(db: None) -> User:
    return User.objects.create_user(username="walker")


@pytest.mark.parametrize(
    "overrides",
    [
        {"status": "PAUSED"},
        {"status": "COMPLETED"},  # without completed_at
        {"completed_at": T0},  # while ACTIVE
        {"status": "COMPLETED", "completed_at": T0 - timedelta(seconds=1)},
        {"speed_kmh": 0},
        {"incline_pct": -1},
        {"max_bout_seconds": 0},
    ],
)
def test_session_check_constraints(user: User, overrides: dict[str, Any]) -> None:
    _refused(lambda: _session(user, **overrides))


def test_one_active_session_per_user_ignoring_tombstones(user: User) -> None:
    first = _session(user)
    _refused(lambda: _session(user))

    other = User.objects.create_user(username="someone-else")
    _session(other)  # the rule is per user
    WalkingSession.objects.filter(pk=first.pk).update(deleted_at=T0)
    _session(user)  # a tombstoned ACTIVE session holds no place


@pytest.mark.parametrize(
    "overrides",
    [
        {"bout_number": 0},
        {"ended_at": T0 - timedelta(seconds=1)},
        {"pain_min": 2},  # without pain_max
        {"pain_max": 2},
        {"pain_min": 1, "pain_max": 3},
        {"pain_min": 3, "pain_max": 2},
        {"pain_min": 0, "pain_max": 1},
        {"pain_min": 5, "pain_max": 6},
        {"stop_reason": "TIRED"},
    ],
)
def test_bout_check_constraints(user: User, overrides: dict[str, Any]) -> None:
    session = _session(user)
    _refused(lambda: _bout(session, **overrides))


@pytest.mark.parametrize(("pain_min", "pain_max"), [(None, None), (2, 2), (2, 3)])
def test_valid_pain_is_stored(user: User, pain_min: int | None, pain_max: int | None) -> None:
    _bout(_session(user), pain_min=pain_min, pain_max=pain_max)


def test_one_open_bout_per_session(user: User) -> None:
    session = _session(user)
    first = _bout(session)
    _refused(lambda: _bout(session, bout_number=2))

    _bout(session, bout_number=2, ended_at=T0)  # closed bouts are unlimited
    WalkingBout.objects.filter(pk=first.pk).update(deleted_at=T0)
    _bout(session, bout_number=3)


def test_one_open_pause_per_bout(user: User) -> None:
    bout = _bout(_session(user))
    _interval(WalkingBoutPause, bout)
    _refused(lambda: _interval(WalkingBoutPause, bout))
    _interval(WalkingBoutPause, bout, ended_at=T0)


def test_one_live_rest_per_bout(user: User) -> None:
    bout = _bout(_session(user), ended_at=T0)
    first = _interval(WalkingRest, bout, ended_at=T0)
    _refused(lambda: _interval(WalkingRest, bout, ended_at=T0))

    WalkingRest.objects.filter(pk=first.pk).update(deleted_at=T0)
    _interval(WalkingRest, bout)


@pytest.mark.parametrize("model", [WalkingBoutPause, WalkingRest])
def test_intervals_cannot_end_before_they_start(
    user: User, model: type[WalkingBoutPause | WalkingRest]
) -> None:
    bout = _bout(_session(user), ended_at=T0 + timedelta(minutes=5))
    _refused(lambda: _interval(model, bout, ended_at=T0 - timedelta(seconds=1)))


def test_pad_defaults_fall_back_to_the_application_defaults() -> None:
    defaults = PadDefaults.current()

    assert defaults.pk == PadDefaults.SINGLETON_ID
    assert defaults._state.adding  # nothing saved yet
    assert (defaults.speed_kmh, defaults.incline_pct, defaults.max_bout_seconds) == (
        Decimal("5.0"),
        Decimal("2.0"),
        480,
    )


def test_pad_defaults_are_a_singleton(db: None) -> None:
    PadDefaults.objects.create(speed_kmh=Decimal("4.5"))

    assert PadDefaults.current().speed_kmh == Decimal("4.5")
    _refused(lambda: PadDefaults.objects.create(id=2))
    _refused(lambda: PadDefaults.objects.create(id=1))
