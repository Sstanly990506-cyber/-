from http.server import BaseHTTPRequestHandler

from api.storage import PsycopgError, ensure_storage, get_environment_status, get_storage_mode

from api._common import json_response


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            ensure_storage()
            json_response(self, 200, {"ok": True, "database": get_storage_mode(), "environment": get_environment_status()})
        except (RuntimeError, PsycopgError) as err:
            json_response(self, 500, {"ok": False, "error": str(err)})
