"""Fail CI when pip-audit reports High or Critical vulnerabilities."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

BLOCKING_SEVERITIES = {"high", "critical"}


def _severity_names(vulnerability: dict[str, Any]) -> set[str]:
    ratings = vulnerability.get("ratings", [])
    severities: set[str] = set()

    if isinstance(ratings, list):
        for rating in ratings:
            if not isinstance(rating, dict):
                continue
            severity = rating.get("severity")
            if isinstance(severity, str):
                severities.add(severity.lower())

    return severities


def main() -> int:
    """Inspect a CycloneDX pip-audit report and enforce the severity threshold."""
    if len(sys.argv) != 2:
        print("usage: enforce_pip_audit_severity.py <cyclonedx-json-report>")
        return 2

    report_path = Path(sys.argv[1])
    report = json.loads(report_path.read_text(encoding="utf-8"))

    vulnerabilities = report.get("vulnerabilities", [])
    if not isinstance(vulnerabilities, list):
        print("pip-audit report has an unexpected vulnerabilities field")
        return 2

    blocking: list[tuple[str, set[str]]] = []
    unclassified = 0

    for vulnerability in vulnerabilities:
        if not isinstance(vulnerability, dict):
            continue

        severities = _severity_names(vulnerability)
        if severities & BLOCKING_SEVERITIES:
            vulnerability_id = str(vulnerability.get("id", "unknown"))
            blocking.append((vulnerability_id, severities))
        elif not severities:
            unclassified += 1

    if unclassified:
        print(
            f"pip-audit found {unclassified} vulnerability record(s) without severity metadata; "
            "they are reported but do not cross the High/Critical threshold."
        )

    if blocking:
        for vulnerability_id, severities in blocking:
            print(f"blocking vulnerability: {vulnerability_id} ({', '.join(sorted(severities))})")
        return 1

    print("No High/Critical dependency vulnerabilities found.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
