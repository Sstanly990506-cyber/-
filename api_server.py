#!/usr/bin/env python3
import errno
import socket

from api.http_server import create_server, is_blocked_static_path
from api.routes import GET_ROUTES, POST_ROUTES, resolve_get_route, resolve_post_route
from api.service import ApiError, delete_entity_payload, list_entity_payload, upsert_entity_payload
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
        for info in socket.getaddrinfo(socket.gethostname(), None, family=socket.AF_INET):
            if not info[4][0].startswith('127.'):
                ips.add(info[4][0])
    except OSError:
        pass
    return sorted(ips)


if app is not None:
    def bearer_token():
        scheme, _, token = request.headers.get('Authorization', '').partition(' ')
        return token.strip() if scheme.lower() == 'bearer' else ''

    def service_response(operation, *args):
        try:
            return jsonify(operation(*args))
        except ApiError as err:
            return jsonify(err.payload), err.status
        except Exception as err:
            return jsonify({'ok': False, 'error': str(err)}), 500

    def route_endpoint(prefix, route_path):
        safe = route_path.strip('/').replace('/', '_').replace('-', '_') or 'root'
        return f'{prefix}_{safe}'

    def route_response(route):
        if not route:
            abort(404)
        operation, args = route
        return service_response(operation, *args)

    for route_path in GET_ROUTES:
        app.add_url_rule(
            route_path,
            route_endpoint('get', route_path),
            lambda route_path=route_path: route_response(
                resolve_get_route(route_path, bearer_token(), request.args)
            ),
        )

    for route_path in POST_ROUTES:
        app.add_url_rule(
            route_path,
            route_endpoint('post', route_path),
            lambda route_path=route_path: route_response(
                resolve_post_route(route_path, bearer_token(), request.get_json(silent=True))
            ),
            methods=['POST'],
        )

    @app.get('/api/data/<entity>')
    def list_entity(entity):
        return service_response(
            list_entity_payload,
            bearer_token(),
            entity,
            request.args.get('page', 1),
            request.args.get('pageSize', 100),
            request.args.get('q', ''),
        )

    @app.put('/api/data/<entity>/<record_id>')
    def put_entity(entity, record_id):
        return service_response(
            upsert_entity_payload,
            bearer_token(),
            entity,
            record_id,
            request.get_json(silent=True),
        )

    @app.delete('/api/data/<entity>/<record_id>')
    def remove_entity(entity, record_id):
        return service_response(delete_entity_payload, bearer_token(), entity, record_id)

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
    raise SystemExit(f'[ERROR] No free port found starting at {preferred_port}')


def run_server(host, port):
    actual_port = _resolve_port(host, port)
    ensure_storage()
    print(f'[INFO] centralized storage: {get_storage_mode()}')
    if not DATABASE_URL:
        print(f'[INFO] local data file: {LOCAL_STATE_PATH}')
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
