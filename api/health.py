from http.server import BaseHTTPRequestHandler

from api_server import DATABASE_URL, ensure_db
from psycopg import Error as PsycopgError

from api._common import json_response


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            ensure_db()
            json_response(self, 200, {"ok": True, "database": "postgresql", "hasDatabaseUrl": bool(DATABASE_URL)})
        except (RuntimeError, PsycopgError) as err:
            json_response(self, 500, {"ok": False, "error": str(err)})
