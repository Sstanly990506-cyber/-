#!/usr/bin/env python3
import errno
import socket

from api.http_server import create_server, is_blocked_static_path
from api.service import ApiError, get_state_payload, health_payload, optimize_trip_payload, update_state_payload, user_action_payload
from api.storage import BASE_DIR, DATABASE_URL, LOCAL_STATE_PATH, ensure_storage, get_storage_mode

try:
    from flask import Flask, abort, jsonify, request, send_from_directory
except ImportError:
    Flask = None
    abort = jsonify = request = send_from_directory = None

app = Flask(__name__, static_folder=str(BASE_DIR), static_url_path='') if Flask is not None else None


def get_lan_ips():
    ips = set()
    try:
        host = socket.gethostname()
        for info in socket.getaddrinfo(host, None, family=socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith('127.'):
                ips.add(ip)
    except OSError:
        pass
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(('8.8.8.8', 80))
            ip = sock.getsockname()[0]
            if ip and not ip.startswith('127.'):
                ips.add(ip)
    except OSError:
        pass
    return sorted(ips)


if app is not None:
    def bearer_token():
        value = request.headers.get('Authorization', '')
        scheme, _, token = value.partition(' ')
        return token.strip() if scheme.lower() == 'bearer' else ''

    def service_response(operation, *args):
        try:
            return jsonify(operation(*args))
        except ApiError as err:
            return jsonify(err.payload), err.status
        except Exception as err:
            return jsonify({'ok': False, 'error': str(err)}), 500

    @app.get('/api/health')
    @app.get('/health')
    def health():
        return service_response(health_payload)

    @app.get('/api/state')
    @app.get('/state')
    def get_state():
        return service_response(get_state_payload, bearer_token())

    @app.post('/api/state')
    @app.post('/state')
    def post_state():
        return service_response(update_state_payload, bearer_token(), request.get_json(silent=True))

    @app.post('/api/users')
    @app.post('/users')
    def post_users():
        return service_response(user_action_payload, bearer_token(), request.get_json(silent=True))

    @app.post('/api/trips/optimize')
    @app.post('/trips/optimize')
    def post_optimize_trip():
        return service_response(optimize_trip_payload, bearer_token(), request.get_json(silent=True))

    @app.get('/')
    def index():
        return send_from_directory(BASE_DIR, 'index.html')

    @app.get('/<path:path>')
    def static_files(path):
        if path.startswith('api/'):
            abort(404)
        if is_blocked_static_path(path):
            abort(403)
        return send_from_directory(BASE_DIR, path)


def _resolve_port(host, preferred_port, max_tries=20):
    for candidate in range(preferred_port, preferred_port + max_tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind((host, candidate))
                return candidate
            except OSError as err:
                if err.errno != errno.EADDRINUSE:
                    raise
    raise SystemExit(f'[ERROR] 找不到可用連接埠（起始埠 {preferred_port}，共嘗試 {max_tries} 個）。')


def run_server(host, port):
    actual_port = _resolve_port(host, port)
    ensure_storage()
    print(f'[INFO] centralized storage: {get_storage_mode()}')
    if not DATABASE_URL:
        print(f'[INFO] 未設定 DATABASE_URL，已使用本機 {LOCAL_STATE_PATH} 儲存。')
    if actual_port != port:
        print(f'[WARN] 連接埠 {port} 已被占用，改用 {actual_port}。')
    print(f'[INFO] server running: http://{host}:{actual_port}')
    if host == '0.0.0.0':
        for ip in get_lan_ips():
            print(f'       http://{ip}:{actual_port}')

    if app is not None:
        app.run(host=host, port=actual_port, use_reloader=False)
        return
    server = create_server(host, actual_port)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=4173)
    args = parser.parse_args()
    run_server(args.host, args.port)
