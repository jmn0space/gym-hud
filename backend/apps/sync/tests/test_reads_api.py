"""``GET /api/v1/sync/bootstrap/`` and ``GET /api/v1/sync/changes/``."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest
from rest_framework.test import APIClient

from apps.pad.models import PadDefaults
from apps.sync.tests.conftest import BOOTSTRAP_URL, CHANGES_URL, push, statuses
from apps.sync.tests.device import Device, at

pytestmark = pytest.mark.django_db


def _all_changes(api: APIClient, limit: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Page through the whole feed; returns (entries, pages)."""
    entries: list[dict[str, Any]] = []
    pages: list[dict[str, Any]] = []
    cursor = 0
    while True:
        response = api.get(CHANGES_URL, {"since": cursor, "limit": limit})
        assert response.status_code == 200
        page: dict[str, Any] = response.json()
        pages.append(page)
        entries.extend(page["changes"])
        assert page["cursor"] >= cursor
        cursor = page["cursor"]
        if not page["has_more"]:
            return entries, pages


# --- Bootstrap ------------------------------------------------------------------


def test_bootstrap_serves_the_application_defaults(api: APIClient) -> None:
    response = api.get(BOOTSTRAP_URL)

    assert response.status_code == 200
    assert "no-store" in response.headers["Cache-Control"]
    assert response.json() == {
        "cursor": 0,
        "limits": {"max_mutations_per_request": 50, "max_changes_per_mutation": 500},
        "pad": {
            "defaults": {"speed_kmh": 5.0, "incline_pct": 2.0, "max_bout_seconds": 480},
            "next_session_settings": {
                "source": "defaults",
                "walking_session_id": None,
                "speed_kmh": 5.0,
                "incline_pct": 2.0,
                "max_bout_seconds": 480,
            },
        },
    }


def test_server_configuration_wins_for_the_defaults(api: APIClient) -> None:
    PadDefaults.objects.create(
        speed_kmh=Decimal("4.5"), incline_pct=Decimal("1.5"), max_bout_seconds=420
    )

    pad = api.get(BOOTSTRAP_URL).json()["pad"]

    assert pad["defaults"] == {"speed_kmh": 4.5, "incline_pct": 1.5, "max_bout_seconds": 420}
    assert pad["next_session_settings"]["source"] == "defaults"
    assert pad["next_session_settings"]["speed_kmh"] == 4.5


def test_a_new_session_inherits_the_latest_completed_one(api: APIClient, device: Device) -> None:
    older, older_id = device.start_session(at(0), speed_kmh=4)
    finish_older = device.finish_session(older_id, at(10))
    latest, latest_id = device.start_session(at(20), speed_kmh=5.65, max_bout_seconds=445)
    finish_latest = device.finish_session(latest_id, at(30))
    discarded, discarded_id = device.start_session(at(40), speed_kmh=9)
    discard = device.finish_session(discarded_id, at(41), status="DISCARDED")
    envelopes = [older, finish_older, latest, finish_latest, discarded, discard]
    assert statuses(push(api, device, *envelopes)) == ["applied"] * 6

    pad = api.get(BOOTSTRAP_URL).json()["pad"]

    assert pad["next_session_settings"] == {
        "source": "previous_session",
        "walking_session_id": latest_id,
        "speed_kmh": 5.65,
        "incline_pct": 2.0,
        "max_bout_seconds": 445,
    }
    assert pad["defaults"]["speed_kmh"] == 5.0  # defaults are still reported as such

    delete = device.commit(at(50), deletes=[("walking_sessions", latest_id)])
    assert statuses(push(api, device, delete)) == ["applied"]
    inherited = api.get(BOOTSTRAP_URL).json()["pad"]["next_session_settings"]
    assert inherited["walking_session_id"] == older_id  # a tombstone is not inherited from


def test_bootstrap_reports_the_cursor(api: APIClient, device: Device) -> None:
    start, session_id = device.start_session(at(0))
    bout, _ = device.start_bout(session_id, at(1))
    assert statuses(push(api, device, start, bout)) == ["applied", "applied"]

    assert api.get(BOOTSTRAP_URL).json()["cursor"] == 2


# --- Changes feed --------------------------------------------------------------------


def _session_with_history(api: APIClient, device: Device) -> list[dict[str, Any]]:
    start, session_id = device.start_session(at(0))
    bout1, bout1_id = device.start_bout(session_id, at(1))
    pause, pause_id = device.pause(bout1_id, at(2))
    resume = device.resume(pause_id, at(3))
    finish1, rest1_id = device.finish_bout(bout1_id, at(8))
    bout2, bout2_id = device.start_next_bout(rest1_id, at(10))
    delete2 = device.delete_bout(bout2_id, at(11))
    finish = device.finish_session(session_id, at(12))
    envelopes = [start, bout1, pause, resume, finish1, bout2, delete2, finish]
    assert statuses(push(api, device, *envelopes)) == ["applied"] * len(envelopes)
    return envelopes


def test_the_feed_returns_exactly_the_records_the_device_holds(
    api: APIClient, device: Device
) -> None:
    """Tombstones included, byte for byte the local shape: a device can store them as-is."""
    _session_with_history(api, device)

    body = api.get(CHANGES_URL).json()

    assert body["has_more"] is False
    assert body["cursor"] == 8
    served = {(entry["store"], entry["entity_id"]): entry["record"] for entry in body["changes"]}
    assert served == device.records
    tombstones = [entry for entry in body["changes"] if entry["record"]["deleted_at"]]
    assert [entry["store"] for entry in tombstones] == ["walking_bouts"]
    for entry in body["changes"]:
        assert entry["entity_type"] == entry["store"][:-1]


def test_the_feed_orders_changes_oldest_first_and_parents_first(
    api: APIClient, device: Device
) -> None:
    start, session_id = device.start_session(at(0))
    bout, bout_id = device.start_bout(session_id, at(1))
    finish_bout, _ = device.finish_bout(bout_id, at(5))
    assert statuses(push(api, device, start, bout, finish_bout)) == ["applied"] * 3

    changes = api.get(CHANGES_URL).json()["changes"]

    assert [(c["change_seq"], c["store"]) for c in changes] == [
        (1, "walking_sessions"),
        (3, "walking_bouts"),  # rewritten by finish_bout, so it moved to change 3
        (3, "walking_rests"),
    ]


def test_a_page_lists_a_parent_before_an_older_child(api: APIClient, device: Device) -> None:
    """The session was edited after its bout was written: it still comes first on the page."""
    start, session_id = device.start_session(at(0))
    bout, _ = device.start_bout(session_id, at(1))
    edit = device.edit(at(2), "walking_sessions", session_id, session_notes="hi")
    assert statuses(push(api, device, start, bout, edit)) == ["applied"] * 3

    page = api.get(CHANGES_URL).json()
    assert [(c["store"], c["change_seq"]) for c in page["changes"]] == [
        ("walking_sessions", 3),
        ("walking_bouts", 2),
    ]
    assert (page["cursor"], page["has_more"]) == (3, False)

    # Paging still follows change order: the bout's page cannot wait for its parent.
    first = api.get(CHANGES_URL, {"limit": 1}).json()
    assert [(c["store"], c["change_seq"]) for c in first["changes"]] == [("walking_bouts", 2)]
    assert (first["cursor"], first["has_more"]) == (2, True)


def test_the_feed_pages_on_mutation_boundaries(api: APIClient, device: Device) -> None:
    _session_with_history(api, device)
    whole = api.get(CHANGES_URL).json()["changes"]

    entries, pages = _all_changes(api, limit=2)

    assert sorted((e["store"], e["entity_id"]) for e in entries) == sorted(
        (e["store"], e["entity_id"]) for e in whole
    )
    assert len(entries) == len(whole)  # every record exactly once
    for earlier, later in zip(pages, pages[1:], strict=False):
        last_seq = earlier["changes"][-1]["change_seq"]
        assert all(entry["change_seq"] > last_seq for entry in later["changes"])
    assert pages[-1]["cursor"] == 8


def test_the_feed_only_returns_what_changed_since_the_cursor(
    api: APIClient, device: Device
) -> None:
    start, session_id = device.start_session(at(0))
    assert statuses(push(api, device, start)) == ["applied"]
    cursor = api.get(CHANGES_URL).json()["cursor"]
    bout, bout_id = device.start_bout(session_id, at(1))
    assert statuses(push(api, device, bout)) == ["applied"]

    body = api.get(CHANGES_URL, {"since": cursor}).json()

    assert [entry["entity_id"] for entry in body["changes"]] == [bout_id]
    assert api.get(CHANGES_URL, {"since": body["cursor"]}).json() == {
        "changes": [],
        "cursor": body["cursor"],
        "has_more": False,
    }


@pytest.mark.parametrize(
    "params",
    [{"since": "-1"}, {"since": "abc"}, {"limit": "0"}, {"limit": "501"}, {"since": "١"}],
)
def test_bad_feed_parameters_are_400(api: APIClient, params: dict[str, str]) -> None:
    response = api.get(CHANGES_URL, params)

    assert response.status_code == 400
    assert response.json()["code"] == "invalid_request"


def test_the_feed_is_per_account(api: APIClient, other_api: APIClient, device: Device) -> None:
    start, _ = device.start_session(at(0))
    assert statuses(push(api, device, start)) == ["applied"]

    assert other_api.get(CHANGES_URL).json() == {"changes": [], "cursor": 0, "has_more": False}
    assert other_api.get(BOOTSTRAP_URL).json()["cursor"] == 0
