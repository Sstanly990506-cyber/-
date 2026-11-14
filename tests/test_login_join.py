import copy
import os
import unittest
import uuid
from unittest.mock import MagicMock, patch

from api import service, storage
from api.settings_store import settings_version, update_settings_if_version


class JoinedLoginTests(unittest.TestCase):
    def setUp(self):
        self.row = {
            'id': 'user-1', 'username': 'operator', 'username_key': 'operator',
            'password_hash': storage.hash_password('correct-password'),
            'display_name': 'Operator', 'role': 'ops', 'allowed_views': ['ordersView'],
            'session_version': 'revision-1', 'created_at': '', 'source': 'test',
            'login_state_json': {'settings': {'appTitle': 'Before'}, 'syncTick': 10,
                                 'users': [{'password': 'private'}],
                                 'receivables': [{'id': 'private-finance'}]},
            'login_state_updated_at': 10,
        }

    def run_login(self, row, password='correct-password'):
        connection = MagicMock()
        cursor = connection.__enter__.return_value.cursor.return_value.__enter__.return_value
        cursor.fetchone.return_value = row
        with patch.object(storage, 'DATABASE_URL', 'postgresql://test'), patch.object(storage, 'ensure_storage'), \
                patch.object(storage, 'get_db_connection', return_value=connection) as get_conn, \
                patch.object(service, 'read_state', side_effect=AssertionError('extra state query')):
            result = service.user_action_payload('', {'action': 'login', 'username': 'operator', 'password': password})
        self.assertEqual(get_conn.call_count, 1)
        self.assertEqual(cursor.execute.call_count, 1)
        return result

    def test_login_uses_one_query_and_returns_only_filtered_bootstrap_data(self):
        result = self.run_login(copy.deepcopy(self.row))
        self.assertTrue(result['token'])
        self.assertEqual(result['bootstrap']['settings']['appTitle'], 'Before')
        self.assertEqual(result['bootstrap']['settingsVersion'], settings_version({'appTitle': 'Before'}))
        self.assertEqual(result['bootstrap']['receivables'], [])
        self.assertNotIn('users', result['bootstrap'])
        self.assertNotIn('password', result['account'])

    def test_bad_password_never_returns_the_joined_state(self):
        with self.assertRaises(service.ApiError) as raised:
            self.run_login(copy.deepcopy(self.row), 'incorrect')
        self.assertEqual(raised.exception.status, 401)
        self.assertNotIn('Before', str(raised.exception))

    def test_missing_state_fails_closed_after_password_validation(self):
        row = copy.deepcopy(self.row)
        row['login_state_json'] = None
        with self.assertRaisesRegex(RuntimeError, '設定資料不存在'):
            self.run_login(row)


@unittest.skipUnless(os.environ.get('TEST_JOIN_LOGIN_DATABASE_URL'), 'disposable PostgreSQL not configured')
class JoinedLoginPostgresTests(unittest.TestCase):
    def test_real_login_and_stale_settings_update(self):
        with patch.object(storage, 'DATABASE_URL', os.environ['TEST_JOIN_LOGIN_DATABASE_URL']), \
                patch.object(storage, 'STORAGE_READY', False), patch.object(storage, 'STORAGE_INITIALIZING', False):
            storage.ensure_storage()
            username = 'joined-' + uuid.uuid4().hex
            storage.register_user(username, 'correct-password', 'Join test', role='ops', allowed_views=['ordersView'])
            before = storage.read_state()
            with patch.object(storage, 'get_db_connection', wraps=storage.get_db_connection) as connections:
                result = service.user_action_payload('', {'action': 'login', 'username': username, 'password': 'correct-password'})
            self.assertEqual(connections.call_count, 1)
            self.assertEqual(result['bootstrap']['settingsVersion'], settings_version(before.get('settings')))
            self.assertEqual(result['account']['allowedViews'], ['ordersView'])
            previous = result['bootstrap']['settingsVersion']
            self.assertIsNotNone(update_settings_if_version({'appTitle': 'new'}, previous))
            self.assertIsNone(update_settings_if_version({'appTitle': 'stale'}, previous))
            self.assertEqual(storage.read_state()['settings']['appTitle'], 'new')
            self.assertIsNotNone(storage.verify_session_token(result['token']))
