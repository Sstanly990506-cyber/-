import mimetypes
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from api._common import get_bearer_token, json_response, read_json_body
from api.service import ApiError, get_state_payload, health_payload, optimize_trip_payload, update_state_payload, user_action_payload
from api.storage import BASE_DIR

SENSITIVE_SUFFIXES = {'.db', '.sqlite', '.sqlite3', '.py', '.bat', '.ps1', '.sh'}
BLOCKED_PATH_PARTS = {'data'}
PUBLIC_ROOT = Path(BASE_DIR).resolve()


def is_sensitive_path(path):
    normalized = path.split('?', 1)[0].lower()
    return any(normalized.endswith(suffix) for suffix in SENSITIVE_SUFFIXES)


def is_blocked_static_path(path):
    candidate = Path(path)
    if candidate.is_absolute():
        return True
    lowered_parts = [part.lower() for part in candidate.parts if part not in {'', '.'}]
    return '..' in lowered_parts or any(part in BLOCKED_PATH_PARTS for part in lowered_parts) or is_sensitive_path(path)


def resolve_public_file(rel_path):
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

    def log_message(self, format, *args):
        return

    def send_service_response(self, operation, *args):
        try:
            json_response(self, 200, operation(*args))
        except ApiError as err:
            json_response(self, err.status, err.payload)
        except Exception as err:
            json_response(self, 500, {'ok': False, 'error': str(err)})

    def do_GET(self):
        path = urlparse(self.path).path or '/'
        if path in {'/api/health', '/health'}:
            self.send_service_response(health_payload)
        elif path in {'/api/state', '/state'}:
            self.send_service_response(get_state_payload, get_bearer_token(self))
        elif path == '/':
            self.serve_file('index.html')
        else:
            rel_path = unquote(path.lstrip('/'))
            if rel_path.startswith('api/'):
                self.send_error(404)
            elif is_blocked_static_path(rel_path):
                self.send_error(403)
            else:
                self.serve_file(rel_path)

    def do_POST(self):
        path = urlparse(self.path).path or '/'
        if path in {'/api/state', '/state'}:
            self.send_service_response(update_state_payload, get_bearer_token(self), read_json_body(self))
        elif path in {'/api/users', '/users'}:
            self.send_service_response(user_action_payload, get_bearer_token(self), read_json_body(self))
        elif path in {'/api/trips/optimize', '/trips/optimize'}:
            self.send_service_response(optimize_trip_payload, get_bearer_token(self), read_json_body(self))
        else:
            self.send_error(404)

    def serve_file(self, rel_path):
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


def create_server(host, port):
    return ThreadingHTTPServer((host, port), partial(AppRequestHandler))
