"""Django Admin: editable PAD defaults, read-only workout records and ledger."""

from __future__ import annotations

import json
from typing import Any

import pytest
from django.contrib.admin.models import LogEntry
from django.contrib.auth.models import Permission, User
from django.test import Client
from rest_framework.test import APIClient

from apps.pad.models import PadDefaults, WalkingBout, WalkingBoutPause, WalkingSession
from apps.sync.models import SERVER_CLIENT_ID, ProcessedMutation, SyncState
from apps.sync.tests.conftest import BOOTSTRAP_URL, push, statuses
from apps.sync.tests.device import Device, at

pytestmark = pytest.mark.django_db


@pytest.fixture
def admin_client_logged_in(db: None) -> tuple[Client, User]:
    admin = User.objects.create_superuser(username="admin", password="unused-password")
    client = Client()
    client.force_login(admin)
    return client, admin


def _seed(user: User) -> tuple[str, str]:
    api = APIClient()
    api.force_login(user)
    device = Device()
    start, session_id = device.start_session(at(0))
    bout, bout_id = device.start_bout(session_id, at(1))
    pause, _ = device.pause(bout_id, at(2))
    assert statuses(push(api, device, start, bout, pause)) == ["applied"] * 3
    return session_id, bout_id


def test_pad_records_and_the_ledger_are_viewable_but_read_only(
    admin_client_logged_in: tuple[Client, User],
) -> None:
    client, admin = admin_client_logged_in
    session_id, bout_id = _seed(admin)
    mutation = ProcessedMutation.objects.first()
    assert mutation is not None

    for url in (
        "/admin/pad/walkingsession/",
        f"/admin/pad/walkingsession/{session_id}/change/",
        "/admin/pad/walkingbout/",
        f"/admin/pad/walkingbout/{bout_id}/change/",
        "/admin/sync/processedmutation/",
        f"/admin/sync/processedmutation/{mutation.pk}/change/",
    ):
        response = client.get(url)
        assert response.status_code == 200, url
        assert b'name="_save"' not in response.content, url  # view-only

    for url in ("/admin/pad/walkingsession/add/", "/admin/sync/processedmutation/add/"):
        assert client.get(url).status_code == 403, url
    assert client.get(f"/admin/pad/walkingsession/{session_id}/delete/").status_code == 403
    assert client.get(f"/admin/sync/processedmutation/{mutation.pk}/delete/").status_code == 403

    # Posting to a view-only page changes nothing.
    client.post(f"/admin/pad/walkingbout/{bout_id}/change/", {"bout_number": 9})
    assert WalkingBout.objects.get(pk=bout_id).bout_number == 1
    assert WalkingSession.objects.count() == 1


def test_pad_defaults_are_an_editable_singleton(
    admin_client_logged_in: tuple[Client, User],
) -> None:
    client, admin = admin_client_logged_in

    assert client.get("/admin/pad/paddefaults/add/").status_code == 200
    response = client.post(
        "/admin/pad/paddefaults/add/",
        {"speed_kmh": "4.5", "incline_pct": "1.0", "max_bout_seconds": "420"},
    )
    assert response.status_code == 302
    defaults = PadDefaults.objects.get()
    assert defaults.pk == PadDefaults.SINGLETON_ID

    assert client.get("/admin/pad/paddefaults/add/").status_code == 403  # only one
    assert client.get("/admin/pad/paddefaults/1/delete/").status_code == 403
    response = client.post(
        "/admin/pad/paddefaults/1/change/",
        {"speed_kmh": "0", "incline_pct": "1.0", "max_bout_seconds": "420"},
    )
    assert response.status_code == 200  # the form re-renders with the validation error
    assert PadDefaults.objects.get().speed_kmh == defaults.speed_kmh

    api = APIClient()
    api.force_login(admin)
    served = api.get(BOOTSTRAP_URL).json()["pad"]["defaults"]
    assert served == {"speed_kmh": 4.5, "incline_pct": 1.0, "max_bout_seconds": 420}


def _discard(client: Client, *session_ids: str) -> Any:
    return client.post(
        "/admin/pad/walkingsession/",
        {"action": "discard_stuck_sessions", "_selected_action": list(session_ids)},
        follow=True,
    )


def test_discarding_a_stuck_session_goes_through_the_engine(
    admin_client_logged_in: tuple[Client, User],
) -> None:
    client, admin = admin_client_logged_in
    session_id, bout_id = _seed(admin)  # a bout and a pause still open
    cursor = SyncState.objects.get(user=admin).change_seq

    response = _discard(client, session_id)

    assert response.status_code == 200
    assert b"Discarded 1 stuck session" in response.content
    session = WalkingSession.objects.get(pk=session_id)
    assert (session.status, session.completed_at) == ("DISCARDED", at(2))
    assert WalkingBout.objects.get(pk=bout_id).ended_at == at(2)
    assert not WalkingBoutPause.objects.filter(ended_at__isnull=True).exists()
    assert SyncState.objects.get(user=admin).change_seq == cursor + 1
    assert session.change_seq == cursor + 1
    assert session.last_client_id == SERVER_CLIENT_ID
    entry = ProcessedMutation.objects.get(code="admin_discard")
    assert (entry.user_id, entry.client_id, entry.change_seq) == (
        admin.pk,
        SERVER_CLIENT_ID,
        cursor + 1,
    )
    assert "by admin" in entry.detail
    assert json.loads(entry.envelope)["actor"] == "admin"
    assert LogEntry.objects.filter(object_id=session_id).exists()
    # The devices learn about it through the changes feed.
    api = APIClient()
    api.force_login(admin)
    feed = api.get("/api/v1/sync/changes/", {"since": cursor}).json()
    assert {c["entity_id"] for c in feed["changes"]} >= {session_id, bout_id}


def test_only_an_active_session_can_be_discarded(
    admin_client_logged_in: tuple[Client, User],
) -> None:
    client, admin = admin_client_logged_in
    api = APIClient()
    api.force_login(admin)
    device = Device()
    start, session_id = device.start_session(at(0))
    finish = device.finish_session(session_id, at(5))
    assert statuses(push(api, device, start, finish)) == ["applied", "applied"]
    cursor = SyncState.objects.get(user=admin).change_seq

    response = _discard(client, session_id)

    assert b"only a live ACTIVE session can be" in response.content
    assert WalkingSession.objects.get(pk=session_id).status == "COMPLETED"
    assert SyncState.objects.get(user=admin).change_seq == cursor
    assert not ProcessedMutation.objects.filter(code="admin_discard").exists()


def test_the_discard_action_needs_the_change_permission(db: None) -> None:
    staff = User.objects.create_user(username="viewer", password="unused-password", is_staff=True)
    staff.user_permissions.add(Permission.objects.get(codename="view_walkingsession"))
    session_id, _ = _seed(staff)
    client = Client()
    client.force_login(staff)

    page = client.get("/admin/pad/walkingsession/")
    assert page.status_code == 200
    assert b"discard_stuck_sessions" not in page.content
    _discard(client, session_id)
    assert WalkingSession.objects.get(pk=session_id).status == "ACTIVE"
