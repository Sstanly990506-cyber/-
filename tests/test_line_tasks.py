import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
from api import line_tasks, records, service, storage


class LineTaskTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        for obj, name, value in [(storage, 'DATABASE_URL', ''), (storage, 'ensure_storage', lambda: None),
                                 (storage, 'DATA_DIR', root), (records, 'RECORDS_PATH', root / 'records.json'),
                                 (records, 'RECORD_STORAGE_READY', False),
                                 (storage, 'read_state', lambda: {field: [] for field in records.ENTITY_FIELDS.values()})]:
            patcher = patch.object(obj, name, value); patcher.start(); self.addCleanup(patcher.stop)

    def task(self, group='group-123456789', number='WO-1', event_id='event-1'):
        self.assertTrue(line_tasks.record_group_issue(group, 'order_not_found', number, '客戶甲', event_id))
        return records.all_records('events')

    def test_coalesces_only_matching_group_and_number_and_deduplicates_event(self):
        first = self.task()[0]
        self.task(event_id='event-1')
        self.assertEqual(records.get_record('events', first['id'])['count'], 1)
        self.task(number='wo-1', event_id='event-2')
        self.assertEqual(records.get_record('events', first['id'])['count'], 2)
        self.task(group='other-group', event_id='event-3')
        self.task(number='WO-2', event_id='event-4')
        self.assertEqual(len(records.all_records('events')), 3)

    def test_unbound_has_one_task_per_group_and_no_customer_leak(self):
        self.assertTrue(line_tasks.record_group_issue('group-123456789', 'unbound', event_id='one'))
        self.assertTrue(line_tasks.record_group_issue('group-123456789', 'unbound', event_id='two'))
        task = records.all_records('events')[0]
        self.assertEqual(task['count'], 2)
        self.assertEqual(task['groupLabel'], '群組 group-...6789')
        self.assertEqual(task['customerName'], '')
        self.assertNotIn('group-123456789', str(task))

    def test_handled_reopens_on_new_question_and_preserves_history(self):
        task = self.task()[0]
        update = {**task, 'taskStatus': 'done', 'resolvedAt': '2026-01-01T00:00:00Z', 'resolvedBy': '員工甲'}
        update.pop('_updatedAt')
        records.write_record_batch([('events', task['id'], update)], expected_versions={('events',task['id']):task['_updatedAt']})
        self.task(event_id='event-1') # A LINE webhook retry must not reopen.
        self.assertEqual(records.get_record('events', task['id'])['taskStatus'], 'done')
        self.task(event_id='event-2')
        reopened = records.get_record('events', task['id'])
        self.assertEqual(reopened['taskStatus'], 'pending')
        self.assertEqual(reopened['count'], 1)
        self.assertEqual(reopened['history'][0]['resolvedBy'], '員工甲')
        self.assertEqual(reopened['history'][0]['count'], 1)

    def test_simultaneous_messages_are_not_lost(self):
        records.ensure_record_storage()
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda i: line_tasks.record_group_issue('group','order_not_found','WO-1','甲',f'e{i}'), range(30)))
        self.assertTrue(all(results))
        self.assertEqual(records.all_records('events')[0]['count'], 30)

    def test_permission_and_stale_version_protect_the_task(self):
        task = self.task()[0]
        payload = {**task, 'taskStatus':'done', '_expectedVersion':task['_updatedAt']}
        with patch.object(service, 'verify_session_token', return_value={'role':'viewer','allowedViews':[]}):
            with self.assertRaises(service.ApiError) as raised:service.upsert_entity_payload('token', 'events', task['id'], payload)
            self.assertEqual(raised.exception.status, 403)
        self.task(event_id='newer')
        with patch.object(service, 'verify_session_token', return_value={'role':'ops','allowedViews':['notificationsView']}):
            with self.assertRaises(service.ApiError) as raised:service.upsert_entity_payload('token', 'events', task['id'], payload)
            self.assertEqual(raised.exception.status, 409)
        self.assertEqual(records.get_record('events',task['id'])['count'], 2)
        self.assertEqual(records.get_record('events',task['id'])['taskStatus'], 'pending')

    def test_failures_do_not_raise_into_line_reply(self):
        with patch.object(records, 'ensure_record_storage', side_effect=OSError('offline')):
            with self.assertLogs('api.line_tasks', level='ERROR'):
                self.assertFalse(line_tasks.record_group_issue('group','unbound',event_id='test'))

# These tests require a disposable PostgreSQL instance. Each run uses a unique schema.
import os
import uuid
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

@unittest.skipUnless(os.environ.get('LINE_TASK_TEST_DATABASE_URL'), 'disposable PostgreSQL not configured')
class PostgresLineTaskTests(unittest.TestCase):
    def setUp(self):
        self.source = os.environ['LINE_TASK_TEST_DATABASE_URL']
        self.schema = 'line_task_' + uuid.uuid4().hex
        with storage.connect(self.source) as conn:
            conn.execute(f'CREATE SCHEMA {self.schema}')
        parsed = urlparse(self.source)
        query = dict(parse_qsl(parsed.query, keep_blank_values=True))
        query['options'] = f'-csearch_path={self.schema}'
        self.url = urlunparse(parsed._replace(query=urlencode(query)))
        for obj, name, value in [(storage,'DATABASE_URL',self.url), (storage,'ensure_storage',lambda:None),
                                 (storage,'_db_pool',None), (storage,'_db_pool_url',None), (storage,'_db_pool_pid',None),
                                 (records,'RECORD_STORAGE_READY',True)]:
            patcher = patch.object(obj,name,value); patcher.start(); self.addCleanup(patcher.stop)
        self.addCleanup(self.cleanup_schema)
        with storage.get_db_connection() as conn:
            conn.execute('CREATE TABLE app_records (entity TEXT NOT NULL, record_id TEXT NOT NULL, data_json JSONB NOT NULL, updated_at BIGINT NOT NULL, deleted BOOLEAN NOT NULL DEFAULT FALSE, PRIMARY KEY(entity,record_id))')

    def cleanup_schema(self):
        if storage._db_pool: storage._db_pool.close()
        with storage.connect(self.source) as conn: conn.execute(f'DROP SCHEMA {self.schema} CASCADE')

    def test_concurrent_creation_and_messages_are_not_lost(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda i: line_tasks.record_group_issue('group-123','order_not_found','WO-1','甲',f'ev-{i}'), range(25)))
        self.assertTrue(all(results))
        items = records.all_records('events')
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['count'], 25)
        with storage.get_db_connection() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) AS n FROM app_records WHERE entity='events'").fetchone()['n'], 1)

    def test_postgres_handle_reopen_preserves_history_and_rejects_stale_write(self):
        self.assertTrue(line_tasks.record_group_issue('group','order_not_found','WO-1','甲','one'))
        first=records.all_records('events')[0]
        update={**first,'taskStatus':'done','resolvedAt':'2026-01-01T00:00:00Z','resolvedBy':'員工甲'};update.pop('_updatedAt')
        records.write_record_batch([('events',first['id'],update)],expected_versions={('events',first['id']):first['_updatedAt']})
        self.assertTrue(line_tasks.record_group_issue('group','order_not_found','WO-1','甲','two'))
        reopened=records.get_record('events',first['id'])
        self.assertEqual(reopened['taskStatus'],'pending')
        self.assertEqual(reopened['history'][0]['resolvedBy'],'員工甲')
        with self.assertRaises(records.RecordConflict):
            records.write_record_batch([('events',first['id'],update)],expected_versions={('events',first['id']):first['_updatedAt']})

if __name__ == '__main__':
    unittest.main()
