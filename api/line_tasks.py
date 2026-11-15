"""Durable, deduplicated notification tasks for unanswered LINE enquiries."""
import hashlib
import logging
from datetime import datetime, timezone
from api import records, storage

logger = logging.getLogger(__name__)


def _task_id(destination_id, issue_type, order_number):
    key = '\0'.join((destination_id, issue_type, order_number.casefold()))
    return 'line-task-' + hashlib.sha256(key.encode('utf-8')).hexdigest()


def _updated_task(previous, task_id, destination_id, issue_type, order_number, customer_name, event_id, now):
    task = dict(previous or {})
    seen = list(task.get('lineEventIds') or [])
    if event_id and event_id in seen:
        return None
    if event_id:
        seen.append(event_id)
        seen = seen[-200:]
    history = list(task.get('history') or [])
    if task.get('taskStatus') == 'done':
        history.append({'resolvedAt': task.get('resolvedAt', ''), 'resolvedBy': task.get('resolvedBy', ''),
                        'count': task.get('count', 1), 'firstAt': task.get('firstAt', '')})
        task['count'] = 0
        task['firstAt'] = now
        task.pop('resolvedAt', None)
        task.pop('resolvedBy', None)
    if not task:
        task['firstAt'] = now
        task['count'] = 0
    masked = f'{destination_id[:6]}...{destination_id[-4:]}' if len(destination_id) > 12 else destination_id
    label = customer_name or ('群組 ' + masked)
    message = (f'LINE 群組尚未綁定客戶：{label}' if issue_type == 'unbound'
               else f'LINE 查不到工單：{label}／{order_number}')
    task.update({'id': task_id, 'kind': 'line_task', 'taskStatus': 'pending',
                 'issueType': issue_type, 'customerName': customer_name,
                 'groupLabel': '群組 ' + masked, 'orderNumber': order_number,
                 'count': int(task.get('count') or 0) + 1, 'lastAt': now,
                 'at': now, 'user': 'LINE', 'level': 'warning', 'message': message,
                 'history': history, 'lineEventIds': seen})
    return task


def record_group_issue(destination_id, issue_type, order_number='', customer_name='', event_id=''):
    """Create or reopen a task; failures must not stop the LINE reply."""
    try:
        destination_id = str(destination_id or '').strip()
        issue_type = str(issue_type or '')
        order_number = str(order_number or '').strip()[:128]
        customer_name = str(customer_name or '').strip()[:200]
        event_id = str(event_id or '').strip()[:128]
        if not destination_id or issue_type not in {'unbound', 'order_not_found'} or (issue_type == 'order_not_found' and not order_number):
            return
        if issue_type == 'unbound':
            order_number = ''
        task_id = _task_id(destination_id, issue_type, order_number)
        now = datetime.now(timezone.utc).isoformat()
        records.ensure_record_storage()
        if storage.DATABASE_URL:
            with storage.get_db_connection() as conn:
                with conn.transaction():
                    with conn.cursor() as cur:
                        # Match ordinary record writes: serialize creation and
                        # updates, and advance the global incremental cursor.
                        cur.execute('LOCK TABLE app_records IN SHARE ROW EXCLUSIVE MODE')
                        cur.execute('SELECT MAX(updated_at) AS latest FROM app_records')
                        latest = int((cur.fetchone() or {}).get('latest') or 0)
                        cur.execute("SELECT data_json,deleted FROM app_records WHERE entity='events' AND record_id=%s", (task_id,))
                        row = cur.fetchone()
                        previous = row['data_json'] if row and not row['deleted'] else None
                        task = _updated_task(previous, task_id, destination_id, issue_type, order_number, customer_name, event_id, now)
                        if task is None: return True
                        tick = max(records._now(), latest + 1)
                        cur.execute("""INSERT INTO app_records(entity,record_id,data_json,updated_at,deleted)
                            VALUES ('events',%s,%s,%s,FALSE) ON CONFLICT(entity,record_id) DO UPDATE
                            SET data_json=EXCLUDED.data_json,updated_at=EXCLUDED.updated_at,deleted=FALSE""",
                            (task_id, storage.Jsonb(task), tick))
        else:
            with records.RECORDS_LOCK:
                all_data = records._load_local()
                rows = all_data.setdefault('events', {})
                row = rows.get(task_id)
                previous = row.get('data') if row and not row.get('deleted') else None
                task = _updated_task(previous, task_id, destination_id, issue_type, order_number, customer_name, event_id, now)
                if task is None: return True
                tick = max([records._now(), *(int(item.get('updatedAt') or 0) + 1 for items in all_data.values() for item in items.values())])
                rows[task_id] = {'data': task, 'updatedAt': tick, 'deleted': False}
                records._write_local(all_data)
        return True
    except Exception:
        logger.exception('Could not record LINE enquiry task')
        return False
