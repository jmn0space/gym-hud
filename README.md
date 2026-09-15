# Gym HUD

Mobile-first PAD walking and gym workout tracking application.

## Frontend quick start

The mobile shell in `frontend/` uses React, TypeScript, and Vite. It requires
Node.js 24 (see `frontend/.nvmrc`); dependencies are locked in
`frontend/package-lock.json` and pinned to exact versions.

```bash
cd frontend
nvm use
npm ci
npm run dev
```

The app runs at `http://localhost:5173`. The port is fixed because Django's
local settings trust exactly that origin for CSRF and CORS.

### API configuration

The frontend calls the API with same-origin requests. In development the Vite
dev server proxies `/api` to the Django backend, so session cookies work without
CORS. Start the backend (see below) and the Home screen reports its health from
`GET /api/v1/health/`.

Copy `frontend/.env.example` to `frontend/.env.local` to override:

- `API_PROXY_TARGET` — development proxy target (default `http://127.0.0.1:8000`).
- `VITE_API_BASE_URL` — API origin prefix compiled into the bundle (default
  empty, meaning same-origin). `VITE_*` values are public; never put secrets there.

To try the shell on a phone on the same network, run `npm run dev -- --host` and
open the printed network URL.

Django checks the page origin on unsafe requests (login and sync, once they
exist). Local settings trust only `http://localhost:5173`, so on the desktop open
`localhost`, not `127.0.0.1`. For a phone, add its network origin for that run
only, without changing the committed defaults:

```bash
export DJANGO_CSRF_TRUSTED_ORIGINS=http://192.168.1.5:5173  # your printed network URL
python backend/manage.py runserver
```

### Frontend quality checks

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run check   # all of the above
```

CI runs a locked `npm ci`, a runtime dependency audit (High/Critical fails),
type checking, ESLint (including accessibility rules), Vitest, and a production build.

### Local persistence

Workout actions are written to IndexedDB together with one pending synchronization
envelope in a single transaction. The UI reports success only after that transaction
completes, and reload recovery reads persisted records and the pending queue back
from IndexedDB. The versioned local envelope is provisional while the backend sync
contract in issue #13 remains open. See [Data & synchronization](docs/data-sync.md)
for the record, ordering, retry, and active-session rules.

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

### Provisioning the application account

Gym HUD is single-user: one account is used for both the app login and
`/admin/`. There are two supported ways to create it.

Interactively (prompts for username/password):

```bash
python backend/manage.py createsuperuser
# or, against the running Compose service:
docker compose exec web python backend/manage.py createsuperuser
```

Non-interactively, for scripted/first-boot provisioning, use the
`ensure_app_user` management command. It reads the credentials from the
environment so the password is never typed as a command-line argument or
printed to logs, validates the password against the configured password
validators (`AUTH_PASSWORD_VALIDATORS`), and is safe to run repeatedly:
without `--reset-password` it leaves an existing user's password untouched
and only reconciles the superuser/staff/active flags; with `--reset-password`
it also updates the password.

```bash
export DJANGO_APP_USERNAME=coach
export DJANGO_APP_PASSWORD='use a strong, unique passphrase'
python backend/manage.py ensure_app_user

# or, against the running Compose service:
docker compose exec \
  -e DJANGO_APP_USERNAME=coach \
  -e DJANGO_APP_PASSWORD='use a strong, unique passphrase' \
  web python backend/manage.py ensure_app_user

# to change the password of an already-provisioned account:
docker compose exec \
  -e DJANGO_APP_USERNAME=coach \
  -e DJANGO_APP_PASSWORD='a new strong, unique passphrase' \
  web python backend/manage.py ensure_app_user --reset-password
```

### Local Docker Compose

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

### Production Compose

Use the standalone production file, not the local Compose configuration:

```bash
cp .env.example .env.production
# Fill in the deployment values, then:
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
```

Provide a strong `DJANGO_SECRET_KEY`, public `DJANGO_ALLOWED_HOSTS`, HTTPS
`DJANGO_CSRF_TRUSTED_ORIGINS`, and the Neon pooled `DATABASE_URL` including
`sslmode=require`. CORS origins and Gunicorn workers are also passed through.
Compose rejects missing required values, and Django validates their security at
startup. This file has no bundled PostgreSQL service or local database dependency.
Do not combine it with `docker-compose.yml`, which is explicitly for local use.

Connect the trusted `cloudflared` container to this Compose project's private
default network and route the application hostname to `http://web:8000`, as
described in [the deployment architecture](docs/architecture.md). Provisioning
the tunnel itself remains part of the deployment work; this scaffold supplies
the backend service. Do not publish port 8000 or attach untrusted containers.

Production Django trusts `X-Forwarded-Proto` from this restricted ingress so an
HTTPS request forwarded over Docker HTTP is not redirected back to itself.
The ingress must supply/overwrite that header from the original request scheme;
this trust setting is not suitable for a directly exposed Gunicorn server.
Plain HTTP still redirects to HTTPS. Server-side database cursors are disabled
for compatibility with Neon's transaction-pooled connection.

### Quality checks

```bash
ruff check backend/ scripts/ tests/
ruff format --check backend/ scripts/ tests/
mypy backend/
pytest
python backend/manage.py check --settings=config.settings.test
```

Pre-commit runs Ruff, Mypy, and detect-secrets. CI additionally audits Python
dependencies with pip-audit JSON, resolves finding IDs and aliases through the
[OSV API](https://google.github.io/osv.dev/api/), and evaluates published CVSS
base scores using the `cvss` library (v2/v3/v4). GitHub advisory severity labels
are also considered. The highest available score applies: High/Critical (7.0+)
blocks CI; classified Low/Moderate findings are reported without blocking.
Missing/malformed severity data, skipped dependencies, or unavailable metadata
fail the audit instead of silently passing. Transient requests are retried.

The audit uses public dependency/advisory identifiers only. To reproduce it:

```bash
pip-audit -r requirements.txt --format json --aliases --output pip-audit.json
# pip-audit exits 1 when it finds vulnerabilities; still evaluate that report:
python scripts/enforce_pip_audit_severity.py pip-audit.json
```

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
