from http.server import BaseHTTPRequestHandler

from api.storage import PsycopgError, authenticate_user, create_session_token, verify_finance_module_password, verify_session_token

from api._common import get_bearer_token, json_response, read_json_body


class handler(BaseHTTPRequestHandler):
    def _current_account(self):
        return verify_session_token(get_bearer_token(self))

    def do_POST(self):
        payload = read_json_body(self)
        if not isinstance(payload, dict):
            json_response(self, 400, {'error': 'invalid json'})
            return

        action = str(payload.get('action') or '').strip().lower()
        if action == 'register':
            json_response(self, 403, {'ok': False, 'error': 'public registration disabled'})
            return

        if action == 'verify_finance_password':
            account = self._current_account()
            if not account:
                json_response(self, 401, {'ok': False, 'error': 'login required'})
                return
            if account.get('role') not in {'admin', 'finance'}:
                json_response(self, 403, {'ok': False, 'error': 'finance role required'})
                return
            password = str(payload.get('password') or '')
            if not password:
                json_response(self, 400, {'ok': False, 'error': 'missing finance password'})
                return
            if not verify_finance_module_password(password):
                json_response(self, 401, {'ok': False, 'error': 'invalid finance password'})
                return
            json_response(self, 200, {'ok': True})
            return

        if action == 'login':
            username = str(payload.get('username') or '').strip()
            password = str(payload.get('password') or '')
            if not username or not password:
                json_response(self, 400, {'error': 'missing login fields'})
                return
            try:
                account = authenticate_user(username, password)
            except (RuntimeError, PsycopgError) as err:
                json_response(self, 500, {'ok': False, 'error': str(err)})
                return
            if not account:
                json_response(self, 401, {'error': 'invalid credentials'})
                return
            json_response(self, 200, {'ok': True, 'account': account, 'token': create_session_token(account)})
            return

        json_response(self, 400, {'error': 'unsupported action'})
