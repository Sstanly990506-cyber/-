"""Normalized record storage used by paginated CRUD and incremental sync APIs."""
import json
import time
from pathlib import Path
from threading import Lock

from api import storage

ENTITY_FIELDS = {
    'customers': 'customers',
    'orders': 'orders',
    'audits': 'audits',
    'receivables': 'receivables',
    'payables': 'payables',
    'inventory': 'inventoryItems',
    'events': 'systemEvents',
}
RECORDS_PATH = storage.DATA_DIR / 'records.json'
RECORDS_LOCK = Lock()


def _now():
    return int(time.time() * 1000)


def _record_id(entity, row, index=0):
    return str(row.get('id') or row.get('orderNumber') or f'{entity}-{index}')


def ensure_record_storage():
    storage.ensure_storage()
    if storage.DATABASE_URL:
        with storage.get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute('''CREATE TABLE IF NOT EXISTS app_records (
                    entity TEXT NOT NULL,
                    record_id TEXT NOT NULL,
                    data_json JSONB NOT NULL,
                    updated_at BIGINT NOT NULL,
                    deleted BOOLEAN NOT NULL DEFAULT FALSE,
                    PRIMARY KEY (entity, record_id)
                )''')
                cur.execute('CREATE INDEX IF NOT EXISTS app_records_entity_updated_idx ON app_records(entity, updated_at)')
                cur.execute('CREATE INDEX IF NOT EXISTS app_records_entity_deleted_idx ON app_records(entity, deleted)')
            conn.commit()
        _migrate_postgres_once()
    else:
        _migrate_local_once()


def _migrate_postgres_once():
    with storage.get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT COUNT(*) AS count FROM app_records')
            if int((cur.fetchone() or {}).get('count') or 0):
                return
        legacy = storage.read_state()
        with conn.transaction():
            with conn.cursor() as cur:
                tick = _now()
                for entity, field in ENTITY_FIELDS.items():
                    for index, row in enumerate(legacy.get(field) or []):
                        record_id = _record_id(entity, row, index)
                        cur.execute('''INSERT INTO app_records(entity, record_id, data_json, updated_at, deleted)
                            VALUES (%s, %s, %s, %s, FALSE) ON CONFLICT DO NOTHING''',
                            (entity, record_id, storage.Jsonb(row), tick))
        conn.commit()


def _load_local():
    if not RECORDS_PATH.exists():
        return {}
    try:
        value = json.loads(RECORDS_PATH.read_text(encoding='utf-8-sig'))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _write_local(value):
    storage.DATA_DIR.mkdir(parents=True, exist_ok=True)
    temp = RECORDS_PATH.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    temp.replace(RECORDS_PATH)


def _migrate_local_once():
    with RECORDS_LOCK:
        if RECORDS_PATH.exists():
            return
        legacy = storage.read_state()
        tick = _now()
        records = {}
        for entity, field in ENTITY_FIELDS.items():
            records[entity] = {}
            for index, row in enumerate(legacy.get(field) or []):
                record_id = _record_id(entity, row, index)
                records[entity][record_id] = {'data': row, 'updatedAt': tick, 'deleted': False}
        _write_local(records)


def list_records(entity, page=1, page_size=100, query=''):
    ensure_record_storage()
    if entity not in ENTITY_FIELDS:
        raise ValueError('unsupported entity')
    page = max(1, int(page or 1)); page_size = max(1, min(500, int(page_size or 100)))
    query = str(query or '').strip().lower()
    if storage.DATABASE_URL:
        with storage.get_db_connection() as conn:
            with conn.cursor() as cur:
                params = [entity]
                where = 'entity = %s AND deleted = FALSE'
                if query:
                    where += ' AND data_json::text ILIKE %s'; params.append(f'%{query}%')
                cur.execute(f'SELECT COUNT(*) AS count FROM app_records WHERE {where}', params)
                total = int((cur.fetchone() or {}).get('count') or 0)
                cur.execute(f'''SELECT record_id, data_json, updated_at FROM app_records WHERE {where}
                    ORDER BY updated_at DESC LIMIT %s OFFSET %s''', [*params, page_size, (page - 1) * page_size])
                rows = cur.fetchall() or []
        items = [dict(row['data_json']) | {'id': row['record_id'], '_updatedAt': int(row['updated_at'])} for row in rows]
    else:
        with RECORDS_LOCK:
            source = _load_local().get(entity, {})
        rows = [(rid, value) for rid, value in source.items() if not value.get('deleted') and (not query or query in json.dumps(value.get('data') or {}, ensure_ascii=False).lower())]
        rows.sort(key=lambda item: int(item[1].get('updatedAt') or 0), reverse=True)
        total = len(rows); rows = rows[(page - 1) * page_size:page * page_size]
        items = [dict(value.get('data') or {}) | {'id': rid, '_updatedAt': int(value.get('updatedAt') or 0)} for rid, value in rows]
    return {'ok': True, 'entity': entity, 'items': items, 'page': page, 'pageSize': page_size, 'total': total, 'pages': (total + page_size - 1) // page_size}


def upsert_record(entity, record_id, data):
    ensure_record_storage()
    if entity not in ENTITY_FIELDS or not isinstance(data, dict):
        raise ValueError('invalid record')
    record_id = str(record_id or data.get('id') or '').strip()
    if not record_id:
        raise ValueError('missing record id')
    tick = _now(); payload = dict(data); payload['id'] = record_id
    if storage.DATABASE_URL:
        with storage.get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute('''INSERT INTO app_records(entity, record_id, data_json, updated_at, deleted)
                    VALUES (%s, %s, %s, %s, FALSE) ON CONFLICT(entity, record_id) DO UPDATE
                    SET data_json=EXCLUDED.data_json, updated_at=EXCLUDED.updated_at, deleted=FALSE''',
                    (entity, record_id, storage.Jsonb(payload), tick))
            conn.commit()
    else:
        with RECORDS_LOCK:
            records = _load_local(); records.setdefault(entity, {})[record_id] = {'data': payload, 'updatedAt': tick, 'deleted': False}; _write_local(records)
    return {'ok': True, 'id': record_id, 'updatedAt': tick}


def delete_record(entity, record_id):
    ensure_record_storage(); tick = _now(); record_id = str(record_id or '')
    if storage.DATABASE_URL:
        with storage.get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute('UPDATE app_records SET deleted=TRUE, updated_at=%s WHERE entity=%s AND record_id=%s', (tick, entity, record_id))
            conn.commit()
    else:
        with RECORDS_LOCK:
            records = _load_local(); value = records.setdefault(entity, {}).setdefault(record_id, {'data': {}}); value.update({'deleted': True, 'updatedAt': tick}); _write_local(records)
    return {'ok': True, 'id': record_id, 'updatedAt': tick}


def changes_since(since, limit=1000):
    ensure_record_storage(); since = max(0, int(since or 0)); limit = max(1, min(5000, int(limit or 1000)))
    changes = []
    if storage.DATABASE_URL:
        with storage.get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute('''SELECT entity, record_id, data_json, updated_at, deleted FROM app_records
                    WHERE updated_at > %s ORDER BY updated_at ASC LIMIT %s''', (since, limit))
                rows = cur.fetchall() or []
        changes = [{'entity': row['entity'], 'id': row['record_id'], 'data': row['data_json'], 'updatedAt': int(row['updated_at']), 'deleted': bool(row['deleted'])} for row in rows]
    else:
        with RECORDS_LOCK:
            records = _load_local()
        for entity, values in records.items():
            for rid, value in values.items():
                if int(value.get('updatedAt') or 0) > since:
                    changes.append({'entity': entity, 'id': rid, 'data': value.get('data') or {}, 'updatedAt': int(value.get('updatedAt') or 0), 'deleted': bool(value.get('deleted'))})
        changes.sort(key=lambda row: row['updatedAt']); changes = changes[:limit]
    cursor = max([since, *[row['updatedAt'] for row in changes]])
    return {'ok': True, 'changes': changes, 'cursor': cursor, 'hasMore': len(changes) == limit}


def report_summary():
    ensure_record_storage()
    orders = list_records('orders', 1, 500)['items']
    receivables = list_records('receivables', 1, 500)['items']
    payables = list_records('payables', 1, 500)['items']
    inventory = list_records('inventory', 1, 500)['items']
    return {'ok': True, 'summary': {
        'ordersLoaded': len(orders),
        'pendingOrders': sum(1 for row in orders if row.get('status') != '已完成'),
        'receivableOutstanding': sum(max(0, float(row.get('amount') or 0) - float(row.get('received') or 0)) for row in receivables),
        'payableOutstanding': sum(max(0, float(row.get('amount') or 0) - float(row.get('paid') or 0)) for row in payables),
        'lowInventory': sum(1 for row in inventory if float(row.get('stock') or 0) <= float(row.get('safetyStock') or 0)),
    }}
