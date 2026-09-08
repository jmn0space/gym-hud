"""Enrich pip-audit JSON findings with OSV CVSS metadata and fail closed."""

from __future__ import annotations

import json
import re
import sys
import time
from functools import cache
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import urlopen

from cvss import CVSS2, CVSS3, CVSS4
from cvss.exceptions import CVSSError

CVSS_PARSERS = {"CVSS_V2": CVSS2, "CVSS_V3": CVSS3, "CVSS_V4": CVSS4}
# GitHub's OSV database_specific severity is useful when no CVSS vector exists.
GITHUB_SCORES = {"LOW": 0.1, "MODERATE": 4.0, "HIGH": 7.0, "CRITICAL": 9.0}


class AuditError(ValueError):
    """The audit cannot establish that a finding is below the threshold."""


@cache
def fetch_advisory(vulnerability_id: str) -> dict[str, Any]:
    """Fetch public OSV metadata, retrying transient errors; unknown IDs may use aliases."""
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", vulnerability_id):
        raise AuditError(f"Invalid advisory ID: {vulnerability_id!r}")
    url = "https://api.osv.dev/v1/vulns/" + quote(vulnerability_id, safe="")
    for attempt in range(3):
        try:
            # Fixed HTTPS API; only the validated, quoted ID is variable.
            with urlopen(url, timeout=10) as response:  # noqa: S310
                advisory = json.load(response)
            if not isinstance(advisory, dict) or advisory.get("id") != vulnerability_id:
                raise AuditError(f"Invalid OSV response for {vulnerability_id}")
            return advisory
        except HTTPError as exc:
            if exc.code == 404:
                return {}
            if exc.code != 429 and exc.code < 500:
                raise AuditError(f"OSV returned HTTP {exc.code} for {vulnerability_id}") from exc
            failure = str(exc)
        except (URLError, TimeoutError, OSError) as exc:
            failure = str(exc)
        except (ValueError, UnicodeError) as exc:
            raise AuditError(f"Invalid OSV metadata for {vulnerability_id}: {exc}") from exc
        if attempt < 2:
            time.sleep(attempt + 1)
    raise AuditError(f"OSV unavailable for {vulnerability_id}: {failure}")


def advisory_scores(advisory: dict[str, Any], package: str) -> list[float]:
    """Use the highest published base score, including package-specific ratings."""
    ratings = list(advisory.get("severity", []))
    for affected in advisory.get("affected", []):
        affected_package = affected.get("package", {})
        normalized_name = re.sub(r"[-_.]+", "-", affected_package.get("name", "")).lower()
        if affected_package.get("ecosystem") == "PyPI" and normalized_name == package:
            ratings.extend(affected.get("severity", []))
    scores = []
    for rating in ratings:
        parser = CVSS_PARSERS.get(rating["type"])
        if parser is None:
            raise AuditError(f"Unsupported severity type: {rating['type']}")
        # Use the maintained CVSS library, not hand-written scoring formulas.
        scores.append(float(parser(rating["score"]).scores()[0]))
    if advisory.get("id", "").startswith("GHSA-"):
        severity = advisory.get("database_specific", {}).get("severity")
        if severity is not None:
            if severity not in GITHUB_SCORES:
                raise AuditError(f"Unknown GitHub severity: {severity!r}")
            scores.append(GITHUB_SCORES[severity])
    return scores


def finding_score(finding: dict[str, Any], package: str) -> float:
    """Resolve advisory aliases and consider all available severity sources."""
    pending = [finding["id"], *finding.get("aliases", [])]
    visited: set[str] = set()
    scores: list[float] = []
    while pending:
        vulnerability_id = pending.pop(0)
        if not isinstance(vulnerability_id, str):
            raise AuditError("Advisory IDs and aliases must be strings")
        if vulnerability_id in visited:
            continue
        visited.add(vulnerability_id)
        if len(visited) > 50:
            raise AuditError("Advisory alias set exceeds 50 entries")
        advisory = fetch_advisory(vulnerability_id)
        scores.extend(advisory_scores(advisory, package))
        pending.extend(advisory.get("aliases", []))
    if not scores:
        raise AuditError(f"No severity metadata for {finding['id']}")
    return max(scores)


def evaluate_report(report: Any) -> int:
    """Return 0 for below-threshold findings, 1 for High/Critical, 2 for incomplete audits."""
    if not isinstance(report, dict) or not isinstance(report.get("dependencies"), list):
        raise AuditError("Expected pip-audit JSON with a dependencies list")
    if not report["dependencies"]:
        raise AuditError("The dependency report is empty")
    blocking = False
    incomplete = False
    for dependency in report["dependencies"]:
        if (
            not isinstance(dependency, dict)
            or not isinstance(dependency.get("name"), str)
            or not isinstance(dependency.get("version"), str)
            or not isinstance(dependency.get("vulns"), list)
            or "skip_reason" in dependency
        ):
            raise AuditError("Malformed or skipped dependency in pip-audit report")
        package = re.sub(r"[-_.]+", "-", dependency["name"]).lower()
        for finding in dependency["vulns"]:
            try:
                score = finding_score(finding, package)
            except (ValueError, TypeError, KeyError, AttributeError, CVSSError) as exc:
                print(f"Unclassified vulnerability in {package}: {exc}", file=sys.stderr)
                incomplete = True
                continue
            print(f"{package}: {finding['id']} — severity score {score:.1f}")
            blocking |= score >= 7.0
    if incomplete:
        return 2
    if blocking:
        return 1
    print("No High/Critical dependency vulnerabilities found; all findings classified.")
    return 0


def main() -> int:
    """Read the audit report and enrich every vulnerability before deciding its severity."""
    if len(sys.argv) != 2:
        print("usage: enforce_pip_audit_severity.py <pip-audit-json-report>", file=sys.stderr)
        return 2
    try:
        report = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
        return evaluate_report(report)
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
        print(f"Unable to complete dependency audit: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
