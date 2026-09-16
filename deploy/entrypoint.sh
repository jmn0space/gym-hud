#!/bin/sh
set -eu

if [ -f /app/.env ]; then
    set -a
    # shellcheck disable=SC1091
    . /app/.env
    set +a
fi

export DJANGO_SETTINGS_MODULE="${DJANGO_SETTINGS_MODULE:-config.settings.production}"

python /app/backend/manage.py migrate --noinput
# Idempotent (no-ops if the table exists, and if the active settings module
# has no database-backed cache configured at all); must run before Gunicorn
# starts so every worker's first request can use the shared login throttle.
python /app/backend/manage.py createcachetable
python /app/backend/manage.py collectstatic --noinput

exec gunicorn \
    --chdir /app/backend \
    --bind 0.0.0.0:8000 \
    --workers "${GUNICORN_WORKERS:-2}" \
    --access-logfile - \
    --error-logfile - \
    config.wsgi:application
