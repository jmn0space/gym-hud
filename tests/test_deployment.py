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

# A fixture LAN address, standing in for whatever a real device test types into
# the phone's browser (see docs/device-smoke-tests.md).
PREVIEW_ENV = {"PREVIEW_HOST": "192.168.1.9"}

# docker-compose.preview.yml has no insecure default for DJANGO_SECRET_KEY (see
# test_preview_compose_requires_a_secret_key_with_no_insecure_default below), so
# every other preview test that needs a fully-rendered config must supply one.
PREVIEW_SECRET_ENV = {"DJANGO_SECRET_KEY": "test-only-preview-validation-key-" * 3}


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
        # Not set in PRODUCTION_ENV: all three are optional, defaulted in the
        # Compose file itself, and must still reach the container so
        # config.settings.base picks them up instead of silently running
        # with whatever the image's own defaults happen to be.
        "DJANGO_SESSION_COOKIE_AGE": "2592000",
        "DJANGO_LOGIN_THROTTLE_RATE": "10/min",
        "DJANGO_SYNC_THROTTLE_RATE": "120/min",
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


def test_preview_compose_defines_expected_services():
    """The Android/Chrome secure-context preview (issue #17) adds a Caddy front
    door in its own file (hard rule R3), never as a service on docker-compose.yml.
    """
    result = compose_config("docker-compose.preview.yml", PREVIEW_SECRET_ENV)
    assert result.returncode == 0, result.stderr
    services = json.loads(result.stdout)["services"]
    assert set(services) == {"caddy", "web", "db"}


def test_preview_compose_routes_api_to_backend():
    result = compose_config("docker-compose.preview.yml", PREVIEW_SECRET_ENV)
    assert result.returncode == 0, result.stderr
    services = json.loads(result.stdout)["services"]

    web = services["web"]
    assert "8000" in web["expose"]
    assert not web.get("ports")

    caddy = services["caddy"]
    caddyfile_mount = next(
        volume for volume in caddy["volumes"] if volume["target"] == "/etc/caddy/Caddyfile"
    )
    assert caddyfile_mount["source"].endswith("deploy/preview/Caddyfile")
    assert caddyfile_mount["read_only"] is True

    # The reverse proxy target itself lives in the Caddyfile, not the Compose
    # file; confirm the two agree on the service name and API prefix instead of
    # asserting on Caddy's own runtime routing, which no test here starts.
    caddyfile_text = (ROOT / "deploy" / "preview" / "Caddyfile").read_text()
    assert "handle /api/*" in caddyfile_text
    assert "reverse_proxy web:8000" in caddyfile_text


def test_preview_compose_bind_mounts_built_frontend_readonly():
    result = compose_config("docker-compose.preview.yml", PREVIEW_SECRET_ENV)
    assert result.returncode == 0, result.stderr
    caddy = json.loads(result.stdout)["services"]["caddy"]
    dist_mount = next(volume for volume in caddy["volumes"] if volume["target"] == "/srv/dist")
    assert dist_mount["source"].endswith("frontend/dist")
    assert dist_mount["read_only"] is True


def test_preview_compose_derives_csrf_origin_from_preview_host():
    result = compose_config("docker-compose.preview.yml", {**PREVIEW_SECRET_ENV, **PREVIEW_ENV})
    assert result.returncode == 0, result.stderr
    services = json.loads(result.stdout)["services"]
    assert services["caddy"]["environment"]["PREVIEW_HOST"] == "192.168.1.9"
    # Same variable feeds both the certificate Caddy mints and the origin
    # Django trusts, so they cannot drift apart; see the Compose file comment
    # and deploy/preview/Caddyfile.
    assert services["web"]["environment"]["DJANGO_CSRF_TRUSTED_ORIGINS"] == "https://192.168.1.9"


def test_preview_compose_has_a_sane_default_preview_host():
    result = compose_config("docker-compose.preview.yml", PREVIEW_SECRET_ENV)
    assert result.returncode == 0, result.stderr
    services = json.loads(result.stdout)["services"]
    default_host = services["caddy"]["environment"]["PREVIEW_HOST"]
    assert default_host
    assert (
        services["web"]["environment"]["DJANGO_CSRF_TRUSTED_ORIGINS"] == f"https://{default_host}"
    )


def test_preview_compose_keeps_django_host_check_satisfied_by_the_proxy():
    result = compose_config("docker-compose.preview.yml", PREVIEW_SECRET_ENV)
    assert result.returncode == 0, result.stderr
    web = json.loads(result.stdout)["services"]["web"]
    # backend/config/settings/local.py hardcodes ALLOWED_HOSTS in code, so
    # DJANGO_ALLOWED_HOSTS cannot widen it: the Caddyfile compensates by always
    # presenting Host: localhost to this container (see its header_up comment).
    assert web["environment"]["DJANGO_ALLOWED_HOSTS"] == "localhost,127.0.0.1"


def test_preview_compose_persists_caddy_data_across_restarts():
    result = compose_config("docker-compose.preview.yml", PREVIEW_SECRET_ENV)
    assert result.returncode == 0, result.stderr
    rendered = json.loads(result.stdout)
    data_mount = next(
        volume for volume in rendered["services"]["caddy"]["volumes"] if volume["target"] == "/data"
    )
    assert data_mount["type"] == "volume"
    assert data_mount["source"] == "caddy_data"
    # A top-level named volume survives `down` (only `down -v` removes it).
    # Without it, "tls internal" mints a new root CA on every `up`, and the
    # phone would have to re-trust it every time.
    assert "caddy_data" in rendered["volumes"]


def test_preview_compose_uses_dedicated_database_volume():
    result = compose_config("docker-compose.preview.yml", PREVIEW_SECRET_ENV)
    assert result.returncode == 0, result.stderr
    rendered = json.loads(result.stdout)
    # Distinct from docker-compose.yml's "postgres_data" so the preview stack
    # can never share state with local dev's database, even though both files
    # name their Django/Postgres services "web"/"db".
    assert "postgres_data" not in rendered["volumes"]
    db_volumes = rendered["services"]["db"]["volumes"]
    assert any(volume["source"] == "preview_postgres_data" for volume in db_volumes)


def test_preview_compose_publishes_only_the_https_port():
    """Port 80 must stay unpublished: Caddy's HTTP->HTTPS redirect only fires
    after the browser already sent the request, and SESSION_COOKIE_SECURE is
    False under config.settings.local, so a published :80 would let a signed-in
    phone leak its session cookie in plaintext on the first bare-http:// hit.
    """
    result = compose_config("docker-compose.preview.yml", PREVIEW_SECRET_ENV)
    assert result.returncode == 0, result.stderr
    caddy = json.loads(result.stdout)["services"]["caddy"]
    published = {port["published"] for port in caddy["ports"]}
    assert published == {"443"}


def test_preview_compose_services_do_not_auto_restart():
    """Unlike production/local, this stack listens on every interface with
    DEBUG=True behind it (see the DEBUG warning in the Compose file and
    README.md). "unless-stopped" would bring it back on every Docker daemon
    restart -- including on whatever network the host is on weeks later --
    with nobody around who meant to start it, so every preview service must
    require an explicit `up` instead.
    """
    result = compose_config("docker-compose.preview.yml", PREVIEW_SECRET_ENV)
    assert result.returncode == 0, result.stderr
    services = json.loads(result.stdout)["services"]
    for name in ("caddy", "web", "db"):
        assert services[name]["restart"] == "no", name


def test_preview_compose_pins_a_single_gunicorn_worker():
    """config.settings.local defaults to a per-process LocMemCache, so more
    than one Gunicorn worker gives the login throttle an independent counter
    per worker -- the advertised rate would really be rate-times-workers.
    """
    result = compose_config("docker-compose.preview.yml", PREVIEW_SECRET_ENV)
    assert result.returncode == 0, result.stderr
    web = json.loads(result.stdout)["services"]["web"]
    assert web["environment"]["GUNICORN_WORKERS"] == "1"


def test_preview_compose_gates_caddy_on_django_readiness():
    """deploy/entrypoint.sh runs migrate/createcachetable/collectstatic before
    gunicorn binds; without a healthcheck gating "caddy"'s depends_on, Caddy
    only waits for the "web" container to start (not for gunicorn to accept
    connections), so /api/* 502s for several seconds right after `up`.
    """
    result = compose_config("docker-compose.preview.yml", PREVIEW_SECRET_ENV)
    assert result.returncode == 0, result.stderr
    services = json.loads(result.stdout)["services"]
    assert services["web"]["healthcheck"]
    assert services["caddy"]["depends_on"]["web"]["condition"] == "service_healthy"


def test_preview_caddyfile_strips_client_supplied_cf_connecting_ip():
    """backend/core/throttling.py's get_client_ident() trusts CF-Connecting-IP
    unconditionally, relying on the premise that only the trusted cloudflared
    connector can ever set it. This preview origin breaks that premise --
    anything on the LAN can reach it -- so the Caddyfile must strip whatever
    the client sent before proxying to Django, or the login throttle can be
    bypassed by simply varying that header per request.
    """
    caddyfile_text = (ROOT / "deploy" / "preview" / "Caddyfile").read_text()
    assert "header_up -CF-Connecting-IP" in caddyfile_text


def test_preview_caddyfile_sets_baseline_security_headers():
    """Django's SecurityMiddleware only ever sees the proxied /api/* traffic;
    everything else Caddy serves directly (the login page included) needs its
    own headers against clickjacking and to give the CSP a real default-src.
    """
    caddyfile_text = (ROOT / "deploy" / "preview" / "Caddyfile").read_text()
    assert "X-Frame-Options" in caddyfile_text
    assert "Strict-Transport-Security" in caddyfile_text
    assert "Content-Security-Policy" in caddyfile_text
    assert "Referrer-Policy" in caddyfile_text


def test_preview_compose_requires_a_secret_key_with_no_insecure_default():
    """Unlike docker-compose.yml (loopback-only by default), this stack's
    ports are LAN-reachable, so it must not fall back to the publicly known
    "insecure-local-development-key-do-not-use-in-production" default --
    that would give any LAN attacker the key signing CSRF tokens and the
    session cookie.
    """
    result = compose_config("docker-compose.preview.yml", {})
    assert result.returncode != 0
    assert "DJANGO_SECRET_KEY" in result.stderr


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
results["cache_backend"] = settings.CACHES["default"]["BACKEND"]
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
    # A per-process cache (the LocMemCache default) would give every Gunicorn
    # worker its own login-throttle counter; production needs one every
    # worker shares. See deploy/entrypoint.sh's createcachetable step, and
    # test_entrypoint_creates_cache_table_before_gunicorn_starts below.
    assert observed["cache_backend"] == "django.core.cache.backends.db.DatabaseCache"


def test_entrypoint_creates_cache_table_before_gunicorn_starts():
    """The shared throttle cache's table must exist before any worker serves a request."""
    entrypoint = (ROOT / "deploy" / "entrypoint.sh").read_text()
    migrate_index = entrypoint.index("manage.py migrate")
    createcachetable_index = entrypoint.index("manage.py createcachetable")
    gunicorn_index = entrypoint.index("exec gunicorn")
    assert migrate_index < createcachetable_index < gunicorn_index
