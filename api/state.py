from http.server import BaseHTTPRequestHandler

from api.storage import PsycopgError, read_state, write_state

from api._common import json_response, read_json_body


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            state = read_state()
            json_response(self, 200, state)
        except (RuntimeError, PsycopgError) as err:
            json_response(self, 500, {"ok": False, "error": str(err)})

    def do_POST(self):
        payload = read_json_body(self)
        if not isinstance(payload, dict):
            json_response(self, 400, {"error": "invalid json"})
            return

        required = ["glossOptions", "customers", "orders", "audits", "receivables", "payables"]
        for key in required:
            if key not in payload:
                json_response(self, 400, {"error": f"missing key: {key}"})
                return

        payload = dict(payload)

        try:
            ok, tick = write_state(payload)
        except (RuntimeError, PsycopgError) as err:
            json_response(self, 500, {"ok": False, "error": str(err)})
            return

        if not ok:
            json_response(self, 409, {"error": "stale syncTick", "serverSyncTick": tick})
            return

        json_response(self, 200, {"ok": True, "syncTick": tick})
