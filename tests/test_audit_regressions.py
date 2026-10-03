import unittest
from unittest.mock import patch

from api.http_server import is_blocked_static_path
from api.service import ApiError, changes_payload, list_entity_payload, merge_state_for_account, send_line_payload, upsert_entity_payload


class AuditRegressionTests(unittest.TestCase):
    def test_trip_only_account_does_not_receive_prices_or_customer_notes(self):
        account = {'role': 'driver', 'allowedViews': ['tripsView']}
        order = {'id': 'o1', 'orderNumber': 'WO1', 'address': 'delivery', 'totalPrice': 999}
        customer = {'id': 'c1', 'name': 'customer', 'phone': '1234', 'note': 'private'}
        with patch('api.service.verify_session_token', return_value=account):
            with patch('api.service.list_records', return_value={'items': [order]}):
                result = list_entity_payload('token', 'orders')
                self.assertNotIn('totalPrice', result['items'][0])
                self.assertEqual(result['items'][0]['address'], 'delivery')
            with patch('api.service.list_records', return_value={'items': [customer]}):
                result = list_entity_payload('token', 'customers')
                self.assertNotIn('note', result['items'][0])
            with patch('api.service.changes_since', return_value={'changes': [{'entity': 'orders', 'data': order}], 'cursor': 1}):
                self.assertNotIn('totalPrice', changes_payload('token')['changes'][0]['data'])

    def test_hidden_files_are_not_public_assets(self):
        for path in ('.env', '.git/config', 'js/.env', 'data/state.json', 'api/storage.py'):
            self.assertTrue(is_blocked_static_path(path), path)
        self.assertFalse(is_blocked_static_path('js/main.js'))

    def test_flask_does_not_bypass_static_guard(self):
        from api_server import app
        if app is None:
            self.skipTest('Flask is not installed')
        client = app.test_client()
        for path in ('/api_server.py', '/.git/config', '/api/storage.py'):
            self.assertIn(client.get(path).status_code, (403, 404), path)
        self.assertEqual(client.get('/').status_code, 200)

    def test_notifications_permission_cannot_change_chat_scope(self):
        account = {'role': 'viewer', 'allowedViews': ['notificationsView']}
        with patch('api.service.verify_session_token', return_value=account), patch('api.service.upsert_record') as write:
            with self.assertRaises(ApiError) as error:
                upsert_entity_payload('token', 'lineDestinations', 'group', {'accessMode': 'internal'})
            self.assertEqual(error.exception.status, 403)
            write.assert_not_called()
        current = {'lineDestinations': [{'id': 'group', 'accessMode': 'customer'}]}
        merged = merge_state_for_account(current, {'lineDestinations': []}, account)
        self.assertEqual(merged['lineDestinations'], current['lineDestinations'])

    def test_old_automatic_push_is_rejected_without_sending(self):
        with patch('api.service.verify_session_token', return_value={'role': 'admin'}), patch('api.line_bot.send_line_message') as send:
            with self.assertRaises(ApiError) as error:
                send_line_payload('token', {'message': 'automatic reminder'})
            self.assertEqual(error.exception.status, 403)
            send.assert_not_called()

    def test_explicit_manual_push_is_preserved(self):
        with patch('api.service.verify_session_token', return_value={'role': 'admin'}), patch('api.line_bot.send_line_message', return_value={'ok': True}) as send:
            self.assertEqual(send_line_payload('token', {'message': 'manual reminder', 'manual': True}), {'ok': True})
            send.assert_called_once_with('manual reminder')
