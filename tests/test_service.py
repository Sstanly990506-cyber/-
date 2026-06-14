import unittest
from unittest.mock import patch

from api.service import ApiError, changes_payload, get_state_payload, health_payload, update_state_payload, user_action_payload
from api.storage import create_session_token, verify_session_token


class ServiceTests(unittest.TestCase):
    def test_health_hides_environment_by_default(self):
        with patch('api.service.ensure_storage'), patch('api.service.get_storage_mode', return_value='local-json'):
            self.assertEqual(health_payload(), {'ok': True, 'database': 'local-json'})

    def test_state_requires_login(self):
        with patch('api.service.verify_session_token', return_value=None):
            with self.assertRaises(ApiError) as caught:
                get_state_payload('bad-token')
        self.assertEqual(caught.exception.status, 401)

    def test_public_registration_is_disabled(self):
        with self.assertRaises(ApiError) as caught:
            user_action_payload('', {'action': 'register'})
        self.assertEqual(caught.exception.status, 403)

    def test_login_returns_session(self):
        account = {'username': 'ops', 'display': 'Ops', 'role': 'ops'}
        with patch('api.service.authenticate_user', return_value=account), patch('api.service.create_session_token', return_value='token'):
            result = user_action_payload('', {'action': 'login', 'username': 'ops', 'password': 'secret'})
        self.assertEqual(result['token'], 'token')
        self.assertEqual(result['account'], account)

    def test_session_verification_does_not_query_users(self):
        account = {'username': 'ops', 'display': 'Ops', 'role': 'ops'}
        token = create_session_token(account)
        with patch('api.storage.read_users', side_effect=AssertionError('token verification queried users')):
            verified = verify_session_token(token)
        self.assertEqual(verified['username'], 'ops')
        self.assertEqual(verified['role'], 'ops')

    def test_update_rejects_incomplete_payload(self):
        with patch('api.service.verify_session_token', return_value={'role': 'ops'}):
            with self.assertRaises(ApiError) as caught:
                update_state_payload('token', {'orders': []})
        self.assertEqual(caught.exception.status, 400)
        self.assertIn('missing key', str(caught.exception))

    def test_stale_update_returns_server_tick(self):
        payload = {key: [] for key in ('glossOptions', 'customers', 'orders', 'audits', 'receivables', 'payables')}
        with patch('api.service.verify_session_token', return_value={'role': 'ops'}), patch('api.service.read_state', return_value={}), patch('api.service.merge_state_for_role', return_value=payload), patch('api.service.write_state', return_value=(False, 42)):
            with self.assertRaises(ApiError) as caught:
                update_state_payload('token', payload)
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(caught.exception.payload['serverSyncTick'], 42)

    def test_incremental_changes_are_filtered_by_role(self):
        source = {'ok': True, 'cursor': 10, 'hasMore': False, 'changes': [
            {'entity': 'orders', 'id': 'o1'}, {'entity': 'receivables', 'id': 'r1'}]}
        with patch('api.service.verify_session_token', return_value={'role': 'ops'}), patch('api.service.changes_since', return_value=source):
            result = changes_payload('token')
        self.assertEqual([row['entity'] for row in result['changes']], ['orders'])

    def test_admin_can_create_account(self):
        created = {'username': 'new-user', 'role': 'ops'}
        with patch('api.service.verify_session_token', return_value={'role': 'admin'}), patch('api.service.register_user', return_value=created):
            result = user_action_payload('token', {'action': 'create_account', 'username': 'new-user', 'password': 'password123', 'role': 'ops'})
        self.assertEqual(result['account'], created)

    def test_non_admin_cannot_change_finance_password(self):
        with patch('api.service.verify_session_token', return_value={'role': 'finance'}):
            with self.assertRaises(ApiError) as caught:
                user_action_payload('token', {'action': 'change_finance_password', 'password': 'password123'})
        self.assertEqual(caught.exception.status, 403)


if __name__ == '__main__':
    unittest.main()
