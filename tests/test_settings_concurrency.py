import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from api import service, storage
from api.settings_store import settings_version, update_settings_if_version


class SettingsConcurrencyTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        for target, value in [('DATABASE_URL', ''), ('DATA_DIR', Path(directory.name)), ('LOCAL_STATE_PATH', Path(directory.name) / 'state.json'), ('ensure_storage', lambda: None)]:
            patcher = patch.object(storage, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        storage.write_local_state_file({'settings': {'title': 'original'}, 'syncTick': 10, 'other': 'preserve'})

    def test_two_administrators_cannot_overwrite_each_other(self):
        baseline = settings_version({'title': 'original'})
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda title: update_settings_if_version({'title': title}, baseline), ['first', 'second']))
        self.assertEqual(sum(result is not None for result in results), 1)
        current = storage.read_state()
        self.assertIn(current['settings']['title'], ['first', 'second'])
        self.assertEqual(current['other'], 'preserve')
        self.assertGreater(current['syncTick'], 10)

    def test_missing_or_stale_version_is_rejected_without_data_change(self):
        for expected in (None, '', 'stale', '測' * 64):
            self.assertIsNone(update_settings_if_version({'title': 'wrong'}, expected))
        self.assertEqual(storage.read_state()['settings']['title'], 'original')

    def test_endpoint_reports_conflict_and_preserves_server_settings(self):
        with patch('api.service.verify_session_token', return_value={'role': 'admin'}):
            first = service.user_action_payload('token', {'action': 'update_settings', 'settings': {'title': 'first'}, 'expectedVersion': settings_version({'title': 'original'})})
            with self.assertRaises(service.ApiError) as error:
                service.user_action_payload('token', {'action': 'update_settings', 'settings': {'title': 'second'}, 'expectedVersion': settings_version({'title': 'original'})})
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(storage.read_state()['settings']['title'], 'first')
        self.assertEqual(first['settingsVersion'], settings_version({'title': 'first'}))
