from http.server import BaseHTTPRequestHandler

from api.storage import DATABASE_URL, PsycopgError, ensure_storage, get_storage_mode

from api._common import json_response


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            ensure_storage()
            json_response(self, 200, {"ok": True, "database": get_storage_mode(), "hasDatabaseUrl": bool(DATABASE_URL)})
        except (RuntimeError, PsycopgError) as err:
            json_response(self, 500, {"ok": False, "error": str(err)})
