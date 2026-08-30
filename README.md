# Gym HUD

Mobile-first PAD walking and gym workout tracking application.

## Backend quick start

Gym HUD uses Django 6.x, Django REST Framework, PostgreSQL, and Docker Compose.

### Local Python setup

```bash
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-dev.txt
pre-commit install

export DJANGO_SETTINGS_MODULE=config.settings.local
python backend/manage.py migrate
python backend/manage.py runserver
```

The health endpoint is available at:

```text
GET http://127.0.0.1:8000/api/v1/health/
```

A healthy response is:

```json
{
  "status": "ok",
  "database": {
    "connected": true
  }
}
```

### Docker Compose

```bash
docker compose up --build
```

The Compose topology intentionally uses `expose: ["8000"]` rather than publishing
port 8000 to the host. This matches the production Cloudflare Tunnel topology.
To verify the health endpoint from inside the Docker network:

```bash
docker compose exec web python -c \
  "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health/').read().decode())"
```

For production, copy `.env.example` to your deployment environment and provide a
strong `DJANGO_SECRET_KEY`, public `DJANGO_ALLOWED_HOSTS`, trusted origins, and the
Neon pooled `DATABASE_URL`. The production settings fail closed when required
security configuration is missing or unsafe.

### Quality checks

```bash
ruff check backend/ scripts/
ruff format --check backend/ scripts/
mypy backend/
pytest backend/
python backend/manage.py check --settings=config.settings.test
```

Pre-commit runs Ruff, Mypy, and detect-secrets. CI additionally audits Python
dependencies and fails when pip-audit supplies High or Critical severity metadata.

## Documentation

The v0.1 specification is split by responsibility so implementation work can reference only the relevant parts:

- [Documentation index](docs/README.md)
- [Product overview](docs/product-overview.md)
- [PAD walking](docs/pad-walking.md)
- [Resistance & cardio](docs/training.md)
- [Architecture & deployment](docs/architecture.md)
- [Data & synchronization](docs/data-sync.md)
- [Acceptance criteria](docs/acceptance-tests.md)

Start with the [documentation index](docs/README.md); each specification file cross-links to related documents.
