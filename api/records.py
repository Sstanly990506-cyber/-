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
    'priceRules': 'priceRules',
    'inventory': 'inventoryItems',
    'events': 'systemEvents',
    'aiCorrections': 'aiCorrections',
    'lineDestinations': 'lineDestinations',
}
RECORDS_PATH = storage.DATA_DIR / 'records.json'
RECORDS_LOCK = Lock()
RECORD_STORAGE_INIT_LOCK = Lock()
RECORD_STORAGE_READY = False


def all_records(entity, query=''):
    first = list_records(entity, 1, 500, query)
    rows = list(first.get('items') or [])
    for page in range(2, int(first.get('pages') or 1) + 1):
        rows.extend(list_records(entity, page, 500, query).get('items') or [])
    return rows


def _now():
    return int(time.time() * 1000)


def _record_id(entity, row, index=0):
    return str(row.get('id') or row.get('orderNumber') or f'{entity}-{index}')


def ensure_record_storage():
    global RECORD_STORAGE_READY
    storage.ensure_storage()
    if RECORD_STORAGE_READY:
        return
    with RECORD_STORAGE_INIT_LOCK:
        if RECORD_STORAGE_READY:
            return
        if storage.DATABASE_URL:
            with storage.get_db_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute('''CREATE TABLE IF NOT EXISTS app_records (
                        entity TEXT NOT NULL, record_id TEXT NOT NULL, data_json JSONB NOT NULL,
                        updated_at BIGINT NOT NULL, deleted BOOLEAN NOT NULL DEFAULT FALSE,
                        PRIMARY KEY (entity, record_id))''')
                    cur.execute('CREATE INDEX IF NOT EXISTS app_records_entity_updated_idx ON app_records(entity, updated_at)')
                    cur.execute('CREATE INDEX IF NOT EXISTS app_records_entity_deleted_idx ON app_records(entity, deleted)')
                conn.commit()
            _migrate_postgres_once()
        else:
            _migrate_local_once()
        RECORD_STORAGE_READY = True


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


def count_records_by_entity(entities=None):
    ensure_record_storage()
    selected = [entity for entity in (entities or ENTITY_FIELDS.keys()) if entity in ENTITY_FIELDS]
    start = time.perf_counter()
    counts = {entity: 0 for entity in selected}
    if storage.DATABASE_URL:
        with storage.get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    'SELECT entity, COUNT(*) AS count FROM app_records WHERE deleted=FALSE AND entity = ANY(%s) GROUP BY entity',
                    (selected,),
                )
                for row in cur.fetchall() or []:
                    counts[str(row['entity'])] = int(row['count'] or 0)
    else:
        with RECORDS_LOCK:
            records = _load_local()
        for entity in selected:
            counts[entity] = sum(1 for value in records.get(entity, {}).values() if not value.get('deleted'))
    return counts, round((time.perf_counter() - start) * 1000, 1)


def first_pages_for_entities(entities, page_size=100):
    ensure_record_storage()
    selected = [entity for entity in entities if entity in ENTITY_FIELDS]
    page_size = max(1, min(500, int(page_size or 100)))
    pages = {}
    if storage.DATABASE_URL:
        with storage.get_db_connection() as conn:
            with conn.cursor() as cur:
                for entity in selected:
                    cur.execute('SELECT COUNT(*) AS count FROM app_records WHERE entity=%s AND deleted=FALSE', (entity,))
                    total = int((cur.fetchone() or {}).get('count') or 0)
                    cur.execute(
                        '''SELECT record_id, data_json, updated_at FROM app_records
                           WHERE entity=%s AND deleted=FALSE ORDER BY updated_at DESC LIMIT %s''',
                        (entity, page_size),
                    )
                    rows = cur.fetchall() or []
                    items = [dict(row['data_json']) | {'id': row['record_id'], '_updatedAt': int(row['updated_at'])} for row in rows]
                    pages[entity] = {'ok': True, 'entity': entity, 'items': items, 'page': 1, 'pageSize': page_size, 'total': total, 'pages': (total + page_size - 1) // page_size}
        return pages
    with RECORDS_LOCK:
        records = _load_local()
    for entity in selected:
        rows = [(rid, value) for rid, value in records.get(entity, {}).items() if not value.get('deleted')]
        rows.sort(key=lambda item: int(item[1].get('updatedAt') or 0), reverse=True)
        total = len(rows)
        items = [dict(value.get('data') or {}) | {'id': rid, '_updatedAt': int(value.get('updatedAt') or 0)} for rid, value in rows[:page_size]]
        pages[entity] = {'ok': True, 'entity': entity, 'items': items, 'page': 1, 'pageSize': page_size, 'total': total, 'pages': (total + page_size - 1) // page_size}
    return pages


def dashboard_counts(entities, today):
    """Count the complete dataset independently of any list page or search."""
    ensure_record_storage()
    selected = [entity for entity in entities if entity in ENTITY_FIELDS]
    def number(field):
        value = f"data_json->>'{field}'"
        return f"(CASE WHEN {value} ~ '^[+-]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$' THEN ({value})::numeric ELSE 0 END)"
    if storage.DATABASE_URL:
        with storage.get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(f'''SELECT entity, COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE entity='orders' AND COALESCE(data_json->>'status','未完成') NOT IN ('已完成','已送出','已取消')) AS pending,
                    COUNT(*) FILTER (WHERE entity='orders' AND left(data_json->>'orderDate',10)=%s) AS today,
                    COUNT(*) FILTER (WHERE entity='inventory' AND {number('stock')} <= {number('safetyStock')}) AS low,
                    COUNT(*) FILTER (WHERE entity='receivables' AND {number('amount')} > {number('received')}) AS unpaid_receivable,
                    COUNT(*) FILTER (WHERE entity='payables' AND {number('amount')} > {number('paid')}) AS unpaid_payable
                    FROM app_records WHERE deleted=FALSE AND entity = ANY(%s) GROUP BY entity''', (today, selected))
                return {row['entity']: {key: int(value) for key, value in row.items() if key != 'entity'} for row in cur.fetchall()}
    with RECORDS_LOCK:
        source = _load_local()
    result = {}
    def numeric(value):
        try:return float(value or 0)
        except (TypeError, ValueError):return 0
    for entity in selected:
        rows = [row['data'] for row in source.get(entity, {}).values() if not row.get('deleted')]
        result[entity] = {
            'total': len(rows),
            'pending': sum(row.get('status', '未完成') not in {'已完成','已送出','已取消'} for row in rows),
            'today': sum(str(row.get('orderDate') or '')[:10] == today for row in rows),
            'low': sum(numeric(row.get('stock')) <= numeric(row.get('safetyStock')) for row in rows),
            'unpaid_receivable': sum(numeric(row.get('amount')) > numeric(row.get('received')) for row in rows),
            'unpaid_payable': sum(numeric(row.get('amount')) > numeric(row.get('paid')) for row in rows),
        }
    return result


def get_record(entity, record_id):
    ensure_record_storage()
    if storage.DATABASE_URL:
        with storage.get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute('SELECT data_json, updated_at FROM app_records WHERE entity=%s AND record_id=%s AND deleted=FALSE', (entity, record_id))
                row = cur.fetchone()
                return {**row['data_json'], 'id': record_id, '_updatedAt': row['updated_at']} if row else None
    with RECORDS_LOCK:
        row = _load_local().get(entity, {}).get(record_id)
        return {**row['data'], 'id': record_id, '_updatedAt': row['updatedAt']} if row and not row.get('deleted') else None


class RecordConflict(ValueError):
    """The caller's snapshot is no longer current."""


def write_record_batch(writes, deletes=(), expected_versions=None, unique_orders=False):
    """Commit related writes together, checking versions and order uniqueness."""
    ensure_record_storage()
    prepared = []
    for entity, record_id, data in writes:
        if entity not in ENTITY_FIELDS or not record_id or not isinstance(data, dict):
            raise ValueError('invalid record')
        prepared.append((entity, record_id, {**data, 'id': record_id}))
    expected_versions = expected_versions or {}
    tick = _now()

    def validate(current):
        nonlocal tick
        for key, expected in expected_versions.items():
            row = current.get(key)
            actual = int(row['updatedAt']) if row and not row.get('deleted') else 0
            if actual != expected:
                raise RecordConflict('資料已由其他人更新；你的修改已保留，請核對最新資料後再儲存。')
            tick = max(tick, actual + 1)
        if unique_orders:
            for entity, record_id, data in prepared:
                number = str(data.get('orderNumber') or '').strip()
                if entity != 'orders' or not number:
                    continue
                if any(e == 'orders' and rid != record_id and not row.get('deleted')
                       and str(row['data'].get('orderNumber') or '').strip() == number
                       for (e, rid), row in current.items()):
                    raise RecordConflict(f'工單編號已存在：{number}，請使用其他編號。')

    if storage.DATABASE_URL:
        with storage.get_db_connection() as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    # Also serializes inserts: two new orders cannot claim the same number.
                    cur.execute('LOCK TABLE app_records IN SHARE ROW EXCLUSIVE MODE')
                    cur.execute('SELECT MAX(updated_at) AS latest FROM app_records')
                    tick = max(tick, int((cur.fetchone() or {}).get('latest') or 0) + 1)
                    current = {}
                    for entity, record_id in expected_versions:
                        cur.execute('SELECT data_json, updated_at, deleted FROM app_records WHERE entity=%s AND record_id=%s', (entity, record_id))
                        row = cur.fetchone()
                        if row:
                            current[(entity, record_id)] = {'data': row['data_json'], 'updatedAt': row['updated_at'], 'deleted': row['deleted']}
                    if unique_orders:
                        for entity, record_id, data in prepared:
                            if entity != 'orders' or not data.get('orderNumber'):
                                continue
                            cur.execute("SELECT record_id, data_json, updated_at FROM app_records WHERE entity='orders' AND deleted=FALSE AND btrim(data_json->>'orderNumber')=%s", (str(data['orderNumber']).strip(),))
                            for row in cur.fetchall():
                                current[('orders', row['record_id'])] = {'data': row['data_json'], 'updatedAt': row['updated_at'], 'deleted': False}
                    validate(current)
                    for entity, record_id, data in prepared:
                        cur.execute("""INSERT INTO app_records(entity,record_id,data_json,updated_at,deleted)
                            VALUES (%s,%s,%s,%s,FALSE) ON CONFLICT(entity,record_id) DO UPDATE
                            SET data_json=EXCLUDED.data_json,updated_at=EXCLUDED.updated_at,deleted=FALSE""",
                            (entity,record_id,storage.Jsonb(data),tick))
                    for entity, record_id in deletes:
                        cur.execute('UPDATE app_records SET deleted=TRUE,updated_at=%s WHERE entity=%s AND record_id=%s',(tick,entity,record_id))
    else:
        with RECORDS_LOCK:
            records = _load_local()
            tick = max([tick, *(int(row.get('updatedAt') or 0) + 1 for rows in records.values() for row in rows.values())])
            validate({(entity, rid): row for entity, rows in records.items() for rid, row in rows.items()})
            for entity, record_id, data in prepared:
                records.setdefault(entity,{})[record_id]={'data':data,'updatedAt':tick,'deleted':False}
            for entity, record_id in deletes:
                row=records.setdefault(entity,{}).setdefault(record_id,{'data':{}})
                row.update({'updatedAt':tick,'deleted':True})
            _write_local(records)
    return {'ok':True,'updatedAt':tick}


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


def clear_records(entities=None):
    ensure_record_storage()
    selected = [entity for entity in (entities or ENTITY_FIELDS.keys()) if entity in ENTITY_FIELDS]
    counts = {entity: 0 for entity in selected}
    tick = _now()
    if storage.DATABASE_URL:
        with storage.get_db_connection() as conn:
            with conn.cursor() as cur:
                for entity in selected:
                    cur.execute('SELECT record_id FROM app_records WHERE entity=%s AND deleted=FALSE ORDER BY updated_at ASC', (entity,))
                    ids = [str(row['record_id']) for row in (cur.fetchall() or [])]
                    counts[entity] = len(ids)
                    for record_id in ids:
                        tick += 1
                        cur.execute('UPDATE app_records SET deleted=TRUE, updated_at=%s WHERE entity=%s AND record_id=%s', (tick, entity, record_id))
            conn.commit()
    else:
        with RECORDS_LOCK:
            records = _load_local()
            for entity in selected:
                values = records.setdefault(entity, {})
                for value in values.values():
                    if value.get('deleted'):
                        continue
                    tick += 1
                    counts[entity] += 1
                    value.update({'deleted': True, 'updatedAt': tick})
            _write_local(records)
    return {'ok': True, 'cleared': counts, 'updatedAt': tick}


def export_records(entities=None):
    ensure_record_storage()
    selected = [entity for entity in (entities or ENTITY_FIELDS.keys()) if entity in ENTITY_FIELDS]
    data = {}
    for entity in selected:
        first = list_records(entity, 1, 500)
        rows = list(first['items'])
        for page in range(2, first['pages'] + 1):
            rows.extend(list_records(entity, page, 500)['items'])
        data[entity] = [{key: value for key, value in row.items() if key != '_updatedAt'} for row in rows]
    return data


def validate_backup_records(records_by_entity):
    if not isinstance(records_by_entity, dict) or set(ENTITY_FIELDS) - set(records_by_entity):
        raise ValueError('備份缺少資料分類，請使用完整匯出的備份檔。')
    prepared = []
    for entity in ENTITY_FIELDS:
        rows = records_by_entity[entity]
        if not isinstance(rows, list):
            raise ValueError(f'備份的 {entity} 格式錯誤，未還原任何資料。')
        seen = set()
        for index, row in enumerate(rows):
            if not isinstance(row, dict):
                raise ValueError(f'備份的 {entity} 第 {index + 1} 筆格式錯誤。')
            record_id = str(row.get('id') or '').strip()
            if not record_id or record_id in seen:
                raise ValueError(f'備份的 {entity} 包含空白或重複的資料 ID。')
            seen.add(record_id)
            payload = {key: value for key, value in row.items() if key != '_updatedAt'}
            # Validate serialization before touching either records or settings.
            json.dumps(payload, allow_nan=False)
            prepared.append((entity, record_id, {**payload, 'id': record_id}))
    return prepared


def restore_records(records_by_entity, state_updates=None):
    ensure_record_storage()
    prepared = validate_backup_records(records_by_entity)
    if state_updates is not None:
        json.dumps(state_updates, allow_nan=False)
    selected = list(ENTITY_FIELDS.keys())
    restored = {entity: 0 for entity in selected}
    tick = _now()
    if storage.DATABASE_URL:
        with storage.get_db_connection() as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute('LOCK TABLE app_records IN SHARE ROW EXCLUSIVE MODE')
                    cur.execute('SELECT MAX(updated_at) AS latest FROM app_records')
                    tick = max(tick, int((cur.fetchone() or {}).get('latest') or 0) + 1)
                    cur.execute('SELECT entity, record_id FROM app_records WHERE entity = ANY(%s)', (selected,))
                    for row in cur.fetchall():
                        tick += 1
                        cur.execute('UPDATE app_records SET deleted=TRUE, updated_at=%s WHERE entity=%s AND record_id=%s', (tick, row['entity'], row['record_id']))
                    for entity, record_id, payload in prepared:
                        tick += 1
                        cur.execute('''INSERT INTO app_records(entity,record_id,data_json,updated_at,deleted)
                            VALUES (%s,%s,%s,%s,FALSE) ON CONFLICT(entity,record_id) DO UPDATE
                            SET data_json=EXCLUDED.data_json,updated_at=EXCLUDED.updated_at,deleted=FALSE''',
                            (entity, record_id, storage.Jsonb(payload), tick))
                        restored[entity] += 1
                    if state_updates is not None:
                        cur.execute('SELECT state_json, updated_at FROM app_state WHERE id=1 FOR UPDATE')
                        previous = cur.fetchone()
                        state_tick = max(tick, int(previous['updated_at']) + 1)
                        payload = {**previous['state_json'], **state_updates, 'syncTick': state_tick}
                        cur.execute('UPDATE app_state SET state_json=%s, updated_at=%s WHERE id=1', (storage.Jsonb(payload), state_tick))
    else:
        with RECORDS_LOCK, storage.LOCAL_FILE_LOCK:
            records = _load_local()
            tick = max([tick, *(int(row.get('updatedAt') or 0) + 1 for rows in records.values() for row in rows.values())])
            for entity in selected:
                for row in records.setdefault(entity, {}).values():
                    tick += 1
                    row.update({'deleted': True, 'updatedAt': tick})
            for entity, record_id, payload in prepared:
                tick += 1
                records[entity][record_id] = {'data': payload, 'deleted': False, 'updatedAt': tick}
                restored[entity] += 1
            paths = [RECORDS_PATH] + ([storage.LOCAL_STATE_PATH] if state_updates is not None else [])
            originals = {path: path.read_bytes() if path.exists() else None for path in paths}
            try:
                if state_updates is not None:
                    previous = storage.load_local_state_file()
                    state_tick = max(tick, int(previous.get('syncTick') or 0) + 1)
                    storage.write_local_state_file({**previous, **state_updates, 'syncTick': state_tick, 'serverUpdatedAt': state_tick})
                _write_local(records)
            except Exception:
                for path, content in originals.items():
                    if content is None:
                        path.unlink(missing_ok=True)
                    else:
                        path.write_bytes(content)
                raise
    return {'ok': True, 'restored': restored, 'updatedAt': tick}


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
