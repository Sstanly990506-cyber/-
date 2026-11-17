import unittest
from unittest.mock import patch

from api.order_draft_key import order_draft_key_payload
from api.service import ApiError
from api_server import app


class OrderDraftKeyTests(unittest.TestCase):
    def test_key_stable_per_account_and_distinct_across_accounts(self):
        with patch('api.order_draft_key.storage.SESSION_SECRET', 'stable-test-key'), \
             patch('api.order_draft_key.storage.SESSION_SECRET_SOURCE', 'environment'), \
             patch('api.order_draft_key.require_entity_access', side_effect=[{'id': 'one'}, {'id': 'one'}, {'id': 'two'}]) as access:
            first = order_draft_key_payload('one-token')
            self.assertEqual(first['key'], order_draft_key_payload('new-token')['key'])
            self.assertNotEqual(first['key'], order_draft_key_payload('other-token')['key'])
            self.assertEqual(first['ownerId'], 'one')
            self.assertEqual(access.call_args_list[0].args, ('one-token', 'orders'))

    def test_requires_authenticated_order_access(self):
        with patch('api.order_draft_key.require_entity_access', side_effect=ApiError('denied', 403)):
            with self.assertRaises(ApiError) as error:
                order_draft_key_payload('denied-token')
            self.assertEqual(error.exception.status, 403)

    def test_refuses_unstable_key_or_missing_account_id(self):
        with patch('api.order_draft_key.require_entity_access', return_value={'id': 'one'}), \
             patch('api.order_draft_key.storage.SESSION_SECRET_SOURCE', 'runtime-random'):
            with self.assertRaises(ApiError) as error:
                order_draft_key_payload('token')
            self.assertEqual(error.exception.status, 503)
        with patch('api.order_draft_key.require_entity_access', return_value={}):
            with self.assertRaises(ApiError) as error:
                order_draft_key_payload('token')
            self.assertEqual(error.exception.status, 403)

    @unittest.skipIf(app is None, 'Flask unavailable')
    def test_endpoint_checks_permissions_and_disables_caching(self):
        client = app.test_client()
        account = {'id': 'one', 'role': 'ops', 'allowedViews': ['ordersView']}
        with patch('api.service.verify_session_token', side_effect=lambda token: account if token == 'allowed' else None), \
             patch('api.order_draft_key.storage.SESSION_SECRET_SOURCE', 'environment'), \
             patch('api.order_draft_key.storage.SESSION_SECRET', 'stable-test-key'):
            response = client.get('/api/orders/draft-key', headers={'Authorization': 'Bearer allowed'})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json['ownerId'], 'one')
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            denied = client.get('/api/orders/draft-key')
            self.assertEqual(denied.status_code, 401)
            self.assertEqual(denied.headers['Cache-Control'], 'no-store')


if __name__ == '__main__':
    unittest.main()
