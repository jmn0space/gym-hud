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
environment, only reading/requiring the password when it will actually be
used, and validates it against the configured password validators
(`AUTH_PASSWORD_VALIDATORS`) at that point. It is safe to run repeatedly:

- Without any flags, an existing user is left untouched -- including its
  password and its superuser/staff/active flags -- and the command reports
  whether anything differs from the expected state; it never types a
  password on the command line, since none is needed for this no-op path.
- `--reset-flags` reconciles an existing user's superuser/staff/active flags
  back to the expected state. This is opt-in and separate from the default
  run specifically so that re-running this command as part of a routine
  deploy/boot script can never silently reactivate an account someone
  deliberately deactivated (e.g. in response to a compromised session).
- `--reset-password` updates the password of an existing user. Rotating the
  password also invalidates every session issued under the old password,
  the next time each one is used.

Enter the password interactively so it never appears in shell history or in
a process listing (`export FOO=bar` and `docker ... -e FOO=bar` both do):

```bash
export DJANGO_APP_USERNAME=coach
read -rsp 'App password: ' DJANGO_APP_PASSWORD && export DJANGO_APP_PASSWORD; echo
python backend/manage.py ensure_app_user

# or, against the running Compose service (bare -e forwards the value from
# this shell's environment instead of taking a literal on the command line):
docker compose exec \
  -e DJANGO_APP_USERNAME \
  -e DJANGO_APP_PASSWORD \
  web python backend/manage.py ensure_app_user

# to change the password of an already-provisioned account:
docker compose exec \
  -e DJANGO_APP_USERNAME \
  -e DJANGO_APP_PASSWORD \
  web python backend/manage.py ensure_app_user --reset-password

# to restore superuser/staff/active status after confirming a deactivation
# was accidental (does not by itself touch the password):
docker compose exec \
  -e DJANGO_APP_USERNAME \
  web python backend/manage.py ensure_app_user --reset-flags
```

`backend/manage.py` matches the Dockerfile's layout: the image's `WORKDIR`
is `/app` and `COPY backend /app/backend`, so `docker compose exec web`
(which runs inside that `WORKDIR`) can reach it at the same relative
`backend/manage.py` path used above and elsewhere in this README.

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

## PWA and offline

Gym HUD installs as a Progressive Web App and keeps working after the network
drops, or after the installed app is fully closed and reopened.

### What is cached, and what is not

- The app shell (`index.html`, the built JS/CSS, the manifest, the icons, and
  the offline fallback page) is precached by the service worker under a
  cache named `gym-hud-shell-<version>`. `<version>` is derived from the
  build's own content hashes, never a timestamp, so it changes exactly when
  the shell's content changes and stays stable across a no-op rebuild.
- `/api/**` responses are **never** cached by the service worker — always
  network-only, unconditionally. Private data lives in IndexedDB only, never
  in the Cache API — see [Architecture: PWA and service
  worker](docs/architecture.md#pwa-and-service-worker) for why that
  boundary is what keeps one login's data from leaking to the next login on
  a shared device.
- Non-GET requests and cross-origin requests are never intercepted by the
  service worker.

### Update policy

A new service-worker version never forces a reload over live work. It
precaches itself and waits; the page surfaces a non-blocking "update ready"
notice and only applies the update (and reloads, once) when no session is
currently active and the local mutation outbox is empty. See [Data &
synchronization: service-worker updates and the
outbox](docs/data-sync.md#service-worker-updates-and-the-outbox).

### Docker preview quick start

Installing the app and registering a service worker on Android needs a
secure context, and a plain `http://<LAN-IP>` origin is not one. The preview
stack (`docker-compose.preview.yml`) serves the built frontend and the
Django API from **one** HTTPS origin through Caddy, so the phone gets a real
(locally-trusted) certificate and ordinary same-origin session/CSRF cookies,
with no CORS involved at all — the same single-origin shape production has,
though the container still runs `config.settings.local` underneath (see
[Architecture: cookies and CSRF
settings](docs/architecture.md#cookies-and-csrf-settings) for exactly what
that does and does not change, such as the `Secure` cookie flag).

**This origin serves full Django debug pages to anyone on the LAN.**
`config.settings.local` runs with `DEBUG = True`, and this stack (unlike
plain `docker-compose.yml`) publishes a port. An unhandled `/api/*`
exception, or simply a mistyped `/api/*` path, returns Django's technical
error page — including the full traceback, request locals, and the
`DATABASE_URL` connection string **with the plaintext `POSTGRES_PASSWORD`
in it** — to any unauthenticated device that can reach the address, not just
the phone under test. Only run this on a network you trust, and stop the
stack (`docker compose -f docker-compose.preview.yml down`) once you are
done. None of its containers auto-restart, so it will not silently come back
after a reboot — start it again explicitly next time.

```bash
# 1. Build the frontend bundle -- Caddy serves whatever is already on disk
#    at frontend/dist/; it does not build it for you.
cd frontend && npm ci && npm run build && cd ..
# No Node locally? Run the same two commands in a throwaway container:
#   docker run --rm -v "$(pwd):/app" -w /app/frontend node:24-bookworm-slim \
#     bash -c "npm ci && npm run build"

# 2. Start the preview stack, with PREVIEW_HOST set to an address your PHONE
#    can reach -- its own LAN IP or your host machine's LAN IP, never
#    "localhost" (that only proves the stack itself boots). DJANGO_SECRET_KEY
#    has no default here (unlike plain docker-compose.yml) -- generate one:
PREVIEW_HOST=192.168.1.5 DJANGO_SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(50))") \
  docker compose -f docker-compose.preview.yml up --build
```

`PREVIEW_HOST` drives both Caddy's certificate and the origin Django trusts:
the Compose file sets `DJANGO_CSRF_TRUSTED_ORIGINS=https://$PREVIEW_HOST` for
you from the same variable, so the two can never drift apart. Provision an
application account against this stack the same way as [local Docker
Compose](#local-docker-compose) above, just adding `-f
docker-compose.preview.yml` to the `docker compose exec` command.

The phone needs to trust Caddy's local certificate authority once:

```bash
docker compose -f docker-compose.preview.yml cp \
  caddy:/data/caddy/pki/authorities/local/root.crt ./gym-hud-preview-ca.crt
adb push ./gym-hud-preview-ca.crt /sdcard/Download/
# Phone: Settings -> Security -> Encryption & credentials -> Install a
# certificate -> CA certificate -> select it from Downloads. (Exact menu
# names/nesting vary by Android version and OEM skin.)
```

**Read this before you tap through the warning.** The prompt you confirm
here is not scoped to this preview stack in any way: once installed, this
root CA is trusted for **every HTTPS site the phone visits, indefinitely**,
not just the `PREVIEW_HOST` this stack happens to issue certificates for —
that only describes what Caddy chooses to *issue*, not what the phone will
*accept*. Anyone who later obtains the CA's private key (unencrypted, in the
`caddy_data` volume at `/data/caddy/pki/authorities/local/root.key` — a
stolen laptop, a backup, a machine shared with someone else) can mint a
certificate for any domain and transparently intercept that phone's HTTPS
traffic, on any network, long after this test is over. **Use a dedicated
test device you are not relying on for anything sensitive**, and when you
are done testing, remove the trust and destroy the key:

```bash
# On the phone: Settings -> Security -> Encryption & credentials -> User
# credentials -> remove "gym-hud-preview-ca.crt" (or whatever name it
# installed under).
docker compose -f docker-compose.preview.yml down -v   # destroys root.key too
```

This trust step only needs repeating if the stack's `caddy_data` volume is
deleted (`docker compose down -v`, the same teardown command above) —
restarting the stack, or later changing `PREVIEW_HOST`, reuses the same
trusted CA and simply issues it a new certificate; that persistence is
exactly why the teardown above matters once you are actually done. Then open
`https://<PREVIEW_HOST>/` on the phone and install from Chrome's menu (⋮ →
"Install app"). `docs/device-smoke-tests.md` has the full
installation/offline-reopen device procedure, and its results table
(currently all `NOT YET RUN`, honestly).

Without a phone available, `adb reverse tcp:8443 tcp:8443` (or Chrome
DevTools' own port-forwarding UI) makes `http://localhost:8443` a secure
context over USB instead, for a faster TLS-free iteration loop. See
`docs/plans/issue-17-installable-offline-pwa.md` (design decision D5) for
both paths and why the Docker path is primary.

## Documentation

The v0.1 specification is split by responsibility so implementation work can reference only the relevant parts:

- [Documentation index](docs/README.md)
- [Product overview](docs/product-overview.md)
- [PAD walking](docs/pad-walking.md)
- [Resistance & cardio](docs/training.md)
- [Architecture & deployment](docs/architecture.md)
- [Data & synchronization](docs/data-sync.md)
- [Acceptance criteria](docs/acceptance-tests.md)
- [Device smoke tests](docs/device-smoke-tests.md)

Start with the [documentation index](docs/README.md); each specification file cross-links to related documents.
