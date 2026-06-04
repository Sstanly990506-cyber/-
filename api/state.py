from http.server import BaseHTTPRequestHandler

from api.storage import PsycopgError, filter_state_for_role, merge_state_for_role, read_state, verify_session_token, write_state

from api._common import get_bearer_token, json_response, read_json_body


class handler(BaseHTTPRequestHandler):
    def _current_account(self):
        return verify_session_token(get_bearer_token(self))

    def do_GET(self):
        account = self._current_account()
        if not account:
            json_response(self, 401, {"ok": False, "error": "login required"})
            return
        try:
            state = filter_state_for_role(read_state(), account.get('role') or 'viewer')
            json_response(self, 200, state)
        except (RuntimeError, PsycopgError) as err:
            json_response(self, 500, {"ok": False, "error": str(err)})

    def do_POST(self):
        account = self._current_account()
        if not account:
            json_response(self, 401, {"ok": False, "error": "login required"})
            return
        payload = read_json_body(self)
        if not isinstance(payload, dict):
            json_response(self, 400, {"error": "invalid json"})
            return

        required = ["glossOptions", "customers", "orders", "audits", "receivables", "payables"]
        for key in required:
            if key not in payload:
                json_response(self, 400, {"error": f"missing key: {key}"})
                return

        try:
            current = read_state()
            payload = merge_state_for_role(current, dict(payload), account.get('role') or 'viewer')
            ok, tick = write_state(payload)
        except (RuntimeError, PsycopgError) as err:
            json_response(self, 500, {"ok": False, "error": str(err)})
            return

        if not ok:
            json_response(self, 409, {"error": "stale syncTick", "serverSyncTick": tick})
            return

        json_response(self, 200, {"ok": True, "syncTick": tick})
