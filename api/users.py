from http.server import BaseHTTPRequestHandler

from api.storage import authenticate_user, register_user
from psycopg import Error as PsycopgError

from api._common import json_response, read_json_body


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        payload = read_json_body(self)
        if not isinstance(payload, dict):
            json_response(self, 400, {'error': 'invalid json'})
            return

        action = str(payload.get('action') or '').strip().lower()
        if action == 'register':
            username = str(payload.get('username') or '').strip()
            password = str(payload.get('password') or '')
            display = str(payload.get('display') or '').strip()
            if not username or not password or not display:
                json_response(self, 400, {'error': 'missing register fields'})
                return
            if len(username) < 3:
                json_response(self, 400, {'error': 'username too short'})
                return
            if len(password) < 4:
                json_response(self, 400, {'error': 'password too short'})
                return
            try:
                account = register_user(username=username, password=password, display=display, role='viewer', source='self-register')
            except ValueError as err:
                json_response(self, 409, {'error': str(err)})
                return
            except (RuntimeError, PsycopgError) as err:
                json_response(self, 500, {'ok': False, 'error': str(err)})
                return
            json_response(self, 200, {'ok': True, 'account': account})
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
            json_response(self, 200, {'ok': True, 'account': account})
            return

        json_response(self, 400, {'error': 'unsupported action'})
