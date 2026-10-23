import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from api import presence, service, storage

class PresenceTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        for target,name,value in [(storage,'DATABASE_URL',''),(storage,'DATA_DIR',Path(temp.name)),(storage,'ensure_storage',lambda:None),
            (service,'verify_session_token',lambda token: {'id':token,'username':token,'display':'Name '+token,'role':'ops'} if token else None)]:
            item=patch.object(target,name,value);item.start();self.addCleanup(item.stop)
    def send(self,token='A',client='client-1111',**values):
        return presence.presence_payload(token,{'clientId':client,'active':True,**values})
    def test_two_users_and_two_tabs_of_same_user_are_distinct(self):
        self.send();second=self.send('B','client-2222',orderId='o1',field='sheetCount',editing=True,cursor={'kind':'field','id':'sheetCount','x':.5,'y':.3})
        self.assertEqual(len(second['peers']),1)
        third=self.send('A','client-3333');self.assertEqual(len(third['peers']),2)
        data=self.send()['peers'];self.assertEqual({peer['clientId'] for peer in data},{'client-2222','client-3333'})
        self.assertEqual(next(peer for peer in data if peer['clientId']=='client-2222')['fieldLabel'],'張數')
    def test_identity_cannot_be_spoofed_and_presences_expire(self):
        with patch.object(presence.time,'time',return_value=1000):self.send(name='Fake')
        with patch.object(presence.time,'time',return_value=1001):
            self.assertEqual(self.send('B','client-2222')['peers'][0]['name'],'Name A')
        with patch.object(presence.time,'time',return_value=1017):self.assertEqual(self.send('B','client-2222')['peers'],[])
    def test_leaving_removes_only_own_presence(self):
        self.send();self.send('B','client-2222');self.send(active=False)
        self.assertEqual(self.send('B','client-2222')['peers'],[])
    def test_authentication_and_module_permission_are_required(self):
        with self.assertRaises(service.ApiError) as caught:self.send('')
        self.assertEqual(caught.exception.status,401)
        with patch.object(service,'verify_session_token',return_value={'role':'viewer'}):
            with self.assertRaises(service.ApiError) as caught:self.send()
        self.assertEqual(caught.exception.status,403)
    def test_malformed_cursor_and_unknown_fields_are_rejected(self):
        for values in [{'field':[]},{'field':'password'},{'cursor':{'kind':'field','id':'password','x':.5,'y':.5}},
            {'cursor':{'kind':'row','id':'o1','x':2,'y':0}},{'cursor':{'kind':'row','id':'o1','x':float('nan'),'y':0}}]:
            with self.subTest(values=values):
                with self.assertRaises(service.ApiError) as caught:self.send(**values)
                self.assertEqual(caught.exception.status,400)
    def test_presence_does_not_write_orders_or_audit_records(self):
        self.send();self.assertTrue((storage.DATA_DIR/'presence.json').exists());self.assertFalse((storage.DATA_DIR/'records.json').exists())
    def test_http_route_is_connected(self):
        from api_server import app
        if app is None:self.skipTest('Flask unavailable')
        result=app.test_client().post('/api/presence',json={'clientId':'client-1111','active':True},headers={'Authorization':'Bearer A'})
        self.assertEqual(result.status_code,200);self.assertEqual(result.json['peers'],[])
