"""Small, explicit record tools. No model-generated SQL or arbitrary mutations."""
import hashlib
import json
import time
import uuid
from datetime import datetime, timezone

from api import records


class RecordConflict(ValueError):
    pass


def fingerprint(row):
    return hashlib.sha256(json.dumps(row, sort_keys=True, ensure_ascii=False).encode('utf-8')).hexdigest()


def inventory_snapshot(record_id):
    records.ensure_record_storage()
    if records.storage.DATABASE_URL:
        with records.storage.get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute('SELECT data_json, updated_at, deleted FROM app_records WHERE entity=%s AND record_id=%s', ('inventory', record_id))
                row = cur.fetchone()
        value = None if not row else {'data': row['data_json'], 'updatedAt': int(row['updated_at']), 'deleted': row['deleted']}
    else:
        with records.RECORDS_LOCK:
            value = records._load_local().get('inventory', {}).get(record_id)
    if not value or value.get('deleted'):
        raise RecordConflict('找不到這筆庫存，請重新查詢。')
    return value


def update_inventory_note(record_id, expected, note, actor):
    """Compare whole snapshot under lock; save note + audit in one transaction."""
    records.ensure_record_storage()

    def prepare(value):
        if not value or value.get('deleted') or fingerprint(value) != expected:
            raise RecordConflict('資料已被修改或移除；未寫入，請重新取得預覽。')
        tick = max(int(time.time() * 1000), int(value.get('updatedAt') or 0) + 1)
        data = dict(value['data'])
        old_note = str(data.get('note') or '')
        data['note'] = note
        data['updatedAt'] = datetime.now(timezone.utc).isoformat()
        audit_id = 'local-ai-' + uuid.uuid4().hex
        audit = {
            'id': audit_id, 'orderNumber': '庫存/' + record_id,
            'field': '庫存備註', 'before': old_note, 'after': note,
            'user': actor, 'device': '本機 AI：使用者確認',
            'changedAt': datetime.now(timezone.utc).isoformat(),
        }
        return data, tick, audit_id, audit

    if records.storage.DATABASE_URL:
        with records.storage.get_db_connection() as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute('SELECT data_json, updated_at, deleted FROM app_records WHERE entity=%s AND record_id=%s FOR UPDATE', ('inventory', record_id))
                    row = cur.fetchone()
                    value = None if not row else {'data': row['data_json'], 'updatedAt': int(row['updated_at']), 'deleted': row['deleted']}
                    data, tick, audit_id, audit = prepare(value)
                    cur.execute('UPDATE app_records SET data_json=%s, updated_at=%s WHERE entity=%s AND record_id=%s', (records.storage.Jsonb(data), tick, 'inventory', record_id))
                    cur.execute('INSERT INTO app_records(entity, record_id, data_json, updated_at, deleted) VALUES (%s,%s,%s,%s,FALSE)', ('audits', audit_id, records.storage.Jsonb(audit), tick))
            conn.commit()
    else:
        with records.RECORDS_LOCK:
            all_records = records._load_local()
            data, tick, audit_id, audit = prepare(all_records.get('inventory', {}).get(record_id))
            all_records['inventory'][record_id] = {'data': data, 'updatedAt': tick, 'deleted': False}
            all_records.setdefault('audits', {})[audit_id] = {'data': audit, 'updatedAt': tick, 'deleted': False}
            records._write_local(all_records)
    return {'ok': True, 'id': record_id, 'updatedAt': tick, 'auditId': audit_id}
