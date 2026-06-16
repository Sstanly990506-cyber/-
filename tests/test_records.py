import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from api import records


class RecordStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.patches = [
            patch.object(records.storage, 'DATABASE_URL', ''),
            patch.object(records.storage, 'DATA_DIR', self.root),
            patch.object(records, 'RECORDS_PATH', self.root / 'records.json'),
            patch.object(records.storage, 'ensure_storage'),
            patch.object(records.storage, 'read_state', return_value={field: [] for field in records.ENTITY_FIELDS.values()}),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def test_pagination_caps_page_size(self):
        for index in range(520):
            records.upsert_record('orders', str(index), {'id': str(index), 'orderNumber': f'WO-{index:04d}'})
        first = records.list_records('orders', page=1, page_size=999)
        second = records.list_records('orders', page=2, page_size=500)
        self.assertEqual(len(first['items']), 500)
        self.assertEqual(len(second['items']), 20)
        self.assertEqual(first['total'], 520)
        self.assertEqual(first['pages'], 2)

    def test_upsert_delete_and_incremental_changes(self):
        created = records.upsert_record('customers', 'c-1', {'id': 'c-1', 'name': 'A'})
        page = records.list_records('customers')
        self.assertEqual(page['items'][0]['name'], 'A')
        records.delete_record('customers', 'c-1')
        self.assertEqual(records.list_records('customers')['total'], 0)
        changes = records.changes_since(created['updatedAt'] - 1)
        self.assertTrue(any(change['id'] == 'c-1' and change['deleted'] for change in changes['changes']))

    def test_clear_records_marks_all_selected_data_deleted(self):
        records.upsert_record('orders', 'o-1', {'id': 'o-1', 'orderNumber': 'WO-1'})
        records.upsert_record('customers', 'c-1', {'id': 'c-1', 'name': 'A'})
        records.upsert_record('payables', 'p-1', {'id': 'p-1', 'vendor': 'B'})
        result = records.clear_records()
        self.assertEqual(result['cleared']['orders'], 1)
        self.assertEqual(result['cleared']['customers'], 1)
        self.assertEqual(result['cleared']['payables'], 1)
        self.assertEqual(records.list_records('orders')['total'], 0)
        changes = records.changes_since(0)
        deleted_ids = {change['id'] for change in changes['changes'] if change['deleted']}
        self.assertEqual({'o-1', 'c-1', 'p-1'} & deleted_ids, {'o-1', 'c-1', 'p-1'})

    def test_search_filters_on_server(self):
        records.upsert_record('inventory', 'a', {'id': 'a', 'name': 'Blue film'})
        records.upsert_record('inventory', 'b', {'id': 'b', 'name': 'Red film'})
        result = records.list_records('inventory', query='blue')
        self.assertEqual([row['id'] for row in result['items']], ['a'])


if __name__ == '__main__':
    unittest.main()
