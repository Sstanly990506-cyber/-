import unittest
from unittest.mock import patch

from api.service import ApiError, _fill_recognized_customer_address, backup_payload, capacity_payload, changes_payload, clear_test_data_payload, get_state_payload, health_payload, list_entity_payload, optimize_trip_payload, recognize_order_payload, recognize_order_status_payload, report_order_correction_payload, restore_backup_payload, update_state_payload, user_action_payload
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
        with patch('api.service.verify_session_token', return_value={'role': 'ops'}), patch('api.service.read_state', return_value={}), patch('api.service.merge_state_for_account', return_value=payload), patch('api.service.write_state', return_value=(False, 42)):
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
        with patch('api.service.verify_session_token', return_value={'role': 'admin'}), patch('api.service.register_user', return_value=created) as register:
            result = user_action_payload('token', {'action': 'create_account', 'username': 'new-user', 'password': 'password123', 'role': 'driver', 'allowedViews': ['tripsView']})
        self.assertEqual(result['account'], created)
        self.assertEqual(register.call_args.kwargs['allowed_views'], ['tripsView'])

    def test_admin_can_list_and_update_account_permissions(self):
        users = [{'id': 'u1', 'username': 'driver1', 'usernameKey': 'driver1', 'display': 'Driver', 'role': 'viewer', 'allowedViews': []}]
        with patch('api.service.verify_session_token', return_value={'role': 'admin'}), patch('api.service.read_users', return_value=users), patch('api.service.write_users') as write:
            listed = user_action_payload('token', {'action': 'list_accounts'})
            updated = user_action_payload('token', {'action': 'update_account_permissions', 'id': 'u1', 'role': 'driver', 'allowedViews': ['tripsView']})
        self.assertEqual(listed['accounts'][0]['username'], 'driver1')
        self.assertEqual(updated['account']['role'], 'driver')
        self.assertEqual(updated['account']['allowedViews'], ['tripsView'])
        write.assert_called_once()

    def test_driver_cannot_list_orders_but_can_optimize_trip(self):
        driver = {'role': 'driver', 'allowedViews': ['tripsView']}
        with patch('api.service.verify_session_token', return_value=driver):
            with self.assertRaises(ApiError) as caught:
                list_entity_payload('token', 'orders')
        self.assertEqual(caught.exception.status, 403)
        with patch('api.service.verify_session_token', return_value=driver), patch('api.service.optimize_trip', return_value={'ok': True}) as optimize:
            result = optimize_trip_payload('token', {'stops': []})
        self.assertEqual(result, {'ok': True})
        optimize.assert_called_once_with({'stops': []})

    def test_non_admin_cannot_change_finance_password(self):
        with patch('api.service.verify_session_token', return_value={'role': 'finance'}):
            with self.assertRaises(ApiError) as caught:
                user_action_payload('token', {'action': 'change_finance_password', 'password': 'password123'})
        self.assertEqual(caught.exception.status, 403)

    def test_only_admin_can_clear_test_data(self):
        with patch('api.service.verify_session_token', return_value={'role': 'ops'}):
            with self.assertRaises(ApiError) as caught:
                clear_test_data_payload('token', {'confirm': '清空測試資料'})
        self.assertEqual(caught.exception.status, 403)

    def test_admin_clear_test_data_requires_confirmation(self):
        with patch('api.service.verify_session_token', return_value={'role': 'admin'}):
            with self.assertRaises(ApiError) as caught:
                clear_test_data_payload('token', {'confirm': 'delete'})
        self.assertEqual(caught.exception.status, 400)

    def test_admin_can_clear_test_data(self):
        cleared = {'ok': True, 'cleared': {'orders': 2}, 'updatedAt': 10}
        with patch('api.service.verify_session_token', return_value={'role': 'admin'}), patch('api.service.clear_records', return_value=cleared) as clear:
            result = clear_test_data_payload('token', {'confirm': '清空測試資料'})
        clear.assert_called_once_with()
        self.assertEqual(result['cleared']['orders'], 2)
        self.assertIn('帳號', result['message'])

    def test_admin_can_download_backup_without_passwords(self):
        with patch('api.service.verify_session_token', return_value={'role': 'admin'}), patch('api.service.read_state', return_value={'settings': {'appTitle': 'A'}, 'glossOptions': ['PVA']}), patch('api.service.export_records', return_value={'orders': []}):
            result = backup_payload('token')
        self.assertEqual(result['backup']['settings']['appTitle'], 'A')
        self.assertEqual(result['backup']['records'], {'orders': []})
        self.assertNotIn('password', str(result['backup']).lower())

    def test_admin_can_read_capacity_payload(self):
        pages = {
            'orders': {'total': 10},
            'customers': {'total': 3},
            'receivables': {'total': 2},
            'payables': {'total': 1},
            'inventory': {'total': 4},
            'audits': {'total': 5},
            'events': {'total': 6},
            'aiCorrections': {'total': 7},
        }
        with patch('api.service.verify_session_token', return_value={'role': 'admin'}), patch('api.service.ensure_storage'), patch('api.service.get_storage_mode', return_value='postgresql'), patch('api.service.list_records', side_effect=lambda entity, *_args: pages[entity]):
            result = capacity_payload('token')
        self.assertEqual(result['totalRecords'], 38)
        self.assertEqual(result['counts']['orders'], 10)
        self.assertEqual(result['status'], 'ok')

    def test_non_admin_cannot_read_capacity_payload(self):
        with patch('api.service.verify_session_token', return_value={'role': 'ops'}):
            with self.assertRaises(ApiError) as caught:
                capacity_payload('token')
        self.assertEqual(caught.exception.status, 403)

    def test_restore_backup_requires_confirmation(self):
        with patch('api.service.verify_session_token', return_value={'role': 'admin'}):
            with self.assertRaises(ApiError) as caught:
                restore_backup_payload('token', {'confirm': 'wrong', 'backup': {'records': {}}})
        self.assertEqual(caught.exception.status, 400)

    def test_admin_can_restore_backup(self):
        backup = {'settings': {'appTitle': 'A'}, 'glossOptions': ['PVA'], 'records': {'orders': []}}
        with patch('api.service.verify_session_token', return_value={'role': 'admin'}), patch('api.service.read_state', return_value={'syncTick': 1}), patch('api.service.write_state', return_value=(True, 10)) as write, patch('api.service.restore_records', return_value={'restored': {'orders': 0}}) as restore:
            result = restore_backup_payload('token', {'confirm': '還原備份', 'backup': backup})
        self.assertEqual(result['restored']['orders'], 0)
        self.assertEqual(write.call_args.args[0]['settings']['appTitle'], 'A')
        restore.assert_called_once_with({'orders': []})

    def test_ops_can_list_ai_corrections(self):
        with patch('api.service.verify_session_token', return_value={'role': 'ops'}), patch('api.service.list_records', return_value={'ok': True, 'items': [], 'total': 0}):
            result = list_entity_payload('token', 'aiCorrections')
        self.assertEqual(result['items'], [])

    def test_admin_can_change_finance_password(self):
        with patch('api.service.verify_session_token', return_value={'role': 'admin'}), patch('api.service.change_finance_module_password') as change_password:
            result = user_action_payload('token', {'action': 'change_finance_password', 'password': 'password123'})
        self.assertEqual(result, {'ok': True})
        change_password.assert_called_once_with('password123')

    def test_vercel_users_handler_uses_shared_user_service(self):
        from api.users import handler

        with patch('api.users.get_bearer_token', return_value='token'), patch('api.users.read_json_body', return_value={'action': 'change_finance_password', 'password': 'password123'}), patch('api.users.user_action_payload', return_value={'ok': True}) as operation, patch('api.users.json_response') as response:
            handler.do_POST(object())
        operation.assert_called_once_with('token', {'action': 'change_finance_password', 'password': 'password123'})
        response.assert_called_once_with(unittest.mock.ANY, 200, {'ok': True})

    def test_ops_can_recognize_order_without_saving_it(self):
        recognized = {'orderNumber': 'WO-1'}
        with patch('api.service.verify_session_token', return_value={'role': 'ops'}), patch('api.service.list_records', return_value={'items': []}), patch('api.service.recognize_order_image', return_value=recognized):
            result = recognize_order_payload('token', {'image': 'data:image/jpeg;base64,YQ=='})
        self.assertEqual(result, {'ok': True, 'order': recognized})

    def test_ai_recognition_uses_downstream_address_from_customer_system(self):
        recognized = {'downstream': '威峰', 'address': ''}
        customers = {'items': [{'name': '威峰裁切有限公司', 'address': '新北市測試路1號'}]}
        with patch('api.service.list_records', return_value=customers):
            result = _fill_recognized_customer_address(recognized)
        self.assertEqual(result['address'], '新北市測試路1號')
        self.assertEqual(result['addressSource'], 'customer-system')

    def test_customer_system_downstream_address_overrides_header_address(self):
        recognized = {'downstream': '成峰', 'address': '廣告設計有限公司表頭地址'}
        customers = {'items': [{'name': '成峰', 'address': '成峰送貨地址'}]}
        with patch('api.service.list_records', return_value=customers):
            result = _fill_recognized_customer_address(recognized)
        self.assertEqual(result['address'], '成峰送貨地址')
        self.assertEqual(result['addressSource'], 'customer-system')

    def test_visible_downstream_destination_is_fallback_when_customer_has_no_address(self):
        recognized = {'downstream': '成峰', 'address': '圖片明確標示的成峰送貨地址'}
        with patch('api.service.list_records', return_value={'items': []}):
            result = _fill_recognized_customer_address(recognized)
        self.assertEqual(result['address'], '圖片明確標示的成峰送貨地址')
        self.assertEqual(result['addressSource'], 'image-downstream-destination')

    def test_ops_can_check_ai_recognition_configuration(self):
        with patch('api.service.verify_session_token', return_value={'role': 'ops'}), patch('api.service.get_order_recognition_status', return_value={'configured': False, 'model': 'gpt-5.4-mini'}):
            result = recognize_order_status_payload('token')
        self.assertEqual(result, {'ok': True, 'configured': False, 'model': 'gpt-5.4-mini'})

    def test_ops_can_report_ai_correction(self):
        with patch('api.service.verify_session_token', return_value={'role': 'ops', 'username': 'ops'}), patch('api.service.upsert_record') as save:
            result = report_order_correction_payload('token', {'changes': {'address': {'wrong': 'A', 'correct': 'B'}}})
        self.assertEqual(result, {'ok': True, 'savedFields': 1})
        self.assertEqual(save.call_args.args[0], 'aiCorrections')

    def test_ai_correction_text_is_length_limited(self):
        with patch('api.service.verify_session_token', return_value={'role': 'ops'}), patch('api.service.upsert_record') as save:
            report_order_correction_payload('token', {'changes': {'address': {'wrong': 'A' * 300, 'correct': 'B' * 300}}})
        saved = save.call_args.args[2]['changes']['address']
        self.assertEqual(len(saved['wrong']), 200)
        self.assertEqual(len(saved['correct']), 200)

    def test_finance_cannot_recognize_order(self):
        with patch('api.service.verify_session_token', return_value={'role': 'finance'}):
            with self.assertRaises(ApiError) as caught:
                recognize_order_payload('token', {'image': 'data:image/jpeg;base64,YQ=='})
        self.assertEqual(caught.exception.status, 403)


if __name__ == '__main__':
    unittest.main()
