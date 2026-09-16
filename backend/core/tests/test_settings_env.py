"""Tests for config.settings.base's env-var helpers (_env_str, _env_int).

Plain os.getenv(name, default) only falls back when a variable is entirely
unset; these helpers also treat an explicitly-empty value (e.g. an unfilled
`VAR=` line in a Compose `environment:` block reaching the process
environment) as "use the default" -- and, for _env_int, must not crash the
way `int(os.getenv(name, default))` would on an empty string.
"""

from __future__ import annotations

import pytest
from config.settings.base import _env_int, _env_str

ENV_VAR = "GYMHUD_TEST_ENV_HELPER_VAR"


@pytest.mark.parametrize("raw", [None, ""], ids=["unset", "empty"])
def test_env_str_falls_back_to_default_when_unset_or_empty(
    monkeypatch: pytest.MonkeyPatch, raw: str | None
) -> None:
    if raw is None:
        monkeypatch.delenv(ENV_VAR, raising=False)
    else:
        monkeypatch.setenv(ENV_VAR, raw)

    assert _env_str(ENV_VAR, "the-default") == "the-default"


def test_env_str_uses_the_actual_value_when_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ENV_VAR, "actual-value")

    assert _env_str(ENV_VAR, "the-default") == "actual-value"


def test_env_str_strips_surrounding_whitespace(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ENV_VAR, "  actual-value  ")

    assert _env_str(ENV_VAR, "the-default") == "actual-value"


@pytest.mark.parametrize("raw", [None, ""], ids=["unset", "empty"])
def test_env_int_falls_back_to_default_when_unset_or_empty(
    monkeypatch: pytest.MonkeyPatch, raw: str | None
) -> None:
    """int(os.getenv(name, default)) would crash on an explicitly-empty value; this must not."""
    if raw is None:
        monkeypatch.delenv(ENV_VAR, raising=False)
    else:
        monkeypatch.setenv(ENV_VAR, raw)

    assert _env_int(ENV_VAR, 42) == 42


def test_env_int_uses_the_actual_value_when_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ENV_VAR, "99")

    assert _env_int(ENV_VAR, 42) == 99


def test_env_int_rejects_a_non_integer_value(monkeypatch: pytest.MonkeyPatch) -> None:
    """A genuinely-set but malformed value must still fail loudly, not silently default."""
    monkeypatch.setenv(ENV_VAR, "not-a-number")

    with pytest.raises(ValueError, match="not-a-number"):
        _env_int(ENV_VAR, 42)
