"""Concurrent delivery against a real PostgreSQL server.

Each request runs on its own thread, and therefore on its own database
connection, released together through a barrier. ``_apply`` is slowed down so
the requests really overlap inside their transactions: without the per-user
``SyncState`` lock and the ledger's unique ``mutation_id`` index, these are
exactly the interleavings that would apply a mutation twice or fail with a 500.

SQLite serializes every writer on one database-wide lock and has no row locks,
so there is nothing meaningful to prove there; the module is skipped unless
``TEST_DATABASE_URL`` points at PostgreSQL (as it does in CI).
"""

from __future__ import annotations

import threading
import time
from collections import Counter
from collections.abc import Sequence
from typing import TYPE_CHECKING, Any

import pytest
from django.conf import settings
from django.contrib.auth.models import User
from django.db import connections
from rest_framework.test import APIClient

from apps.pad.models import WalkingBout, WalkingSession
from apps.sync import engine
from apps.sync.models import ProcessedMutation, SyncState
from apps.sync.tests.conftest import MUTATIONS_URL
from apps.sync.tests.device import Device, at

if TYPE_CHECKING:
    from rest_framework.response import _MonkeyPatchedResponse as Response

pytestmark = [
    pytest.mark.django_db(transaction=True),
    pytest.mark.skipif(
        settings.DATABASES["default"]["ENGINE"] != "django.db.backends.postgresql",
        reason="needs PostgreSQL: row locks and truly concurrent connections",
    ),
]


@pytest.fixture(autouse=True)
def _slow_apply(monkeypatch: pytest.MonkeyPatch) -> None:
    """Hold every mutation's transaction open long enough for the others to arrive."""
    real_apply = engine._apply

    def slow_apply(*args: Any, **kwargs: Any) -> list[str]:
        time.sleep(0.3)
        return real_apply(*args, **kwargs)

    monkeypatch.setattr(engine, "_apply", slow_apply)


def _post_concurrently(requests: Sequence[tuple[User, dict[str, Any]]]) -> list[Response]:
    """POST every ``(user, body)`` at the same moment, each on its own connection."""
    barrier = threading.Barrier(len(requests))
    responses: list[Response | None] = [None] * len(requests)
    errors: list[BaseException] = []

    def worker(index: int, user: User, body: dict[str, Any]) -> None:
        try:
            client = APIClient()
            client.force_login(user)
            barrier.wait(timeout=10)
            responses[index] = client.post(MUTATIONS_URL, body, format="json")
        except BaseException as exc:  # surfaced below; a thread cannot fail the test itself
            errors.append(exc)
        finally:
            connections.close_all()

    threads = [
        threading.Thread(target=worker, args=(index, user, body))
        for index, (user, body) in enumerate(requests)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    assert not errors, errors
    finished = [response for response in responses if response is not None]
    assert len(finished) == len(requests)
    for response in finished:
        assert response.status_code == 200, response.content
    return finished


def _batch(device: Device, *envelopes: dict[str, Any]) -> dict[str, Any]:
    return {"client_id": device.client_id, "mutations": list(envelopes)}


def _statuses(responses: Sequence[Response]) -> Counter[str]:
    return Counter(item["status"] for response in responses for item in response.json()["results"])


def test_concurrent_duplicate_delivery_applies_once(user: User, device: Device) -> None:
    start, session_id = device.start_session(at(0))

    responses = _post_concurrently([(user, _batch(device, start))] * 6)

    assert _statuses(responses) == Counter({"applied": 1, "duplicate": 5})
    assert WalkingSession.objects.count() == 1
    assert WalkingSession.objects.filter(pk=session_id).exists()
    assert ProcessedMutation.objects.count() == 1
    assert SyncState.objects.get(user=user).change_seq == 1


def test_a_retry_racing_the_original_batch_applies_each_mutation_once(
    user: User, device: Device
) -> None:
    """The original request is still running when the device gives up and resends it."""
    start, session_id = device.start_session(at(0))
    bout, _ = device.start_bout(session_id, at(1))
    body = _batch(device, start, bout)

    responses = _post_concurrently([(user, body), (user, body)])

    assert _statuses(responses) == Counter({"applied": 2, "duplicate": 2})
    assert WalkingSession.objects.count() == 1
    assert WalkingBout.objects.count() == 1
    assert ProcessedMutation.objects.count() == 2
    assert SyncState.objects.get(user=user).change_seq == 2


def test_two_devices_racing_for_the_active_session_slot(user: User) -> None:
    phone, tablet = Device(), Device()
    phone_start, _ = phone.start_session(at(0))
    tablet_start, _ = tablet.start_session(at(0))

    responses = _post_concurrently(
        [(user, _batch(phone, phone_start)), (user, _batch(tablet, tablet_start))]
    )

    outcomes = sorted(
        (item["status"], item.get("code"))
        for response in responses
        for item in response.json()["results"]
    )
    assert outcomes == [("applied", None), ("rejected", "active_conflict")]
    assert WalkingSession.objects.filter(status="ACTIVE").count() == 1


def test_two_accounts_racing_on_one_mutation_id(user: User, other_user: User) -> None:
    """The unique ledger index settles it: one application, one conflict, no 500."""
    device = Device()
    start, session_id = device.start_session(at(0))

    responses = _post_concurrently(
        [(user, _batch(device, start)), (other_user, _batch(device, start))]
    )

    outcomes = sorted(
        (item["status"], item.get("code"))
        for response in responses
        for item in response.json()["results"]
    )
    assert outcomes == [("applied", None), ("rejected", "mutation_id_conflict")]
    assert ProcessedMutation.objects.count() == 1
    assert WalkingSession.objects.filter(pk=session_id).count() == 1
    owner = ProcessedMutation.objects.get().user_id
    assert WalkingSession.objects.get(pk=session_id).user_id == owner


def test_concurrent_deletion_replay_and_stale_edit_leave_one_tombstone(
    user: User, device: Device
) -> None:
    start, session_id = device.start_session(at(0))
    bout, bout_id = device.start_bout(session_id, at(1))
    client = APIClient()
    client.force_login(user)
    assert client.post(MUTATIONS_URL, _batch(device, start, bout), format="json").status_code == 200
    stale_edit = device.edit(at(2), "walking_bouts", bout_id, pain_min=2, pain_max=3)
    delete = device.delete_bout(bout_id, at(3))

    responses = _post_concurrently(
        [
            (user, _batch(device, delete)),
            (user, _batch(device, delete)),
            (user, _batch(device, stale_edit)),
        ]
    )

    assert _statuses(responses) == Counter({"applied": 2, "duplicate": 1})
    bout_row = WalkingBout.objects.get(pk=bout_id)
    assert bout_row.deleted_at == at(3)  # whichever order they committed in
    assert WalkingBout.objects.count() == 1
    assert ProcessedMutation.objects.count() == 4
