"""``POST /api/v1/sync/mutations/``: the push protocol, end to end.

Runs against PostgreSQL in CI (``TEST_DATABASE_URL``) and against SQLite
locally; the tests that need real concurrent connections live in
``test_concurrency_pg``. Every envelope comes from
:class:`apps.sync.tests.device.Device`, which stamps and orders changes the way
the frontend repository does.
"""

from __future__ import annotations

import copy
import uuid
from typing import Any

import pytest
from core.tests.conftest import csrf_token
from django.contrib.auth.models import User
from django.db import OperationalError, connection
from django.test import override_settings
from rest_framework.test import APIClient
from rest_framework.throttling import ScopedRateThrottle

from apps.pad.models import WalkingBout, WalkingBoutPause, WalkingRest, WalkingSession
from apps.sync.models import ProcessedMutation, SyncState
from apps.sync.tests.conftest import MUTATIONS_URL, codes, push, results, statuses
from apps.sync.tests.device import Device, at, iso, new_id

pytestmark = pytest.mark.django_db


def _counts() -> dict[str, int]:
    return {
        "sessions": WalkingSession.objects.count(),
        "bouts": WalkingBout.objects.count(),
        "pauses": WalkingBoutPause.objects.count(),
        "rests": WalkingRest.objects.count(),
        "ledger": ProcessedMutation.objects.count(),
    }


def _cursor(user: User) -> int:
    return SyncState.objects.get(user=user).change_seq


# --- Request level -------------------------------------------------------------


def test_anonymous_push_is_rejected_with_401(client: APIClient, device: Device) -> None:
    envelope, _ = device.start_session(at(0))
    response = push(client, device, envelope)

    assert response.status_code == 401
    assert response.json()["code"] == "not_authenticated"
    assert _counts()["sessions"] == 0


def test_push_enforces_csrf_for_a_session(user: User, device: Device) -> None:
    """An authenticated browser session must still send the CSRF token."""
    client = APIClient(enforce_csrf_checks=True)
    client.force_login(user)
    envelope, _ = device.start_session(at(0))
    body = {"client_id": device.client_id, "mutations": [envelope]}

    refused = client.post(MUTATIONS_URL, body, format="json")
    assert refused.status_code == 403
    assert refused.json()["code"] == "csrf_failed"
    assert _counts()["sessions"] == 0

    accepted = client.post(MUTATIONS_URL, body, format="json", HTTP_X_CSRFTOKEN=csrf_token(client))
    assert accepted.status_code == 200
    assert accepted.json() == {
        "results": [{"mutation_id": envelope["mutation_id"], "status": "applied"}]
    }


def test_push_is_never_cached(api: APIClient, device: Device) -> None:
    envelope, _ = device.start_session(at(0))
    assert "no-store" in push(api, device, envelope).headers["Cache-Control"]


@pytest.mark.parametrize(
    ("body", "detail_fragment"),
    [
        ([], "JSON object"),
        ({"mutations": []}, "client_id"),
        ({"client_id": "NOT-A-UUID", "mutations": [{}]}, "client_id"),
        ({"client_id": "6F9619FF-8B86-D011-B42D-00C04FC964FF", "mutations": [{}]}, "client_id"),
        ({"client_id": "6f9619ff-8b86-4011-b42d-00c04fc964ff", "mutations": []}, "non-empty"),
        ({"client_id": "6f9619ff-8b86-4011-b42d-00c04fc964ff", "mutations": {}}, "non-empty"),
        (
            {
                "client_id": "6f9619ff-8b86-4011-b42d-00c04fc964ff",
                "mutations": [{"sequence": 2}, {"sequence": 1}],
            },
            "ascending",
        ),
        (
            {"client_id": "6f9619ff-8b86-4011-b42d-00c04fc964ff", "mutations": [{}] * 51},
            "at most 50",
        ),
    ],
)
def test_malformed_requests_are_400_and_process_nothing(
    api: APIClient, body: object, detail_fragment: str
) -> None:
    response = api.post(MUTATIONS_URL, body, format="json")

    assert response.status_code == 400
    assert response.json()["code"] == "invalid_request"
    assert detail_fragment in response.json()["detail"]
    assert ProcessedMutation.objects.count() == 0


def test_unparseable_json_is_a_400_parse_error(api: APIClient) -> None:
    response = api.post(MUTATIONS_URL, "{not json", content_type="application/json")

    assert response.status_code == 400
    assert response.json()["code"] == "parse_error"


def test_a_non_json_body_is_415(api: APIClient) -> None:
    response = api.post(MUTATIONS_URL, {"client_id": "x"})  # multipart form

    assert response.status_code == 415
    assert response.json()["code"] == "unsupported_media_type"


@override_settings(DATA_UPLOAD_MAX_MEMORY_SIZE=200)
def test_an_oversized_body_is_413_before_it_is_parsed(api: APIClient, device: Device) -> None:
    envelope, _ = device.start_session(at(0))
    response = push(api, device, envelope)

    assert response.status_code == 413
    assert response.json()["code"] == "request_too_large"
    assert _counts()["sessions"] == 0


def test_sync_endpoints_share_a_per_user_throttle(
    api: APIClient, device: Device, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(ScopedRateThrottle, "THROTTLE_RATES", {"sync": "2/min"})
    envelope, _ = device.start_session(at(0))

    assert push(api, device, envelope).status_code == 200
    assert api.get("/api/v1/sync/bootstrap/").status_code == 200
    throttled = api.get("/api/v1/sync/changes/")
    assert throttled.status_code == 429
    assert throttled.json()["code"] == "throttled"


# --- Applying what the frontend produces ----------------------------------------


def test_a_whole_pad_session_as_the_device_records_it(
    api: APIClient, user: User, device: Device
) -> None:
    """Every PAD action in one batch, in outbox order: all applied, nothing lost."""
    start, session_id = device.start_session(at(0), speed_kmh=5.65, max_bout_seconds=445)
    bout1, bout1_id = device.start_bout(session_id, at(1))
    pause, pause_id = device.pause(bout1_id, at(3))
    resume = device.resume(pause_id, at(5))
    pain = device.edit(at(6), "walking_bouts", bout1_id, pain_min=3, pain_max=4)
    finish1, rest1_id = device.finish_bout(bout1_id, at(9), stop_reason="CLAUDICATION")
    bout2, bout2_id = device.start_next_bout(rest1_id, at(12))
    pause2, _ = device.pause(bout2_id, at(14))
    finish = device.finish_session(session_id, at(15))
    envelopes = [start, bout1, pause, resume, pain, finish1, bout2, pause2, finish]

    response = push(api, device, *envelopes)

    assert results(response) == [
        {"mutation_id": e["mutation_id"], "status": "applied"} for e in envelopes
    ]
    session = WalkingSession.objects.get(pk=session_id)
    assert session.status == "COMPLETED"
    assert session.speed_kmh == 5.65  # carried exactly, never rounded
    assert session.max_bout_seconds == 445
    first = WalkingBout.objects.get(pk=bout1_id)
    assert (first.pain_min, first.pain_max, first.stop_reason) == (3, 4, "CLAUDICATION")
    assert WalkingRest.objects.get(pk=rest1_id).ended_at == at(12)
    assert not WalkingBout.objects.filter(ended_at__isnull=True).exists()
    assert not WalkingBoutPause.objects.filter(ended_at__isnull=True).exists()
    assert _cursor(user) == len(envelopes)
    assert set(ProcessedMutation.objects.values_list("status", flat=True)) == {"applied"}


def test_discarding_a_session_closes_it_as_discarded(api: APIClient, device: Device) -> None:
    start, session_id = device.start_session(at(0))
    bout, _ = device.start_bout(session_id, at(1))
    discard = device.finish_session(session_id, at(2), status="DISCARDED")

    assert statuses(push(api, device, start, bout, discard)) == ["applied"] * 3
    assert WalkingSession.objects.get(pk=session_id).status == "DISCARDED"


def test_unknown_record_fields_are_ignored_not_rejected(api: APIClient, device: Device) -> None:
    """The repository may carry fields the server does not model (carriedFields)."""
    envelope, session_id = device.start_session(at(0))
    envelope["changes"][0]["record"]["added_by_a_later_client"] = {"nested": [1, 2]}

    assert statuses(push(api, device, envelope)) == ["applied"]
    assert WalkingSession.objects.filter(pk=session_id).exists()


# --- PAD-05 and idempotency ----------------------------------------------------


def test_pad05_the_same_mutation_twice_is_one_logical_event(
    api: APIClient, user: User, device: Device
) -> None:
    """PAD-05 — Duplicate mutation: transmit the same mutation twice."""
    start, session_id = device.start_session(at(0))
    bout, bout_id = device.start_bout(session_id, at(1))
    assert statuses(push(api, device, start, bout)) == ["applied", "applied"]
    before = _counts()
    stamped = WalkingBout.objects.get(pk=bout_id)

    again = push(api, device, bout)

    assert results(again) == [{"mutation_id": bout["mutation_id"], "status": "duplicate"}]
    assert _counts() == before
    assert WalkingBout.objects.filter(walking_session_id=uuid.UUID(session_id)).count() == 1
    unchanged = WalkingBout.objects.get(pk=bout_id)
    assert unchanged.change_seq == stamped.change_seq
    assert unchanged.server_updated_at == stamped.server_updated_at
    assert _cursor(user) == 2


def test_retry_after_a_lost_response_applies_nothing_twice(
    api: APIClient, user: User, device: Device
) -> None:
    """The device never saw the acknowledgements, so it resends the whole queue."""
    start, session_id = device.start_session(at(0))
    bout, _ = device.start_bout(session_id, at(1))
    assert statuses(push(api, device, start, bout)) == ["applied", "applied"]  # response lost
    finish = device.finish_session(session_id, at(2))

    retry = push(api, device, start, bout, finish)

    assert statuses(retry) == ["duplicate", "duplicate", "applied"]
    assert _counts() == {"sessions": 1, "bouts": 1, "pauses": 0, "rests": 0, "ledger": 3}
    assert _cursor(user) == 3


def test_a_reused_mutation_id_with_a_different_payload_is_refused(
    api: APIClient, device: Device
) -> None:
    start, session_id = device.start_session(at(0))
    assert statuses(push(api, device, start)) == ["applied"]
    tampered = copy.deepcopy(start)
    tampered["changes"][0]["record"]["speed_kmh"] = 9

    response = push(api, device, tampered)

    assert results(response) == [
        {
            "mutation_id": start["mutation_id"],
            "status": "rejected",
            "code": "mutation_id_conflict",
            "retryable": False,
            "detail": "This mutation_id was already used with a different payload.",
        }
    ]
    assert WalkingSession.objects.get(pk=session_id).speed_kmh == 5
    assert ProcessedMutation.objects.count() == 1


def test_key_order_does_not_change_the_payload_fingerprint(api: APIClient, device: Device) -> None:
    start, _ = device.start_session(at(0))
    assert statuses(push(api, device, start)) == ["applied"]
    reordered = dict(reversed(list(start.items())))

    assert statuses(push(api, device, reordered)) == ["duplicate"]


# --- Permanent rejections --------------------------------------------------------


def test_a_rejection_is_recorded_and_answered_identically_on_every_retry(
    api: APIClient, device: Device
) -> None:
    start, session_id = device.start_session(at(0))
    start["changes"][0]["record"]["speed_kmh"] = 0

    first = results(push(api, device, start))
    second = results(push(api, device, start))

    assert first == second
    assert first == [
        {
            "mutation_id": start["mutation_id"],
            "status": "rejected",
            "code": "invalid_record",
            "retryable": False,
            "detail": f"walking_sessions/{session_id}: speed_kmh must be a finite number "
            "greater than 0.",
        }
    ]
    ledger = ProcessedMutation.objects.get()
    assert (ledger.status, ledger.code) == ("rejected", "invalid_record")
    assert ledger.fingerprint and ledger.envelope
    assert not WalkingSession.objects.exists()


def test_a_rejection_does_not_stop_the_batch_and_dependents_fail_on_their_own(
    api: APIClient, device: Device
) -> None:
    """The agreed batch rule: permanent rejections continue; dependents are rejected too."""
    bad_start, session_id = device.start_session(at(0))
    bad_start["changes"][0]["record"]["speed_kmh"] = -1
    orphan_bout, _ = device.start_bout(session_id, at(1))
    independent, independent_id = device.start_session(at(5))

    response = push(api, device, bad_start, orphan_bout, independent)

    assert statuses(response) == ["rejected", "rejected", "applied"]
    assert codes(response) == ["invalid_record", "parent_not_found", None]
    assert list(WalkingSession.objects.values_list("id", flat=True)) == [uuid.UUID(independent_id)]


def test_an_invalid_mutation_id_is_rejected_without_a_ledger_row(
    api: APIClient, device: Device
) -> None:
    start, _ = device.start_session(at(0))
    start["mutation_id"] = "not-a-uuid"

    assert results(push(api, device, start)) == [
        {
            "mutation_id": "not-a-uuid",
            "status": "rejected",
            "code": "invalid_envelope",
            "retryable": False,
            "detail": "mutation_id must be a lowercase UUID.",
        }
    ]
    assert ProcessedMutation.objects.count() == 0


@pytest.mark.parametrize(
    ("mutate", "code"),
    [
        (lambda e: e.update(sequence=0), "invalid_envelope"),
        (lambda e: e.update(created_at="yesterday"), "invalid_envelope"),
        (lambda e: e.update(changes=[]), "invalid_envelope"),
        (lambda e: e["changes"][0].update(entity_type="walking_bout"), "invalid_envelope"),
        (lambda e: e["changes"][0].update(operation="upsert"), "invalid_envelope"),
        (lambda e: e["changes"][0]["record"].update(id=new_id()), "invalid_envelope"),
        (lambda e: e["changes"].append(copy.deepcopy(e["changes"][0])), "invalid_envelope"),
        (lambda e: e["changes"][0]["record"].update(deleted_at=iso(at(0))), "invalid_record"),
        (
            lambda e: e["changes"][0]["record"].update(started_at="2026-09-14T10:00:00"),
            "invalid_record",
        ),
        (lambda e: e["changes"][0]["record"].update(status="PAUSED"), "invalid_record"),
    ],
)
def test_structurally_invalid_envelopes_are_rejected_and_recorded(
    api: APIClient, device: Device, mutate: Any, code: str
) -> None:
    start, _ = device.start_session(at(0))
    mutate(start)

    assert codes(push(api, device, start)) == [code]
    assert ProcessedMutation.objects.get().code == code
    assert not WalkingSession.objects.exists()


# --- Retryable outcomes stop the batch ------------------------------------------------


def test_an_unsupported_store_is_retryable_unrecorded_and_ends_the_batch(
    api: APIClient, device: Device
) -> None:
    start, session_id = device.start_session(at(0))
    resistance = device.commit(
        at(1),
        puts=[("resistance_sessions", {"id": new_id(), "status": "ACTIVE"})],
    )
    bout, _ = device.start_bout(session_id, at(2))

    response = push(api, device, start, resistance, bout)

    assert results(response) == [
        {"mutation_id": start["mutation_id"], "status": "applied"},
        {
            "mutation_id": resistance["mutation_id"],
            "status": "retry",
            "code": "unsupported_store",
            "retryable": True,
            "detail": "This server does not synchronize resistance_sessions yet; "
            "keep the mutation queued.",
        },
    ]
    assert not WalkingBout.objects.exists()  # not applied ahead of the queued mutation
    assert ProcessedMutation.objects.count() == 1


def test_a_newer_envelope_version_is_retryable(api: APIClient, device: Device) -> None:
    start, _ = device.start_session(at(0))
    start["version"] = 2

    assert results(push(api, device, start))[0]["code"] == "unsupported_version"
    assert results(push(api, device, start))[0]["retryable"] is True
    assert ProcessedMutation.objects.count() == 0


def test_a_database_failure_mid_mutation_rolls_it_back_and_is_retryable(
    api: APIClient, user: User, device: Device, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Rollback: the bout is written, then the database fails before the rest is."""
    start, session_id = device.start_session(at(0))
    bout, bout_id = device.start_bout(session_id, at(1))
    assert statuses(push(api, device, start, bout)) == ["applied", "applied"]
    finish_bout, rest_id = device.finish_bout(bout_id, at(9))
    next_bout, _ = device.start_next_bout(rest_id, at(12))

    original_save = WalkingRest.save

    def failing_save(self: WalkingRest, *args: Any, **kwargs: Any) -> None:
        raise OperationalError("connection lost")

    monkeypatch.setattr(WalkingRest, "save", failing_save)
    response = push(api, device, finish_bout, next_bout)

    assert results(response) == [
        {
            "mutation_id": finish_bout["mutation_id"],
            "status": "retry",
            "code": "temporarily_unavailable",
            "retryable": True,
            "detail": "The server could not complete this mutation right now; retry later.",
        }
    ]
    assert WalkingBout.objects.get(pk=bout_id).ended_at is None  # the bout write rolled back
    assert not WalkingRest.objects.exists()
    assert WalkingBout.objects.count() == 1
    assert ProcessedMutation.objects.count() == 2
    assert _cursor(user) == 2

    monkeypatch.setattr(WalkingRest, "save", original_save)
    assert statuses(push(api, device, finish_bout, next_bout)) == ["applied", "applied"]


# --- Transactions: multi-record operations are all-or-nothing -----------------------


def test_finish_bout_and_start_rest_roll_back_together(api: APIClient, device: Device) -> None:
    start, session_id = device.start_session(at(0))
    bout, bout_id = device.start_bout(session_id, at(1))
    assert statuses(push(api, device, start, bout)) == ["applied", "applied"]
    finish_bout, rest_id = device.finish_bout(bout_id, at(9))
    rest_change = next(c for c in finish_bout["changes"] if c["store"] == "walking_rests")
    rest_change["record"]["started_at"] = iso(at(8))  # before the bout ended

    response = push(api, device, finish_bout)

    assert codes(response) == ["invalid_timing"]
    assert WalkingBout.objects.get(pk=bout_id).ended_at is None
    assert not WalkingRest.objects.filter(pk=rest_id).exists()


def test_close_rest_and_start_next_roll_back_together(api: APIClient, device: Device) -> None:
    start, session_id = device.start_session(at(0))
    bout, bout_id = device.start_bout(session_id, at(1))
    finish_bout, rest_id = device.finish_bout(bout_id, at(9))
    assert statuses(push(api, device, start, bout, finish_bout)) == ["applied"] * 3
    next_bout, next_id = device.start_next_bout(rest_id, at(12))
    bout_change = next(c for c in next_bout["changes"] if c["store"] == "walking_bouts")
    bout_change["record"]["started_at"] = iso(at(-1))  # before its session started

    assert codes(push(api, device, next_bout)) == ["invalid_timing"]
    assert WalkingRest.objects.get(pk=rest_id).ended_at is None
    assert not WalkingBout.objects.filter(pk=next_id).exists()


def test_a_database_constraint_violation_rolls_back_the_whole_mutation(
    api: APIClient, device: Device
) -> None:
    """An IntegrityError after earlier writes of the same mutation undoes them too."""
    start, session_id = device.start_session(at(0))
    bout, bout_id = device.start_bout(session_id, at(1))
    assert statuses(push(api, device, start, bout)) == ["applied", "applied"]
    second_open = device._bout_record(session_id, at(2))
    renamed = device._fields("walking_sessions", session_id, session_notes="edited")
    envelope = device.commit(
        at(2), puts=[("walking_sessions", renamed), ("walking_bouts", second_open)]
    )

    assert codes(push(api, device, envelope)) == ["active_conflict"]
    assert WalkingSession.objects.get(pk=session_id).session_notes is None
    assert list(WalkingBout.objects.values_list("id", flat=True)) == [uuid.UUID(bout_id)]


# --- PAD-06 and invalid transitions ---------------------------------------------------


def test_pad06_a_bout_cannot_start_while_a_rest_is_open(api: APIClient, device: Device) -> None:
    """PAD-06 — Rest integrity, through the API."""
    start, session_id = device.start_session(at(0))
    bout, bout_id = device.start_bout(session_id, at(1))
    finish_bout, rest_id = device.finish_bout(bout_id, at(9))
    assert statuses(push(api, device, start, bout, finish_bout)) == ["applied"] * 3

    outside_the_control, sneaky_id = device.start_bout(session_id, at(10))  # rest left open
    refused = push(api, device, outside_the_control)
    assert codes(refused) == ["invalid_transition"]
    assert "PAD-06" in results(refused)[0]["detail"]
    assert not WalkingBout.objects.filter(pk=sneaky_id).exists()
    assert WalkingRest.objects.get(pk=rest_id).ended_at is None

    start_next, next_id = device.start_next_bout(rest_id, at(12))
    assert statuses(push(api, device, start_next)) == ["applied"]
    assert WalkingRest.objects.get(pk=rest_id).ended_at == at(12)
    assert WalkingBout.objects.get(pk=next_id).ended_at is None


def _active_session(api: APIClient, device: Device) -> tuple[str, str]:
    start, session_id = device.start_session(at(0))
    bout, bout_id = device.start_bout(session_id, at(1))
    assert statuses(push(api, device, start, bout)) == ["applied", "applied"]
    return session_id, bout_id


def test_a_second_active_session_is_refused(api: APIClient, device: Device) -> None:
    _active_session(api, device)
    second, _ = device.start_session(at(3))

    response = push(api, device, second)
    assert codes(response) == ["active_conflict"]
    if connection.vendor == "postgresql":  # SQLite does not name the violated index
        assert results(response)[0]["detail"] == "Another walking session is already ACTIVE."


def test_a_second_open_bout_is_refused(api: APIClient, device: Device) -> None:
    session_id, _ = _active_session(api, device)
    second, _ = device.start_bout(session_id, at(2))

    assert codes(push(api, device, second)) == ["active_conflict"]


def test_a_second_rest_for_one_bout_is_refused(api: APIClient, device: Device) -> None:
    session_id, bout_id = _active_session(api, device)
    finish_bout, _ = device.finish_bout(bout_id, at(9))
    assert statuses(push(api, device, finish_bout)) == ["applied"]
    extra = {
        "id": new_id(),
        "walking_bout_id": bout_id,
        "started_at": iso(at(9)),
        "ended_at": iso(at(10)),
    }

    assert codes(push(api, device, device.commit(at(10), puts=[("walking_rests", extra)]))) == [
        "active_conflict"
    ]


def test_a_pause_cannot_be_open_in_an_ended_bout(api: APIClient, device: Device) -> None:
    session_id, bout_id = _active_session(api, device)
    finish_bout, _ = device.finish_bout(bout_id, at(9))
    assert statuses(push(api, device, finish_bout)) == ["applied"]
    late_pause, _ = device.pause(bout_id, at(10))

    assert codes(push(api, device, late_pause)) == ["invalid_timing"]


def test_a_bout_cannot_be_open_in_a_finished_session(api: APIClient, device: Device) -> None:
    session_id, _ = _active_session(api, device)
    assert statuses(push(api, device, device.finish_session(session_id, at(5)))) == ["applied"]
    late_bout, _ = device.start_bout(session_id, at(6))

    assert codes(push(api, device, late_bout)) == ["invalid_timing"]


@pytest.mark.parametrize("new_status", ["ACTIVE", "DISCARDED"])
def test_a_finished_session_stays_finished(api: APIClient, device: Device, new_status: str) -> None:
    session_id, _ = _active_session(api, device)
    assert statuses(push(api, device, device.finish_session(session_id, at(5)))) == ["applied"]
    fields: dict[str, Any] = {"status": new_status}
    if new_status == "ACTIVE":
        fields["completed_at"] = None

    response = push(api, device, device.edit(at(6), "walking_sessions", session_id, **fields))
    assert codes(response) == ["invalid_transition"]
    assert WalkingSession.objects.get(pk=session_id).status == "COMPLETED"


def test_a_record_cannot_move_to_another_parent(api: APIClient, device: Device) -> None:
    session_id, bout_id = _active_session(api, device)
    finish = device.finish_session(session_id, at(5))
    other_start, other_session = device.start_session(at(6))
    assert statuses(push(api, device, finish, other_start)) == ["applied", "applied"]
    moved = device.edit(at(7), "walking_bouts", bout_id, walking_session_id=other_session)

    assert codes(push(api, device, moved)) == ["invalid_transition"]


def test_a_missing_parent_is_parent_not_found(api: APIClient, device: Device) -> None:
    orphan, _ = device.start_bout(new_id(), at(1))

    assert codes(push(api, device, orphan)) == ["parent_not_found"]


def test_a_parent_cannot_be_deleted_under_live_children(api: APIClient, device: Device) -> None:
    session_id, bout_id = _active_session(api, device)
    pause, _ = device.pause(bout_id, at(2))
    assert statuses(push(api, device, pause)) == ["applied"]
    only_the_bout = device.commit(at(3), deletes=[("walking_bouts", bout_id)])

    assert codes(push(api, device, only_the_bout)) == ["invalid_transition"]
    assert WalkingBout.objects.get(pk=bout_id).deleted_at is None


# --- Timestamp ordering and containment -------------------------------------------------


@pytest.mark.parametrize(
    ("store_field", "value_minutes"),
    [
        (("walking_bouts", "ended_at"), 0.5),  # before the bout started (at 1)
        (("walking_bouts", "started_at"), -1),  # before the session started (at 0)
    ],
)
def test_bad_bout_timing_is_invalid_timing(
    api: APIClient, device: Device, store_field: tuple[str, str], value_minutes: float
) -> None:
    session_id, bout_id = _active_session(api, device)
    store, field = store_field
    edit = device.edit(at(2), store, bout_id, **{field: iso(at(value_minutes))})

    assert codes(push(api, device, edit)) == ["invalid_timing"]


def test_a_session_cannot_close_before_its_children_end(api: APIClient, device: Device) -> None:
    session_id, bout_id = _active_session(api, device)
    finish_bout, _ = device.finish_bout(bout_id, at(9))
    assert statuses(push(api, device, finish_bout)) == ["applied"]
    finish = device.finish_session(session_id, at(12))
    session_change = next(c for c in finish["changes"] if c["store"] == "walking_sessions")
    session_change["record"]["completed_at"] = iso(at(10))  # the rest closes at 12

    assert codes(push(api, device, finish)) == ["invalid_timing"]
    assert WalkingSession.objects.get(pk=session_id).status == "ACTIVE"


def test_a_time_correction_is_judged_on_the_finished_state(api: APIClient, device: Device) -> None:
    """PAD-09's correction: moving a bout's end must move what depends on it, in one mutation."""
    session_id, bout_id = _active_session(api, device)
    pause, pause_id = device.pause(bout_id, at(6))
    resume = device.resume(pause_id, at(8))
    finish_bout, rest_id = device.finish_bout(bout_id, at(20))
    assert statuses(push(api, device, pause, resume, finish_bout)) == ["applied"] * 3

    # The bout really ended at 7, mid-pause: alone, that leaves the pause outside it.
    alone = device.edit(at(21), "walking_bouts", bout_id, ended_at=iso(at(7)))
    assert codes(push(api, device, alone)) == ["invalid_timing"]
    assert WalkingBout.objects.get(pk=bout_id).ended_at == at(20)

    corrected = device.commit(
        at(22),
        puts=[
            ("walking_bouts", device._fields("walking_bouts", bout_id, ended_at=iso(at(7)))),
            ("walking_pauses", device._fields("walking_pauses", pause_id, ended_at=iso(at(7)))),
        ],
    )
    assert statuses(push(api, device, corrected)) == ["applied"]
    assert WalkingBout.objects.get(pk=bout_id).ended_at == at(7)
    assert WalkingBoutPause.objects.get(pk=pause_id).ended_at == at(7)
    assert WalkingRest.objects.get(pk=rest_id).started_at == at(20)


# --- Deletes, undo, and "latest explicit edit wins" ---------------------------------------


def test_deleting_a_bout_tombstones_it_and_its_children(api: APIClient, device: Device) -> None:
    session_id, bout_id = _active_session(api, device)
    pause, pause_id = device.pause(bout_id, at(2))
    resume = device.resume(pause_id, at(3))
    delete = device.delete_bout(bout_id, at(4))

    assert statuses(push(api, device, pause, resume, delete)) == ["applied"] * 3
    bout = WalkingBout.objects.get(pk=bout_id)
    assert bout.deleted_at == at(4)
    assert WalkingBoutPause.objects.get(pk=pause_id).deleted_at == at(4)
    # A tombstone frees the one-open-bout place.
    new_bout, _ = device.start_bout(session_id, at(5))
    assert statuses(push(api, device, new_bout)) == ["applied"]


def test_deletion_replay_changes_nothing(api: APIClient, user: User, device: Device) -> None:
    session_id, bout_id = _active_session(api, device)
    delete = device.delete_bout(bout_id, at(4))
    assert statuses(push(api, device, delete)) == ["applied"]
    tombstone = WalkingBout.objects.get(pk=bout_id)
    cursor = _cursor(user)

    assert statuses(push(api, device, delete)) == ["duplicate"]
    # The same deletion as a *new* mutation (another tab, say): already gone.
    again = device.commit(at(5), deletes=[])
    again["changes"] = copy.deepcopy(delete["changes"])
    assert statuses(push(api, device, again)) == ["applied"]

    after = WalkingBout.objects.get(pk=bout_id)
    assert (after.deleted_at, after.change_seq) == (tombstone.deleted_at, tombstone.change_seq)
    assert WalkingBout.objects.count() == 1
    assert _cursor(user) == cursor + 1  # the no-op mutation still counts as processed


def test_a_stale_replay_never_resurrects_a_tombstone(api: APIClient, device: Device) -> None:
    session_id, bout_id = _active_session(api, device)
    pain = device.edit(at(2), "walking_bouts", bout_id, pain_min=2, pain_max=2)
    delete = device.delete_bout(bout_id, at(3))
    # The delete (higher sequence) arrives first; the older edit arrives later.
    assert statuses(push(api, device, delete)) == ["applied"]

    response = push(api, device, pain)

    assert statuses(response) == ["applied"]  # acknowledged, not flagged
    bout = WalkingBout.objects.get(pk=bout_id)
    assert bout.deleted_at is not None
    assert bout.pain_min is None
    ledger = ProcessedMutation.objects.get(mutation_id=pain["mutation_id"])
    assert "superseded" in ledger.detail


def test_an_explicit_undo_restores_a_deleted_bout(api: APIClient, device: Device) -> None:
    session_id, bout_id = _active_session(api, device)
    before = device.record("walking_bouts", bout_id)
    delete = device.delete_bout(bout_id, at(3))
    undo = device.restore(at(4), "walking_bouts", before)

    assert statuses(push(api, device, delete, undo)) == ["applied", "applied"]
    assert WalkingBout.objects.get(pk=bout_id).deleted_at is None


def test_a_stale_edit_from_the_same_device_loses_even_with_a_later_clock(
    api: APIClient, device: Device
) -> None:
    """Within one device the outbox sequence decides, whatever the wall clock said."""
    session_id, bout_id = _active_session(api, device)
    older = device.edit(at(30), "walking_bouts", bout_id, pain_min=4, pain_max=5)  # clock ahead
    newer = device.edit(at(2), "walking_bouts", bout_id, pain_min=2, pain_max=3)  # clock fixed
    assert statuses(push(api, device, newer)) == ["applied"]

    assert statuses(push(api, device, older)) == ["applied"]
    bout = WalkingBout.objects.get(pk=bout_id)
    assert (bout.pain_min, bout.pain_max) == (2, 3)


def test_across_devices_the_last_committed_edit_wins(api: APIClient, device: Device) -> None:
    session_id, bout_id = _active_session(api, device)
    tablet = Device()
    tablet.records = copy.deepcopy(device.records)
    phone_edit = device.edit(at(5), "walking_bouts", bout_id, pain_min=2, pain_max=2)
    tablet_edit = tablet.edit(at(4), "walking_bouts", bout_id, pain_min=4, pain_max=4)

    assert statuses(push(api, device, phone_edit)) == ["applied"]
    assert statuses(push(api, tablet, tablet_edit)) == ["applied"]
    assert WalkingBout.objects.get(pk=bout_id).pain_min == 4


# --- Ownership -------------------------------------------------------------------------


def test_another_account_cannot_touch_or_see_these_records(
    api: APIClient, other_api: APIClient, device: Device
) -> None:
    start, session_id = device.start_session(at(0))
    bout, bout_id = device.start_bout(session_id, at(1))
    assert statuses(push(api, device, start, bout)) == ["applied", "applied"]
    intruder = Device()
    intruder.records = copy.deepcopy(device.records)

    overwrite = intruder.edit(at(2), "walking_sessions", session_id, session_notes="mine")
    child, _ = intruder.start_bout(session_id, at(3))
    delete = intruder.delete_bout(bout_id, at(4))
    replay = copy.deepcopy(start)
    replay["sequence"] = intruder.sequence + 1

    response = push(other_api, intruder, overwrite, child, delete, replay)

    assert codes(response) == ["not_found", "parent_not_found", None, "mutation_id_conflict"]
    assert statuses(response)[2] == "applied"  # nothing of this account's to delete
    assert WalkingSession.objects.get(pk=session_id).session_notes is None
    assert WalkingBout.objects.get(pk=bout_id).deleted_at is None
    assert WalkingBout.objects.count() == 1
    assert other_api.get("/api/v1/sync/changes/").json()["changes"] == []
