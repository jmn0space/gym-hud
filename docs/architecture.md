# Architecture & Deployment

[← Documentation index](README.md) · [Product overview](product-overview.md) · [Data & sync](data-sync.md) · [Acceptance criteria](acceptance-tests.md)

## Frontend

- TypeScript
- React
- Vite
- PWA/service worker
- IndexedDB
- responsive mobile-first UI

Primary target device: **Xiaomi Redmi Note 13 Pro+ / Android**.

A heavyweight desktop UI framework is unnecessary. The frontend should optimize for large touch targets, minimal keyboard use, reliable recovery, and quick session entry.

## PWA and service worker

The frontend installs as a Progressive Web App: a manifest
(`frontend/public/manifest.webmanifest`, served at `/manifest.webmanifest`),
a set of home-screen icons under `/icons/`, and a service worker registered
at the site root (`/sw.js`, root scope `/`). See [Data &
synchronization](data-sync.md#authentication-and-offline-continuation) for
how installation and offline continuation fit the authentication model, and
[the README's "PWA and offline"
section](../README.md#pwa-and-offline) for what is cached, the update policy
in user-facing terms, and the Docker preview quick start used to install and
test this on the target Android device (see "Preview and device testing"
below).

### App-shell cache and version policy

The service worker precaches the app shell — `index.html`, the built JS/CSS
entry chunks, the manifest, the icons, and the offline fallback document —
under a cache named `gym-hud-shell-<version>`. `<version>` is generated at
build time from a hash of the precached asset list and their (Vite-assigned,
content-hashed) filenames, not from a timestamp, so the cache name changes
exactly when the shell's actual content changes and stays identical across a
no-op rebuild. On `activate`, the worker deletes every cache whose name
starts with `gym-hud-shell-` other than the current version, so at most one
version's worth of shell assets is ever on disk at a time.

Runtime request handling:

- **Navigation requests** (loading/reloading a page): network-first with a
  short timeout, falling back to the precached `/index.html` app shell, and
  falling back further to `/offline.html` only if the shell itself is
  unavailable.
- **Precached shell assets** (hashed JS/CSS, icons, manifest): cache-first —
  safe because they are immutable by construction; any real change produces
  a new filename.
- **`/api/**`**: never cached, unconditionally network-only, always passed
  straight through.
- **Non-GET requests and cross-origin requests**: never intercepted by the
  service worker at all.

The service worker never applies an update by forcing a reload out from
under live work: a new worker reaches `installed` and waits; the page
surfaces a non-blocking "update ready" notice and only triggers the swap
(and a single guarded reload) when no session is active and the local
mutation outbox is empty. See [Data &
synchronization](data-sync.md#service-worker-updates-and-the-outbox) for how
this interacts with an in-progress workout and pending synchronization.

### The Cache API never holds private data

Private API data lives in IndexedDB only — this is the same login/logout
boundary [Data & synchronization](data-sync.md#authentication-and-offline-continuation)
already defines for the rest of the app, extended here to the service worker
layer. `/api/**` responses are never written to the Cache API, with no
exceptions: a service worker's `fetch` handler sits ahead of any of the
application's own authentication logic, so a cached API response would be
served to whoever loads the page next with no ownership check at all — unlike
an IndexedDB read, which always goes through
`frontend/src/storage/repository.ts` and the application-level checks built
on top of it (e.g. the outbox-owner "different-user protection" in
data-sync.md). Logging out therefore cannot leave a stale authenticated
response reachable from the cache the way it could if API responses were
ever cached; the service worker has nothing of the previous user's to serve.

### Preview and device testing

Android Chrome will not register a service worker, and will not offer
"Install app," over a plain `http://<LAN-IP>` origin — that is not a secure
context. `docker-compose.preview.yml` serves the built frontend and the
Django API from one HTTPS origin (Caddy, `deploy/preview/Caddyfile`, using a
locally-trusted certificate) so the target phone gets a real secure context
without CORS or cross-origin cookies. This is a LAN development/testing aid,
not a production ingress — see "Deployment topology" below for what actually
serves the application in production, and the README's "PWA and offline"
section for the exact commands. The real-device installation/offline-reopen
result this workflow exists to support is recorded in
[`docs/device-smoke-tests.md`](device-smoke-tests.md).

## Backend

- Python
- Django 6.x
- Django REST Framework
- PostgreSQL
- Gunicorn
- WhiteNoise for static assets

Django is preferred for v1 because the application benefits from its built-in authentication, password hashing, sessions, CSRF protection, ORM, migrations, and admin interface.

The REST API and frontend use the same Django session authentication.

Django apps (under `backend/`):

- `core` — health, session login/logout/status, CSRF and JSON error handling,
  throttling, the throttled admin site;
- `apps.sync` — the server synchronization protocol: the processed-mutation
  ledger, per-account change counter, envelope parsing, the transactional replay
  engine, and the `/api/v1/sync/` endpoints. Domains plug their stores in through
  `apps.sync.registry`;
- `apps.pad` — PAD walking sessions, bouts, pauses and rests, their validation
  rules, and the admin-editable PAD defaults.

See [Data & synchronization: server synchronization
protocol](data-sync.md#server-synchronization-protocol) for the contract.

## Database

Primary database: **PostgreSQL hosted on Neon**.

The application should remain ordinary PostgreSQL and must not depend on Neon-specific functionality.

Use the Neon pooled database connection string for normal application traffic.

PostgreSQL is the authoritative synchronized datastore. IndexedDB is the authoritative local datastore while an action is waiting to synchronize. See [Data & sync](data-sync.md).

## Deployment topology

The application is deployed with Docker Compose on the VPS.

```text
Android PWA
     │
   HTTPS
     │
Cloudflare
     │
Cloudflare Tunnel
     │
cloudflared container
     │
Docker bridge network
     │
Django / Gunicorn container
     │
Encrypted PostgreSQL connection
     │
Neon PostgreSQL
```

Recommended services:

```text
docker-compose.yml
├── web
│   └── Django + Gunicorn
└── cloudflared
    └── Cloudflare Tunnel connector
```

The Django container listens inside the Docker network on:

```text
0.0.0.0:8000
```

This does **not** mean port 8000 is exposed publicly.

Use:

```yaml
expose:
  - "8000"
```

Do not normally use:

```yaml
ports:
  - "8000:8000"
```

`cloudflared` reaches Django via the Docker service name:

```text
http://web:8000
```

No inbound public application port is required on the VPS.

## Repository structure

Recommended layout:

```text
project/
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── .env.example
├── manage.py
├── backend/
├── frontend/
├── requirements.txt
└── deploy/
    ├── cloudflared/
    └── entrypoint.sh
```

Secrets must not be committed.

Typical configuration:

```text
DJANGO_SECRET_KEY
DJANGO_DEBUG=False
DJANGO_ALLOWED_HOSTS
DJANGO_CSRF_TRUSTED_ORIGINS
DATABASE_URL
CLOUDFLARE_TUNNEL_TOKEN
```

## Application startup

For the single-instance v1 deployment:

```text
1. Load environment configuration.
2. Run Django migrations.
3. Collect static files.
4. Start Gunicorn.
```

Because v1 uses one Django application instance, migrations may be executed by the deployment entrypoint. If multiple replicas are introduced later, migrations should move to a separate controlled deployment step.

## Static files

The production image should contain the compiled frontend and Django static assets.

WhiteNoise may serve these directly from the Django container.

No persistent volume is required for static files. Persistent local storage should only be introduced later if uploaded or locally generated files become part of the product.

The production `Dockerfile` collects and serves only Django's own static
assets (`collectstatic`, via WhiteNoise); it does not copy a compiled
`frontend/` build into the image or serve it. See
[Authentication](#authentication) for how that gap affects the public
endpoint list today.

## Cloudflare Tunnel

Conceptual ingress:

```yaml
ingress:
  - hostname: app.example.com
    service: http://web:8000
  - service: http_status:404
```

A tunnel token or credentials file must be supplied through environment configuration or Docker secrets and never committed.

A Cloudflare Tunnel hides the VPS application port, but a published hostname remains reachable from the Internet. Application-level access control is therefore still required.

For v1, that access control is Django authentication.

## Authentication

Use Django's standard user model. V1 contains one application user; no custom multi-tenant model is required.

The same account may access `/admin/`.

Authentication uses normal Django session authentication (`django.contrib.sessions`
plus DRF's `SessionAuthentication`), driven by three JSON endpoints under
`core/urls.py`:

| Endpoint | Method | Auth required | CSRF enforced | Purpose |
| --- | --- | --- | --- | --- |
| `/api/v1/auth/session/` | GET | No | No (safe method) | Report the current authentication state and always set the `csrftoken` cookie, including for a caller who has never logged in. |
| `/api/v1/auth/login/` | POST | No | **Yes, even for anonymous callers** | Authenticate with `{"username", "password"}`, start a session, rotate the session key and CSRF token. |
| `/api/v1/auth/logout/` | POST | No | Yes | End the session if one exists. Idempotent: succeeds (204) even when already anonymous. |

`GET /api/v1/auth/session/` responds `200 {"authenticated": true, "username":
"<name>"}` or `200 {"authenticated": false, "username": null}`, and is marked
`no-store` so the browser and any intermediary never caches a stale
authentication state. `POST /api/v1/auth/login/` responds `200 {"authenticated":
true, "username": "..."}` on success; bad credentials or an inactive user
return `400 {"code": "invalid_credentials", ...}`; a missing/empty username or
password returns `400 {"code": "invalid_request", ...}`. `POST
/api/v1/auth/logout/` responds `204 No Content`.

### CSRF on the login/logout endpoints

DRF's `SessionAuthentication` only enforces CSRF for requests that are
*already* authenticated by a session cookie — by design, it skips the check
for anonymous requests, since DRF assumes anonymous endpoints don't need it.
That default is wrong for a login endpoint: an attacker's page could still
force an anonymous browser to POST a login. `LoginView` and `LogoutView`
therefore opt back into Django's ordinary CSRF middleware protection with
`django.views.decorators.csrf.csrf_protect`, which checks the CSRF cookie
against the `X-CSRFToken` header (or `csrfmiddlewaretoken` field) regardless
of authentication state. `LoginView` applies it to `dispatch` (not just
`post`), so an invalid/missing CSRF token is rejected *before*
`APIView.initial()` runs — and therefore before `check_throttles` — so a
CSRF-failing request never consumes a login attempt from the throttle
described below.

Because DRF's `APIView` exempts itself from `CsrfViewMiddleware` by default, a
CSRF failure on these two endpoints is usually *not* routed through DRF's
normal exception handling — Django's CSRF middleware short-circuits the
request and renders `settings.CSRF_FAILURE_VIEW` directly. `CSRF_FAILURE_VIEW`
is set to `core.csrf.csrf_failure`, which returns `403 {"code": "csrf_failed",
"detail": "..."}` for any path under `/api/`, and falls back to Django's
normal HTML failure page everywhere else (so `/admin/` keeps its usual
behavior).

### CSRF on every other authenticated endpoint

The paragraph above covers the *anonymous* CSRF path. DRF's own
`SessionAuthentication.enforce_csrf` separately enforces CSRF for any
already-authenticated request on every protected view, not just
login/logout. `core.authentication.SessionAuthentication.enforce_csrf`
overrides it so that failure gets the same `403 {"code": "csrf_failed"}`
shape as the anonymous case above, on any endpoint, instead of DRF's generic
`permission_denied` — see `core.authentication.CsrfFailed` and
`core.exceptions._CODES_BY_EXCEPTION` for the mechanism.
`core.tests.test_auth` covers both paths, including `LogoutView`, the
concrete case that exercises this one rather than the anonymous path above
(its `csrf_protect` decorates `post`, not `dispatch`).

### Uniform API error shape

Every `/api/v1/` error response takes the shape `{"code": "...", "detail":
"..."}`. Errors raised inside a DRF view go through
`core.exceptions.exception_handler` (`REST_FRAMEWORK["EXCEPTION_HANDLER"]`);
a CSRF failure (handled outside DRF's exception machinery, as above) and a
request matching no URL pattern or raising an exception no DRF view ever sees
(handled by `config.urls.handler404`/`handler500`) produce the same shape by
construction rather than by sharing that code path:

| Situation | Status | `code` |
| --- | --- | --- |
| No session / expired session on a protected endpoint | 401 | `not_authenticated` |
| CSRF check failed, anonymous or authenticated, any endpoint | 403 | `csrf_failed` |
| Authenticated but not permitted | 403 | `permission_denied` |
| Login rejected: missing/empty/non-string username or password | 400 | `invalid_request` |
| Login rejected: well-formed but wrong credentials, or inactive user | 400 | `invalid_credentials` |
| Login throttled (`POST /api/v1/auth/login/`) | 429 | `throttled` |
| Sync request malformed (`client_id`, `mutations`, feed parameters) | 400 | `invalid_request` |
| Request body is not valid JSON | 400 | `parse_error` |
| Request body is not JSON (`POST /api/v1/sync/mutations/`) | 415 | `unsupported_media_type` |
| Sync request body over `DATA_UPLOAD_MAX_MEMORY_SIZE` | 413 | `request_too_large` |
| Sync rate limit (`/api/v1/sync/`, per account) | 429 | `throttled` |
| No URL pattern matches an `/api/` path | 404 | `not_found` |
| Unhandled exception under `/api/` | 500 | `server_error` |

DRF's default `SessionAuthentication` returns **403** for an unauthenticated
request, not 401, because it advertises no `WWW-Authenticate` scheme (DRF only
emits 401 when an authenticator's `authenticate_header` returns something).
`core.authentication.SessionAuthentication` (the configured
`DEFAULT_AUTHENTICATION_CLASSES` entry) overrides `authenticate_header` to
return `"Session"` — a non-`Basic` scheme name — which both restores the
correct 401 and avoids triggering a browser's native credential-prompt dialog
(which happens for the `Basic` scheme).

`config.urls.handler404`/`handler500` close the last gap in this contract: a
path matching *no* URL pattern at all, or an exception that
`core.exceptions.exception_handler` doesn't recognize (so DRF re-raises it),
never reaches a DRF view or its exception handler and would otherwise fall
through to Django's default HTML error pages even under `/api/`. Both check
`request.path` and return the JSON shape above only for `/api/`-prefixed
paths, leaving Django's ordinary behavior everywhere else (in particular,
`/admin/` is unaffected). `handler500`'s `detail` is deliberately generic
(matching Django's own default 500 page), since it is reached precisely when
the error is unexpected. Both are only invoked when `DEBUG` is `False`
(Django's debug pages take over otherwise) — true in every environment
except local development, where `config.settings.local` sets `DEBUG = True`
unconditionally.

### Public vs. protected endpoints

Public (no authentication required):

- `GET /api/v1/health/`
- `GET /api/v1/auth/session/`
- `POST /api/v1/auth/login/` (CSRF-enforced instead)
- `POST /api/v1/auth/logout/` (CSRF-enforced instead)
- Static assets served by WhiteNoise (`/static/...`)
- The Django Admin login page itself (`/admin/login/`); the rest of `/admin/`
  requires an authenticated staff/superuser session, enforced by Django admin
  independently of the DRF settings below.

Everything else under `/api/v1/` is protected -- today that is the
synchronization API (`POST /api/v1/sync/mutations/`, `GET
/api/v1/sync/bootstrap/`, `GET /api/v1/sync/changes/`; see [Data &
synchronization](data-sync.md#server-synchronization-protocol)), and it will be
any future workout, configuration or export endpoint. Protection is the default: `REST_FRAMEWORK`'s
`DEFAULT_PERMISSION_CLASSES` is `["rest_framework.permissions.IsAuthenticated"]`
and `DEFAULT_AUTHENTICATION_CLASSES` is
`["core.authentication.SessionAuthentication"]`, so a new view is private
unless it explicitly opts out (as the endpoints above do with
`permission_classes = [AllowAny]`). `core.tests.test_url_auth_coverage` walks
every URL pattern actually registered under `/api/v1/` at test time and
asserts that each one outside the allowlist above rejects an anonymous
request with `401`, so a future endpoint that forgets to think about this
fails a test instead of shipping open.

The SPA shell itself is **not currently served by Django**: the production
`Dockerfile` builds and runs only the Django/Gunicorn image; it does not copy
a compiled `frontend/` build into `STATICFILES_DIRS` or add a catch-all route
for it. Serving the built SPA in production (and deciding whether that route
is public) is therefore still open work — issue #17's Docker preview
workflow (["PWA and service worker" above](#pwa-and-service-worker),
`docker-compose.preview.yml`) covers the *device-testing* need for a
single-origin HTTPS deployment during development, but it is a separate,
non-production Compose file and does not change what the production
`Dockerfile`/`docker-compose.production.yml` serve. Nothing in this
repository makes Django serve the SPA in production yet.

### Cookies and CSRF settings

```text
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SECURE = True
SESSION_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_AGE = <DJANGO_SESSION_COOKIE_AGE, default 30 days>
CSRF_COOKIE_SECURE = True
CSRF_COOKIE_HTTPONLY = False
```

`SESSION_COOKIE_AGE` is overridable via the `DJANGO_SESSION_COOKIE_AGE`
environment variable (seconds) and defaults to 30 days, so a signed-in device
stays authenticated across being closed and reopened offline for a while,
consistent with the app's offline-continuation behavior, without the session
living forever.

This expiry is **rolling, not fixed**: `core.views.SessionView.get` marks an
authenticated request's session modified (`request.session.modified = True`),
which makes `SessionMiddleware.process_response` re-save it with a fresh
`SESSION_COOKIE_AGE` from *now*. That only happens when this endpoint is
actually called, though, and the frontend does not poll it while already
authenticated — it calls this endpoint at startup to confirm the session is
alive (see [Data & synchronization](data-sync.md)), and its `online`/focus/
visibility recheck logic only re-calls it while the auth state is not yet
decided either way, deliberately excluding the already-`authenticated` case.
So in practice this means "30 days since the app was last (re)opened while
the session was still valid," not "30 days since login" — a daily user who
closes and reopens the app is never signed out mid-use just because their
first login was a month ago — but a tab left open continuously for 30+ days,
never re-triggering that startup check, can still cross expiry mid-session.
`SESSION_SAVE_EVERY_REQUEST` stays `False` so only this one endpoint pays
the extra session write, not every request. `core.tests.test_auth.
test_session_check_refreshes_expiry_for_authenticated_caller` covers the
refresh, asserting on the persisted `Session` row's `expire_date` rather
than the test client's own `SessionStore` (which is unusable for this: it
recomputes to "now" on every access, whether or not the server re-saved
anything); the anonymous case is a no-op (there is no authenticated session
to extend, and none is created just from checking).

`CSRF_COOKIE_HTTPONLY` is deliberately `False` (Django's own default): the
SPA reads the `csrftoken` cookie from JavaScript and echoes it back as the
`X-CSRFToken` request header on unsafe requests, which is Django's documented
pattern for JavaScript clients. This does not weaken session security — the
CSRF cookie carries no authentication data by itself, and
`SESSION_COOKIE_HTTPONLY` (which protects the actual session identifier)
stays `True`.

Credentials and authentication tokens must never be stored in `localStorage`.

### Brute-force login protection

`POST /api/v1/auth/login/` is throttled using
`core.throttling.CloudflareScopedRateThrottle`, a `ScopedRateThrottle`
subclass (`throttle_scope = "login"`) rate-limited via
`REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]["login"]`, itself overridable
through the `DJANGO_LOGIN_THROTTLE_RATE` environment variable (default
`10/min`). This is a minimal mitigation appropriate for a single-account app
behind Cloudflare; it does not replace Cloudflare-level protections (e.g.
rate limiting or WAF rules on the tunnel hostname), which remain the primary
defense against sustained credential-guessing traffic and are configured
outside this repository.

**Client identity.** The only ingress to this application is the trusted
`cloudflared` connector on the private Docker network — the same trust
boundary the production `SECURE_PROXY_SSL_HEADER` setting relies on for the
request scheme (see the README's Production Compose section). `cloudflared`
forwards Cloudflare's `CF-Connecting-IP` header, which Cloudflare's edge sets to the
real client IP and which nothing else can reach Django to spoof, since
Gunicorn's port is never published. `CloudflareScopedRateThrottle.get_ident`
therefore keys on `HTTP_CF_CONNECTING_IP`, falling back to `REMOTE_ADDR` only
when that header is absent (e.g. local development without the tunnel in
front) — **never** on `X-Forwarded-For`, which DRF's stock
`ScopedRateThrottle` would otherwise use (as the whole, externally-settable
header value, absent `NUM_PROXIES`) and which an external client can freely
rewrite to reset its own bucket on every request. A request rejected for CSRF
(see above) is rejected before `check_throttles` runs and so never consumes a
login attempt either. Regression tests for all of this live in
`core.tests.test_throttling`.

**`/admin/login/` shares the bucket, in the common case.** The account
`ensure_app_user` provisions is also the Django superuser (see below), so
`/admin/login/` is an equally valuable credential-guessing target as the API
login — but it is a plain Django view that never goes through DRF's throttle
machinery, and was previously entirely unthrottled. `core.admin.
ThrottledAdminSite` (wired in as `django.contrib.admin`'s `default_site`)
calls `core.throttling.check_login_rate_limit` before delegating to the real
admin login view; see that function's docstring for why it reimplements the
cache-bucket algorithm against a plain `HttpRequest` rather than fabricating
a DRF `Request`/`APIView`. It fails closed with a `503 {"code":
"throttle_unavailable", ...}` if the cache backend itself raises (e.g. a
Neon outage), instead of letting that propagate as an opaque, unhandled 500.

Both entry points read the same `ScopedRateThrottle.THROTTLE_RATES["login"]`,
the same cache, and the same cache-key format — but that is **not** always
one shared budget. `check_login_rate_limit` always keys by IP
(`get_client_ident`), while `CloudflareScopedRateThrottle` inherits DRF's
`SimpleRateThrottle.get_cache_key`, which keys an *authenticated* caller by
`request.user.pk` instead. In practice this only matters for an
already-authenticated client re-posting valid-CSRF credentials to `POST
/api/v1/auth/login/` (the ordinary anonymous case is keyed by IP on both
entry points, so it is unaffected there): that request draws from a
separate, per-user bucket that `/admin/login/` never touches, and vice
versa. Verified: exhausting the authenticated API-login bucket does not
throttle a subsequent `/admin/login/` attempt from the same IP.

### Cache backend

The throttle above stores its per-client attempt history in Django's default
cache (`django.core.cache.cache`). Gunicorn runs `GUNICORN_WORKERS` separate
worker processes, each with its own memory, so the default `LocMemCache`
would give every worker an independent counter — a client could regain
throttle budget just by landing on a different worker on its next attempt.
`config.settings.production` configures a `DatabaseCache` instead, visible to
every worker: `CACHES["default"]["BACKEND"] =
"django.core.cache.backends.db.DatabaseCache"`. `deploy/entrypoint.sh` runs
`manage.py createcachetable` (idempotent) immediately after migrations and
before Gunicorn starts, so the table always exists before any worker serves a
request. Local development and the test suite are unaffected —
`config.settings.base` doesn't configure `CACHES` at all, so Django's
`LocMemCache` default applies there, which is fine for a single process.

### Provisioning the application account

See the [README](../README.md#provisioning-the-application-account) for the
full `createsuperuser` and `ensure_app_user` provisioning workflows. In
short: `ensure_app_user` reads `DJANGO_APP_USERNAME`/`DJANGO_APP_PASSWORD`
from the environment (interactively, via `read -rs`, per the README — never
as a command-line argument), is idempotent, validates the password against
`AUTH_PASSWORD_VALIDATORS`, and never logs the password. Re-running it with
no flags is a safe no-op against an existing user: it deliberately leaves
`is_active`/`is_staff`/`is_superuser` **and** the password untouched, so a
routine deploy/boot script invoking it can never silently revive an account
that was deliberately deactivated (e.g. because a session was believed
compromised) — only `--reset-flags` reconciles those flags, and only
`--reset-password` rotates the password. Rotating the password invalidates
every session issued under the old one the next time each is used (Django
compares each session's stored auth hash, derived from the password hash,
against the current one), which is also how `ensure_app_user
--reset-password` is the supported way to force a full sign-out after a
suspected compromise.

## Public exposure rules

Only Cloudflare should expose the application hostname publicly.

The Django container:

- is reachable by `cloudflared` on the private Docker bridge network;
- does not publish its application port to the VPS host;
- requires no public firewall opening for the application server.

## Admin interface

Django Admin is the v1 configuration surface for infrequently changed values such as:

- PAD defaults (implemented: the `PadDefaults` singleton, served to devices by
  `GET /api/v1/sync/bootstrap/`);
- muscle-group progression percentages;
- exercise configuration;
- allowed starting-load percentages;
- cardio-machine registry.

Domain-specific details are documented in [PAD walking](pad-walking.md) and [Resistance & cardio](training.md).

Synchronized workout records (PAD sessions, bouts, pauses, rests) and the
processed-mutation ledger are shown in the admin **read-only** in the generic
change form: every change to them must arrive as a device mutation (or a
dedicated engine-backed admin action, such as "Discard stuck session"), so
that it is recorded in the ledger and reaches other devices through the
changes feed. The same design applies to `Exercise` and `RoutineExercise`
once they synchronize: their admin-only fields are edited normally in the
change form, but the fields a device can also write are changed only
through an engine-backed admin action, never the generic change form -- see
[Data & synchronization: Server-admin configuration
precedence](data-sync.md#server-admin-configuration-precedence) and [Server
model and administration](data-sync.md#server-model-and-administration).
This is the specified design; it is not implemented yet, since resistance
and routine stores don't synchronize (see [Data & synchronization:
Unsupported stores and
versions](data-sync.md#unsupported-stores-and-versions)).
