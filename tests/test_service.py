import unittest
from unittest.mock import patch

from api.service import ApiError, get_state_payload, health_payload, update_state_payload, user_action_payload


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


if __name__ == '__main__':
    unittest.main()
