"""Wire-level vocabulary of the synchronization protocol.

The acknowledgement statuses, the per-mutation ``code`` values, request limits,
the outcome exceptions store handlers raise, and the small parsers every
handler uses to read one field of a local record. The protocol itself --
request/response shapes, batch semantics, ordering and conflict rules -- is
documented in docs/data-sync.md ("Server synchronization protocol"); keep the
two in step.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime

#: The only envelope ``version`` this server applies (the local outbox writes 1).
PROTOCOL_VERSION = 1

#: Request limits. A legitimate local action is a handful of changes; the change
#: cap only has to admit deleting one long walking session with every descendant.
MAX_MUTATIONS_PER_REQUEST = 50
MAX_CHANGES_PER_MUTATION = 500
DEFAULT_CHANGES_PAGE_SIZE = 200
MAX_CHANGES_PAGE_SIZE = 500

# Acknowledgement statuses.
APPLIED = "applied"
DUPLICATE = "duplicate"
REJECTED = "rejected"
RETRY = "retry"

# Permanent rejection codes. All but the last are recorded in the ledger, so a
# retry of the same mutation is answered with the same rejection.
INVALID_ENVELOPE = "invalid_envelope"
INVALID_RECORD = "invalid_record"
INVALID_TRANSITION = "invalid_transition"
ACTIVE_CONFLICT = "active_conflict"
PARENT_NOT_FOUND = "parent_not_found"
NOT_FOUND = "not_found"
# Permanent, but never recorded: the ledger already holds the original.
MUTATION_ID_CONFLICT = "mutation_id_conflict"

# Retryable codes (never recorded; processing of the batch stops at the first).
UNSUPPORTED_STORE = "unsupported_store"
UNSUPPORTED_VERSION = "unsupported_version"
TEMPORARILY_UNAVAILABLE = "temporarily_unavailable"
SERVER_ERROR = "server_error"

PUT = "put"
DELETE = "delete"

# A JSON parser joins an escaped surrogate *pair* into one character, so any
# surrogate left in a parsed string is a lone one.
_SURROGATE = re.compile("[\ud800-\udfff]")

_CANONICAL_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

#: The largest integer a JavaScript number represents exactly
#: (``Number.MAX_SAFE_INTEGER``); every integer on the wire came from one.
MAX_SAFE_INTEGER = 2**53 - 1


class Rejected(Exception):
    """A permanent, deterministic refusal of a mutation.

    Raised anywhere while a mutation is parsed or applied. Everything the
    mutation wrote is rolled back, and the rejection is recorded in the ledger
    so a retry of the same mutation receives the same answer.
    """

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


class Deferred(Exception):
    """A retryable refusal: the client keeps the mutation queued and resends it.

    Never recorded, and it ends the batch: nothing after it is processed, so no
    later mutation is applied ahead of this one.
    """

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class Ack:
    """One mutation's acknowledgement (one entry of the response's ``results``).

    ``applied`` and ``duplicate`` carry only the mutation id and status;
    ``rejected`` and ``retry`` add ``code``, ``retryable`` and ``detail``.
    :meth:`as_dict` always emits those keys in the same order, and a recorded
    rejection is rebuilt from the ledger columns alone, so every retry of a
    rejected mutation receives an identical entry.
    """

    mutation_id: str | None
    status: str
    code: str | None = None
    detail: str | None = None

    @property
    def retryable(self) -> bool:
        """Whether the client should keep the mutation queued and resend it."""
        return self.status == RETRY

    def as_dict(self) -> dict[str, object]:
        """The JSON object sent for this mutation."""
        result: dict[str, object] = {"mutation_id": self.mutation_id, "status": self.status}
        if self.status in (REJECTED, RETRY):
            result["code"] = self.code
            result["retryable"] = self.retryable
            result["detail"] = self.detail
        return result


def canonical_json(value: object) -> str:
    """``value`` as canonical JSON text: sorted keys, no whitespace, ASCII only.

    ASCII-only escaping keeps every control character (``\\u0000`` included) as
    an escape sequence, so the text is always storable in a PostgreSQL text
    column.
    """
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def fingerprint(canonical: str) -> str:
    """SHA-256 of a mutation's canonical JSON: what "the same payload" means.

    Retries of one outbox entry send the same bytes, so they parse to equal
    values and hash equally regardless of key order.
    """
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def is_canonical_uuid(value: object) -> bool:
    """True for a lowercase, hyphenated UUID string, as ``crypto.randomUUID()`` makes.

    Identity must round-trip byte for byte: the local stores key records by the
    exact string, so the server neither accepts nor produces any other spelling.
    """
    return isinstance(value, str) and _CANONICAL_UUID.fullmatch(value) is not None


def format_timestamp(value: datetime) -> str:
    """A UTC timestamp in the local repository's own shape (``Date.toISOString()``)."""
    text = value.astimezone(UTC).isoformat(timespec="milliseconds")
    return text.removesuffix("+00:00") + "Z"


def parse_timestamp(value: object) -> datetime | None:
    """An aware ISO 8601 timestamp as a UTC ``datetime``, or ``None`` if unusable."""
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.utcoffset() is None:
        return None
    try:
        return parsed.astimezone(UTC)
    except OverflowError:
        # "0001-01-01T00:00:00+01:00" is a valid literal whose UTC instant is
        # before year 1 -- unrepresentable, so as unusable as a malformed one.
        return None


def parse_integer(value: object) -> int | None:
    """An exact integer (``bool`` excluded), or ``None``.

    JavaScript has one number type, so an integral float is accepted too.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


# --- Record field readers ------------------------------------------------------
#
# Each reads one field of a local record and raises ``Rejected(INVALID_RECORD,
# ...)`` naming the field when it is unusable. "Absent" and ``null`` are the
# same thing for an optional field, exactly as the local parsers treat them.


def _invalid(field: str, expectation: str) -> Rejected:
    return Rejected(INVALID_RECORD, f"{field} must be {expectation}.")


def read_uuid(record: Mapping[str, object], field: str) -> uuid.UUID:
    """A required canonical UUID field."""
    value = record.get(field)
    if not is_canonical_uuid(value):
        raise _invalid(field, "a lowercase UUID")
    return uuid.UUID(str(value))


def read_timestamp(record: Mapping[str, object], field: str) -> datetime:
    """A required timestamp field."""
    parsed = parse_timestamp(record.get(field))
    if parsed is None:
        raise _invalid(field, "an ISO 8601 timestamp with a time zone")
    return parsed


def read_optional_timestamp(record: Mapping[str, object], field: str) -> datetime | None:
    """A timestamp field that may be absent or ``null``."""
    if record.get(field) is None:
        return None
    return read_timestamp(record, field)


def read_integer(
    record: Mapping[str, object], field: str, *, minimum: int, maximum: int = MAX_SAFE_INTEGER
) -> int:
    """A required integer field within ``[minimum, maximum]``."""
    parsed = parse_integer(record.get(field))
    if parsed is None or not minimum <= parsed <= maximum:
        raise _invalid(field, f"an integer from {minimum} to {maximum}")
    return parsed


def read_optional_integer(
    record: Mapping[str, object], field: str, *, minimum: int, maximum: int
) -> int | None:
    """An integer field within ``[minimum, maximum]`` that may be absent or ``null``."""
    if record.get(field) is None:
        return None
    return read_integer(record, field, minimum=minimum, maximum=maximum)


def read_number(
    record: Mapping[str, object], field: str, *, minimum: float, exclusive: bool
) -> float:
    """A required finite number above ``minimum`` (or at least it, if not ``exclusive``)."""
    value = record.get(field)
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise _invalid(field, "a number")
    try:
        number = float(value)
    except OverflowError:
        # An integer literal beyond any double (JSON allows 1e400 written out).
        raise _invalid(field, "a finite number") from None
    in_range = number > minimum if exclusive else number >= minimum
    if not math.isfinite(number) or not in_range:
        bound = "greater than" if exclusive else "at least"
        raise _invalid(field, f"a finite number {bound} {minimum:g}")
    return number


def storable_text(value: str) -> str:
    """``value`` with what a PostgreSQL ``text`` column cannot hold repaired.

    NUL characters are removed (PostgreSQL text cannot hold one at all), and a
    lone UTF-16 surrogate -- which a JSON ``\\ud800`` escape produces, but UTF-8
    cannot encode -- becomes U+FFFD. Only ever used for free text: the user's
    words are kept rather than their workout refused over one character.
    """
    return _SURROGATE.sub("\ufffd", value.replace("\x00", ""))


def printable(value: str) -> str:
    """``value`` made safe to echo in an acknowledgement or a log line."""
    return _SURROGATE.sub("\ufffd", value)


def read_optional_text(record: Mapping[str, object], field: str) -> str | None:
    """A free-text field that may be absent or ``null``, made storable (:func:`storable_text`)."""
    value = record.get(field)
    if value is None:
        return None
    if not isinstance(value, str):
        raise _invalid(field, "text, or null")
    return storable_text(value)


def read_choice(record: Mapping[str, object], field: str, choices: list[str]) -> str:
    """A required field holding one of ``choices``."""
    value = record.get(field)
    if not isinstance(value, str) or value not in choices:
        raise _invalid(field, "one of " + ", ".join(choices))
    return value


def read_optional_choice(
    record: Mapping[str, object], field: str, choices: list[str]
) -> str | None:
    """A field holding one of ``choices``, or absent/``null``."""
    if record.get(field) is None:
        return None
    return read_choice(record, field, choices)
