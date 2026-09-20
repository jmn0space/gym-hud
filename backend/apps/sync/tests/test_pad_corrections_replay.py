"""Replay actual frontend #22 actions (correction, undo, delete-with-renumber)
through the authenticated sync endpoint.

``frontend/src/padCorrectionsReplay.test.ts`` generates and checks the
committed IndexedDB outbox fixture. Keep that test and this one paired: this
side does not invent envelopes or bypass ``POST /api/v1/sync/mutations/``.
Deliberately a separate fixture/test pair from issue #21's
(``pad_workflow_outbox.json`` / ``test_pad_workflow_replay.py``) so that
proof stays exactly as it was.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from django.contrib.auth.models import User
from rest_framework.test import APIClient

from apps.pad.models import WalkingBout, WalkingBoutPause, WalkingRest, WalkingSession
from apps.sync.models import ProcessedMutation, SyncState
from apps.sync.tests.conftest import MUTATIONS_URL, results

pytestmark = pytest.mark.django_db

FIXTURE = Path(__file__).parent / "fixtures" / "pad_corrections_outbox.json"
BASE_TIME = datetime(2026, 9, 20, 10, tzinfo=UTC)
SESSION_ID = uuid.UUID("00000000-0000-4000-8000-000000000302")
BOUT_1_ID = uuid.UUID("00000000-0000-4000-8000-000000000303")
BOUT_2_ID = uuid.UUID("00000000-0000-4000-8000-000000000304")
BOUT_3_ID = uuid.UUID("00000000-0000-4000-8000-000000000305")
REST_1_ID = uuid.UUID("00000000-0000-4000-8000-000000000306")
REST_2_ID = uuid.UUID("00000000-0000-4000-8000-000000000307")
REST_2B_ID = uuid.UUID("00000000-0000-4000-8000-000000000308")
REST_3_ID = uuid.UUID("00000000-0000-4000-8000-000000000309")
PAUSE_1_ID = uuid.UUID("00000000-0000-4000-8000-000000000310")


def at(minute: int) -> datetime:
    return BASE_TIME + timedelta(minutes=minute)


def _server_state(user: User) -> tuple[int, dict[str, list[tuple[Any, ...]]]]:
    """Enough state to prove a second delivery made no record or cursor write."""
    return SyncState.objects.get(user=user).change_seq, {
        model.__name__: list(
            model.objects.filter(user=user)
            .order_by("pk")
            .values_list("pk", "change_seq", "server_updated_at", "deleted_at")
        )
        for model in (WalkingSession, WalkingBout, WalkingBoutPause, WalkingRest)
    }


def test_frontend_pad_corrections_outbox_applies_once_and_replays_as_duplicates(
    api: APIClient, user: User
) -> None:
    payload: dict[str, Any] = json.loads(FIXTURE.read_text())
    mutations: list[dict[str, Any]] = payload["mutations"]
    assert len(mutations) == 14
    assert [item["sequence"] for item in mutations] == list(range(1, 15))
    assert len({item["mutation_id"] for item in mutations}) == len(mutations)

    # Mutation 6 is the PAD-09 correction: only the bout moves.
    assert {(c["store"], c["operation"]) for c in mutations[5]["changes"]} == {
        ("walking_sessions", "put"),
        ("walking_bouts", "put"),
    }
    # Mutation 9 is the undo of "bout finished": bout reopened, rest tombstoned.
    assert {(c["store"], c["operation"]) for c in mutations[8]["changes"]} == {
        ("walking_sessions", "put"),
        ("walking_bouts", "put"),
        ("walking_rests", "delete"),
    }
    # Mutation 13 is the delete-with-renumber: one transaction, one envelope
    # (owner decision, issue #22), tombstoning bout 2 and its rest while
    # putting bout 3's renumbered record.
    delete_changes = {(c["store"], c["operation"]) for c in mutations[12]["changes"]}
    assert delete_changes == {
        ("walking_sessions", "put"),
        ("walking_bouts", "put"),
        ("walking_rests", "delete"),
        ("walking_bouts", "delete"),
    }

    response = api.post(MUTATIONS_URL, payload, format="json")
    assert results(response) == [
        {"mutation_id": item["mutation_id"], "status": "applied"} for item in mutations
    ]

    session = WalkingSession.objects.get(pk=SESSION_ID, user=user)
    first = WalkingBout.objects.get(pk=BOUT_1_ID, user=user)
    third = WalkingBout.objects.get(pk=BOUT_3_ID, user=user)
    pause = WalkingBoutPause.objects.get(pk=PAUSE_1_ID, user=user)
    first_rest = WalkingRest.objects.get(pk=REST_1_ID, user=user)

    assert (session.status, session.completed_at) == ("COMPLETED", at(24))

    # PAD-09: the corrected end time stands, and everything derived from it
    # (the effective walking time the bout+pause combination implies) is
    # exactly what the correction should produce.
    assert (first.started_at, first.ended_at) == (at(1), at(8))
    assert (pause.started_at, pause.ended_at) == (at(2), at(3))
    assert first_rest.started_at == at(20)  # unmoved by the bout-end correction

    # Mutation 8 (the first finish of bout 2) is still in the fixture and is
    # pushed and applied like any other -- undo never removes anything from
    # the outbox (owner decision, issue #22) -- so its rest exists on the
    # server too, but as a tombstone: mutation 9's undo deleted it.
    assert WalkingRest.objects.get(pk=REST_2_ID).deleted_at is not None

    # Bout 2 and its rest are tombstoned by the delete; bout 3 renumbered to 2,
    # its own UUID unchanged (owner decision: UUIDs never change).
    deleted_bout = WalkingBout.objects.get(pk=BOUT_2_ID)
    assert deleted_bout.deleted_at is not None
    assert WalkingRest.objects.get(pk=REST_2B_ID).deleted_at is not None
    assert (third.bout_number, third.deleted_at) == (2, None)
    assert (first.bout_number, first.deleted_at) == (1, None)
    assert not WalkingBout.objects.filter(user=user, ended_at__isnull=True).exists()
    live_open_rests = WalkingRest.objects.filter(
        user=user, deleted_at__isnull=True, ended_at__isnull=True
    )
    assert not live_open_rests.exists()
    assert ProcessedMutation.objects.filter(user=user, status="applied").count() == len(mutations)

    before = _server_state(user)
    duplicate = api.post(MUTATIONS_URL, payload, format="json")
    assert results(duplicate) == [
        {"mutation_id": item["mutation_id"], "status": "duplicate"} for item in mutations
    ]
    assert _server_state(user) == before
    assert ProcessedMutation.objects.filter(user=user).count() == len(mutations)
