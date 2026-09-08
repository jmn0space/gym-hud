"""Exercise real pip-audit formatter output and mocked OSV response/failure cases."""

import io
import json
from urllib.error import HTTPError, URLError

import pytest
from packaging.version import Version
from pip_audit._format.json import JsonFormat
from pip_audit._service import ResolvedDependency, SkippedDependency, VulnerabilityResult

from scripts import enforce_pip_audit_severity as audit

HIGH = "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H"
CRITICAL = "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N"
MEDIUM = "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N"
LOW = "CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N"


def report(aliases=()):
    vulnerability = VulnerabilityResult(
        id="PYSEC-2026-1",
        description="test finding",
        fix_versions=[],
        aliases=set(aliases),
    )
    raw = JsonFormat(output_desc=False, output_aliases=True).format(
        {ResolvedDependency("example-package", Version("1.0")): [vulnerability]}, []
    )
    # Reproduce the reviewer's input: pip-audit itself emits no severity ratings.
    assert "ratings" not in raw and "severity" not in raw
    return json.loads(raw)


@pytest.mark.parametrize(
    "kind,vector,expected",
    [
        ("CVSS_V2", "AV:N/AC:L/Au:N/C:C/I:C/A:C", 1),
        ("CVSS_V3", HIGH, 1),
        ("CVSS_V4", CRITICAL, 1),
        ("CVSS_V3", MEDIUM, 0),
        ("CVSS_V3", LOW, 0),
    ],
)
def test_real_formatter_findings_use_osv_cvss(monkeypatch, kind, vector, expected):
    monkeypatch.setattr(
        audit,
        "fetch_advisory",
        lambda _id: {"id": _id, "severity": [{"type": kind, "score": vector}]},
    )
    assert audit.evaluate_report(report()) == expected


def test_alias_severity_and_cycle_are_resolved(monkeypatch):
    records = {
        "PYSEC-2026-1": {"id": "PYSEC-2026-1", "aliases": ["GHSA-test-1234-5678"]},
        "GHSA-test-1234-5678": {
            "id": "GHSA-test-1234-5678",
            "aliases": ["PYSEC-2026-1"],
            "database_specific": {"severity": "CRITICAL"},
        },
    }
    monkeypatch.setattr(audit, "fetch_advisory", records.__getitem__)
    assert audit.evaluate_report(report()) == 1


def test_highest_score_across_aliases_wins(monkeypatch):
    monkeypatch.setattr(
        audit,
        "fetch_advisory",
        lambda _id: {
            "id": _id,
            "severity": [{"type": "CVSS_V3", "score": MEDIUM if _id.startswith("PYSEC") else HIGH}],
        },
    )
    assert audit.evaluate_report(report(["GHSA-test-1234-5678"])) == 1


def test_package_specific_severity(monkeypatch):
    monkeypatch.setattr(
        audit,
        "fetch_advisory",
        lambda _id: {
            "id": _id,
            "affected": [
                {
                    "package": {"ecosystem": "PyPI", "name": "Example_Package"},
                    "severity": [{"type": "CVSS_V3", "score": HIGH}],
                }
            ],
        },
    )
    assert audit.evaluate_report(report()) == 1


@pytest.mark.parametrize(
    "metadata",
    [
        {},
        {"severity": []},
        {"severity": [{"type": "CVSS_V3", "score": "invalid"}]},
        {"severity": [{"type": "unknown", "score": "10"}]},
        {"severity": None},
    ],
)
def test_unknown_or_malformed_severity_fails_closed(monkeypatch, metadata):
    monkeypatch.setattr(audit, "fetch_advisory", lambda _id: metadata)
    assert audit.evaluate_report(report()) == 2


def test_unavailable_metadata_fails_closed(monkeypatch):
    def unavailable(_id):
        raise audit.AuditError("OSV unavailable")

    monkeypatch.setattr(audit, "fetch_advisory", unavailable)
    assert audit.evaluate_report(report()) == 2


def test_clean_real_formatter_report_needs_no_metadata(monkeypatch):
    def unexpected(_id):
        pytest.fail("No metadata lookup should occur for a clean report")

    monkeypatch.setattr(audit, "fetch_advisory", unexpected)
    raw = JsonFormat(False, True).format(
        {ResolvedDependency("example-package", Version("1.0")): []}, []
    )
    assert audit.evaluate_report(json.loads(raw)) == 0


def test_skipped_real_formatter_dependency_is_not_a_clean_audit():
    raw = JsonFormat(False, True).format(
        {SkippedDependency("example-package", "could not audit"): []}, []
    )
    with pytest.raises(audit.AuditError, match="skipped"):
        audit.evaluate_report(json.loads(raw))


@pytest.mark.parametrize("raw", ["{", "{}", "[]", '{"dependencies": []}'])
def test_cli_rejects_invalid_or_empty_reports(monkeypatch, tmp_path, raw):
    path = tmp_path / "audit.json"
    path.write_text(raw)
    monkeypatch.setattr(audit.sys, "argv", ["audit", str(path)])
    assert audit.main() == 2


@pytest.fixture
def uncached_fetch():
    audit.fetch_advisory.cache_clear()
    yield audit.fetch_advisory
    audit.fetch_advisory.cache_clear()


def test_metadata_retries_then_caches_success(monkeypatch, uncached_fetch):
    calls = []

    def fetch(url, timeout):
        calls.append((url, timeout))
        if len(calls) < 3:
            raise URLError("temporary outage")
        return io.BytesIO(b'{"id":"PYSEC-2026-1"}')

    monkeypatch.setattr(audit, "urlopen", fetch)
    monkeypatch.setattr(audit.time, "sleep", lambda _: None)
    assert uncached_fetch("PYSEC-2026-1") == {"id": "PYSEC-2026-1"}
    assert uncached_fetch("PYSEC-2026-1") == {"id": "PYSEC-2026-1"}
    assert len(calls) == 3
    assert all(url == "https://api.osv.dev/v1/vulns/PYSEC-2026-1" for url, _ in calls)


def test_metadata_outage_exhausts_retries(monkeypatch, uncached_fetch):
    calls = []

    def fetch(url, timeout):
        calls.append(url)
        raise URLError("offline")

    monkeypatch.setattr(audit, "urlopen", fetch)
    monkeypatch.setattr(audit.time, "sleep", lambda _: None)
    with pytest.raises(audit.AuditError, match="OSV unavailable"):
        uncached_fetch("PYSEC-2026-1")
    assert len(calls) == 3


def test_missing_primary_metadata_uses_formatter_alias(monkeypatch, uncached_fetch):
    def fetch(url, timeout):
        if url.endswith("PYSEC-2026-1"):
            raise HTTPError(url, 404, "not found", {}, None)
        return io.BytesIO(b'{"id":"GHSA-test-1234-5678","database_specific":{"severity":"HIGH"}}')

    monkeypatch.setattr(audit, "urlopen", fetch)
    assert audit.evaluate_report(report(["GHSA-test-1234-5678"])) == 1


def test_mismatched_metadata_is_rejected(monkeypatch, uncached_fetch):
    monkeypatch.setattr(audit, "urlopen", lambda *a, **kw: io.BytesIO(b'{"id":"different"}'))
    with pytest.raises(audit.AuditError, match="Invalid OSV"):
        uncached_fetch("PYSEC-2026-1")
