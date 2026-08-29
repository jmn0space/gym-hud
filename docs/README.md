# Gym HUD Documentation

This directory contains the v0.1 functional and technical specification for Gym HUD.

## Documentation map

- [Product overview](product-overview.md) — product objective, scope, principles, and v1 non-goals.
- [PAD walking](pad-walking.md) — walking sessions, bouts, pain input, pause/rest flow, editing, and HUD behaviour.
- [Resistance & cardio](training.md) — five-day resistance rotation, exercise setup, load assessment/progression, and generic cardio-machine sessions.
- [Architecture & deployment](architecture.md) — frontend/backend stack, Django authentication, Docker, Cloudflare Tunnel, Neon PostgreSQL, and production layout.
- [Data & synchronization](data-sync.md) — entity summary, IndexedDB, mutation outbox, offline behaviour, conflict rules, history, and backups.
- [Acceptance criteria](acceptance-tests.md) — critical behavioural tests for PAD, resistance training, cardio, authentication, deployment, and offline recovery.

## Reading order

For implementation work, start with [Product overview](product-overview.md), then read the domain-specific workflow you are implementing. The architecture and data/sync documents define the cross-cutting constraints that all features must respect.

## Core design rule

Gym HUD is a **training notebook and session HUD, not an automated coach**. It may calculate suggestions from configured rules, but it never changes training parameters without explicit user action.
