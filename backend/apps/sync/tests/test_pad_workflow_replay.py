"""Replay actual frontend #21 actions through the authenticated sync endpoint.

``frontend/src/padWorkflowReplay.test.ts`` generates and checks the committed
IndexedDB outbox fixture. Keep that test and this one paired: this side does not
invent envelopes or bypass ``POST /api/v1/sync/mutations/``.
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

FIXTURE = Path(__file__).parent / "fixtures" / "pad_workflow_outbox.json"
BASE_TIME = datetime(2026, 9, 19, 10, tzinfo=UTC)
SESSION_ID = uuid.UUID("00000000-0000-4000-8000-000000000201")
BOUT_1_ID = uuid.UUID("00000000-0000-4000-8000-000000000202")
BOUT_2_ID = uuid.UUID("00000000-0000-4000-8000-000000000203")
REST_1_ID = uuid.UUID("00000000-0000-4000-8000-000000000204")
REST_2_ID = uuid.UUID("00000000-0000-4000-8000-000000000205")


def at(minute: int) -> datetime:
    return BASE_TIME + timedelta(minutes=minute)


def _server_state(user: User) -> tuple[int, dict[str, list[tuple[Any, ...]]]]:
    """Enough state to prove a second delivery made no record or cursor write."""
    return SyncState.objects.get(user=user).change_seq, {
        model.__name__: list(
            model.objects.filter(user=user)
            .order_by("pk")
            .values_list("pk", "change_seq", "server_updated_at")
        )
        for model in (WalkingSession, WalkingBout, WalkingBoutPause, WalkingRest)
    }


def test_frontend_pad_workflow_outbox_applies_once_and_replays_as_duplicates(
    api: APIClient, user: User
) -> None:
    payload: dict[str, Any] = json.loads(FIXTURE.read_text())
    mutations: list[dict[str, Any]] = payload["mutations"]
    assert len(mutations) == 13
    assert [item["sequence"] for item in mutations] == list(range(1, 14))
    assert len({item["mutation_id"] for item in mutations}) == len(mutations)

    # The third pause remains open until finish bout. The frontend's one action
    # must close it and its bout and open rest together in mutation 8.
    assert {(change["store"], change["operation"]) for change in mutations[7]["changes"]} == {
        ("walking_sessions", "put"),
        ("walking_pauses", "put"),
        ("walking_bouts", "put"),
        ("walking_rests", "put"),
    }
    assert {(change["store"], change["operation"]) for change in mutations[12]["changes"]} == {
        ("walking_rests", "put"),
        ("walking_sessions", "put"),
    }

    response = api.post(MUTATIONS_URL, payload, format="json")
    assert results(response) == [
        {"mutation_id": item["mutation_id"], "status": "applied"} for item in mutations
    ]

    session = WalkingSession.objects.get(pk=SESSION_ID, user=user)
    first = WalkingBout.objects.get(pk=BOUT_1_ID, user=user)
    second = WalkingBout.objects.get(pk=BOUT_2_ID, user=user)
    pauses = list(WalkingBoutPause.objects.filter(walking_bout=first).order_by("started_at"))
    first_rest = WalkingRest.objects.get(pk=REST_1_ID, user=user)
    second_rest = WalkingRest.objects.get(pk=REST_2_ID, user=user)

    assert (session.status, session.started_at, session.completed_at) == (
        "COMPLETED",
        at(0),
        at(15),
    )
    assert (session.speed_kmh, session.incline_pct, session.max_bout_seconds) == (5.65, 2.5, 445)
    assert session.session_notes == "Recovered before bout two"
    assert (first.bout_number, first.started_at, first.ended_at) == (1, at(1), at(7))
    assert (first.pain_min, first.pain_max, first.stop_reason) == (3, 4, "CLAUDICATION")
    assert first.notes == "Calf pain after third pause"
    assert [(pause.started_at, pause.ended_at) for pause in pauses] == [
        (at(2), at(3)),
        (at(4), at(5)),
        (at(6), at(7)),
    ]
    assert (first_rest.started_at, first_rest.ended_at) == (at(7), at(10))
    assert (second.bout_number, second.started_at, second.ended_at) == (2, at(10), at(12))
    assert (second_rest.started_at, second_rest.ended_at) == (at(12), at(15))
    assert first.ended_at is not None
    assert second.ended_at is not None
    paused = timedelta()
    for pause in pauses:
        assert pause.ended_at is not None
        paused += pause.ended_at - pause.started_at
    first_effective = (first.ended_at - first.started_at) - paused
    assert first_effective == timedelta(minutes=3)
    assert first_effective + (second.ended_at - second.started_at) == timedelta(minutes=5)
    assert not WalkingBout.objects.filter(user=user, ended_at__isnull=True).exists()
    assert not WalkingBoutPause.objects.filter(user=user, ended_at__isnull=True).exists()
    assert not WalkingRest.objects.filter(user=user, ended_at__isnull=True).exists()
    assert ProcessedMutation.objects.filter(user=user, status="applied").count() == len(mutations)

    before = _server_state(user)
    duplicate = api.post(MUTATIONS_URL, payload, format="json")
    assert results(duplicate) == [
        {"mutation_id": item["mutation_id"], "status": "duplicate"} for item in mutations
    ]
    assert _server_state(user) == before
    assert ProcessedMutation.objects.filter(user=user).count() == len(mutations)
