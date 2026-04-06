import json
import os
import time
import uuid
import hashlib
import hmac
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
DEFAULT_DATA_DIR = (BASE_DIR.parent / '.gloss-app-data').resolve()
DATA_DIR = Path(os.environ.get('APP_DATA_DIR') or DEFAULT_DATA_DIR).expanduser().resolve()
LOCAL_STATE_PATH = DATA_DIR / 'app_state.json'
LOCAL_USERS_PATH = DATA_DIR / 'users.json'
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
    'syncTick': 0,
}

BUILTIN_ACCOUNTS = [
    {'username': 'admin', 'password': 'admin123', 'role': 'admin', 'display': '系統管理員'},
    {'username': 'ops', 'password': 'ops123', 'role': 'ops', 'display': '作業主管'},
    {'username': 'finance', 'password': 'finance123', 'role': 'finance', 'display': '財務主管'},
    {'username': 'audit', 'password': 'audit123', 'role': 'audit', 'display': '稽核主管'},
]

DB_INIT_LOCK = Lock()
DB_INITIALIZED = False
STORAGE_READY = False
STORAGE_INITIALIZING = False
LOCAL_FILE_LOCK = Lock()
USERS_FILE_LOCK = Lock()


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


def normalize_username(username: str) -> str:
    return str(username or '').strip().lower()


def hash_password(password: str, salt_hex: str | None = None) -> str:
    normalized = str(password or '')
    salt = bytes.fromhex(salt_hex) if salt_hex else os.urandom(16)
    digest = hashlib.pbkdf2_hmac('sha256', normalized.encode('utf-8'), salt, 120000)
    return f'pbkdf2_sha256$120000${salt.hex()}${digest.hex()}'


def verify_password(password: str, encoded: str) -> bool:
    value = str(encoded or '')
    if value.startswith('pbkdf2_sha256$'):
        try:
            _, rounds, salt_hex, expected = value.split('$', 3)
            if rounds != '120000':
                return False
            candidate = hash_password(password, salt_hex).split('$', 3)[-1]
            return hmac.compare_digest(candidate, expected)
        except ValueError:
            return False
    return hmac.compare_digest(str(password or ''), value)


def sanitize_account_public(user: dict) -> dict:
    return {
        'id': user.get('id') or '',
        'username': user.get('username') or '',
        'display': user.get('display') or user.get('username') or '',
        'role': user.get('role') or 'viewer',
        'createdAt': user.get('createdAt') or '',
    }


def normalize_user_record(user: dict, source: str = 'legacy-import') -> dict | None:
    username = str((user or {}).get('username') or '').strip()
    password = str((user or {}).get('password') or '')
    if not username or not password:
        return None

    encoded = password if password.startswith('pbkdf2_sha256$') else hash_password(password)
    return {
        'id': str((user or {}).get('id') or uuid.uuid4()),
        'username': username,
        'usernameKey': normalize_username(username),
        'password': encoded,
        'display': str((user or {}).get('display') or username).strip() or username,
        'role': str((user or {}).get('role') or 'viewer').strip() or 'viewer',
        'createdAt': str((user or {}).get('createdAt') or time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())),
        'source': str((user or {}).get('source') or source),
    }


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
                    CREATE TABLE IF NOT EXISTS app_users (
                        id TEXT PRIMARY KEY,
                        username TEXT NOT NULL UNIQUE,
                        username_key TEXT NOT NULL UNIQUE,
                        password_hash TEXT NOT NULL,
                        display_name TEXT NOT NULL,
                        role TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        source TEXT NOT NULL
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


def build_default_local_state():
    payload = dict(DEFAULT_APP_STATE)
    payload['serverUpdatedAt'] = 0
    return payload


def write_local_state_file(payload):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    temp_path = LOCAL_STATE_PATH.with_suffix('.tmp')
    temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    temp_path.replace(LOCAL_STATE_PATH)


def load_local_state_file():
    if not LOCAL_STATE_PATH.exists():
        payload = build_default_local_state()
        write_local_state_file(payload)
        return payload

    try:
        payload = json.loads(LOCAL_STATE_PATH.read_text(encoding='utf-8-sig'))
    except (OSError, json.JSONDecodeError):
        broken_path = LOCAL_STATE_PATH.with_name(f"app_state.broken-{int(time.time())}.json")
        try:
            LOCAL_STATE_PATH.replace(broken_path)
        except OSError:
            pass
        payload = build_default_local_state()
        write_local_state_file(payload)
        return payload

    if not isinstance(payload, dict):
        payload = build_default_local_state()
        write_local_state_file(payload)
        return payload

    normalized = dict(DEFAULT_APP_STATE)
    normalized.update(payload)
    normalized['serverUpdatedAt'] = int(payload.get('serverUpdatedAt') or payload.get('syncTick') or 0)
    normalized.pop('users', None)
    return normalized


def ensure_local_storage():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not LOCAL_STATE_PATH.exists():
        write_local_state_file(build_default_local_state())


def load_users_local_file():
    if not LOCAL_USERS_PATH.exists():
        return []
    try:
        payload = json.loads(LOCAL_USERS_PATH.read_text(encoding='utf-8-sig'))
    except (OSError, json.JSONDecodeError):
        broken_path = LOCAL_USERS_PATH.with_name(f"users.broken-{int(time.time())}.json")
        try:
            LOCAL_USERS_PATH.replace(broken_path)
        except OSError:
            pass
        return []
    if not isinstance(payload, list):
        return []
    users = []
    for item in payload:
        normalized = normalize_user_record(item)
        if normalized:
            users.append(normalized)
    return users


def write_users_local_file(users):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    temp_path = LOCAL_USERS_PATH.with_suffix('.tmp')
    temp_path.write_text(json.dumps(users, ensure_ascii=False, indent=2), encoding='utf-8')
    temp_path.replace(LOCAL_USERS_PATH)


def read_users():
    ensure_storage()
    if DATABASE_URL:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    '''
                    SELECT id, username, username_key, password_hash, display_name, role, created_at, source
                    FROM app_users
                    ORDER BY created_at DESC
                    '''
                )
                rows = cur.fetchall() or []
        return [
            {
                'id': row.get('id'),
                'username': row.get('username'),
                'usernameKey': row.get('username_key'),
                'password': row.get('password_hash'),
                'display': row.get('display_name'),
                'role': row.get('role'),
                'createdAt': row.get('created_at'),
                'source': row.get('source'),
            }
            for row in rows
        ]

    with USERS_FILE_LOCK:
        return load_users_local_file()


def write_users(users):
    ensure_storage()
    if DATABASE_URL:
        with get_db_connection() as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute('DELETE FROM app_users')
                    for user in users:
                        cur.execute(
                            '''
                            INSERT INTO app_users (id, username, username_key, password_hash, display_name, role, created_at, source)
                            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                            ''',
                            (
                                user['id'],
                                user['username'],
                                user['usernameKey'],
                                user['password'],
                                user['display'],
                                user['role'],
                                user['createdAt'],
                                user['source'],
                            ),
                        )
            conn.commit()
        return

    with USERS_FILE_LOCK:
        write_users_local_file(users)


def ensure_builtin_users():
    existing = read_users()
    existing_keys = {u['usernameKey'] for u in existing}
    changed = False
    for builtin in BUILTIN_ACCOUNTS:
        key = normalize_username(builtin['username'])
        if key in existing_keys:
            continue
        existing.append(normalize_user_record({
            'id': str(uuid.uuid4()),
            'username': builtin['username'],
            'password': builtin['password'],
            'display': builtin['display'],
            'role': builtin['role'],
            'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'source': 'builtin',
        }, source='builtin'))
        existing_keys.add(key)
        changed = True
    if changed:
        write_users(existing)


def migrate_legacy_users_once():
    if DATABASE_URL:
        with get_db_connection() as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute('SELECT state_json FROM app_state WHERE id = 1 FOR UPDATE')
                    row = cur.fetchone() or {}
                    state_json = row.get('state_json') or {}
                    state_json = state_json if isinstance(state_json, dict) else json.loads(state_json)
                    legacy_users = state_json.get('users') if isinstance(state_json.get('users'), list) else []
                    if legacy_users:
                        for legacy in legacy_users:
                            normalized = normalize_user_record(legacy)
                            if not normalized:
                                continue
                            cur.execute(
                                '''
                                INSERT INTO app_users (id, username, username_key, password_hash, display_name, role, created_at, source)
                                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                                ON CONFLICT (username_key) DO NOTHING
                                ''',
                                (
                                    normalized['id'],
                                    normalized['username'],
                                    normalized['usernameKey'],
                                    normalized['password'],
                                    normalized['display'],
                                    normalized['role'],
                                    normalized['createdAt'],
                                    'legacy-import',
                                ),
                            )
                    if 'users' in state_json:
                        state_json.pop('users', None)
                        cur.execute('UPDATE app_state SET state_json = %s WHERE id = 1', (Jsonb(state_json),))
            conn.commit()
        return

    with LOCAL_FILE_LOCK:
        if LOCAL_STATE_PATH.exists():
            try:
                raw_state = json.loads(LOCAL_STATE_PATH.read_text(encoding='utf-8-sig'))
            except (OSError, json.JSONDecodeError):
                raw_state = {}
        else:
            raw_state = {}

        local_state = load_local_state_file()
        legacy_users = raw_state.get('users') if isinstance(raw_state, dict) and isinstance(raw_state.get('users'), list) else []
        if legacy_users:
            with USERS_FILE_LOCK:
                users = load_users_local_file()
                user_keys = {u['usernameKey'] for u in users}
                for legacy in legacy_users:
                    normalized = normalize_user_record(legacy)
                    if not normalized or normalized['usernameKey'] in user_keys:
                        continue
                    normalized['source'] = 'legacy-import'
                    users.append(normalized)
                    user_keys.add(normalized['usernameKey'])
                write_users_local_file(users)
        if isinstance(raw_state, dict) and 'users' in raw_state:
            local_state.pop('users', None)
            write_local_state_file(local_state)


def register_user(username: str, password: str, display: str, role: str = 'viewer', source: str = 'register'):
    normalized = normalize_user_record(
        {
            'id': str(uuid.uuid4()),
            'username': username,
            'password': password,
            'display': display,
            'role': role,
            'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'source': source,
        },
        source=source,
    )
    if not normalized:
        raise ValueError('invalid user payload')

    users = read_users()
    if any(u['usernameKey'] == normalized['usernameKey'] for u in users):
        raise ValueError('username already exists')
    users.append(normalized)
    write_users(users)
    return sanitize_account_public(normalized)


def authenticate_user(username: str, password: str):
    key = normalize_username(username)
    if not key:
        return None
    users = read_users()
    for user in users:
        if user['usernameKey'] != key:
            continue
        if verify_password(password, user['password']):
            return sanitize_account_public(user)
        return None
    return None


def ensure_storage():
    global STORAGE_READY, STORAGE_INITIALIZING
    if STORAGE_READY:
        return
    if STORAGE_INITIALIZING:
        return

    STORAGE_INITIALIZING = True
    try:
        if DATABASE_URL:
            ensure_postgres_storage()
        else:
            ensure_local_storage()
        migrate_legacy_users_once()
        ensure_builtin_users()
        STORAGE_READY = True
    finally:
        STORAGE_INITIALIZING = False


def read_state():
    ensure_storage()
    if DATABASE_URL:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute('SELECT state_json, updated_at FROM app_state WHERE id = 1')
                row = cur.fetchone()
        state = row['state_json'] if isinstance(row['state_json'], dict) else json.loads(row['state_json'])
        state.pop('users', None)
        state['serverUpdatedAt'] = int(row['updated_at'] or 0)
        return state

    with LOCAL_FILE_LOCK:
        return load_local_state_file()


def write_state(new_state):
    ensure_storage()
    tick = int(new_state.get('syncTick') or int(time.time() * 1000))
    payload = dict(new_state)
    payload.pop('users', None)
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
        current = load_local_state_file()
        current_tick = int(current.get('serverUpdatedAt') or current.get('syncTick') or 0)
        if tick < current_tick:
            return False, current_tick
        next_payload = dict(DEFAULT_APP_STATE)
        next_payload.update(payload)
        next_payload.pop('users', None)
        next_payload['serverUpdatedAt'] = tick
        write_local_state_file(next_payload)
    return True, tick


__all__ = [
    'BASE_DIR',
    'DATA_DIR',
    'DATABASE_URL',
    'DEFAULT_APP_STATE',
    'LOCAL_STATE_PATH',
    'LOCAL_USERS_PATH',
    'PsycopgError',
    'authenticate_user',
    'ensure_storage',
    'get_storage_mode',
    'read_state',
    'read_users',
    'register_user',
    'sanitize_account_public',
    'write_state',
]
