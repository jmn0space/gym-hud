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
of authentication state.

Because DRF's `APIView` exempts itself from `CsrfViewMiddleware` by default, a
CSRF failure on these two endpoints is *not* routed through DRF's normal
exception handling — Django's CSRF middleware short-circuits the request and
renders `settings.CSRF_FAILURE_VIEW` directly. `CSRF_FAILURE_VIEW` is set to
`core.csrf.csrf_failure`, which returns `403 {"code": "csrf_failed", "detail":
"..."}` for any path under `/api/`, and falls back to Django's normal HTML
failure page everywhere else (so `/admin/` keeps its usual behavior).

### Uniform API error shape

Every `/api/v1/` error response — other than a CSRF failure, handled above —
takes the shape `{"code": "...", "detail": "..."}`, produced by
`core.exceptions.exception_handler` (`REST_FRAMEWORK["EXCEPTION_HANDLER"]`):

| Situation | Status | `code` |
| --- | --- | --- |
| No session / expired session on a protected endpoint | 401 | `not_authenticated` |
| CSRF check failed (login/logout) | 403 | `csrf_failed` |
| Authenticated but not permitted | 403 | `permission_denied` |
| Login throttled | 429 | `throttled` |

DRF's default `SessionAuthentication` returns **403** for an unauthenticated
request, not 401, because it advertises no `WWW-Authenticate` scheme (DRF only
emits 401 when an authenticator's `authenticate_header` returns something).
`core.authentication.SessionAuthentication` (the configured
`DEFAULT_AUTHENTICATION_CLASSES` entry) overrides `authenticate_header` to
return `"Session"` — a non-`Basic` scheme name — which both restores the
correct 401 and avoids triggering a browser's native credential-prompt dialog
(which happens for the `Basic` scheme).

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
`permission_classes = [AllowAny]`).

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

`CSRF_COOKIE_HTTPONLY` is deliberately `False` (Django's own default): the
SPA reads the `csrftoken` cookie from JavaScript and echoes it back as the
`X-CSRFToken` request header on unsafe requests, which is Django's documented
pattern for JavaScript clients. This does not weaken session security — the
CSRF cookie carries no authentication data by itself, and
`SESSION_COOKIE_HTTPONLY` (which protects the actual session identifier)
stays `True`.

Credentials and authentication tokens must never be stored in `localStorage`.

### Brute-force login protection

`POST /api/v1/auth/login/` is throttled using DRF's `ScopedRateThrottle`
(`throttle_scope = "login"`), rate-limited per client IP via
`REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]["login"]`, itself overridable
through the `DJANGO_LOGIN_THROTTLE_RATE` environment variable (default
`10/min`). This is a minimal mitigation appropriate for a single-account app
behind Cloudflare; it does not replace Cloudflare-level protections (e.g.
rate limiting or WAF rules on the tunnel hostname), which remain the primary
defense against sustained credential-guessing traffic and are configured
outside this repository.

### Provisioning the application account

See the [README](../README.md#provisioning-the-application-account) for the
`createsuperuser` and `ensure_app_user` provisioning workflows. In short:
`ensure_app_user` reads `DJANGO_APP_USERNAME`/`DJANGO_APP_PASSWORD` from the
environment, is idempotent, validates the password against
`AUTH_PASSWORD_VALIDATORS`, never logs the password, and only changes an
existing user's password when `--reset-password` is passed explicitly.

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
