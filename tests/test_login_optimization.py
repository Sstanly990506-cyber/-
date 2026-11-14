import copy
import os
import unittest
from unittest.mock import MagicMock, patch

from api import storage


class LoginOptimizationTests(unittest.TestCase):
    def setUp(self):
        self.user = {
            'id': 'user-1', 'username': 'operator', 'usernameKey': 'operator',
            'password': storage.hash_password('correct-password'),
            'display': 'Operator', 'role': 'ops', 'allowedViews': ['ordersView'],
            'sessionVersion': 'initial', 'createdAt': '', 'source': 'test',
        }

    def test_login_reads_the_user_once_and_returns_no_password_or_revision(self):
        with patch.object(storage, 'DATABASE_URL', ''), patch.object(storage, 'read_users', return_value=[self.user]) as read:
            account, token = storage.authenticate_user_with_session('operator', 'correct-password')
            self.assertEqual(read.call_count, 1)
            self.assertNotIn('password', account)
            self.assertNotIn('sessionVersion', account)
            self.assertEqual(storage.verify_session_token(token)['username'], 'operator')

    def test_invalid_password_never_produces_a_session(self):
        with patch.object(storage, 'DATABASE_URL', ''), patch.object(storage, 'read_users', return_value=[self.user]) as read:
            self.assertIsNone(storage.authenticate_user_with_session('operator', 'incorrect-password'))
            self.assertEqual(read.call_count, 1)

    def test_postgres_login_uses_one_connection_and_one_query_for_account(self):
        row = {'id': self.user['id'], 'username': self.user['username'], 'username_key': self.user['usernameKey'],
               'password_hash': self.user['password'], 'display_name': self.user['display'], 'role': self.user['role'],
               'allowed_views': self.user['allowedViews'], 'session_version': self.user['sessionVersion'],
               'created_at': '', 'source': 'test'}
        connection = MagicMock()
        cursor = connection.__enter__.return_value.cursor.return_value.__enter__.return_value
        cursor.fetchone.return_value = row
        with patch.object(storage, 'DATABASE_URL', 'postgresql://test'), patch.object(storage, 'ensure_storage'), \
                patch.object(storage, 'get_db_connection', return_value=connection) as get_conn:
            account, token = storage.authenticate_user_with_session('operator', 'correct-password')
        self.assertEqual(account['username'], 'operator')
        self.assertTrue(token)
        self.assertEqual(get_conn.call_count, 1)
        self.assertEqual(cursor.execute.call_count, 1)

    def test_password_or_permission_change_revokes_token_from_older_snapshot(self):
        with patch.object(storage, 'DATABASE_URL', ''), patch.object(storage, 'read_users', return_value=[self.user]):
            _, token = storage.authenticate_user_with_session('operator', 'correct-password')
        for field, value in [('password', storage.hash_password('new-password')), ('allowedViews', []), ('sessionVersion', 'new')]:
            changed = copy.deepcopy(self.user)
            changed[field] = value
            with self.subTest(field=field), patch.object(storage, 'read_users', return_value=[changed]):
                self.assertIsNone(storage.verify_session_token(token))


@unittest.skipUnless(os.environ.get('TEST_LOGIN_DATABASE_URL'), 'disposable PostgreSQL not configured')
class LoginPostgresTests(unittest.TestCase):
    def test_real_postgres_one_query_login_and_permission_revocation(self):
        url = os.environ['TEST_LOGIN_DATABASE_URL']
        with patch.object(storage, 'DATABASE_URL', url), patch.object(storage, 'STORAGE_READY', False), \
                patch.object(storage, 'STORAGE_INITIALIZING', False):
            storage.ensure_storage()
            storage.register_user('query-test', 'correct-password', '測試', role='ops', allowed_views=['ordersView'])
            with patch.object(storage, 'get_db_connection', wraps=storage.get_db_connection) as get_conn:
                account, token = storage.authenticate_user_with_session('query-test', 'correct-password')
            self.assertEqual(get_conn.call_count, 1)
            self.assertEqual(account['display'], '測試')
            self.assertEqual(account['allowedViews'], ['ordersView'])
            self.assertIsNotNone(storage.verify_session_token(token))
            with storage.get_db_connection() as conn:
                conn.execute("UPDATE app_users SET session_version = 'changed' WHERE username_key = 'query-test'")
            self.assertIsNone(storage.verify_session_token(token))
