"""Atomic, per-settings optimistic concurrency for administrative edits."""
import hashlib
import hmac
import json
import time
from api import storage


def settings_version(settings):
    encoded = json.dumps(settings, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def update_settings_if_version(settings, expected):
    storage.ensure_storage()

    def updated_state(current, current_tick):
        if (not isinstance(expected, str) or len(expected) != 64
                or any(char not in '0123456789abcdef' for char in expected)
                or not hmac.compare_digest(expected, settings_version(current.get('settings')))):
            return None, None
        tick = max(int(time.time() * 1000), current_tick + 1)
        updated = {**current, 'settings': settings, 'syncTick': tick, 'serverUpdatedAt': tick}
        updated.pop('users', None)
        return updated, tick

    if storage.DATABASE_URL:
        with storage.get_db_connection() as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute('SELECT state_json, updated_at FROM app_state WHERE id = 1 FOR UPDATE')
                    row = cur.fetchone()
                    if not row:
                        raise RuntimeError('設定資料不存在')
                    current = row['state_json'] if isinstance(row['state_json'], dict) else json.loads(row['state_json'])
                    updated, tick = updated_state(current, int(row['updated_at'] or 0))
                    if updated is None:
                        return None
                    cur.execute('UPDATE app_state SET state_json = %s, updated_at = %s WHERE id = 1', (storage.Jsonb(updated), tick))
        return tick

    with storage.LOCAL_FILE_LOCK:
        current = storage.load_local_state_file()
        updated, tick = updated_state(current, int(current.get('serverUpdatedAt') or current.get('syncTick') or 0))
        if updated is None:
            return None
        storage.write_local_state_file(updated)
    return tick
