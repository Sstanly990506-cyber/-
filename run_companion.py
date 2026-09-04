"""User-session local service. No installation or machine-wide configuration."""
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent


def main():
    sys.path.insert(0, str(ROOT))
    from run_local_ai import clean_environment
    clean = clean_environment(ROOT.parent / '.sanqing-companion-unused-data')
    if '--worker' not in sys.argv:
        try:
            return subprocess.call([sys.executable, '-B', str(ROOT / 'run_companion.py'), '--worker'], cwd=ROOT, env=clean)
        except KeyboardInterrupt:
            return 130
    os.environ.clear()
    os.environ.update(clean)
    from api.local_ai_runtime import load_local_engine
    from companion_server import Companion, CompanionServer
    answer, secret_check = load_local_engine()
    server = CompanionServer(Companion(answer, secret_check))
    print('本機 AI 已啟動：http://127.0.0.1:4175', flush=True)
    print('請到正式網站登入並按「連接這台電腦」，再到本機控制頁確認配對。', flush=True)
    print('按 Ctrl+C 或本機控制頁的停止按鈕可結束。', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError):
        print('無法啟動：請確認本機 4175 沒有被占用，並保留同層 sanqing-local-ai 資料夾。', file=sys.stderr)
        raise SystemExit(1)
