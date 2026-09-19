"""Django Admin: editable PAD defaults, read-only workout records and ledger."""

from __future__ import annotations

import pytest
from django.contrib.auth.models import User
from django.test import Client
from rest_framework.test import APIClient

from apps.pad.models import PadDefaults, WalkingBout, WalkingSession
from apps.sync.models import ProcessedMutation
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
