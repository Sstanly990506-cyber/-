import mimetypes
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from api._common import json_response, read_json_body
from api.storage import BASE_DIR, DATABASE_URL, authenticate_user, ensure_storage, get_storage_mode, read_state, register_user, write_state
from api.trip_optimizer import optimize_trip

SENSITIVE_SUFFIXES = {'.db', '.sqlite', '.sqlite3', '.py', '.bat', '.ps1', '.sh'}
BLOCKED_PATH_PARTS = {'data'}
PUBLIC_ROOT = Path(BASE_DIR).resolve()


def is_sensitive_path(path: str) -> bool:
    normalized = path.split('?', 1)[0].lower()
    return any(normalized.endswith(suffix) for suffix in SENSITIVE_SUFFIXES)


def is_blocked_static_path(path: str) -> bool:
    candidate = Path(path)
    if candidate.is_absolute():
        return True

    lowered_parts = [part.lower() for part in candidate.parts if part not in {'', '.'}]
    if any(part == '..' for part in lowered_parts):
        return True
    if any(part in BLOCKED_PATH_PARTS for part in lowered_parts):
        return True
    return is_sensitive_path(path)


def resolve_public_file(rel_path: str) -> Path | None:
    if is_blocked_static_path(rel_path):
        return None

    file_path = (PUBLIC_ROOT / rel_path).resolve()
    try:
        file_path.relative_to(PUBLIC_ROOT)
    except ValueError:
        return None
    return file_path


class AppRequestHandler(BaseHTTPRequestHandler):
    server_version = 'GlossApp/1.0'

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path or '/'

        if path in {'/api/health', '/health'}:
            self.handle_health()
            return
        if path in {'/api/state', '/state'}:
            self.handle_get_state()
            return
        if path == '/':
            self.serve_file('index.html')
            return

        rel_path = unquote(path.lstrip('/'))
        if rel_path.startswith('api/'):
            self.send_error(404)
            return
        if is_blocked_static_path(rel_path):
            self.send_error(403)
            return
        self.serve_file(rel_path)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path or '/'
        if path in {'/api/state', '/state'}:
            self.handle_post_state()
            return
        if path in {'/api/users', '/users'}:
            self.handle_post_users()
            return
        if path in {'/api/trips/optimize', '/trips/optimize'}:
            self.handle_post_optimize_trip()
            return
        self.send_error(404)

    def log_message(self, format, *args):
        return

    def handle_health(self):
        try:
            ensure_storage()
            json_response(self, 200, {'ok': True, 'database': get_storage_mode(), 'hasDatabaseUrl': bool(DATABASE_URL)})
        except Exception as err:
            json_response(self, 500, {'ok': False, 'error': str(err)})

    def handle_get_state(self):
        try:
            state = read_state()
            json_response(self, 200, state)
        except Exception as err:
            json_response(self, 500, {'ok': False, 'error': str(err)})

    def handle_post_state(self):
        payload = read_json_body(self)
        if not isinstance(payload, dict):
            json_response(self, 400, {'error': 'invalid json'})
            return

        required = ['glossOptions', 'customers', 'orders', 'audits', 'receivables', 'payables']
        for key in required:
            if key not in payload:
                json_response(self, 400, {'error': f'missing key: {key}'})
                return

        payload = dict(payload)

        try:
            ok, tick = write_state(payload)
        except Exception as err:
            json_response(self, 500, {'ok': False, 'error': str(err)})
            return
        if not ok:
            json_response(self, 409, {'error': 'stale syncTick', 'serverSyncTick': tick})
            return
        json_response(self, 200, {'ok': True, 'syncTick': tick})


    def handle_post_users(self):
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
            json_response(self, 200, {'ok': True, 'account': account})
            return

        if action == 'login':
            username = str(payload.get('username') or '').strip()
            password = str(payload.get('password') or '')
            if not username or not password:
                json_response(self, 400, {'error': 'missing login fields'})
                return
            account = authenticate_user(username, password)
            if not account:
                json_response(self, 401, {'error': 'invalid credentials'})
                return
            json_response(self, 200, {'ok': True, 'account': account})
            return

        json_response(self, 400, {'error': 'unsupported action'})

    def handle_post_optimize_trip(self):
        payload = read_json_body(self)
        if not isinstance(payload, dict):
            json_response(self, 400, {'error': 'invalid json'})
            return
        try:
            result = optimize_trip(payload)
        except ValueError as err:
            json_response(self, 400, {'error': str(err)})
            return
        json_response(self, 200, result)

    def serve_file(self, rel_path: str):
        file_path = resolve_public_file(rel_path)
        if file_path is None:
            self.send_error(403)
            return
        if not file_path.exists() or not file_path.is_file():
            self.send_error(404)
            return

        body = file_path.read_bytes()
        content_type = mimetypes.guess_type(str(file_path))[0] or 'application/octet-stream'
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def create_server(host: str, port: int) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), partial(AppRequestHandler))
