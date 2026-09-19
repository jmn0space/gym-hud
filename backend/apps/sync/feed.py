"""The synchronization reads: bootstrap data and the paged changes feed.

``cursor`` values are the owner's :class:`~apps.sync.models.SyncState` change
counter. Every row a mutation writes carries the counter value that mutation
committed, and one user's mutations commit strictly in counter order, so
"everything with ``change_seq`` above my cursor" is exactly what a device has
not seen yet. A row appears once, at its latest version -- tombstones included
-- so a device that stores each returned record as-is converges on the
server's state. Records carry only the fields the server models; fields a
device keeps locally beyond those are not in them (docs/data-sync.md, "Pull:
changes feed").
"""

from __future__ import annotations

from apps.sync.models import SyncedRecord, SyncState
from apps.sync.protocol import MAX_CHANGES_PER_MUTATION, MAX_MUTATIONS_PER_REQUEST
from apps.sync.registry import StoreSpec, all_specs, domains


def current_cursor(user_id: int) -> int:
    """The user's change counter: the high-water mark of everything committed."""
    value = SyncState.objects.filter(user_id=user_id).values_list("change_seq", flat=True).first()
    return value or 0


def bootstrap(user_id: int) -> dict[str, object]:
    """``GET /api/v1/sync/bootstrap/``: limits, the cursor, and each domain's entry."""
    payload: dict[str, object] = {
        "cursor": current_cursor(user_id),
        "limits": {
            "max_mutations_per_request": MAX_MUTATIONS_PER_REQUEST,
            "max_changes_per_mutation": MAX_CHANGES_PER_MUTATION,
        },
    }
    for domain in domains():
        payload[domain.name] = domain.bootstrap(user_id)
    return payload


def _entry(spec: StoreSpec, row: SyncedRecord) -> dict[str, object]:
    return {
        "store": spec.store,
        "entity_type": spec.entity_type,
        "entity_id": str(row.pk),
        "change_seq": row.change_seq,
        "record": spec.serialize(row),
    }


def changes_since(user_id: int, since: int, limit: int) -> dict[str, object]:
    """One page of records changed after ``since``, parents before children.

    A page is every row whose ``change_seq`` lies in ``(since, cursor]``, and
    it ends on a mutation boundary: rows sharing a ``change_seq`` were written
    by one mutation and are never split across pages, so a page may exceed
    ``limit`` by at most one mutation's changes. Which rows make a page is
    decided in change order; the page is then listed parents first (by store
    depth, then change order), so a child never precedes a parent that is on
    the same page. A parent last changed *after* the page's cursor is on a
    later page -- the client applies feed records without parent checks.
    ``cursor`` is where the next request should start, and ``has_more`` says
    whether it would return anything.

    The counter is read *before* the rows, and rows above it are left for the
    next page: a mutation committing mid-read can only be picked up later,
    never skipped.
    """
    high = current_cursor(user_id)
    specs = all_specs()
    candidates: list[tuple[int, int, str, StoreSpec, SyncedRecord]] = []
    for spec in specs:
        rows = spec.model._default_manager.filter(
            user_id=user_id, change_seq__gt=since, change_seq__lte=high
        ).order_by("change_seq", "id")[: limit + 1]
        candidates.extend((row.change_seq, spec.depth, str(row.pk), spec, row) for row in rows)
    candidates.sort(key=lambda item: item[:3])

    if len(candidates) <= limit:
        # No store was cut short, so this is everything up to the high-water mark.
        page = candidates
        cursor = max(high, since)
        has_more = False
    else:
        cursor = candidates[limit - 1][0]
        page = [item for item in candidates if item[0] < cursor]
        for spec in specs:
            rows = spec.model._default_manager.filter(user_id=user_id, change_seq=cursor)
            page.extend((row.change_seq, spec.depth, str(row.pk), spec, row) for row in rows)
        has_more = any(
            spec.model._default_manager.filter(
                user_id=user_id, change_seq__gt=cursor, change_seq__lte=high
            ).exists()
            for spec in specs
        )
        if not has_more:
            cursor = high

    page.sort(key=lambda item: (item[1], item[0], item[2]))
    return {
        "changes": [_entry(spec, row) for _, _, _, spec, row in page],
        "cursor": cursor,
        "has_more": has_more,
    }
