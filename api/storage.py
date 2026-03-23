import json
import os
import time
from pathlib import Path
from threading import Lock
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

try:
    from psycopg import Error as PsycopgError
    from psycopg import connect
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb
except ImportError:  # optional unless DATABASE_URL is configured
    PsycopgError = RuntimeError
    connect = None
    dict_row = None
    Jsonb = None

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / 'data'
LOCAL_STATE_PATH = DATA_DIR / 'app_state.json'
DATABASE_URL = os.environ.get('DATABASE_URL', '').strip()

DEFAULT_APP_STATE = {
    'glossOptions': ['PVA光', 'PVB光/油', '耐磨', '壓光'],
    'customers': [],
    'orders': [],
    'audits': [],
    'receivables': [],
    'payables': [],
    'systemEvents': [],
    'settings': None,
    'inventoryItems': [],
    'users': [],
    'syncTick': 0,
}
DB_INIT_LOCK = Lock()
DB_INITIALIZED = False
LOCAL_FILE_LOCK = Lock()


def get_storage_mode() -> str:
    return 'postgresql' if DATABASE_URL else 'local-json'


def normalize_database_url(url: str) -> str:
    if not url:
        raise RuntimeError('DATABASE_URL 未設定，無法連線到 PostgreSQL')
    parsed = urlparse(url)
    if parsed.scheme not in {'postgres', 'postgresql'}:
        raise RuntimeError('DATABASE_URL 必須是 PostgreSQL 連線字串')
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query.setdefault('sslmode', 'require')
    return urlunparse(parsed._replace(query=urlencode(query)))


def ensure_psycopg_available():
    if connect is None or dict_row is None or Jsonb is None:
        raise RuntimeError('已設定 DATABASE_URL，但系統未安裝 psycopg；請先安裝 requirements.txt 內的套件。')


def get_db_connection():
    ensure_psycopg_available()
    return connect(normalize_database_url(DATABASE_URL), row_factory=dict_row)


def ensure_postgres_storage():
    global DB_INITIALIZED
    ensure_psycopg_available()
    if DB_INITIALIZED:
        return
    with DB_INIT_LOCK:
        if DB_INITIALIZED:
            return
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    '''
                    CREATE TABLE IF NOT EXISTS app_state (
                        id SMALLINT PRIMARY KEY CHECK (id = 1),
                        state_json JSONB NOT NULL,
                        updated_at BIGINT NOT NULL
                    )
                    '''
                )
                cur.execute(
                    '''
                    INSERT INTO app_state (id, state_json, updated_at)
                    VALUES (1, %s, %s)
                    ON CONFLICT (id) DO NOTHING
                    ''',
                    (Jsonb(DEFAULT_APP_STATE), 0),
                )
            conn.commit()
        DB_INITIALIZED = True


def ensure_local_storage():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if LOCAL_STATE_PATH.exists():
        return
    payload = dict(DEFAULT_APP_STATE)
    payload['serverUpdatedAt'] = 0
    LOCAL_STATE_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')


def ensure_storage():
    if DATABASE_URL:
        ensure_postgres_storage()
        return
    ensure_local_storage()


def read_state():
    ensure_storage()
    if DATABASE_URL:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute('SELECT state_json, updated_at FROM app_state WHERE id = 1')
                row = cur.fetchone()
        state = row['state_json'] if isinstance(row['state_json'], dict) else json.loads(row['state_json'])
        state['serverUpdatedAt'] = int(row['updated_at'] or 0)
        return state

    with LOCAL_FILE_LOCK:
        payload = json.loads(LOCAL_STATE_PATH.read_text(encoding='utf-8'))
    payload.setdefault('serverUpdatedAt', int(payload.get('syncTick') or 0))
    return payload


def write_state(new_state):
    ensure_storage()
    tick = int(new_state.get('syncTick') or int(time.time() * 1000))
    payload = dict(new_state)
    payload['syncTick'] = tick

    if DATABASE_URL:
        with get_db_connection() as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute('SELECT updated_at FROM app_state WHERE id = 1 FOR UPDATE')
                    row = cur.fetchone()
                    current_tick = int((row or {}).get('updated_at') or 0)
                    if tick < current_tick:
                        return False, current_tick
                    cur.execute(
                        'UPDATE app_state SET state_json = %s, updated_at = %s WHERE id = 1',
                        (Jsonb(payload), tick),
                    )
            conn.commit()
        return True, tick

    with LOCAL_FILE_LOCK:
        current = json.loads(LOCAL_STATE_PATH.read_text(encoding='utf-8'))
        current_tick = int(current.get('serverUpdatedAt') or current.get('syncTick') or 0)
        if tick < current_tick:
            return False, current_tick
        payload['serverUpdatedAt'] = tick
        LOCAL_STATE_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    return True, tick


__all__ = [
    'BASE_DIR',
    'DATABASE_URL',
    'DEFAULT_APP_STATE',
    'PsycopgError',
    'ensure_storage',
    'get_storage_mode',
    'read_state',
    'write_state',
]
