"""Core API views."""

from django.db import DatabaseError, connection
from django.utils.decorators import method_decorator
from django.views.decorators.cache import cache_control
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView


@method_decorator(
    cache_control(no_cache=True, no_store=True, must_revalidate=True),
    name="dispatch",
)
class HealthView(APIView):
    """Report application and database health without caching probe results."""

    permission_classes = [AllowAny]

    def get(self, _request: Request) -> Response:
        """Return health status, including a live database connectivity check."""
        database_connected = True

        try:
            connection.ensure_connection()
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")
                cursor.fetchone()
        except DatabaseError:
            database_connected = False

        payload = {
            "status": "ok" if database_connected else "degraded",
            "database": {
                "connected": database_connected,
            },
        }
        response_status = (
            status.HTTP_200_OK if database_connected else status.HTTP_503_SERVICE_UNAVAILABLE
        )
        return Response(payload, status=response_status)
