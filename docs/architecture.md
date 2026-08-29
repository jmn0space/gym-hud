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

Authentication uses normal Django session authentication:

```text
username
password
```

Recommended production settings include:

```text
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SESSION_COOKIE_SAMESITE = "Lax"
```

Credentials and authentication tokens must never be stored in `localStorage`.

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
