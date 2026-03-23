#!/usr/bin/env python3
import socket
<<<<<< codex/fix-website-loading-issue-and-refactor-code-eckeq3

from api.storage import DATABASE_URL, ensure_storage, get_storage_mode

try:
    from flask import Flask, abort, jsonify, request, send_from_directory
except ImportError:
    Flask = None
    abort = jsonify = request = send_from_directory = None

from api.http_server import create_server, is_sensitive_path
from api.storage import BASE_DIR, PsycopgError, read_state, write_state
from api.trip_optimizer import optimize_trip

app = None
if Flask is not None:
    app = Flask(__name__, static_folder=str(BASE_DIR), static_url_path='')
=======
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_from_directory

from api.storage import BASE_DIR, DATABASE_URL, PsycopgError, ensure_storage, get_storage_mode, read_state, write_state
from api.trip_optimizer import optimize_trip

SENSITIVE_SUFFIXES = {'.db', '.sqlite', '.sqlite3', '.py', '.bat', '.ps1', '.sh'}

app = Flask(__name__, static_folder=str(BASE_DIR), static_url_path='')
>>>>>> main


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


<<<<<< codex/fix-website-loading-issue-and-refactor-code-eckeq3
if app is not None:
    def json_error(message, status=500):
        return jsonify({'ok': False, 'error': message}), status


    @app.get('/api/health')
    @app.get('/health')
    def health():
        try:
            ensure_storage()
            return jsonify({'ok': True, 'database': get_storage_mode(), 'hasDatabaseUrl': bool(DATABASE_URL)})
        except (RuntimeError, PsycopgError) as err:
            return json_error(str(err), 500)


    @app.get('/api/state')
    @app.get('/state')
    def get_state():
        try:
            state = read_state()
            state['users'] = []
            return jsonify(state)
        except (RuntimeError, PsycopgError) as err:
            return json_error(str(err), 500)


    @app.post('/api/state')
    @app.post('/state')
    def post_state():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({'error': 'invalid json'}), 400

        required = ['glossOptions', 'customers', 'orders', 'audits', 'receivables', 'payables']
        for key in required:
            if key not in payload:
                return jsonify({'error': f'missing key: {key}'}), 400

        payload = dict(payload)
        payload.pop('users', None)

        try:
            ok, tick = write_state(payload)
        except (RuntimeError, PsycopgError) as err:
            return json_error(str(err), 500)
        if not ok:
            return jsonify({'error': 'stale syncTick', 'serverSyncTick': tick}), 409
        return jsonify({'ok': True, 'syncTick': tick})


    @app.post('/api/trips/optimize')
    @app.post('/trips/optimize')
    def post_optimize_trip():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({'error': 'invalid json'}), 400
        try:
            result = optimize_trip(payload)
        except ValueError as err:
            return jsonify({'error': str(err)}), 400
        return jsonify(result)


    @app.get('/')
    def index():
        return send_from_directory(BASE_DIR, 'index.html')


    @app.get('/<path:path>')
    def static_files(path):
        if path.startswith('api/'):
            abort(404)
        if is_sensitive_path(path):
            abort(403)
        return send_from_directory(BASE_DIR, path)


def run_server(host: str, port: int):
    ensure_storage()
    print(f'[INFO] centralized storage: {get_storage_mode()}')
    if not DATABASE_URL:
        print('[INFO] 未設定 DATABASE_URL，已自動改用本機 data/app_state.json 儲存。')
    if app is None:
        print('[INFO] 未安裝 Flask，已自動改用 Python 內建伺服器。')
    print(f'[INFO] server running: http://{host}:{port}')
    if host == '0.0.0.0':
        lan_ips = get_lan_ips()
        if lan_ips:
            print('[INFO] LAN 可用網址：')
            for ip in lan_ips:
                print(f'       http://{ip}:{port}')
        else:
            print('[WARN] 無法自動偵測區網 IP，請手動查詢電腦 IP 後讓手機連線。')

    if app is not None:
        app.run(host=host, port=port)
        return
=======
def is_sensitive_path(path: str) -> bool:
    normalized = path.split('?', 1)[0].lower()
    return any(normalized.endswith(suffix) for suffix in SENSITIVE_SUFFIXES)


def json_error(message, status=500):
    return jsonify({'ok': False, 'error': message}), status


@app.get('/api/health')
@app.get('/health')
def health():
    try:
        ensure_storage()
        return jsonify({'ok': True, 'database': get_storage_mode(), 'hasDatabaseUrl': bool(DATABASE_URL)})
    except (RuntimeError, PsycopgError) as err:
        return json_error(str(err), 500)


@app.get('/api/state')
@app.get('/state')
def get_state():
    try:
        state = read_state()
        state['users'] = []
        return jsonify(state)
    except (RuntimeError, PsycopgError) as err:
        return json_error(str(err), 500)


@app.post('/api/state')
@app.post('/state')
def post_state():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({'error': 'invalid json'}), 400

    required = ['glossOptions', 'customers', 'orders', 'audits', 'receivables', 'payables']
    for key in required:
        if key not in payload:
            return jsonify({'error': f'missing key: {key}'}), 400

    payload = dict(payload)
    payload.pop('users', None)
>>>>>> main

    server = create_server(host, port)
    try:
<<<<<< codex/fix-website-loading-issue-and-refactor-code-eckeq3
        server.serve_forever()
    finally:
        server.server_close()


=======
        ok, tick = write_state(payload)
    except (RuntimeError, PsycopgError) as err:
        return json_error(str(err), 500)
    if not ok:
        return jsonify({'error': 'stale syncTick', 'serverSyncTick': tick}), 409
    return jsonify({'ok': True, 'syncTick': tick})


@app.post('/api/trips/optimize')
@app.post('/trips/optimize')
def post_optimize_trip():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({'error': 'invalid json'}), 400
    try:
        result = optimize_trip(payload)
    except ValueError as err:
        return jsonify({'error': str(err)}), 400
    return jsonify(result)


@app.get('/')
def index():
    return send_from_directory(BASE_DIR, 'index.html')


@app.get('/<path:path>')
def static_files(path):
    if path.startswith('api/'):
        abort(404)
    if is_sensitive_path(path):
        abort(403)
    file_path = Path(BASE_DIR) / path
    if not file_path.exists() or not file_path.is_file():
        abort(404)
    return send_from_directory(BASE_DIR, path)


>>>>>> main
if __name__ == '__main__':
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=4173)
    args = parser.parse_args()
<<<<<< codex/fix-website-loading-issue-and-refactor-code-eckeq3
    run_server(args.host, args.port)
=======

    ensure_storage()
    print(f'[INFO] centralized storage: {get_storage_mode()}')
    if not DATABASE_URL:
        print('[INFO] 未設定 DATABASE_URL，已自動改用本機 data/app_state.json 儲存。')
    print(f'[INFO] server running: http://{args.host}:{args.port}')
    if args.host == '0.0.0.0':
        lan_ips = get_lan_ips()
        if lan_ips:
            print('[INFO] LAN 可用網址：')
            for ip in lan_ips:
                print(f'       http://{ip}:{args.port}')
        else:
            print('[WARN] 無法自動偵測區網 IP，請手動查詢電腦 IP 後讓手機連線。')
    app.run(host=args.host, port=args.port)
>>>>>> main
