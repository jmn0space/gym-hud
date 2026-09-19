"""Unit tests for the wire vocabulary, envelope parsing and the registry."""

from __future__ import annotations

import copy
from datetime import UTC, datetime
from typing import Any

import pytest
from django.core.exceptions import ImproperlyConfigured

from apps.pad.sync import PAD_DOMAIN
from apps.sync.envelope import InvalidRequest, parse_batch, parse_envelope
from apps.sync.protocol import (
    Ack,
    Deferred,
    Rejected,
    canonical_json,
    fingerprint,
    format_timestamp,
    is_canonical_uuid,
    parse_timestamp,
)
from apps.sync.registry import SyncDomain, all_specs, child_specs, register
from apps.sync.tests.device import Device, at, new_id

CLIENT_ID = "6f9619ff-8b86-4011-b42d-00c04fc964ff"


def _start() -> dict[str, Any]:
    envelope, _ = Device().start_session(at(0))
    return envelope


# --- Acknowledgements ------------------------------------------------------------


def test_ack_shapes_follow_the_agreed_contract() -> None:
    assert Ack("m", "applied").as_dict() == {"mutation_id": "m", "status": "applied"}
    assert Ack("m", "duplicate").as_dict() == {"mutation_id": "m", "status": "duplicate"}
    assert Ack("m", "rejected", "invalid_record", "bad").as_dict() == {
        "mutation_id": "m",
        "status": "rejected",
        "code": "invalid_record",
        "retryable": False,
        "detail": "bad",
    }
    assert Ack("m", "retry", "unsupported_store", "later").as_dict() == {
        "mutation_id": "m",
        "status": "retry",
        "code": "unsupported_store",
        "retryable": True,
        "detail": "later",
    }


# --- Canonical form and fingerprint ---------------------------------------------------


def test_the_fingerprint_ignores_key_order_but_not_values() -> None:
    envelope = _start()
    reordered = dict(reversed(list(envelope.items())))
    changed = copy.deepcopy(envelope)
    changed["changes"][0]["record"]["speed_kmh"] = 6

    assert fingerprint(canonical_json(envelope)) == fingerprint(canonical_json(reordered))
    assert fingerprint(canonical_json(envelope)) != fingerprint(canonical_json(changed))


def test_canonical_json_keeps_control_characters_escaped() -> None:
    """The ledger stores this text; PostgreSQL text cannot hold a NUL byte."""
    text = canonical_json({"notes": "a\x00b", "accent": "caf\u00e9"})

    assert "\x00" not in text
    assert text == '{"accent":"caf\\u00e9","notes":"a\\u0000b"}'


def test_timestamps_round_trip_in_the_local_repository_format() -> None:
    moment = datetime(2026, 9, 14, 10, 15, 30, 123000, tzinfo=UTC)

    assert format_timestamp(moment) == "2026-09-14T10:15:30.123Z"
    assert parse_timestamp("2026-09-14T10:15:30.123Z") == moment
    assert parse_timestamp("2026-09-14T10:15:30.123") is None


@pytest.mark.parametrize(
    ("value", "canonical"),
    [
        ("6f9619ff-8b86-4011-b42d-00c04fc964ff", True),
        ("6F9619FF-8B86-4011-B42D-00C04FC964FF", False),
        ("6f9619ff8b864011b42d00c04fc964ff", False),
        ("{6f9619ff-8b86-4011-b42d-00c04fc964ff}", False),
        ("urn:uuid:6f9619ff-8b86-4011-b42d-00c04fc964ff", False),
        ("6f9619ff-8b86-4011-b42d-00c04fc964ff\n", False),
        (None, False),
    ],
)
def test_only_the_canonical_uuid_spelling_is_accepted(value: object, canonical: bool) -> None:
    assert is_canonical_uuid(value) is canonical


# --- Request and envelope parsing -------------------------------------------------------


def test_a_batch_leaves_broken_items_to_their_own_acknowledgement() -> None:
    batch = parse_batch(
        {"client_id": CLIENT_ID, "mutations": ["junk", {"sequence": 1}, {"sequence": "x"}]}
    )

    assert str(batch.client_id) == CLIENT_ID
    assert len(batch.mutations) == 3


def test_a_batch_must_ascend_by_sequence() -> None:
    with pytest.raises(InvalidRequest, match="ascending"):
        parse_batch({"client_id": CLIENT_ID, "mutations": [{"sequence": 3}, {"sequence": 3}]})


def test_a_frontend_envelope_parses_into_ordered_changes() -> None:
    device = Device()
    start, session_id = device.start_session(at(0))
    bout, _ = device.start_bout(session_id, at(1))
    finish = device.finish_session(session_id, at(5))

    envelope = parse_envelope(finish)

    assert envelope.sequence == 3
    assert [change.spec.store for change in envelope.changes] == [
        "walking_sessions",
        "walking_bouts",
    ]
    assert parse_envelope(start).changes[0].values["status"] == "ACTIVE"
    assert parse_envelope(bout).changes[0].operation == "put"


def test_a_newer_version_is_deferred_and_an_invalid_one_rejected() -> None:
    with pytest.raises(Deferred) as deferred:
        parse_envelope({**_start(), "version": 2})
    assert deferred.value.code == "unsupported_version"

    with pytest.raises(Rejected) as rejected:
        parse_envelope({**_start(), "version": 0})
    assert rejected.value.code == "invalid_envelope"


def test_an_unsupported_store_is_deferred_before_records_are_judged() -> None:
    """A future server may accept the whole mutation, broken PAD record and all."""
    envelope = _start()
    envelope["changes"][0]["record"]["speed_kmh"] = -1
    envelope["changes"].append(
        {
            "store": "cardio_sessions",
            "entity_type": "cardio_machine_session",
            "entity_id": new_id(),
            "operation": "put",
            "record": {},
        }
    )

    with pytest.raises(Deferred) as deferred:
        parse_envelope(envelope)
    assert deferred.value.code == "unsupported_store"
    assert "cardio_sessions" in deferred.value.detail


def test_a_delete_needs_a_tombstone_timestamp() -> None:
    device = Device()
    start, session_id = device.start_session(at(0))
    delete = device.commit(at(1), deletes=[("walking_sessions", session_id)])
    assert parse_envelope(delete).changes[0].values["deleted_at"] == at(1)

    delete["changes"][0]["record"]["deleted_at"] = None
    with pytest.raises(Rejected) as rejected:
        parse_envelope(delete)
    assert rejected.value.code == "invalid_record"
    assert rejected.value.detail.startswith(f"walking_sessions/{session_id}: ")


def test_a_delete_must_name_its_target_consistently() -> None:
    device = Device()
    _, session_id = device.start_session(at(0))
    delete = device.commit(at(1), deletes=[("walking_sessions", session_id)])
    delete["changes"][0]["id"] = new_id()

    with pytest.raises(Rejected, match="id must equal entity_id"):
        parse_envelope(delete)


# --- Registry -----------------------------------------------------------------------


def test_pad_is_registered_parents_first() -> None:
    assert [spec.store for spec in all_specs()] == [
        "walking_sessions",
        "walking_bouts",
        "walking_pauses",
        "walking_rests",
    ]
    assert [spec.store for spec in child_specs("walking_bouts")] == [
        "walking_pauses",
        "walking_rests",
    ]


def test_registering_is_idempotent_but_names_stay_unique() -> None:
    register(PAD_DOMAIN)  # the same object again: a no-op

    impostor = SyncDomain(
        name="pad",
        stores=(),
        check_mutation=lambda ctx, written: None,
        bootstrap=lambda user_id: {},
        integrity_details={},
    )
    with pytest.raises(ImproperlyConfigured):
        register(impostor)
    with pytest.raises(ImproperlyConfigured):
        register(
            SyncDomain(
                name="pad-copy",
                stores=PAD_DOMAIN.stores,
                check_mutation=lambda ctx, written: None,
                bootstrap=lambda user_id: {},
                integrity_details={},
            )
        )
