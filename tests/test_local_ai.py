import http.client
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, MagicMock

from api import local_ai, local_ai_records, records
from api.http_server import create_server, is_blocked_static_path
from api.service import ApiError
from api.storage import create_session_token
from api.local_ai_runtime import load_local_engine


class LocalAiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sanqing-ai-fake-')
        root = Path(self.temp.name)
        self.patches = [
            patch.object(records.storage, 'DATABASE_URL', ''),
            patch.object(records.storage, 'DATA_DIR', root),
            patch.object(records, 'RECORDS_PATH', root / 'records.json'),
            patch.object(records, 'RECORD_STORAGE_READY', True),
            patch.object(records.storage, 'ensure_storage'),
            patch.object(local_ai, 'ENABLED', True),
            patch.object(local_ai, 'PRODUCTION', False),
            patch.object(local_ai, 'DEMO', False),
            patch.object(local_ai, 'ALLOW_WRITES', True),
            patch.object(local_ai, '_PROPOSALS', {}),
            patch.object(local_ai, 'SECRET_CHECK', lambda text: 'test-sensitive-marker' in text),
            patch.object(local_ai, 'ANSWER', MagicMock(return_value=SimpleNamespace(found=True, answer='測試回答', sources=('test.md，第 1 行',), mode='documents'))),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)
        self.addCleanup(self.temp.cleanup)
        self.admin = create_session_token({'username': 'fake-admin', 'role': 'admin'})
        self.other = create_session_token({'username': 'fake-other', 'role': 'admin'})
        self.viewer = create_session_token({'username': 'fake-viewer', 'role': 'viewer', 'allowedViews': []})
        self.driver = create_session_token({'username': 'fake-driver', 'role': 'driver', 'allowedViews': ['tripsView']})
        self.ops = create_session_token({'username': 'fake-ops', 'role': 'ops', 'allowedViews': ['inventoryView']})
        records.upsert_record('inventory', 'fake-stock', {'id': 'fake-stock', 'material': '假資料透明膜', 'stock': 40, 'note': '測試備註'})
        records.upsert_record('orders', 'fake-order', {'id': 'fake-order', 'orderNumber': 'DEMO-001', 'totalPrice': 99, 'privateExtra': 'should-not-return'})

    def assert_api(self, status, fn, *args):
        with self.assertRaises(ApiError) as caught:
            fn(*args)
        self.assertEqual(caught.exception.status, status)
        return caught.exception

    def preview(self, token=None):
        return local_ai.preview_payload(token or self.admin, {'recordId': 'fake-stock', 'note': '新測試備註'})

    def confirm(self, proposal, token=None):
        return local_ai.confirm_payload(token or self.admin, {'proposalId': proposal['proposalId'], 'confirmed': True})

    def test_auth_required_for_chat_and_preview(self):
        self.assert_api(401, local_ai.chat_payload, '', {'question': '你好'})
        self.assert_api(401, local_ai.preview_payload, '', {'recordId': 'fake-stock', 'note': '測試'})
        local_ai.ANSWER.assert_not_called()

    def test_read_permission_is_checked_before_storage(self):
        with patch.object(local_ai, 'list_entity_payload') as listing:
            self.assert_api(403, local_ai.chat_payload, self.viewer, {'mode': 'data', 'entity': 'inventory', 'question': '最近'})
            listing.assert_not_called()

    def test_driver_can_read_orders_not_inventory(self):
        response = local_ai.chat_payload(self.driver, {'mode': 'data', 'entity': 'orders', 'question': 'DEMO-001'})
        self.assertTrue(response['found'])
        self.assertFalse(response['canEditNote'])
        self.assert_api(403, local_ai.chat_payload, self.driver, {'mode': 'data', 'entity': 'inventory', 'question': '最近'})

    def test_projection_omits_prices_credentials_and_extra_fields(self):
        response = local_ai.chat_payload(self.admin, {'mode': 'data', 'entity': 'orders', 'question': 'DEMO-001'})
        self.assertNotIn('totalPrice', response['rows'][0])
        self.assertNotIn('privateExtra', response['rows'][0])
        self.assertIn('fake-order', response['sources'][0])
        local_ai.ANSWER.assert_not_called()

    def test_queries_are_literal_and_unknown_refuses(self):
        response = local_ai.chat_payload(self.admin, {'mode': 'data', 'entity': 'orders', 'question': "'; DROP TABLE app_records;--"})
        self.assertFalse(response['found'])
        self.assertIn('不知道', response['answer'])
        self.assertEqual(records.list_records('orders')['total'], 1)

    def test_query_returns_at_most_five_rows(self):
        for n in range(8):
            records.upsert_record('orders', f'fake-{n}', {'orderNumber': f'DEMO-{n}'})
        response = local_ai.chat_payload(self.admin, {'mode': 'data', 'entity': 'orders', 'question': '最近'})
        self.assertEqual(len(response['rows']), 5)

    def test_finance_users_and_sql_tools_not_exposed(self):
        for entity in ('users', 'payables', 'receivables', 'sql', '../data', []):
            self.assert_api(400, local_ai.chat_payload, self.admin, {'mode': 'data', 'entity': entity, 'question': '最近'})

    def test_documents_admin_only_and_sources_preserved(self):
        self.assert_api(403, local_ai.chat_payload, self.viewer, {'mode': 'documents', 'question': '測試'})
        result = local_ai.chat_payload(self.admin, {'mode': 'documents', 'question': '測試'})
        self.assertEqual(result['sources'], ['test.md，第 1 行'])

    def test_document_history_not_forwarded(self):
        local_ai.chat_payload(self.admin, {'mode': 'documents', 'question': '測試', 'history': [['舊問題', '舊答案']]})
        self.assertEqual(local_ai.ANSWER.call_args.args[2], [])

    def test_general_history_is_bounded(self):
        self.assert_api(400, local_ai.chat_payload, self.admin, {'question': '你好', 'history': [['q', 'a']] * 3})
        self.assert_api(400, local_ai.chat_payload, self.admin, {'question': '你好', 'history': [['q' * 301, 'a']]})

    def test_secret_input_rejected_and_output_hidden(self):
        self.assert_api(400, local_ai.chat_payload, self.admin, {'question': 'test-sensitive-marker'})
        local_ai.ANSWER.return_value.answer = 'test-sensitive-marker'
        answer = local_ai.chat_payload(self.admin, {'question': '你好'})['answer']
        self.assertNotIn('test-sensitive-marker', answer)
        self.assertIn('隱藏', answer)

    def test_busy_model_rejects_second_request(self):
        local_ai._MODEL_LOCK.acquire()
        try:
            self.assert_api(429, local_ai.chat_payload, self.admin, {'question': '你好'})
        finally:
            local_ai._MODEL_LOCK.release()

    def test_model_failure_does_not_expose_exception_details(self):
        local_ai.ANSWER.side_effect = RuntimeError('test-sensitive-marker')
        error = self.assert_api(503, local_ai.chat_payload, self.admin, {'question': '你好'})
        self.assertNotIn('test-sensitive-marker', str(error))
        self.assertFalse(local_ai._MODEL_LOCK.locked())

    def test_disabled_has_no_cloud_fallback(self):
        with patch.object(local_ai, 'ENABLED', False):
            self.assert_api(503, local_ai.chat_payload, self.admin, {'question': '你好'})
        local_ai.ANSWER.assert_not_called()

    def test_no_demo_login_in_regular_website(self):
        self.assert_api(404, local_ai.demo_session, '', {})

    def test_preview_does_not_write(self):
        self.preview()
        self.assertEqual(local_ai_records.inventory_snapshot('fake-stock')['data']['note'], '測試備註')
        self.assertEqual(records.list_records('audits')['total'], 0)

    def test_confirm_updates_only_note_and_creates_audit(self):
        result = self.confirm(self.preview())
        data = local_ai_records.inventory_snapshot('fake-stock')['data']
        self.assertEqual(data['note'], '新測試備註')
        self.assertEqual(data['stock'], 40)
        audits = records.list_records('audits')['items']
        self.assertEqual(len(audits), 1)
        self.assertEqual(audits[0]['id'], result['auditId'])
        self.assertEqual(audits[0]['user'], 'fake-admin')

    def test_confirm_requires_explicit_boolean(self):
        proposal = self.preview()
        self.assert_api(400, local_ai.confirm_payload, self.admin, {'proposalId': proposal['proposalId'], 'confirmed': 'true'})

    def test_wrong_session_cannot_use_or_consume_proposal(self):
        proposal = self.preview()
        self.assert_api(409, local_ai.confirm_payload, self.other, {'proposalId': proposal['proposalId'], 'confirmed': True})
        self.assertTrue(self.confirm(proposal)['ok'])

    def test_expired_proposal(self):
        proposal = self.preview()
        with patch.object(local_ai.time, 'monotonic', return_value=time.monotonic() + 121):
            self.assert_api(409, local_ai.confirm_payload, self.admin, {'proposalId': proposal['proposalId'], 'confirmed': True})

    def test_proposal_single_use(self):
        proposal = self.preview()
        self.confirm(proposal)
        self.assert_api(409, local_ai.confirm_payload, self.admin, {'proposalId': proposal['proposalId'], 'confirmed': True})
        self.assertEqual(records.list_records('audits')['total'], 1)

    def test_intervening_change_prevents_overwrite(self):
        proposal = self.preview()
        records.upsert_record('inventory', 'fake-stock', {'material': '另一次修改', 'note': '他人備註', 'stock': 41})
        self.assert_api(409, local_ai.confirm_payload, self.admin, {'proposalId': proposal['proposalId'], 'confirmed': True})
        self.assertEqual(local_ai_records.inventory_snapshot('fake-stock')['data']['note'], '他人備註')

    def test_only_admin_and_enabled_writes(self):
        self.assert_api(403, local_ai.preview_payload, self.ops, {'recordId': 'fake-stock', 'note': '新內容'})
        with patch.object(local_ai, 'ALLOW_WRITES', False):
            self.assert_api(403, local_ai.preview_payload, self.admin, {'recordId': 'fake-stock', 'note': '新內容'})

    def test_mutation_payload_does_not_allow_extra_fields_or_empty_note(self):
        self.assert_api(400, local_ai.preview_payload, self.admin, {'recordId': 'fake-stock', 'note': '新', 'stock': 10})
        self.assert_api(400, local_ai.preview_payload, self.admin, {'recordId': 'fake-stock', 'note': ''})
        proposal = self.preview()
        self.assert_api(400, local_ai.confirm_payload, self.admin, {'proposalId': proposal['proposalId'], 'confirmed': True, 'note': '偷偷換內容'})

    def test_two_previews_cannot_both_overwrite_same_snapshot(self):
        first, second = self.preview(), self.preview()
        self.confirm(first)
        self.assert_api(409, local_ai.confirm_payload, self.admin, {'proposalId': second['proposalId'], 'confirmed': True})

    def test_production_confirmation_survives_worker_restart_and_rejects_replay(self):
        with patch.object(local_ai, 'PRODUCTION', True):
            proposal = self.preview()
            local_ai._PROPOSALS.clear()
            result = self.confirm(proposal)
            self.assertTrue(result['ok'])
            self.assert_api(409, local_ai.confirm_payload, self.admin, {'proposalId': proposal['proposalId'], 'confirmed': True})
            self.assertEqual(records.list_records('audits')['total'], 1)

    def test_production_proposal_tampering_and_wrong_session_rejected(self):
        with patch.object(local_ai, 'PRODUCTION', True):
            proposal = self.preview()
            self.assert_api(409, local_ai.confirm_payload, self.other, {'proposalId': proposal['proposalId'], 'confirmed': True})
            self.assert_api(409, local_ai.confirm_payload, self.admin, {'proposalId': proposal['proposalId'] + 'x', 'confirmed': True})
            self.assertEqual(records.list_records('audits')['total'], 0)

    def test_postgres_uses_row_lock_parameters_and_transaction(self):
        snapshot = local_ai_records.inventory_snapshot('fake-stock')
        conn = MagicMock()
        cur = conn.cursor.return_value.__enter__.return_value
        cur.fetchone.return_value = {'data_json': snapshot['data'], 'updated_at': snapshot['updatedAt'], 'deleted': False}
        with patch.object(records.storage, 'DATABASE_URL', 'fake-test-only'), patch.object(records.storage, 'get_db_connection') as connect, patch.object(records.storage, 'Jsonb', side_effect=lambda value: value):
            connect.return_value.__enter__.return_value = conn
            local_ai_records.update_inventory_note('fake-stock', local_ai_records.fingerprint(snapshot), '測試', 'fake-admin')
        self.assertIn('FOR UPDATE', cur.execute.call_args_list[0].args[0])
        self.assertEqual(cur.execute.call_args_list[0].args[1], ('inventory', 'fake-stock'))
        self.assertEqual(cur.execute.call_count, 3)
        conn.transaction.assert_called_once()
        conn.commit.assert_called_once()


class BoundaryTests(unittest.TestCase):
    def engine(self):
        source = Path(__file__).resolve().parents[2] / 'sanqing-local-ai' / 'src' / 'sanqing_ai' / 'answer.py'
        if not source.is_file():
            self.skipTest('Separate local engine is not installed in this checkout')
        return load_local_engine()

    def test_rejects_cross_origin_remote_host_and_oversized_body(self):
        cases = [
            ('192.168.1.2', '127.0.0.1:4173', '', 4173, 'POST', 'application/json', '2'),
            ('127.0.0.1', 'evil.example:4173', '', 4173, 'POST', 'application/json', '2'),
            ('127.0.0.1', '127.0.0.1:4173', 'https://evil.example', 4173, 'POST', 'application/json', '2'),
            ('127.0.0.1', '127.0.0.1:4173', '', 4173, 'POST', 'text/plain', '2'),
            ('127.0.0.1', '127.0.0.1:4173', '', 4173, 'POST', 'application/json', '16385'),
        ]
        for case in cases:
            with self.assertRaises(ApiError):
                local_ai.validate_request(*case)

    def test_hidden_and_private_files_blocked(self):
        for path in ('.env', '.git/config', 'data/private/test.md', '../file', 'runtime/log.txt', '.runtime/python/python.exe', 'secrets.json', 'api/storage.py'):
            self.assertTrue(is_blocked_static_path(path), path)
        self.assertFalse(is_blocked_static_path('js/local-ai.js'))

    def test_real_http_transport_enforces_guard_and_auth(self):
        with patch.object(local_ai, 'ENABLED', True), patch.object(local_ai, 'DEMO', False):
            server = create_server('127.0.0.1', 0)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                conn.request('POST', '/api/local-ai/chat', json.dumps({'question': '你好'}), {'Content-Type': 'application/json'})
                response = conn.getresponse()
                self.assertEqual(response.status, 401)
                self.assertEqual(response.getheader('Cache-Control'), 'no-store')
                response.read()
                conn.close()
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                conn.request('POST', '/api/local-ai/demo-session', '{}', {'Content-Type': 'application/json', 'Origin': 'https://evil.example'})
                response = conn.getresponse()
                self.assertEqual(response.status, 403)
                response.read()
                conn.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=3)

    def test_flask_guard_if_flask_installed(self):
        from api_server import app
        if app is None:
            self.skipTest('Flask optional; safe runner uses the tested standard-library server')
        client = app.test_client()
        response = client.post('/api/local-ai/chat', json={'question': '你好'}, base_url='http://evil.example:4173')
        self.assertEqual(response.status_code, 403)
        response = client.get('/.git/config', base_url='http://127.0.0.1:4173')
        self.assertEqual(response.status_code, 403)

    def test_frontend_never_evaluates_response_html_or_persists_conversations(self):
        source = (Path(__file__).resolve().parents[1] / 'js' / 'local-ai.js').read_text(encoding='utf-8')
        for unsafe in ('innerHTML', 'outerHTML', 'eval(', 'localStorage', 'sessionStorage', 'document.cookie'):
            self.assertNotIn(unsafe, source)
        self.assertIn('textContent', source)
        self.assertIn('app:auth-changed', source)
        self.assertIn("chosenMode === 'general'", source)

    def test_real_engine_greeting_and_company_routing_need_no_model(self):
        self.engine()
        with patch('sanqing_ai.launcher._start_server', side_effect=AssertionError('must not start')):
            answer, secret_check = load_local_engine()
            self.assertIn('你好', answer('你好', 'general', []).answer)
            self.assertFalse(answer('公司客戶有誰', 'general', []).found)
        self.assertFalse(secret_check('普通測試文字'))

    def test_engine_low_memory_never_starts_model(self):
        self.engine()
        with patch('sanqing_ai.launcher._available_memory_gib', return_value=1.0), patch('sanqing_ai.launcher._start_server') as start:
            answer, _ = load_local_engine()
            with self.assertRaises(ApiError) as caught:
                answer('QX-17 是什麼意思', 'documents', [])
            self.assertEqual(caught.exception.status, 503)
            start.assert_not_called()

    def test_engine_cleanup_even_if_generation_fails(self):
        self.engine()
        with patch('sanqing_ai.launcher._available_memory_gib', return_value=2.0), patch('sanqing_ai.launcher._preflight'), patch('sanqing_ai.launcher._assert_loopback_only', return_value=[]), patch('sanqing_ai.launcher._start_server', return_value='fake-owned') as start, patch('sanqing_ai.launcher._stop_owned') as stop, patch('sanqing_ai.answer.answer_question', side_effect=RuntimeError('fake-failure')):
            answer, _ = load_local_engine()
            with self.assertRaises(RuntimeError):
                answer('QX-17 是什麼意思', 'documents', [])
            start.assert_called_once()
            stop.assert_called_once_with('fake-owned')

    def test_stop_only_available_to_demo_admin_after_confirmation(self):
        token = create_session_token({'username': 'fake-admin', 'role': 'admin'})
        with patch.object(local_ai, 'ENABLED', True), patch.object(local_ai, 'DEMO', False):
            with self.assertRaises(ApiError):
                local_ai.stop_payload(token, {'confirmed': True})
        with patch.object(local_ai, 'ENABLED', True), patch.object(local_ai, 'DEMO', True), patch.object(local_ai, 'STOP_SERVER', lambda: None), patch.object(local_ai.threading, 'Timer') as timer:
            with self.assertRaises(ApiError):
                local_ai.stop_payload(token, {})
            timer.assert_not_called()
            self.assertTrue(local_ai.stop_payload(token, {'confirmed': True})['ok'])
            timer.return_value.start.assert_called_once()

    def test_runner_blocks_external_network(self):
        from run_local_ai import local_network_only
        with self.assertRaises(PermissionError):
            local_network_only('socket.connect', (None, ('203.0.113.1', 443)))
        local_network_only('socket.connect', (None, ('127.0.0.1', 11434)))


if __name__ == '__main__':
    unittest.main()
