import base64
import hashlib
import hmac
import json
import unittest
from unittest.mock import patch

from api.line_bot import handle_line_webhook
from api.service import ApiError, _customer_names_for_ai, _fill_recognized_customer_address, backup_payload, capacity_payload, changes_payload, clear_test_data_payload, delete_entity_payload, execute_trip_payload, get_state_payload, health_payload, import_customers_payload, list_entity_payload, optimize_trip_payload, pricing_quote_payload, recognize_order_payload, recognize_order_status_payload, report_order_correction_payload, restore_backup_payload, update_state_payload, upsert_entity_payload, user_action_payload
from api.storage import create_session_token, verify_session_token


class ServiceTests(unittest.TestCase):
    def test_health_hides_environment_by_default(self):
        with patch('api.service.ensure_storage'), patch('api.service.get_storage_mode', return_value='local-json'):
            self.assertEqual(health_payload(), {'ok': True, 'database': 'local-json'})

    def test_line_webhook_verifies_signature_and_replies(self):
        payload = {
            'events': [{
                'type': 'message',
                'replyToken': 'reply-token',
                'source': {'type': 'user', 'userId': 'U1234567890'},
                'message': {'type': 'text', 'text': '綁定'},
            }]
        }
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        signature = base64.b64encode(hmac.new(b'secret', body, hashlib.sha256).digest()).decode('ascii')
        with patch.dict('os.environ', {'LINE_CHANNEL_SECRET': 'secret', 'LINE_CHANNEL_ACCESS_TOKEN': 'token'}), patch('api.line_bot.upsert_record') as upsert, patch('api.line_bot._line_api_post') as line_post:
            result = handle_line_webhook(body, signature)
        self.assertEqual(result['handled'], 1)
        self.assertEqual(upsert.call_args.args[0], 'lineDestinations')
        self.assertEqual(upsert.call_args.args[1], 'U1234567890')
        self.assertEqual(line_post.call_args.args[0], 'https://api.line.me/v2/bot/message/reply')
        message = line_post.call_args.args[1]['messages'][0]
        self.assertIn('quickReply', message)
        self.assertIn('未完成工單', [item['action']['label'] for item in message['quickReply']['items']])

    def test_line_query_requires_bound_destination(self):
        payload = {
            'events': [{
                'type': 'message',
                'replyToken': 'reply-token',
                'source': {'type': 'user', 'userId': 'U1234567890'},
                'message': {'type': 'text', 'text': '工單 WO-1'},
            }]
        }
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        signature = base64.b64encode(hmac.new(b'secret', body, hashlib.sha256).digest()).decode('ascii')
        with patch.dict('os.environ', {'LINE_CHANNEL_SECRET': 'secret', 'LINE_CHANNEL_ACCESS_TOKEN': 'token'}), patch('api.line_bot.list_records', return_value={'items': []}), patch('api.line_bot.upsert_record') as upsert, patch('api.line_bot._line_api_post') as line_post:
            handle_line_webhook(body, signature)
        upsert.assert_not_called()
        self.assertIn('請先輸入', line_post.call_args.args[1]['messages'][0]['text'])

    def test_line_query_returns_order_result_for_bound_destination(self):
        payload = {
            'events': [{
                'type': 'message',
                'replyToken': 'reply-token',
                'source': {'type': 'user', 'userId': 'U1234567890'},
                'message': {'type': 'text', 'text': '工單 WO-1'},
            }]
        }
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        signature = base64.b64encode(hmac.new(b'secret', body, hashlib.sha256).digest()).decode('ascii')

        def fake_list_records(entity, page=1, page_size=100, query=''):
            if entity == 'lineDestinations':
                return {'items': [{'id': 'U1234567890', 'destinationId': 'U1234567890', 'active': True}]}
            if entity == 'orders':
                return {'items': [{'id': 'o1', 'orderNumber': 'WO-1', 'orderDate': '2026-07-07', 'billingCustomer': '三青', 'status': '未完成', 'totalPrice': 1200}]}
            return {'items': []}

        with patch.dict('os.environ', {'LINE_CHANNEL_SECRET': 'secret', 'LINE_CHANNEL_ACCESS_TOKEN': 'token'}), patch('api.line_bot.list_records', side_effect=fake_list_records), patch('api.line_bot._line_api_post') as line_post:
            handle_line_webhook(body, signature)
        reply_text = line_post.call_args.args[1]['messages'][0]['text']
        self.assertIn('【工單查詢】', reply_text)
        self.assertIn('WO-1', reply_text)
        self.assertIn('三青', reply_text)
        labels = [item['action']['label'] for item in line_post.call_args.args[1]['messages'][0]['quickReply']['items']]
        self.assertIn('查客戶', labels)

    def test_line_group_chat_ignores_plain_conversation(self):
        payload = {
            'events': [{
                'type': 'message',
                'replyToken': 'reply-token',
                'source': {'type': 'group', 'groupId': 'G1234567890'},
                'message': {'type': 'text', 'text': '媽媽'},
            }]
        }
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        signature = base64.b64encode(hmac.new(b'secret', body, hashlib.sha256).digest()).decode('ascii')
        with patch.dict('os.environ', {'LINE_CHANNEL_SECRET': 'secret', 'LINE_CHANNEL_ACCESS_TOKEN': 'token'}), patch('api.line_bot._line_api_post') as line_post:
            handle_line_webhook(body, signature)
        line_post.assert_not_called()

    def test_line_group_chat_ignores_unmentioned_commands(self):
        payload = {
            'events': [{
                'type': 'message',
                'replyToken': 'reply-token',
                'source': {'type': 'group', 'groupId': 'G1234567890'},
                'message': {'type': 'text', 'text': '未完成工單'},
            }]
        }
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        signature = base64.b64encode(hmac.new(b'secret', body, hashlib.sha256).digest()).decode('ascii')
        with patch.dict('os.environ', {'LINE_CHANNEL_SECRET': 'secret', 'LINE_CHANNEL_ACCESS_TOKEN': 'token'}), patch('api.line_bot._line_api_post') as line_post:
            handle_line_webhook(body, signature)
        line_post.assert_not_called()

    def test_line_group_chat_replies_when_addressed(self):
        payload = {
            'events': [{
                'type': 'message',
                'replyToken': 'reply-token',
                'source': {'type': 'group', 'groupId': 'G1234567890'},
                'message': {'type': 'text', 'text': '@三青 客戶 媽媽'},
            }]
        }
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        signature = base64.b64encode(hmac.new(b'secret', body, hashlib.sha256).digest()).decode('ascii')

        def fake_list_records(entity, page=1, page_size=100, query=''):
            if entity == 'lineDestinations':
                return {'items': [{'id': 'G1234567890', 'destinationId': 'G1234567890', 'active': True}]}
            if entity == 'customers':
                return {'items': [{'id': 'c1', 'name': '媽媽公司', 'role': '上游', 'taxId': '12345678', 'phone': '2222-3333', 'address': '台北市'}]}
            return {'items': []}

        with patch.dict('os.environ', {'LINE_CHANNEL_SECRET': 'secret', 'LINE_CHANNEL_ACCESS_TOKEN': 'token'}), patch('api.line_bot.list_records', side_effect=fake_list_records), patch('api.line_bot._line_api_post') as line_post:
            handle_line_webhook(body, signature)
        reply_text = line_post.call_args.args[1]['messages'][0]['text']
        self.assertIn('【客戶/廠商查詢】', reply_text)
        self.assertIn('媽媽公司', reply_text)
        self.assertNotIn('quickReply', line_post.call_args.args[1]['messages'][0])

    def test_line_group_chat_replies_for_other_members_when_addressed(self):
        payload = {
            'events': [{
                'type': 'message',
                'replyToken': 'reply-token',
                'source': {'type': 'group', 'groupId': 'G1234567890', 'userId': 'UOTHER'},
                'message': {'type': 'text', 'text': '@三青 客戶 媽媽'},
            }]
        }
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        signature = base64.b64encode(hmac.new(b'secret', body, hashlib.sha256).digest()).decode('ascii')

        def fake_list_records(entity, page=1, page_size=100, query=''):
            if entity == 'lineDestinations':
                return {'items': [{'id': 'G1234567890', 'destinationId': 'G1234567890', 'active': True}]}
            if entity == 'customers':
                return {'items': [{'id': 'c1', 'name': '媽媽公司', 'role': '上游'}]}
            return {'items': []}

        with patch.dict('os.environ', {'LINE_CHANNEL_SECRET': 'secret', 'LINE_CHANNEL_ACCESS_TOKEN': 'token'}), patch('api.line_bot.list_records', side_effect=fake_list_records), patch('api.line_bot._line_api_post') as line_post:
            handle_line_webhook(body, signature)
        self.assertIn('媽媽公司', line_post.call_args.args[1]['messages'][0]['text'])

    def test_line_group_chat_ignores_unlisted_member_when_allowlist_is_set(self):
        payload = {
            'events': [{
                'type': 'message',
                'replyToken': 'reply-token',
                'source': {'type': 'group', 'groupId': 'G1234567890', 'userId': 'UOTHER'},
                'message': {'type': 'text', 'text': '@銝? 摰Ｘ 慦賢直'},
            }]
        }
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        signature = base64.b64encode(hmac.new(b'secret', body, hashlib.sha256).digest()).decode('ascii')

        with patch.dict('os.environ', {
            'LINE_CHANNEL_SECRET': 'secret',
            'LINE_CHANNEL_ACCESS_TOKEN': 'token',
            'LINE_ALLOWED_USER_IDS': 'UADMIN',
        }), patch('api.line_bot._line_api_post') as line_post:
            handle_line_webhook(body, signature)
        line_post.assert_not_called()

    def test_line_allowlist_helper_parses_config(self):
        from api import line_bot
        with patch.dict('os.environ', {'LINE_ALLOWED_USER_IDS': 'UADMIN,UOTHER'}):
            self.assertTrue(line_bot._is_line_user_allowed({'userId': 'UOTHER'}))
            self.assertFalse(line_bot._is_line_user_allowed({'userId': 'UUNKNOWN'}))

    def test_line_group_chat_replies_to_line_mention_metadata(self):
        mention_text = '@官方帳號 客戶 媽媽'
        payload = {
            'events': [{
                'type': 'message',
                'replyToken': 'reply-token',
                'source': {'type': 'group', 'groupId': 'G1234567890', 'userId': 'UOTHER'},
                'message': {
                    'type': 'text',
                    'text': mention_text,
                    'mention': {'mentionees': [{'index': 0, 'length': len('@官方帳號'), 'isSelf': True}]},
                },
            }]
        }
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        signature = base64.b64encode(hmac.new(b'secret', body, hashlib.sha256).digest()).decode('ascii')

        def fake_list_records(entity, page=1, page_size=100, query=''):
            if entity == 'lineDestinations':
                return {'items': [{'id': 'G1234567890', 'destinationId': 'G1234567890', 'active': True}]}
            if entity == 'customers':
                return {'items': [{'id': 'c1', 'name': '媽媽公司', 'role': '上游'}]}
            return {'items': []}

        with patch.dict('os.environ', {'LINE_CHANNEL_SECRET': 'secret', 'LINE_CHANNEL_ACCESS_TOKEN': 'token'}), patch('api.line_bot.list_records', side_effect=fake_list_records), patch('api.line_bot._line_api_post') as line_post:
            handle_line_webhook(body, signature)
        reply_text = line_post.call_args.args[1]['messages'][0]['text']
        self.assertIn('【客戶/廠商查詢】', reply_text)
        self.assertIn('媽媽公司', reply_text)

    def test_line_smart_query_understands_receivable_question(self):
        payload = {
            'events': [{
                'type': 'message',
                'replyToken': 'reply-token',
                'source': {'type': 'user', 'userId': 'U1234567890'},
                'message': {'type': 'text', 'text': '佳德欠多少'},
            }]
        }
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        signature = base64.b64encode(hmac.new(b'secret', body, hashlib.sha256).digest()).decode('ascii')

        def fake_list_records(entity, page=1, page_size=100, query=''):
            if entity == 'lineDestinations':
                return {'items': [{'id': 'U1234567890', 'destinationId': 'U1234567890', 'active': True}]}
            if entity == 'receivables':
                return {'items': [{'id': 'r1', 'customer': '佳德印刷有限公司', 'orderNumber': 'WO-2', 'amount': 3000, 'received': 1000}]}
            return {'items': []}

        with patch.dict('os.environ', {'LINE_CHANNEL_SECRET': 'secret', 'LINE_CHANNEL_ACCESS_TOKEN': 'token'}), patch('api.line_bot.list_records', side_effect=fake_list_records), patch('api.line_bot._line_api_post') as line_post:
            handle_line_webhook(body, signature)
        reply_text = line_post.call_args.args[1]['messages'][0]['text']
        self.assertIn('【應收未收】', reply_text)
        self.assertIn('NT$ 2,000', reply_text)

    def test_line_smart_query_understands_bare_order_number(self):
        payload = {
            'events': [{
                'type': 'message',
                'replyToken': 'reply-token',
                'source': {'type': 'user', 'userId': 'U1234567890'},
                'message': {'type': 'text', 'text': '115060162好了嗎'},
            }]
        }
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        signature = base64.b64encode(hmac.new(b'secret', body, hashlib.sha256).digest()).decode('ascii')

        def fake_list_records(entity, page=1, page_size=100, query=''):
            if entity == 'lineDestinations':
                return {'items': [{'id': 'U1234567890', 'destinationId': 'U1234567890', 'active': True}]}
            if entity == 'orders':
                return {'items': [{'id': 'o1', 'orderNumber': '115060162', 'billingCustomer': '三青', 'status': '未完成'}]}
            return {'items': []}

        with patch.dict('os.environ', {'LINE_CHANNEL_SECRET': 'secret', 'LINE_CHANNEL_ACCESS_TOKEN': 'token'}), patch('api.line_bot.list_records', side_effect=fake_list_records), patch('api.line_bot._line_api_post') as line_post:
            handle_line_webhook(body, signature)
        reply_text = line_post.call_args.args[1]['messages'][0]['text']
        self.assertIn('【工單查詢】', reply_text)
        self.assertIn('115060162', reply_text)

    def test_line_query_understands_delivery_question(self):
        payload = {
            'events': [{
                'type': 'message',
                'replyToken': 'reply-token',
                'source': {'type': 'user', 'userId': 'U1234567890'},
                'message': {'type': 'text', 'text': '有哪些要送'},
            }]
        }
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        signature = base64.b64encode(hmac.new(b'secret', body, hashlib.sha256).digest()).decode('ascii')

        def fake_list_records(entity, page=1, page_size=100, query=''):
            if entity == 'lineDestinations':
                return {'items': [{'id': 'U1234567890', 'destinationId': 'U1234567890', 'active': True}]}
            if entity == 'orders':
                return {'items': [
                    {'id': 'o1', 'orderNumber': 'WO-SEND', 'orderDate': '2026-07-14', 'billingCustomer': '富盛', 'downstream': '成峰', 'address': '新北市測試路1號', 'status': '未完成'},
                    {'id': 'o2', 'orderNumber': 'WO-SENT', 'orderDate': '2026-07-14', 'billingCustomer': '富盛', 'downstream': '成峰', 'address': '新北市測試路2號', 'status': '已送出'},
                    {'id': 'o3', 'orderNumber': 'WO-DONE', 'orderDate': '2026-07-13', 'billingCustomer': '富盛', 'downstream': '成峰', 'address': '新北市測試路3號', 'status': '已完成'},
                ]}
            return {'items': []}

        with patch.dict('os.environ', {'LINE_CHANNEL_SECRET': 'secret', 'LINE_CHANNEL_ACCESS_TOKEN': 'token'}), patch('api.line_bot.list_records', side_effect=fake_list_records), patch('api.line_bot._line_api_post') as line_post:
            handle_line_webhook(body, signature)
        reply_text = line_post.call_args.args[1]['messages'][0]['text']
        self.assertIn('【待送工單】', reply_text)
        self.assertIn('WO-SEND', reply_text)
        self.assertIn('送往：成峰', reply_text)
        self.assertNotIn('WO-SENT', reply_text)
        self.assertNotIn('WO-DONE', reply_text)

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
        bootstrap = {'scalableDataApi': True}
        with patch('api.service.authenticate_user', return_value=account), patch('api.service.create_session_token', return_value='token'), patch('api.service.build_bootstrap_payload', return_value=bootstrap) as build_bootstrap:
            result = user_action_payload('', {'action': 'login', 'username': 'ops', 'password': 'secret'})
        self.assertEqual(result['token'], 'token')
        self.assertEqual(result['account'], account)
        self.assertEqual(result['bootstrap'], bootstrap)
        build_bootstrap.assert_called_once_with(account, include_pages=False)

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

    def test_admin_can_update_shared_settings(self):
        current = {'settings': None, 'syncTick': 4}
        settings = {'moduleInternals': {'orders': {'pricingRules': {'divisor': 4680}}}}
        with patch('api.service.verify_session_token', return_value={'role': 'admin'}), patch('api.service.read_state', return_value=current), patch('api.service.write_state', return_value=(True, 5)) as write:
            result = user_action_payload('token', {'action': 'update_settings', 'settings': settings})
        self.assertEqual(result['syncTick'], 5)
        self.assertEqual(write.call_args.args[0]['settings'], settings)

    def test_non_admin_cannot_update_shared_settings(self):
        with patch('api.service.verify_session_token', return_value={'role': 'ops'}):
            with self.assertRaises(ApiError) as caught:
                user_action_payload('token', {'action': 'update_settings', 'settings': {}})
        self.assertEqual(caught.exception.status, 403)

    def test_admin_can_list_and_update_account_permissions(self):
        users = [{'id': 'u1', 'username': 'driver1', 'usernameKey': 'driver1', 'display': 'Driver', 'role': 'viewer', 'allowedViews': []}]
        with patch('api.service.verify_session_token', return_value={'role': 'admin'}), patch('api.service.read_users', return_value=users), patch('api.service.write_users') as write:
            listed = user_action_payload('token', {'action': 'list_accounts'})
            updated = user_action_payload('token', {'action': 'update_account_permissions', 'id': 'u1', 'role': 'driver', 'allowedViews': ['tripsView']})
        self.assertEqual(listed['accounts'][0]['username'], 'driver1')
        self.assertEqual(updated['account']['role'], 'driver')
        self.assertEqual(updated['account']['allowedViews'], ['tripsView'])
        write.assert_called_once()

    def test_driver_can_read_trip_dependencies_but_cannot_modify_orders(self):
        driver = {'role': 'driver', 'allowedViews': ['tripsView']}
        with patch('api.service.verify_session_token', return_value=driver), patch('api.service.list_records', return_value={'ok': True, 'items': []}):
            result = list_entity_payload('token', 'orders')
        self.assertEqual(result['items'], [])
        with patch('api.service.verify_session_token', return_value=driver):
            with self.assertRaises(ApiError) as caught:
                upsert_entity_payload('token', 'orders', 'o1', {'orderNumber': 'WO-1'})
        self.assertEqual(caught.exception.status, 403)
        with patch('api.service.verify_session_token', return_value=driver), patch('api.service.optimize_trip', return_value={'ok': True}) as optimize:
            result = optimize_trip_payload('token', {'stops': []})
        self.assertEqual(result, {'ok': True})
        optimize.assert_called_once_with({'stops': []})

    def test_driver_can_execute_trip_for_unfinished_or_completed_orders(self):
        driver = {'role': 'driver', 'display': '司機', 'allowedViews': ['tripsView']}
        orders = [
            {'id': 'o1', 'orderNumber': 'WO-1', 'status': '未完成', 'totalPrice': 1200, 'billingCustomer': '客戶甲', '_updatedAt': 1},
            {'id': 'o2', 'orderNumber': 'WO-2', 'status': '已送出'},
            {'id': 'o3', 'orderNumber': 'WO-3', 'status': '已完成'},
        ]

        def records(entity):
            return orders if entity == 'orders' else []

        with patch('api.service.verify_session_token', return_value=driver), patch('api.service._all_records', side_effect=records), patch('api.service.upsert_record', return_value={'ok': True, 'updatedAt': 99}) as upsert:
            result = execute_trip_payload('token', {'orderIds': ['o1', 'o2', 'o3']})

        self.assertEqual(result['updated'], 2)
        self.assertEqual(result['alreadySent'], 1)
        self.assertEqual(result['skippedCompleted'], 0)
        self.assertEqual(result['orders'][0]['status'], '已送出')
        order_writes = [call for call in upsert.call_args_list if call.args[0] == 'orders']
        self.assertEqual([call.args[1] for call in order_writes], ['o1', 'o3'])
        self.assertTrue(all(call.args[2]['status'] == '已送出' for call in order_writes))
        self.assertTrue(all('_updatedAt' not in call.args[2] for call in order_writes))
        self.assertTrue(any(call.args[0] == 'audits' for call in upsert.call_args_list))
        self.assertTrue(any(call.args[0] == 'receivables' for call in upsert.call_args_list))

    def test_ops_can_request_pricing_quote(self):
        payload = {'width': 26, 'height': 18, 'quantity': 1000, 'coatingType': 'PVA', 'machineType': 'BIG'}
        state = {'settings': {'moduleInternals': {'orders': {'pricingRules': {'divisor': 4680}}}}}
        with patch('api.service.verify_session_token', return_value={'role': 'ops'}), patch('api.service.read_state', return_value=state):
            result = pricing_quote_payload('token', payload)
        self.assertEqual(result['calculatedPrice'], 900)
        self.assertEqual(result['finalPrice'], 1000)
        self.assertTrue(result['minimumApplied'])

    def test_pricing_quote_uses_customer_override(self):
        payload = {'width': 26, 'height': 18, 'quantity': 1000, 'coatingType': 'PVB', 'machineType': 'BIG', 'customer': '三青'}
        rules = [{'id': 'p1', 'customer': '三青', 'glossType': 'PVB光/油', 'pricingMode': 'formula', 'sizeWidthTai': 26, 'sizeLengthTai': 18, 'unitPrice': 800}]
        with patch('api.service.verify_session_token', return_value={'role': 'ops'}), patch('api.service.read_state', return_value={'settings': None}), patch('api.service._all_records', return_value=rules):
            result = pricing_quote_payload('token', payload)
        self.assertEqual(result['unitPrice'], 800)
        self.assertEqual(result['calculatedPrice'], 800)
        self.assertEqual(result['finalPrice'], 1000)

    def test_pricing_quote_uses_customer_tier_matrix_price(self):
        payload = {'width': 30, 'height': 20, 'quantity': 1000, 'coatingType': 'PVA', 'machineType': 'REGULAR', 'customer': '三青'}
        rules = [{'id': 'p1', 'customer': '三青', 'glossType': 'PVA光', 'machineType': 'REGULAR', 'pricingMode': 'formula', 'priceScope': 'customer-tier', 'unitPrice': 760}]
        with patch('api.service.verify_session_token', return_value={'role': 'ops'}), patch('api.service.read_state', return_value={'settings': None}), patch('api.service._all_records', return_value=rules):
            result = pricing_quote_payload('token', payload)
        self.assertEqual(result['unitPrice'], 760)
        self.assertEqual(result['pricingTier'], 'REGULAR')

    def test_pricing_quote_uses_customer_tier_bounds(self):
        payload = {'width': 40, 'height': 20, 'quantity': 1000, 'coatingType': 'PVA', 'customer': '三青'}
        rules = [
            {'id': 'b1', 'customer': '三青', 'priceScope': 'customer-tier-bounds', 'tierBounds': {'REGULAR': {'shortMin': 18, 'shortMax': 25, 'longMin': 26, 'longMax': 45}}},
            {'id': 'p1', 'customer': '三青', 'glossType': 'PVA光', 'machineType': 'REGULAR', 'pricingMode': 'formula', 'priceScope': 'customer-tier', 'unitPrice': 760},
            {'id': 'p2', 'customer': '三青', 'glossType': 'PVA光', 'machineType': 'BIG', 'pricingMode': 'formula', 'priceScope': 'customer-tier', 'unitPrice': 990},
        ]
        with patch('api.service.verify_session_token', return_value={'role': 'ops'}), patch('api.service.read_state', return_value={'settings': None}), patch('api.service._all_records', return_value=rules):
            result = pricing_quote_payload('token', payload)
        self.assertEqual(result['pricingTier'], 'REGULAR')
        self.assertEqual(result['unitPrice'], 760)

    def test_deleting_order_also_deletes_linked_auto_receivable(self):
        records = {
            'orders': [{'id': 'o-1', 'orderNumber': 'WO-1'}],
            'receivables': [
                {'id': 'r-1', 'source': 'auto-order', 'orderNumber': 'WO-1'},
                {'id': 'r-2', 'source': 'manual', 'orderNumber': 'WO-1'},
            ],
        }
        with patch('api.service.verify_session_token', return_value={'role': 'ops'}), \
                patch('api.service._all_records', side_effect=lambda entity: records[entity]), \
                patch('api.service.delete_record', return_value={'ok': True}) as remove:
            result = delete_entity_payload('token', 'orders', 'o-1')
        self.assertEqual(remove.call_args_list[0].args, ('orders', 'o-1'))
        self.assertEqual(remove.call_args_list[1].args, ('receivables', 'r-1'))
        self.assertEqual(remove.call_count, 2)
        self.assertEqual(result['deletedLinkedReceivables'], 1)

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
        counts = {
            'orders': 10,
            'customers': 3,
            'receivables': 2,
            'payables': 1,
            'priceRules': 8,
            'inventory': 4,
            'audits': 5,
            'events': 6,
            'aiCorrections': 7,
        }
        with patch('api.service.verify_session_token', return_value={'role': 'admin'}), patch('api.service.ensure_storage'), patch('api.service.get_storage_mode', return_value='postgresql'), patch('api.service.count_records_by_entity', return_value=(counts, 12.3)):
            result = capacity_payload('token')
        self.assertEqual(result['totalRecords'], 46)
        self.assertEqual(result['counts']['orders'], 10)
        self.assertEqual(result['counts']['priceRules'], 8)
        self.assertEqual(result['countMs'], 12.3)
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

    def test_route_table_maps_user_actions_to_shared_service(self):
        from api.routes import resolve_post_route

        payload = {'action': 'change_finance_password', 'password': 'password123'}
        operation, args = resolve_post_route('/api/users', 'token', payload)
        self.assertIs(operation, user_action_payload)
        self.assertEqual(args, ('token', payload))

    def test_admin_can_import_customers_with_token(self):
        payload = {'username': 'admin', 'password': 'secret', 'customers': [{'name': '佳德印刷有限公司', 'role': '上游', 'taxId': '27595356', 'phone': '02-22269858', 'address': '新北市中和區'}]}
        with patch('api.service.verify_session_token', return_value={'role': 'admin'}), patch('api.service.list_records', return_value={'items': []}), patch('api.service.upsert_record', return_value={'ok': True}) as upsert:
            result = import_customers_payload('token', payload)
        self.assertEqual(result['count'], 1)
        saved = upsert.call_args.args[2]
        self.assertEqual(saved['name'], '佳德印刷有限公司')
        self.assertEqual(saved['taxId'], '27595356')
        self.assertEqual(saved['phone'], '2226-9858')

    def test_non_admin_cannot_import_customers(self):
        with patch('api.service.verify_session_token', return_value={'role': 'ops'}):
            with self.assertRaises(ApiError) as caught:
                import_customers_payload('token', {'username': 'ops', 'password': 'secret', 'customers': [{'name': 'A'}]})
        self.assertEqual(caught.exception.status, 403)

    def test_ops_can_recognize_order_without_saving_it(self):
        job = {'recognitionId': 'resp_test12345678', 'status': 'queued', 'model': 'gpt-5.4-mini'}
        with patch('api.service.verify_session_token', return_value={'role': 'ops'}), patch('api.service.list_records', return_value={'items': []}), patch('api.service.recognize_order_image', return_value=job) as recognize:
            result = recognize_order_payload('token', {'image': 'data:image/jpeg;base64,YQ=='})
        self.assertEqual(result, {'ok': True, 'pending': True, **job})
        self.assertTrue(recognize.call_args.args[5])

    def test_ai_recognition_passes_known_company_names(self):
        job = {'recognitionId': 'resp_test12345678', 'status': 'queued', 'model': 'gpt-5.4-mini'}
        customers = {'items': [{'name': '富盛', 'role': '上游'}, {'name': '成峰', 'role': '下游'}]}
        with patch('api.service.verify_session_token', return_value={'role': 'ops'}), patch('api.service.list_records', side_effect=[{'items': []}, customers]), patch('api.service.recognize_order_image', return_value=job) as recognize:
            result = recognize_order_payload('token', {'image': 'data:image/jpeg;base64,YQ==', 'glossOptions': ['PVA光']})
        self.assertEqual(result, {'ok': True, 'pending': True, **job})
        self.assertEqual(recognize.call_args.args[3], ['富盛', '成峰'])

    def test_ai_recognition_status_returns_pending_job(self):
        pending = {'recognitionId': 'resp_test12345678', 'status': 'in_progress', 'pending': True}
        with patch('api.service.verify_session_token', return_value={'role': 'ops'}), patch('api.service.get_order_recognition_result', return_value=pending):
            result = recognize_order_status_payload('token', 'resp_test12345678')
        self.assertEqual(result, {'ok': True, **pending})

    def test_ai_company_names_include_all_active_roles(self):
        customers = {'items': [
            {'name': '富盛', 'role': '上游'},
            {'name': '雙向公司', 'role': '兩者'},
            {'name': '舊客人', 'role': '客人'},
            {'name': '成峰', 'role': '下游'},
            {'name': '停用廠商', 'role': '上游', 'active': False},
        ]}
        with patch('api.service.list_records', return_value=customers):
            self.assertEqual(_customer_names_for_ai(), ['富盛', '雙向公司', '舊客人', '成峰'])

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
