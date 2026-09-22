"""PAD walking models: the server copies of the local PAD records, plus defaults.

Field lists mirror docs/pad-walking.md and the local records written by
``frontend/src/pad/records.ts``. The database enforces every rule that one row
(or one table) can express -- statuses, stop reasons, pain values, positive
settings, ``ended_at >= started_at``, and the "only one active/open" rules as
partial unique indexes that ignore tombstones. Rules spanning parent and child
rows (timestamp containment, rest integrity) are checked by
:mod:`apps.pad.sync` over the finished state of each mutation.
"""

from __future__ import annotations

from decimal import Decimal

from django.core.validators import MinValueValidator
from django.db import models
from django.db.models import F, Q

from apps.sync.models import SyncedRecord

#: Application defaults (docs/pad-walking.md), used until an administrator
#: saves :class:`PadDefaults`; the same values as ``DEFAULT_WALKING_SETTINGS``
#: in ``frontend/src/pad/types.ts``.
DEFAULT_SPEED_KMH = Decimal("5.0")
DEFAULT_INCLINE_PCT = Decimal("2.0")
DEFAULT_MAX_BOUT_SECONDS = 480

#: ``bout_number`` is stored as a PostgreSQL ``integer``.
MAX_BOUT_NUMBER = 2**31 - 1


class WalkingSessionStatus(models.TextChoices):
    ACTIVE = "ACTIVE", "Active"
    COMPLETED = "COMPLETED", "Completed"
    DISCARDED = "DISCARDED", "Discarded"


class WalkingStopReason(models.TextChoices):
    MAX_DURATION = "MAX_DURATION", "Maximum duration"
    CLAUDICATION = "CLAUDICATION", "Claudication"
    FOOT_NUMBNESS = "FOOT_NUMBNESS", "Foot numbness"
    SUDDEN_SWELLING = "SUDDEN_SWELLING", "Sudden swelling"
    OTHER = "OTHER", "Other"


def _ended_after_start(prefix: str) -> models.CheckConstraint:
    return models.CheckConstraint(
        condition=Q(ended_at__isnull=True) | Q(ended_at__gte=F("started_at")),
        name=f"{prefix}_ended_after_start",
    )


class PadDefaults(models.Model):
    """The application defaults a new walking session starts from.

    A singleton edited in Django Admin. "Server configuration wins"
    (docs/data-sync.md, "Conflict strategy"): these values are served by the
    bootstrap read and only apply when there is no previous completed session
    to inherit from. Until someone saves the row, :meth:`current` returns an
    unsaved instance holding the built-in defaults.
    """

    SINGLETON_ID = 1

    id = models.PositiveSmallIntegerField(primary_key=True, default=SINGLETON_ID, editable=False)
    speed_kmh = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        default=DEFAULT_SPEED_KMH,
        validators=[MinValueValidator(Decimal("0.01"))],
        help_text="Treadmill speed in km/h.",
    )
    incline_pct = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        default=DEFAULT_INCLINE_PCT,
        validators=[MinValueValidator(Decimal("0"))],
        help_text="Treadmill incline in percent.",
    )
    max_bout_seconds = models.PositiveIntegerField(
        default=DEFAULT_MAX_BOUT_SECONDS,
        validators=[MinValueValidator(1)],
        help_text="Maximum bout duration in seconds (480 = 8 minutes).",
    )
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "PAD defaults"
        verbose_name_plural = "PAD defaults"
        constraints = [
            models.CheckConstraint(condition=Q(id=1), name="pad_defaults_singleton"),
            models.CheckConstraint(
                condition=Q(speed_kmh__gt=0), name="pad_defaults_speed_positive"
            ),
            models.CheckConstraint(
                condition=Q(incline_pct__gte=0), name="pad_defaults_incline_non_negative"
            ),
            models.CheckConstraint(
                condition=Q(max_bout_seconds__gte=1), name="pad_defaults_max_bout_positive"
            ),
        ]

    def __str__(self) -> str:
        return "PAD defaults"

    @classmethod
    def current(cls) -> PadDefaults:
        """The saved defaults, or an unsaved instance holding the built-in ones."""
        return cls.objects.filter(pk=cls.SINGLETON_ID).first() or cls()


class WalkingSession(SyncedRecord):
    """One PAD walking session (docs/pad-walking.md, "Walking session").

    Speed and incline are ``double precision`` rather than ``numeric``: the
    local record holds JavaScript numbers, and a double stores any of them --
    an inherited 5.65 km/h included -- exactly, so nothing the device accepted
    is rounded or refused here.
    """

    status = models.CharField(max_length=16, choices=WalkingSessionStatus)
    started_at = models.DateTimeField()
    completed_at = models.DateTimeField(null=True, blank=True)
    speed_kmh = models.FloatField()
    incline_pct = models.FloatField()
    max_bout_seconds = models.PositiveBigIntegerField()
    session_notes = models.TextField(null=True, blank=True)

    class Meta(SyncedRecord.Meta):
        constraints = [
            models.CheckConstraint(
                condition=Q(status__in=WalkingSessionStatus.values),
                name="pad_session_status_valid",
            ),
            models.CheckConstraint(
                condition=Q(status=WalkingSessionStatus.ACTIVE, completed_at__isnull=True)
                | Q(
                    status__in=[WalkingSessionStatus.COMPLETED, WalkingSessionStatus.DISCARDED],
                    completed_at__isnull=False,
                ),
                name="pad_session_completion_matches_status",
            ),
            models.CheckConstraint(
                condition=Q(completed_at__isnull=True) | Q(completed_at__gte=F("started_at")),
                name="pad_session_completed_after_start",
            ),
            models.CheckConstraint(condition=Q(speed_kmh__gt=0), name="pad_session_speed_positive"),
            models.CheckConstraint(
                condition=Q(incline_pct__gte=0), name="pad_session_incline_non_negative"
            ),
            models.CheckConstraint(
                condition=Q(max_bout_seconds__gte=1), name="pad_session_max_bout_positive"
            ),
            models.UniqueConstraint(
                fields=["user"],
                condition=Q(status=WalkingSessionStatus.ACTIVE, deleted_at__isnull=True),
                name="pad_one_active_session_per_user",
            ),
        ]

    def __str__(self) -> str:
        return f"Walking session {self.pk} ({self.status})"


class WalkingBout(SyncedRecord):
    """One walking bout (docs/pad-walking.md, "Walking bout").

    ``bout_number`` is the number the bout had when it was recorded. It is not
    unique: display numbering is recomputed after a delete, and a new bout can
    reuse the number of a deleted one.

    ``pain_onset_at`` is the moment pain started during the bout
    (docs/pad-walking.md, "Pain onset"), null while none was recorded. Only the
    moment is stored: the pain-free walking time is derived from it and the
    bout's own timestamps, like every other PAD duration.
    """

    walking_session = models.ForeignKey(
        WalkingSession, on_delete=models.CASCADE, related_name="bouts"
    )
    bout_number = models.PositiveIntegerField()
    started_at = models.DateTimeField()
    ended_at = models.DateTimeField(null=True, blank=True)
    pain_min = models.PositiveSmallIntegerField(null=True, blank=True)
    pain_max = models.PositiveSmallIntegerField(null=True, blank=True)
    pain_onset_at = models.DateTimeField(null=True, blank=True)
    stop_reason = models.CharField(max_length=32, choices=WalkingStopReason, null=True, blank=True)
    notes = models.TextField(null=True, blank=True)

    class Meta(SyncedRecord.Meta):
        constraints = [
            models.CheckConstraint(
                condition=Q(bout_number__gte=1), name="pad_bout_number_positive"
            ),
            _ended_after_start("pad_bout"),
            # One value (min == max) or two adjacent values (max == min + 1),
            # both set or both null. The isnull=False terms matter: in SQL a
            # comparison with NULL is unknown, which a CHECK treats as passing.
            models.CheckConstraint(
                condition=Q(pain_min__isnull=True, pain_max__isnull=True)
                | (
                    Q(
                        pain_min__isnull=False,
                        pain_max__isnull=False,
                        pain_min__gte=1,
                        pain_max__lte=5,
                        pain_min__lte=F("pain_max"),
                    )
                    & Q(pain_max__lte=F("pain_min") + 1)
                ),
                name="pad_bout_pain_valid",
            ),
            models.CheckConstraint(
                condition=Q(stop_reason__isnull=True) | Q(stop_reason__in=WalkingStopReason.values),
                name="pad_bout_stop_reason_valid",
            ),
            # A recorded pain onset lies inside its own bout. As above, the
            # isnull terms carry the meaning: a comparison with NULL is
            # unknown, which a CHECK treats as passing, so an open bout has
            # only the lower bound and no onset has neither.
            models.CheckConstraint(
                condition=Q(pain_onset_at__isnull=True)
                | (
                    Q(pain_onset_at__gte=F("started_at"))
                    & (Q(ended_at__isnull=True) | Q(pain_onset_at__lte=F("ended_at")))
                ),
                name="pad_bout_pain_onset_within_bout",
            ),
            models.UniqueConstraint(
                fields=["walking_session"],
                condition=Q(ended_at__isnull=True, deleted_at__isnull=True),
                name="pad_one_open_bout_per_session",
            ),
        ]

    def __str__(self) -> str:
        return f"Bout {self.bout_number} ({self.pk})"


class WalkingBoutPause(SyncedRecord):
    """One pause inside a walking bout (docs/pad-walking.md, "Pause handling")."""

    walking_bout = models.ForeignKey(WalkingBout, on_delete=models.CASCADE, related_name="pauses")
    started_at = models.DateTimeField()
    ended_at = models.DateTimeField(null=True, blank=True)

    class Meta(SyncedRecord.Meta):
        verbose_name = "walking bout pause"
        constraints = [
            _ended_after_start("pad_pause"),
            models.UniqueConstraint(
                fields=["walking_bout"],
                condition=Q(ended_at__isnull=True, deleted_at__isnull=True),
                name="pad_one_open_pause_per_bout",
            ),
        ]

    def __str__(self) -> str:
        return f"Pause {self.pk}"


class WalkingRest(SyncedRecord):
    """The rest after a walking bout (docs/pad-walking.md, "Rest handling").

    "A completed bout may have one rest interval": at most one *live* rest per
    bout, open or closed. Undoing a finished bout tombstones its rest, which
    frees the place for the rest of the next finish.
    """

    walking_bout = models.ForeignKey(WalkingBout, on_delete=models.CASCADE, related_name="rests")
    started_at = models.DateTimeField()
    ended_at = models.DateTimeField(null=True, blank=True)

    class Meta(SyncedRecord.Meta):
        constraints = [
            _ended_after_start("pad_rest"),
            models.UniqueConstraint(
                fields=["walking_bout"],
                condition=Q(deleted_at__isnull=True),
                name="pad_one_rest_per_bout",
            ),
        ]

    def __str__(self) -> str:
        return f"Rest {self.pk}"
