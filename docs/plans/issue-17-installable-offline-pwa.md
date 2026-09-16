# Issue #17 implementation plan

Source: https://github.com/jmn0space/gym-hud/issues/17
Base: main at cd1b52a (Django session auth from #16 merged).

## Goal and boundaries

Make the PWA installable on Android and recoverable after the process is fully
terminated while offline: a web app manifest, home-screen icons, a registered
service worker, an offline navigation fallback, and a documented secure-context
preview workflow for the target device. Cache the app shell with an explicit
version/update policy while keeping private API data exclusively in IndexedDB,
respecting the existing login/logout boundary in [Data &
synchronization](../data-sync.md). Prove the "first authenticated online, then
cold-start offline" continuity story required by PAD-02 and the Overall v1
continuity criterion in [Acceptance criteria](../acceptance-tests.md), handle
service-worker updates and IndexedDB upgrades without forcing a reload that
loses an active session or its outbox, and record one real-device
installation/offline-reopen smoke result. Background synchronization stays
optional, per the existing rule in data-sync.md that the app must never depend
on it.

This issue deliberately does **not**:

- add a server-side synchronization protocol (issue #13 remains open);
- make Django serve the compiled SPA in production ([Architecture &
  deployment](../architecture.md) documents that gap; the Docker preview
  below is a development/testing aid, not that fix);
- add any PAD/resistance/cardio controls;
- add a new IndexedDB store or bump `DATABASE_VERSION` (still 3 — this issue
  adds no stores);
- add a new npm runtime or dev dependency — no `vite-plugin-pwa`, no
  `workbox-*` (see D1 below for why, and CI's `npm audit --omit=dev
  --audit-level=high` / `npm audit --audit-level=critical` gates that make a
  new dependency an ongoing cost, not just an initial risk).

## Two-agent split

This work split cleanly into two surfaces that were built concurrently
against one frozen interface contract (below), coordinated by an orchestrator
that owns the actual commit(s) and holds both agents to non-overlapping file
ownership:

- **Frontend agent** — owns `frontend/**`: the manifest, icons, the
  hand-written service worker and its build-time precache manifest, the
  registration module, the offline fallback page, and the icon-generation
  script.
- **Docker preview + documentation agent** (this document's author) — owns
  `docs/**`, root `README.md`, `docker-compose.preview.yml`,
  `deploy/preview/**`, `tests/test_deployment.py`, `.dockerignore`, and
  `.gitignore`.

Neither agent edited the other's files; anything one agent needed changed in
the other's territory was reported back to the orchestrator instead of done
directly. `deploy/preview/Caddyfile` was authored first, in its own earlier
commit, and treated by both halves as a fixed dependency from that point on:
its `reverse_proxy web:8000` and its static-file routes for `/sw.js`,
`/manifest.webmanifest`, `/offline.html`, and `/icons/*` fix several of the
names in the contract below in a way neither agent could unilaterally change
without breaking the other's half.

This document is written by the Docker preview + documentation agent. It
records the shared decisions (D1–D5) and describes the frontend half only as
context for why the Docker/docs half is shaped the way it is — it does not
claim to have authored or independently verified the frontend agent's code or
test results; see "Testing performed" below for exactly what this half of the
work actually checked.

## Frozen interface contract

Both agents coded against exactly these names; changing any of them after the
fact would require re-coordinating both halves.

| Thing | Path / value |
|---|---|
| Manifest | `frontend/public/manifest.webmanifest`, served at `/manifest.webmanifest` |
| Icons | `frontend/public/icons/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon-180.png` |
| Service worker source | `frontend/src/sw/service-worker.ts` |
| Service worker URL | `/sw.js` at the site root (root scope `/`) |
| Registration module | `frontend/src/pwa/registerServiceWorker.ts` |
| Offline fallback document | precached `/index.html` app shell; `frontend/public/offline.html` served at `/offline.html` only when the shell is genuinely absent |
| Build output | `frontend/dist/` |
| Cache name prefix | `gym-hud-shell-` followed by the build version, e.g. `gym-hud-shell-<hash>` |
| Manifest `start_url` / `scope` | `/` |
| Manifest `display` | `standalone` |
| Manifest `theme_color` / `background_color` | `#0b0d10` (matches `frontend/index.html`) |
| Manifest `name` / `short_name` | `Gym HUD` / `Gym HUD` |
| Preview HTTPS origin | the phone-reachable LAN IP directly, e.g. `https://192.168.1.5` (no `nip.io` or similar wildcard-DNS service) |
| Preview compose file | `docker-compose.preview.yml` |
| Preview reverse proxy | Caddy (`caddy:2-alpine`), config at `deploy/preview/Caddyfile` |
| Smoke evidence doc | `docs/device-smoke-tests.md` |
| Plan doc | this file |

## Design decisions (binding; recorded here rather than renegotiated per-agent)

### D1 — Versioned app-shell precache, generated at build time

Vite emits content-hashed filenames for the shell's JS/CSS, so the service
worker cannot know in advance what to precache — it has to be told, at build
time, exactly which URLs the current build produced. The chosen mechanism is
a small **inline** Vite plugin inside `frontend/vite.config.ts` (no new
dependency) that, in `generateBundle`/`writeBundle`, collects the emitted
shell assets (`index.html`, the JS/CSS entry chunks, the manifest, the icons,
`offline.html`) and injects that list plus a build version string into the
service worker's own output. The version is derived from a hash of the asset
list plus their content hashes — **never** a timestamp, because a
timestamp-derived version would change on every rebuild even when nothing
precached actually changed, which would (a) force every open client to churn
through an activate/cache-swap cycle for a no-op deploy and (b) break
reproducible builds (two builds of the same source producing different
service-worker output).

**Why no `vite-plugin-pwa` / `workbox-*`.** Two independent reasons, not just
the hard rule:

1. Hard rule R2 forbids new npm runtime or dev dependencies for this issue,
   specifically because CI's dependency-audit gates
   (`npm audit --omit=dev --audit-level=high` and
   `npm audit --audit-level=critical`) and the locked, `save-exact`/
   `engine-strict` install convention in `.npmrc` turn every new dependency
   into an ongoing maintenance and supply-chain surface, not just an
   initial integration cost.
2. Independently of the rule, this app's cache policy is narrow and unusual
   enough that a general-purpose SW toolkit would not actually save much
   code. Workbox's value is in configurable "runtime caching routes" for
   common patterns (stale-while-revalidate API caching, generic navigation
   fallbacks); this app needs the *opposite* of the common API-caching
   pattern (D2: `/api/**` must never be cached, with no exceptions or
   size/method carve-outs), plus an update-gating rule tied to
   application-specific state — no active session, no pending outbox entry
   (D3) — that no off-the-shelf recipe encodes. Expressing D2/D3 correctly
   on top of Workbox would need about as much custom glue code as writing
   the whole worker by hand, while adding real bytes and a third-party
   dependency tree to reason about. A small hand-written worker is easier to
   review, line by line, for the one property that matters most here: that
   an authenticated API response can never enter the Cache API.

### D2 — Cache strategies

- **Navigation requests:** network-first with a short timeout, falling back
  to the precached `/index.html` shell; if that is missing, `/offline.html`.
  Network-first keeps the app showing live content whenever the network is
  actually usable, without hanging indefinitely on a slow/broken connection
  before falling back; the shell fallback is what makes the app open at all
  offline, and `/offline.html` is the last resort for the case where even the
  precache itself is unavailable (e.g. the cache was evicted by the browser).
- **Precached shell assets** (hashed JS/CSS/icons/manifest): cache-first.
  They are immutable by construction — any change to their content produces a
  new hashed filename (D1) — so cache-first can never serve stale content for
  something that actually changed, and it skips a network round-trip for
  something that is guaranteed not to.
- **`/api/**`:** never cached by the service worker, unconditionally
  network-only, straight pass-through. Non-GET requests are never
  intercepted at all, and neither are cross-origin requests.
- **Non-GET requests:** never intercepted, at any path. Mutations must always
  either reach the network or fail in a way the app's own outbox logic (not
  the service worker) is responsible for queuing and retrying.

#### Why API responses never enter the Cache API

Private API data lives in IndexedDB only — this is the login/logout boundary
that [Data & synchronization](../data-sync.md) already defines, and it is
also the concrete mechanism this issue relies on to avoid a specific, real
leak: if an authenticated `/api/**` response were ever written to the Cache
API, `caches.match()` would transparently serve that stored response to
**whoever loads the page next**, with no authentication or ownership check in
the loop at all — a service worker's fetch handler sits ahead of any of the
app's own auth logic. IndexedDB reads do not have this problem, because every
one of them goes through `frontend/src/storage/repository.ts`'s functions,
which the application layer above them can and does gate: the "different-user
protection" already documented in data-sync.md (comparing a device's outbox
owner against the server-confirmed identity) is exactly this kind of
application-level check, and it has no equivalent that a service worker's
cache lookup could consult. So the rule has no exceptions or size-based
carve-outs: `/api/**` is always network-only, unconditionally, regardless of
method, status code, or response size.

### D3 — Update policy: never force a reload over live work

- `install`: precache the new version, then call `self.skipWaiting()` **only**
  when the page explicitly asks for it (a `SKIP_WAITING` message) — never
  unconditionally inside `install`. Skipping unconditionally would let a new
  worker take over mid-session underneath whatever the currently-running page
  is doing.
- `activate`: `clients.claim()`, then delete every cache whose name starts
  with `gym-hud-shell-` but is not the current version, so exactly one
  version's worth of shell assets is ever on disk at a time.
- The page registers the service worker, watches `updatefound`/
  `statechange`, and when a worker reaches `installed` while an existing
  controller is already active, it surfaces a non-blocking "Update ready"
  affordance rather than forcing anything. It only sends `SKIP_WAITING` (and
  then reloads once, on `controllerchange`, guarded by a flag so it cannot
  double-fire) when doing so is actually safe: **no active session and no
  pending outbox entry**. Otherwise the banner stays visible and explains
  that the update will apply once the current session finishes — the same
  "never discard local work" principle `docs/data-sync.md` already applies to
  the outbox is extended here to service-worker updates.
- Registration is a no-op, not a crash, when `navigator.serviceWorker` is
  undefined (jsdom, a non-secure context) or when registration itself
  rejects.

### D4 — IndexedDB upgrades stay non-destructive; `DATABASE_VERSION` stays 3

This issue adds no new stores, so the schema itself does not change. The work
here is to prove — with regression tests, not a schema change — the property
the whole offline-continuity story depends on: an in-flight IndexedDB version
change or service-worker update must never discard an active session or the
outbox. The `onversionchange`/`onclose` cache-invalidation behavior in
`frontend/src/storage/repository.ts` (added for issue #15) already handles
reconnection; what issue #17 adds is coverage asserting that a pending
outbox entry and an active session both survive a close/reopen and a
non-destructive upgrade (acceptance test LOCAL-02), and that a
service-worker update does not trigger a reload while either is non-empty
(D3).

### D5 — Secure context: two documented preview paths, Docker first

Android Chrome treats `http://localhost` as a secure context but not
`http://<LAN-IP>`, and a PWA will not install or register a service worker
without one. Testing "Install app" and offline reopen on the actual target
device (a Xiaomi Redmi Note 13 Pro+, per `docs/architecture.md`) therefore
needs either a real certificate or a way to make the phone treat a
`localhost`-equivalent origin as secure over USB. Both are documented,
Docker first:

- **Primary (Docker).** `docker-compose.preview.yml` serves the already-built
  `frontend/dist/` over HTTPS via Caddy with `tls internal`, and
  reverse-proxies `/api` to the Django `web` service, so the phone talks to
  **one** origin — no CORS, ordinary same-origin session/CSRF cookies, the
  same single-origin shape production has (the container still runs
  `config.settings.local` underneath, so cookie flags like `Secure` are not
  identical to production's — see `docs/architecture.md`'s cookie settings).
  This is the path that survives being handed to someone else, or repeated
  later, without a cable plugged in: the phone trusts Caddy's local root CA
  once (the certificate is
  reissued from the same persisted CA for whatever `PREVIEW_HOST` is set to,
  so that trust step does not need repeating when the LAN IP changes — see
  the Compose file's own comments and `docs/device-smoke-tests.md`).
- **Secondary (no TLS).** `adb reverse tcp:8443 tcp:8443` (or Chrome DevTools'
  own port-forwarding UI) makes `http://localhost:PORT` on the phone a
  secure context over USB, for a faster, TLS-free iteration loop when a cable
  is available.

Both paths need `DJANGO_CSRF_TRUSTED_ORIGINS` to include the exact origin the
phone's browser will send, which is why `docker-compose.preview.yml` derives
it from the same `PREVIEW_HOST` variable Caddy's site address uses — see the
"Docker preview quick start" section in `README.md`.

## Implementation sequence

### Frontend half (owned by the frontend agent; summarized here for context)

1. Add `frontend/public/manifest.webmanifest`, the four icon files, and
   `frontend/public/offline.html`.
2. Add `frontend/src/sw/service-worker.ts` implementing D2/D3, plus the D1
   inline Vite plugin wired into `frontend/vite.config.ts`.
3. Add `frontend/src/pwa/registerServiceWorker.ts` and call it from the app
   shell; implement the update-ready banner and its session/outbox-aware
   `SKIP_WAITING` gating.
4. Add a service-worker-scoped `tsconfig` (with `lib` including
   `"WebWorker"`) wired into the `tsc -b` project references so
   `npm run typecheck` covers it, and an ESLint override for the worker's
   global scope (`globals.serviceworker`), consistent with
   `frontend/eslint.config.js`'s existing per-directory blocks.
5. Add regression tests for D3/D4: registration no-ops safely outside a
   secure/supported context; an update is not applied while a session or the
   outbox is non-empty; a pending outbox entry and an active session survive
   a close/reopen and a non-destructive upgrade.

### Docker preview and documentation half (this agent)

1. Kept `deploy/preview/Caddyfile` as already committed — see its own
   comments for the `header_up Host localhost` / CSRF reasoning, verified
   against `backend/config/settings/local.py` (`ALLOWED_HOSTS` is hardcoded
   there and cannot be widened by environment; `CSRF_TRUSTED_ORIGINS` is
   read from `DJANGO_CSRF_TRUSTED_ORIGINS` and can be).
2. Added `docker-compose.preview.yml`: Caddy (serving `frontend/dist/`,
   bind-mounted read-only at `/srv/dist`; a named `caddy_data`/`caddy_config`
   volume so the locally-trusted CA survives restarts), `web` (the same
   image and local settings as `docker-compose.yml`'s service, plus
   `DJANGO_CSRF_TRUSTED_ORIGINS` derived from the same `PREVIEW_HOST` Caddy's
   site address uses), and a dedicated `db` with its own named volume,
   distinct from local dev's `postgres_data`, so the two stacks never share
   data even though both name their services `web`/`db` — a standalone file,
   per hard rule R3.
3. Documented running the project's own frontend build (`npm run build` in
   `frontend/`) before `docker compose up`, rather than adding a frontend
   build service to the Compose file itself (see "Why not a frontend build
   service" below).
4. Extended `tests/test_deployment.py` with structural `docker compose
   config` coverage for the new file: the expected service set, the `/api`
   route and Caddyfile wiring, the `PREVIEW_HOST` → `DJANGO_CSRF_TRUSTED_ORIGINS`
   derivation (including its default), the persisted Caddy data volume, the
   dedicated database volume, and the published ports — following the file's
   existing `compose_config()`/`clean_environment()` conventions.
5. Updated `docs/architecture.md`, `docs/data-sync.md`,
   `docs/acceptance-tests.md`, and root `README.md`; added
   `docs/device-smoke-tests.md` as the acceptance-criterion-5 evidence
   record, honestly marked not yet run.

### Why not a frontend build service

`docker-compose.preview.yml` deliberately does not add a
`node:24-bookworm-slim` build service. A build-once container inside an
otherwise long-running Compose stack either needs `depends_on: condition:
service_completed_successfully` on Caddy plus care around its exit code (more
moving parts for something that only needs to run when frontend source
changes), or risks a silent footgun: Docker creates an empty directory for a
bind-mount source that does not exist yet, so if `frontend/dist/` had never
been built, Caddy would come up serving nothing, with no error at all.
Running an `npm ci`/`npm run build` inside a second container mounting the
same `frontend/` directory the frontend agent's own tooling was concurrently
installing into during this issue's development was also an avoidable risk.
Documenting a plain `npm run build` (README.md's "Frontend quick start"
already covers installing Node 24 and dependencies) as a one-line
prerequisite is simpler and keeps this Compose file's only job what its name
says: preview the app that has already been built.

## Testing performed (this agent's half)

- `docker compose -f docker-compose.preview.yml config` renders cleanly on
  the host, both with defaults and with `PREVIEW_HOST` overridden.
- Manually exercised the rendered stack end to end on the host, without
  building the Django image (`db` and `caddy --no-deps` only): confirmed
  `tls internal` mints a certificate for both `localhost` and a bare
  LAN-style IP address from the same persisted CA in the `caddy_data`
  volume across a container recreation; confirmed `/manifest.webmanifest`
  and `/sw.js` 404 with the intended `Content-Type`/`Cache-Control` headers
  when the build has not produced them yet, rather than being silently
  swallowed by the SPA fallback; confirmed the catch-all serves
  `index.html`; confirmed `/api/*` reverse-proxies (502, since `web` was not
  started for this check — the point was confirming Caddy attempts the
  proxy at all, not exercising Django).
- `tests/test_deployment.py`: the new tests pass against the real rendered
  compose file on the host; inside the sandboxed backend container (no
  Docker CLI available there) they skip by design, matching the file's
  existing `compose_config()` skip behavior for the pre-existing tests.
  `ruff check tests/` and `ruff format --check tests/` both pass.
- Did **not** run `npm run check`/`npm run build` or any frontend test —
  that is the frontend agent's half, and this document does not claim its
  results.
- Did **not** perform the real-device smoke test in
  `docs/device-smoke-tests.md` — no Android hardware is reachable from this
  environment. Every row there is recorded as pending, not passing.

## Follow-on work explicitly out of scope

- Django serving the compiled SPA in production. `docs/architecture.md`
  still documents this as open work; the preview workflow added here is a
  development/testing aid, not that fix.
- The backend synchronization contract (issue #13) and any PAD/resistance/
  cardio controls it would unlock — several items in
  `docs/acceptance-tests.md`'s Android/synchronization checklist still
  depend on that contract, not just on installation/service-worker work.
- Background sync. `docs/data-sync.md` already forbids depending on it; this
  issue does not add it.
- Actually running `docs/device-smoke-tests.md` on the target Xiaomi Redmi
  Note 13 Pro+ — recorded there as not yet run.
