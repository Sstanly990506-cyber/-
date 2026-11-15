"""Creation time is authoritative and does not rewrite historical records."""
import copy
import os
import tempfile
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from unittest.mock import patch

from api import records, service, storage


class OrderCreatedAtTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='order-created-')
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        for obj, name, value in [
            (storage, 'DATABASE_URL', ''), (storage, 'DATA_DIR', root),
            (storage, 'LOCAL_STATE_PATH', root / 'state.json'),
            (storage, 'ensure_storage', lambda: None),
            (records, 'RECORDS_PATH', root / 'records.json'),
            (records, 'RECORD_STORAGE_READY', True),
            (service, 'verify_session_token', lambda token: {'username': 'fixture', 'role': 'admin'}),
        ]:
            p = patch.object(obj, name, value); p.start(); self.addCleanup(p.stop)

    def save(self, record_id, number, **values):
        return service.upsert_entity_payload('fixture', 'orders', record_id,
            {'id': record_id, 'orderNumber': number, 'status': '未完成', **values})

    def test_creation_ignores_client_time_and_edits_keep_server_time(self):
        before = datetime.now(timezone.utc)
        result = self.save('a', 'A', createdAt='1999-01-01T00:00:00Z')
        after = datetime.now(timezone.utc)
        created = result['createdAt']
        parsed = datetime.fromisoformat(created.replace('Z', '+00:00'))
        self.assertLessEqual(before.timestamp() - .001, parsed.timestamp())
        self.assertLessEqual(parsed, after)
        self.assertEqual(records.get_record('orders', 'a')['createdAt'], created)
        updated = self.save('a', 'A', _expectedVersion=result['updatedAt'],
                            createdAt='2099-01-01T00:00:00Z', note='changed')
        self.assertEqual(updated['createdAt'], created)
        self.assertEqual(records.get_record('orders', 'a')['createdAt'], created)
        updated_again = self.save('a', 'A', _expectedVersion=updated['updatedAt'], note='again')
        self.assertEqual(updated_again['createdAt'], created)

    def test_legacy_order_stays_unknown_even_if_client_supplies_a_time(self):
        records.upsert_record('orders', 'old', {'id': 'old', 'orderNumber': 'OLD', 'status': '未完成'})
        legacy = records.get_record('orders', 'old')
        result = self.save('old', 'OLD', _expectedVersion=legacy['_updatedAt'], createdAt='2020-01-01T00:00:00Z')
        self.assertNotIn('createdAt', result)
        self.assertNotIn('createdAt', records.get_record('orders', 'old'))

    def test_copy_or_import_as_new_gets_a_new_server_time(self):
        first = self.save('a', 'A')
        # An import/copy can contain the old row verbatim; a new ID must not
        # inherit that row's historical creation time.
        row = records.get_record('orders', 'a')
        copied = {**row, 'id': 'b', 'orderNumber': 'B', '_expectedVersion': 0}
        with patch.object(service, 'datetime') as clock:
            clock.now.return_value = datetime(2030, 1, 1, tzinfo=timezone.utc)
            result = service.upsert_entity_payload('fixture', 'orders', 'b', copied)
        self.assertEqual(result['createdAt'], '2030-01-01T00:00:00.000Z')
        self.assertNotEqual(result['createdAt'], first['createdAt'])
        self.assertEqual(records.get_record('orders', 'a')['createdAt'], first['createdAt'])
        self.assertEqual(records.get_record('orders', 'b')['createdAt'], result['createdAt'])

    def test_backup_round_trip_preserves_known_and_unknown_times(self):
        created = self.save('a', 'A')['createdAt']
        records.upsert_record('orders', 'old', {'id': 'old', 'orderNumber': 'OLD'})
        backup = records.export_records()
        records.restore_records(copy.deepcopy(backup))
        self.assertEqual(records.get_record('orders', 'a')['createdAt'], created)
        self.assertNotIn('createdAt', records.get_record('orders', 'old'))

    def test_moving_orders_does_not_change_creation_time(self):
        created_a = self.save('a', 'A', sortOrder=0)['createdAt']
        created_b = self.save('b', 'B', sortOrder=1)['createdAt']
        records.move_order_record('a', 'b', True)
        self.assertEqual(records.get_record('orders', 'a')['createdAt'], created_a)
        self.assertEqual(records.get_record('orders', 'b')['createdAt'], created_b)

    def test_concurrent_edits_cannot_rewrite_or_remove_creation_time(self):
        result = self.save('a', 'A')
        barrier = threading.Barrier(2)
        original_get = service.get_record
        def synced_get(entity, rid):
            value = original_get(entity, rid)
            if entity == 'orders' and rid == 'a': barrier.wait(timeout=5)
            return value
        def edit(note):
            try:
                self.save('a', 'A', _expectedVersion=result['updatedAt'], note=note,
                          createdAt='2099-01-01T00:00:00Z')
                return 200
            except service.ApiError as error:
                return error.status
        with patch.object(service, 'get_record', side_effect=synced_get):
            with ThreadPoolExecutor(max_workers=2) as executor:
                statuses = list(executor.map(edit, ['first', 'second']))
        self.assertEqual(sorted(statuses), [200, 409])
        self.assertEqual(records.get_record('orders', 'a')['createdAt'], result['createdAt'])


@unittest.skipUnless(os.environ.get('AUDIT_TEST_DATABASE_URL'), 'disposable PostgreSQL not configured')
class PostgresCreatedAtTests(unittest.TestCase):
    def setUp(self):
        source = os.environ['AUDIT_TEST_DATABASE_URL']
        self.schema = 'created_' + uuid.uuid4().hex
        with storage.connect(source) as conn: conn.execute(f'CREATE SCHEMA {self.schema}')
        parsed = urlparse(source)
        params = dict(parse_qsl(parsed.query)); params['options'] = f'-csearch_path={self.schema}'
        url = urlunparse(parsed._replace(query=urlencode(params)))
        def cleanup():
            with storage.connect(source) as conn: conn.execute(f'DROP SCHEMA {self.schema} CASCADE')
        self.addCleanup(cleanup)
        for obj, name, value in [
            (storage, 'DATABASE_URL', url), (storage, 'STORAGE_READY', True),
            (records, 'RECORD_STORAGE_READY', True),
            (service, 'verify_session_token', lambda token: {'username': 'fixture', 'role': 'admin'}),
        ]:
            p = patch.object(obj, name, value); p.start(); self.addCleanup(p.stop)
        with storage.get_db_connection() as conn:
            conn.execute('''CREATE TABLE app_records(entity TEXT NOT NULL, record_id TEXT NOT NULL,
                data_json JSONB NOT NULL, updated_at BIGINT NOT NULL, deleted BOOLEAN NOT NULL DEFAULT FALSE,
                PRIMARY KEY(entity, record_id))''')

    def test_postgres_create_update_copy_move_and_restore(self):
        def save(rid, number, **changes):
            return service.upsert_entity_payload('fixture', 'orders', rid,
                {'id': rid, 'orderNumber': number, 'status': '未完成', **changes})
        first = save('a', 'A', sortOrder=0, createdAt='1999')
        second = save('b', 'B', sortOrder=1, createdAt='1999')
        self.assertNotEqual(first['createdAt'], '1999')
        changed = save('a', 'A', _expectedVersion=first['updatedAt'], createdAt='forged')
        self.assertEqual(changed['createdAt'], first['createdAt'])
        records.upsert_record('orders', 'old', {'id': 'old', 'orderNumber': 'OLD', 'sortOrder': 2})
        legacy = records.get_record('orders', 'old')
        save('old', 'OLD', _expectedVersion=legacy['_updatedAt'], createdAt='forged')
        records.move_order_record('a', 'b', True)
        backup = records.export_records()
        records.restore_records(copy.deepcopy(backup))
        self.assertEqual(records.get_record('orders', 'a')['createdAt'], first['createdAt'])
        self.assertEqual(records.get_record('orders', 'b')['createdAt'], second['createdAt'])
        self.assertNotIn('createdAt', records.get_record('orders', 'old'))
