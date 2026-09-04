import http.client
import json
import shutil
import subprocess
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from companion_server import Companion, CompanionHandler, verify_website, NoRedirect
from api import local_ai
from api.assistant_security import SITE_ORIGIN, COMPANION_ORIGIN
from api.assistant_tickets import issue, verify
from api.assistant_proposals import seal, unseal
from api.storage import create_session_token, verify_session_token
from api.service import ApiError


class PairingTests(unittest.TestCase):
    def setUp(self):
        self.model = MagicMock(return_value=SimpleNamespace(found=True, answer='本機測試答案', sources=('fake.md，第 2 行',), mode='documents'))
        self.identity = MagicMock(return_value={'username': 'fake-admin', 'display': '測試管理員', 'role': 'admin'})
        self.state = Companion(self.model, verifier=self.identity)
        self.ticket = 'sqai1.this-is-a-fake-scoped-ticket'

    def connected(self):
        pair = self.state.begin(self.ticket)
        self.state.approve(pair['pairId'], self.state.control_nonce)
        return self.state.finish(pair['pairId'], self.ticket)['capability']

    def test_needs_local_approval_not_just_valid_login(self):
        pair = self.state.begin(self.ticket)
        self.assertEqual(self.state.finish(pair['pairId'], self.ticket)['status'], 'pending')
        with self.assertRaises(ApiError):
            self.state.check('not-approved', self.ticket)
        self.model.assert_not_called()

    def test_approval_requires_local_nonce(self):
        pair = self.state.begin(self.ticket)
        with self.assertRaises(ApiError):
            self.state.approve(pair['pairId'], 'wrong')
        self.assertEqual(self.state.finish(pair['pairId'], self.ticket)['status'], 'pending')

    def test_wrong_owner_cannot_finish_pairing_or_chat(self):
        pair = self.state.begin(self.ticket)
        with self.assertRaises(ApiError):
            self.state.finish(pair['pairId'], 'wrong-ticket')
        cap = self.connected()
        with self.assertRaises(ApiError):
            self.state.check(cap, 'wrong-ticket')

    def test_pending_and_sessions_expire(self):
        pair = self.state.begin(self.ticket)
        with patch('companion_server.time.monotonic', return_value=time.monotonic() + 121):
            with self.assertRaises(ApiError):
                self.state.finish(pair['pairId'], self.ticket)
        cap = self.connected()
        with patch('companion_server.time.monotonic', return_value=time.monotonic() + 1201):
            with self.assertRaises(ApiError):
                self.state.check(cap, self.ticket)

    def test_pending_queue_is_bounded(self):
        for _ in range(4):
            self.state.begin(self.ticket)
        with self.assertRaises(ApiError) as caught:
            self.state.begin(self.ticket)
        self.assertEqual(caught.exception.status, 429)

    def test_new_pairing_revokes_old_browser(self):
        old = self.connected()
        current = self.connected()
        with self.assertRaises(ApiError):
            self.state.check(old, self.ticket)
        self.state.check(current, self.ticket)

    def test_chat_auth_and_sources_and_no_document_history(self):
        cap = self.connected()
        result = self.state.chat({'mode': 'documents', 'question': '測試', 'history': [['old', 'old answer']]}, self.ticket, cap)
        self.assertEqual(result['sources'], ['fake.md，第 2 行'])
        self.assertEqual(self.model.call_args.args[2], [])
        self.assertEqual(self.identity.call_args.args, (self.ticket,))

    def test_revocation_during_model_call_discards_answer(self):
        cap = self.connected()
        self.model.side_effect = lambda *args: self.state.revoke(self.state.control_nonce) or None
        with self.assertRaises(ApiError):
            self.state.chat({'mode': 'general', 'question': '測試'}, self.ticket, cap)
        self.assertFalse(self.state.model_lock.locked())

    def test_secret_input_no_model_and_secret_output_hidden(self):
        cap = self.connected()
        with self.assertRaises(ApiError):
            self.state.chat({'mode': 'general', 'question': 'password=test-fixture-not-real'}, self.ticket, cap)
        self.model.assert_not_called()
        self.model.return_value.answer = 'password=test-fixture-not-real'
        result = self.state.chat({'mode': 'general', 'question': '測試'}, self.ticket, cap)
        self.assertFalse(result['found'])
        self.assertNotIn('test-fixture-not-real', result['answer'])

    def test_arbitrary_tools_and_data_mode_rejected(self):
        cap = self.connected()
        for payload in ({'mode': 'data', 'question': 'sql'}, {'mode': 'general', 'question': 'hi', 'command': 'anything'}):
            with self.assertRaises(ApiError):
                self.state.chat(payload, self.ticket, cap)
        self.model.assert_not_called()

    def test_model_request_serialized(self):
        cap = self.connected()
        self.state.model_lock.acquire()
        try:
            with self.assertRaises(ApiError) as caught:
                self.state.chat({'mode': 'general', 'question': 'hi'}, self.ticket, cap)
            self.assertEqual(caught.exception.status, 429)
        finally:
            self.state.model_lock.release()

    def test_identity_failure_stops_model(self):
        cap = self.connected()
        self.identity.side_effect = ApiError('expired', 401)
        with self.assertRaises(ApiError):
            self.state.chat({'mode': 'general', 'question': 'hi'}, self.ticket, cap)
        self.model.assert_not_called()

    def test_fixed_site_verifier_never_forwards_full_login_session(self):
        with patch('companion_server.build_opener') as opener:
            with self.assertRaises(ApiError):
                verify_website('a-full-login-token-not-an-ai-ticket')
            opener.assert_not_called()
            response = opener.return_value.open.return_value.__enter__.return_value
            response.status = 200
            response.read.return_value = json.dumps({'ok': True, 'protocol': 1, 'account': self.identity.return_value}).encode()
            self.assertEqual(verify_website(self.ticket)['role'], 'admin')
            request = opener.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url, SITE_ORIGIN + '/api/local-ai/session')
            self.assertIsNone(request.data)
        with self.assertRaises(ApiError):
            NoRedirect().redirect_request(None, None, 302, None, None, 'https://other.example')


class TicketTests(unittest.TestCase):
    def setUp(self):
        self.session = create_session_token({'username': 'fake-admin', 'role': 'admin'})

    def test_ticket_is_scoped_not_a_website_session(self):
        ticket = issue(self.session)
        self.assertEqual(verify(ticket)['username'], 'fake-admin')
        self.assertIsNone(verify_session_token(ticket))

    def test_unauth_and_non_admin_cannot_issue(self):
        for token in ('', create_session_token({'username': 'fake-viewer', 'role': 'viewer'})):
            with self.assertRaises(ApiError):
                issue(token)

    def test_expired_and_tampered_ticket_fail(self):
        ticket = issue(self.session)
        with patch('api.assistant_tickets.time.time', return_value=time.time() + 1201):
            with self.assertRaises(ApiError):
                verify(ticket)
        with self.assertRaises(ApiError):
            verify(ticket + 'x')

    def test_proposal_cannot_be_used_as_ticket(self):
        proposal = seal({'owner': 'fake', 'recordId': 'fake', 'note': 'fake', 'version': 'fake', 'expires': time.time() + 120})
        with self.assertRaises(ApiError):
            verify('sqai1.' + proposal)

    def test_stateless_proposal_binds_owner_expiry_and_content(self):
        value = {'owner': 'fake', 'recordId': 'fake', 'note': 'new', 'version': 'test-version', 'expires': time.time() + 120}
        signed = seal(value)
        self.assertEqual(unseal(signed, 'fake'), value)
        for encoded, owner in ((signed, 'someone-else'), (signed + 'x', 'fake')):
            with self.assertRaises(ApiError):
                unseal(encoded, owner)
        with patch('api.assistant_proposals.time.time', return_value=time.time() + 121):
            with self.assertRaises(ApiError):
                unseal(signed, 'fake')

    def test_production_cloud_never_generates_or_exposes_demo_login(self):
        with patch.object(local_ai, 'PRODUCTION', True), patch.object(local_ai, 'ENABLED', True), patch.object(local_ai, 'DEMO', False), patch.object(local_ai, 'ANSWER') as model:
            with self.assertRaises(ApiError):
                local_ai.chat_payload(self.session, {'mode': 'general', 'question': 'private'})
            with self.assertRaises(ApiError):
                local_ai.demo_session('', {})
            model.assert_not_called()

    def test_production_flask_transport_and_scoped_session(self):
        from api_server import app
        if app is None:
            self.skipTest('Flask is validated by the deployment CI')
        ticket = issue(self.session)
        with patch.object(local_ai, 'PRODUCTION', True), patch.object(local_ai, 'ENABLED', True), patch.object(local_ai, 'DEMO', False):
            client = app.test_client()
            self.assertEqual(client.get('/api/local-ai/config', base_url=SITE_ORIGIN).json['transport'], 'companion')
            self.assertEqual(client.post('/api/local-ai/ticket', json={}, base_url=SITE_ORIGIN).status_code, 401)
            response = client.get('/api/local-ai/session', headers={'Authorization': 'Bearer ' + ticket}, base_url=SITE_ORIGIN)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json['account']['username'], 'fake-admin')
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            self.assertEqual(client.post('/api/local-ai/demo-session', json={}, base_url=SITE_ORIGIN).status_code, 404)
            self.assertEqual(client.post('/api/local-ai/ticket', json={}, headers={'Origin': 'https://evil.example'}, base_url=SITE_ORIGIN).status_code, 403)


class CompanionHttpTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), CompanionHandler)
        self.server.state = Companion(MagicMock(), verifier=lambda token: {'username': 'fake', 'display': '測試', 'role': 'admin'})
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    def call(self, method, path, payload=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        all_headers = {'Host': '127.0.0.1:4175', **(headers or {})}
        try:
            connection.request(method, path, None if payload is None else json.dumps(payload), all_headers)
            response = connection.getresponse()
            body = response.read()
            return response.status, dict(response.getheaders()), body
        finally:
            connection.close()

    def test_preflight_allows_exact_site_only(self):
        headers = {'Origin': SITE_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,x-sanqing-capability'}
        status, reply, _ = self.call('OPTIONS', '/chat', headers=headers)
        self.assertEqual(status, 204)
        self.assertEqual(reply['Access-Control-Allow-Origin'], SITE_ORIGIN)
        status, reply, _ = self.call('OPTIONS', '/chat', headers=headers | {'Origin': 'https://evil.example'})
        self.assertEqual(status, 403)
        self.assertNotIn('Access-Control-Allow-Origin', reply)

    def test_wrong_host_opaque_origin_and_simple_post_blocked(self):
        for headers in ({'Host': 'evil.example'}, {'Origin': 'null'}, {'Origin': SITE_ORIGIN, 'Content-Type': 'text/plain'}):
            status, _, _ = self.call('POST', '/pair', {}, headers)
            self.assertIn(status, (403, 415))

    def test_cloud_cannot_access_local_control_nonce(self):
        status, _, body = self.call('GET', '/control', headers={'Origin': SITE_ORIGIN, 'X-Sanqing-Control': '1'})
        self.assertEqual(status, 403)
        self.assertNotIn(self.server.state.control_nonce.encode(), body)
        self.assertEqual(self.call('GET', '/control', headers={'X-Sanqing-Control': '1'})[0], 200)

    def test_http_pairing_roundtrip_needs_local_approval(self):
        ticket = 'sqai1.fake-ticket-long-enough'
        headers = {'Origin': SITE_ORIGIN, 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ticket}
        status, _, body = self.call('POST', '/pair', {}, headers)
        self.assertEqual(status, 200)
        pair = json.loads(body)
        self.assertEqual(json.loads(self.call('POST', '/pair/status', {'pairId': pair['pairId']}, headers)[2])['status'], 'pending')
        approval = {'Origin': COMPANION_ORIGIN, 'Content-Type': 'application/json', 'X-Sanqing-Control': self.server.state.control_nonce}
        self.assertEqual(self.call('POST', '/control/approve', {'pairId': pair['pairId']}, approval)[0], 200)
        self.assertEqual(json.loads(self.call('POST', '/pair/status', {'pairId': pair['pairId']}, headers)[2])['status'], 'connected')

    def test_only_allowlisted_control_assets_are_served(self):
        self.assertEqual(self.call('GET', '/')[0], 200)
        for path in ('/.env', '/.git/config', '/api/storage.py', '/data/private/test.md', '/companion_server.py'):
            self.assertEqual(self.call('GET', path)[0], 404)


class FrontendTransportTests(unittest.TestCase):
    def test_routing_pairing_and_logout_race(self):
        node = shutil.which('node')
        if not node:
            self.skipTest('Node unavailable')
        result = subprocess.run([node, str(Path(__file__).with_name('test_transport.mjs'))], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
