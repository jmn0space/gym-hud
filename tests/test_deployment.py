"""Regression checks for rendered Compose and the actual production settings."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PRODUCTION_ENV = {
    "DJANGO_SECRET_KEY": "test-only-production-validation-key-" * 3,
    "DJANGO_ALLOWED_HOSTS": "gym.example.com",
    "DJANGO_CSRF_TRUSTED_ORIGINS": "https://gym.example.com",
    "CORS_ALLOWED_ORIGINS": "https://gym.example.com",
    "DATABASE_URL": "postgresql://fixture:fixture@pooler.example.com/gymhud?sslmode=require",
    "GUNICORN_WORKERS": "3",
}


def clean_environment():
    return {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("DJANGO_", "POSTGRES_", "CORS_", "COMPOSE_", "GUNICORN_"))
        and key not in {"DATABASE_URL", "TEST_DATABASE_URL"}
    }


def compose_config(filename, variables):
    docker = shutil.which("docker")
    if docker is None:
        pytest.skip("Docker Compose CLI required; no daemon needed")
    # Only repository-owned Compose filenames and fixture values are executed.
    return subprocess.run(  # noqa: S603
        [
            docker,
            "compose",
            "--env-file",
            "/dev/null",
            "-f",
            filename,
            "config",
            "--format",
            "json",
        ],
        cwd=ROOT,
        env={**clean_environment(), **variables},
        text=True,
        capture_output=True,
        check=False,
        timeout=20,
    )


def test_production_compose_uses_deployment_values_without_local_database():
    result = compose_config("docker-compose.production.yml", PRODUCTION_ENV)
    assert result.returncode == 0, result.stderr
    services = json.loads(result.stdout)["services"]
    assert set(services) == {"web"}
    web = services["web"]
    assert web["environment"] == {
        **PRODUCTION_ENV,
        "DJANGO_SETTINGS_MODULE": "config.settings.production",
        "DJANGO_ENV": "production",
    }
    assert not web.get("ports")
    assert not web.get("depends_on")
    assert "8000" in web["expose"]


@pytest.mark.parametrize(
    "missing",
    ["DATABASE_URL", "DJANGO_SECRET_KEY", "DJANGO_ALLOWED_HOSTS", "DJANGO_CSRF_TRUSTED_ORIGINS"],
)
def test_production_compose_rejects_missing_configuration(missing):
    env = {key: value for key, value in PRODUCTION_ENV.items() if key != missing}
    result = compose_config("docker-compose.production.yml", env)
    assert result.returncode != 0
    assert missing in result.stderr


def test_local_compose_keeps_local_database_and_health_dependency():
    result = compose_config("docker-compose.yml", {})
    assert result.returncode == 0, result.stderr
    services = json.loads(result.stdout)["services"]
    assert set(services) == {"web", "db"}
    web = services["web"]
    assert web["environment"]["DJANGO_SETTINGS_MODULE"] == "config.settings.local"
    assert "@db:5432/" in web["environment"]["DATABASE_URL"]
    assert web["depends_on"]["db"]["condition"] == "service_healthy"
    assert not web.get("ports")


def test_production_proxy_scheme_and_transaction_pooling():
    code = """
import json
import django
django.setup()
from django.conf import settings
from django.http import HttpResponse
from django.middleware.security import SecurityMiddleware
from django.test import RequestFactory
factory = RequestFactory()
middleware = SecurityMiddleware(lambda request: HttpResponse("ok"))
results = {}
for proto in ("https", "http", ""):
    request = factory.get("/api/v1/health/", HTTP_HOST="gym.example.com",
                          HTTP_X_FORWARDED_PROTO=proto, REMOTE_ADDR="172.20.0.3")
    response = middleware(request)
    results[proto] = [request.is_secure(), response.status_code, response.get("Location")]
results["cursors_disabled"] = settings.DATABASES["default"]["DISABLE_SERVER_SIDE_CURSORS"]
results["sslmode"] = settings.DATABASES["default"]["OPTIONS"]["sslmode"]
results["debug"] = settings.DEBUG
print(json.dumps(results))
"""
    # Fixed test program, run with the current virtual environment's interpreter.
    result = subprocess.run(  # noqa: S603
        [sys.executable, "-c", code],
        cwd=ROOT,
        env={
            **clean_environment(),
            **PRODUCTION_ENV,
            "DJANGO_SETTINGS_MODULE": "config.settings.production",
            "PYTHONPATH": str(ROOT / "backend"),
        },
        text=True,
        capture_output=True,
        check=True,
        timeout=20,
    )
    observed = json.loads(result.stdout)
    assert observed["https"] == [True, 200, None]
    for proto in ("http", ""):
        assert observed[proto] == [False, 301, "https://gym.example.com/api/v1/health/"]
    assert observed["cursors_disabled"] is True
    assert observed["sslmode"] == "require"
    assert observed["debug"] is False
