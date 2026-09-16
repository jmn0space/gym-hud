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

## Backend

- Python
- Django 6.x
- Django REST Framework
- PostgreSQL
- Gunicorn
- WhiteNoise for static assets

Django is preferred for v1 because the application benefits from its built-in authentication, password hashing, sessions, CSRF protection, ORM, migrations, and admin interface.

The REST API and frontend use the same Django session authentication.

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

As of this change, the production `Dockerfile` collects and serves only
Django's own static assets (`collectstatic`, via WhiteNoise); it does not yet
copy a compiled `frontend/` build into the image or serve it. See
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
`SessionAuthentication.enforce_csrf` separately enforces CSRF for any request
that *does* carry a valid session — on every protected view, not just
login/logout — but it raises the generic `rest_framework.exceptions.
PermissionDenied`, which `core.exceptions.exception_handler` would report as
`{"code": "permission_denied", ...}`: a different code than the anonymous case
above for what is, from the client's point of view, the same failure.
`core.authentication.SessionAuthentication.enforce_csrf` overrides this to
raise `core.authentication.CsrfFailed` instead — a `PermissionDenied`
subclass with `default_code = "csrf_failed"` — and
`core.exceptions._CODES_BY_EXCEPTION` matches it *before* the generic
`PermissionDenied` entry (subclass-before-superclass, since the lookup
returns on the first `isinstance()` match). The net effect: **an authenticated
CSRF failure gets the same `403 {"code": "csrf_failed"}` shape as an
anonymous one, on any endpoint**, regardless of which of the two mechanisms
above actually intercepts a given request. `LogoutView` (whose
`csrf_protect` decorates `post`, not `dispatch`) is a concrete case where an
authenticated caller's CSRF failure is caught by *this* path rather than the
anonymous one; `core.tests.test_auth` has regression tests for both.

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
(Django's debug pages take over otherwise), which is the case in every
environment except a developer's own explicit opt-in.

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

Everything else under `/api/v1/` (workout, configuration, sync, export, and
any future endpoints) is protected by default: `REST_FRAMEWORK`'s
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
for it. Serving the built SPA (and deciding whether that route is public) is
therefore still open work, not something this change silently adds.

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
`SESSION_COOKIE_AGE` from *now*. In practice this means "30 days since the
app last confirmed the session with the server," not "30 days since login" —
a daily user is never signed out mid-use just because their first login was
a month ago. `SESSION_SAVE_EVERY_REQUEST` stays `False` so only this one
endpoint (which the frontend already polls to confirm the session is alive;
see [Data & synchronization](data-sync.md)) pays the extra session write,
not every request. `core.tests.test_auth.
test_session_check_refreshes_expiry_for_authenticated_caller` covers the
refresh; the anonymous case is a no-op (there is no authenticated session to
extend, and none is created just from checking).

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

**`/admin/login/` shares the bucket.** The account `ensure_app_user`
provisions is also the Django superuser (see below), so `/admin/login/` is an
equally valuable credential-guessing target as the API login — but it is a
plain Django view that never goes through DRF's throttle machinery, and was
previously entirely unthrottled. `core.admin.ThrottledAdminSite` (wired in as
`django.contrib.admin`'s `default_site` via the `core.admin.
ThrottledAdminConfig` app config in `INSTALLED_APPS`) calls
`core.throttling.check_login_rate_limit` before delegating to the real admin
login view. That helper — rather than a second `CloudflareScopedRateThrottle`
instance — reimplements just the cache-bucket algorithm against a plain
`HttpRequest`, because `/admin/login/` has no DRF `Request`/`APIView` to give
a real DRF throttle's `allow_request(request, view)`; fabricating one would
be worse than a second entry point, since a bare `rest_framework.request.
Request(request)` with no authenticators configured resolves `.user` to
`AnonymousUser` unconditionally, unlike `SessionAuthentication`, which reads
the underlying Django request's already-resolved `.user`. Both entry points
read the same `ScopedRateThrottle.THROTTLE_RATES["login"]`, the same cache,
and the same cache-key format, so a client is limited identically — and
shares one budget — regardless of which login form it uses.

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

- PAD defaults;
- muscle-group progression percentages;
- exercise configuration;
- allowed starting-load percentages;
- cardio-machine registry.

Domain-specific details are documented in [PAD walking](pad-walking.md) and [Resistance & cardio](training.md).
