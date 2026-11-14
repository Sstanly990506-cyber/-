import copy
import unittest
from unittest.mock import patch
from api import remember_session, storage
from api_server import app
from api.http_server import create_server
import json
import threading
import urllib.request
import urllib.error

@unittest.skipIf(app is None, 'Flask unavailable')
class RememberSessionTests(unittest.TestCase):
    def setUp(self):
        self.user={'id':'u1','username':'operator','usernameKey':'operator','password':storage.hash_password('password'),'display':'Operator','role':'ops','allowedViews':['ordersView'],'sessionVersion':'v1','createdAt':'','source':'test'}
        self.users=[self.user]
        item=patch.object(storage,'read_users',side_effect=lambda: self.users);item.start();self.addCleanup(item.stop)
        item=patch.object(remember_session,'build_bootstrap_payload',return_value={'settings':None,'settingsVersion':'test'});item.start();self.addCleanup(item.stop)
        self.client=app.test_client()
        self.token=storage.create_session_token(self.user)
        self.headers={'Origin':'https://localhost','Content-Type':'application/json','Authorization':'Bearer '+self.token,'Sec-Fetch-Site':'same-origin'}
    def post(self, path, headers=None):
        return self.client.post(path,headers=self.headers if headers is None else headers,json={})
    def test_no_cookie_without_explicit_remember_and_valid_login(self):
        self.assertEqual(self.client.get('/api/session/restore').status_code,401)
        bad={**self.headers,'Authorization':'Bearer invalid'}
        response=self.post('/api/session/remember',bad)
        self.assertEqual(response.status_code,401)
        self.assertIsNone(response.headers.get('Set-Cookie'))
    def test_opt_in_cookie_is_secure_scoped_http_only_and_expires(self):
        response=self.post('/api/session/remember')
        self.assertEqual(response.status_code,200)
        cookie=response.headers['Set-Cookie']
        for part in ['HttpOnly','Secure','SameSite=Strict','Path=/api/session','Max-Age=43200']:
            self.assertIn(part,cookie)
        self.assertEqual(response.headers['Cache-Control'],'no-store')
        result=self.client.get('/api/session/restore')
        self.assertEqual(result.status_code,200)
        self.assertEqual(result.json['account']['username'],'operator')
        self.assertEqual(result.headers['Cache-Control'],'no-store')
    def test_password_permission_changes_and_expiry_reject_restoration(self):
        for field,value in [('password',storage.hash_password('different')),('allowedViews',[]),('sessionVersion','v2')]:
            with self.subTest(field=field):
                self.user.update({'password':storage.hash_password('password'),'allowedViews':['ordersView'],'sessionVersion':'v1'})
                token=storage.create_session_token(self.user)
                self.client.set_cookie(remember_session.COOKIE_NAME,token,path=remember_session.COOKIE_PATH,secure=True)
                self.user[field]=value
                result=self.client.get('/api/session/restore')
                self.assertEqual(result.status_code,401)
                self.assertIn('Max-Age=0',result.headers['Set-Cookie'])
        self.user['sessionVersion']='v1'
        with patch('api.storage.time.time', return_value=1):token=storage.create_session_token(self.user)
        self.client.set_cookie(remember_session.COOKIE_NAME,token,path=remember_session.COOKIE_PATH,secure=True)
        self.assertEqual(self.client.get('/api/session/restore').status_code,401)
    def test_logout_clears_cookie_and_reload_does_not_restore(self):
        self.post('/api/session/remember')
        logout=self.post('/api/session/logout')
        self.assertEqual(logout.status_code,200)
        self.assertIn('Max-Age=0',logout.headers['Set-Cookie'])
        self.assertEqual(self.client.get('/api/session/restore').status_code,401)
    def test_cross_origin_and_non_json_cookie_changes_are_denied(self):
        for headers in [{**self.headers,'Origin':'https://evil.example'}, {**self.headers,'Sec-Fetch-Site':'cross-site'}, {**self.headers,'Origin':''}]:
            with self.subTest(headers=headers):
                self.assertEqual(self.post('/api/session/remember',headers).status_code,403)
                self.assertEqual(self.post('/api/session/logout',headers).status_code,403)
        self.assertEqual(self.client.post('/api/session/logout',headers={'Origin':'https://localhost'},data='').status_code,415)
    def test_finance_unlocked_session_is_never_persisted(self):
        self.user['role']='finance';self.user['allowedViews']=['financeView']
        with patch.object(storage,'_finance_revision',return_value='finance'):
            token=storage.create_session_token(self.user,finance_unlocked=True)
            response=self.post('/api/session/remember',{**self.headers,'Authorization':'Bearer '+token})
        self.assertEqual(response.status_code,403)

    def test_builtin_server_enforces_same_rules_and_handles_cookie(self):
        server = create_server('127.0.0.1', 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        self.addCleanup(thread.join, 2); self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        base=f'http://127.0.0.1:{server.server_port}'
        def post(path, origin):
            request=urllib.request.Request(base+path, data=b'{}', headers={'Origin':origin,'Content-Type':'application/json','Authorization':'Bearer '+self.token}, method='POST')
            return urllib.request.urlopen(request, timeout=5)
        with self.assertRaises(urllib.error.HTTPError) as failure: post('/api/session/remember','http://evil.example')
        self.assertEqual(failure.exception.code,403)
        with post('/api/session/remember',base) as response:
            cookie=response.headers['Set-Cookie'].split(';',1)[0]
        request=urllib.request.Request(base+'/api/session/restore',headers={'Cookie':cookie})
        with urllib.request.urlopen(request,timeout=5) as response:
            self.assertEqual(json.load(response)['account']['username'],'operator')
        with post('/api/session/logout',base) as response:
            self.assertIn('Max-Age=0',response.headers['Set-Cookie'])
