"""Isolated fake-data website runner. No .env loading, installs, or production DB."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent


def clean_environment(data_dir):
    # Read only normal runtime paths, never inherited credentials / database settings.
    keys = ('SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'COMSPEC')
    env = {key: os.environ[key] for key in keys if key in os.environ}
    env.update({'APP_DATA_DIR': str(data_dir), 'PYTHONUTF8': '1', 'PYTHONDONTWRITEBYTECODE': '1',
                'APP_SESSION_TTL_SECONDS': '1800', 'OLLAMA_NO_CLOUD': '1', 'OLLAMA_HOST': '127.0.0.1:11434'})
    return env


def local_network_only(event, args):
    if event in ('socket.connect', 'socket.bind'):
        address = args[1]
        if not isinstance(address, tuple) or address[0] != '127.0.0.1':
            raise PermissionError('This demo allows only IPv4 loopback networking.')
    if event == 'socket.getaddrinfo' and args[0] not in ('127.0.0.1', b'127.0.0.1'):
        raise PermissionError('External name resolution is disabled in this demo.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--test', action='store_true')
    parser.add_argument('--port', type=int, default=4173)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('port must be 1024..65535')
    if not args.worker:
        # Persistent FAKE data outside the public/static root and original website.
        folder = ROOT.parent / '.sanqing-website-ai-demo-v1'
        command = [sys.executable, '-B', str(Path(__file__).resolve()), '--worker', '--port', str(args.port)]
        if args.test:
            command.append('--test')
        try:
            return subprocess.call(command, env=clean_environment(folder), cwd=ROOT)
        except KeyboardInterrupt:
            return 130
    sys.path.insert(0, str(ROOT))
    # The internal flag isn't an escape hatch: workers also discard all non-allowlisted settings.
    test_directory = tempfile.TemporaryDirectory(prefix='sanqing-tests-worker-') if args.test else None
    data_dir = Path(test_directory.name) if test_directory else ROOT.parent / '.sanqing-website-ai-demo-v1'
    safe_env = clean_environment(data_dir)
    os.environ.clear()
    os.environ.update(safe_env)
    sys.addaudithook(local_network_only)
    if args.test:
        import unittest
        try:
            result = unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.discover(str(ROOT / 'tests')))
            return 0 if result.wasSuccessful() else 1
        finally:
            test_directory.cleanup()
    from api import storage, records, local_ai
    from api.http_server import create_server
    from api.local_ai_runtime import load_local_engine
    # Demo bypasses account-file provisioning, NOT production authentication.
    # Only this dedicated runner has a passwordless synthetic session route.
    storage.STORAGE_READY = True
    storage.DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not records.RECORDS_PATH.exists():
        records.ensure_record_storage()
        for entity, record in (
            ('orders', {'id': 'demo-order-1', 'orderNumber': 'DEMO-001', 'billingCustomer': '虛構晨光紙品', 'orderDate': '2026-09-10', 'status': '未完成', 'sheetCount': 800}),
            ('customers', {'id': 'demo-customer-1', 'name': '虛構晨光紙品', 'role': '上游'}),
            ('inventory', {'id': 'demo-stock-1', 'material': '測試用透明膜', 'category': '假資料耗材', 'stock': 40, 'unit': '捲', 'safetyStock': 10, 'note': '這是假資料，可以練習修改備註。'}),
        ):
            records.upsert_record(entity, record['id'], record)
    answer, secret_check = load_local_engine()
    server = create_server('127.0.0.1', args.port)
    local_ai.configure(answer=answer, secret_check=secret_check, demo=True, allow_writes=True, stop=server.shutdown)
    print(f'三青網站 AI 假資料示範：http://127.0.0.1:{args.port}', flush=True)
    print('請按「進入假資料示範」。沒有連正式資料庫；按 Ctrl+C 停止。', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n網站已停止；未刪除示範資料。')
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError):
        print('啟動失敗：請確認 4173 連接埠沒有被占用，且 sanqing-local-ai 位於同一層。', file=sys.stderr)
        raise SystemExit(1)
