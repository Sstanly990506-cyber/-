"""Regression coverage for complete data, financial gates and durable revocation."""
import copy
import io
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

from api import line_bot, records, service, storage, trip_optimizer
from api.assistant_tickets import issue, verify


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.user = {'id':'finance-id','username':'finance-fixture','role':'finance','allowedViews':['financeView'], 'password':'fixture-hash', 'sessionVersion':'initial'}
        self.users = [self.user]
        p = patch('api.storage.read_users', side_effect=lambda:copy.deepcopy(self.users));p.start();self.addCleanup(p.stop)
        p = patch('api.storage.read_secret_hash', return_value='finance-fixture-hash');p.start();self.addCleanup(p.stop)

    def test_finance_api_requires_second_password_even_for_admin(self):
        for role in ('finance','admin'):
            self.user['role']=role
            token=storage.create_session_token(self.user)
            with self.assertRaises(service.ApiError) as caught:service.list_entity_payload(token,'receivables')
            self.assertEqual(caught.exception.status,403)
            self.assertTrue(caught.exception.payload['financeLocked'])
            with self.assertRaises(service.ApiError):service.finance_data_payload(token)
            with patch('api.service.verify_finance_module_password', return_value=False):
                with self.assertRaises(service.ApiError):service.user_action_payload(token,{'action':'verify_finance_password','password':'wrong'})

    def test_finance_only_account_can_read_statement_dependencies_but_not_write_them(self):
        token=storage.create_session_token(self.user)
        self.assertFalse(service.account_can_read_entity(storage.verify_session_token(token),'orders'))
        with patch('api.service.verify_finance_module_password',return_value=True):
            unlocked=service.user_action_payload(token,{'action':'verify_finance_password','password':'correct'})
        account=storage.verify_session_token(unlocked['token'])
        row={'id':'o1','billingCustomer':'甲公司','totalPrice':123,'actualCost':40}
        with patch('api.service.list_records',return_value={'items':[row]}):
            self.assertEqual(service.list_entity_payload(unlocked['token'],'orders')['items'][0]['totalPrice'],123)
        with self.assertRaises(service.ApiError):service.upsert_entity_payload(unlocked['token'],'orders','o1',row)
        with patch('api.service._all_records',return_value=[row]):
            self.assertEqual(len(service.finance_data_payload(unlocked['token'])['records']['orders']),1)
        with patch('api.storage.time.time',return_value=unlocked['financeUntil']+1):
            with self.assertRaises(service.ApiError):service.finance_data_payload(unlocked['token'])
        with patch('api.storage.read_secret_hash',return_value='new-finance-password-hash'):
            with self.assertRaises(service.ApiError):service.finance_data_payload(unlocked['token'])

    def test_every_data_path_hides_locked_finance(self):
        token=storage.create_session_token(self.user)
        account=storage.verify_session_token(token)
        source={**storage.DEFAULT_APP_STATE,'receivables':[{'amount':9}],'payables':[{'amount':8}]}
        self.assertEqual(service.filter_state_for_account(source,account)['receivables'],[])
        self.assertEqual(service.merge_state_for_account(source,{'receivables':[]},account)['receivables'],source['receivables'])
        self.assertNotIn('receivables',service.bootstrap_entities_for_account(account))
        with patch('api.service.changes_since',return_value={'changes':[{'entity':'receivables','id':'r'}]}):
            self.assertEqual(service.changes_payload(token)['changes'],[])
        with self.assertRaises(service.ApiError):service.report_payload(token)

    def test_deleted_password_and_permission_changes_revoke_sessions(self):
        original=copy.deepcopy(self.user)
        for field,value in [('password','changed'),('role','viewer'),('allowedViews',[])]:
            self.user.clear();self.user.update(original)
            token=storage.create_session_token(self.user)
            self.user[field]=value
            self.assertIsNone(storage.verify_session_token(token))
        self.user.clear();self.user.update(original)
        token=storage.create_session_token(self.user)
        self.users.clear()
        self.assertIsNone(storage.verify_session_token(token))

    def test_permission_change_rotates_epoch_even_if_permissions_are_restored(self):
        token=storage.create_session_token(self.user)
        changed=copy.deepcopy(self.user);changed['allowedViews']=[]
        with patch('api.storage.ensure_storage'),patch('api.storage.DATABASE_URL',''),patch('api.storage.write_users_local_file') as write:
            storage.write_users([changed]);self.users[:]=copy.deepcopy(write.call_args.args[0])
            restored=copy.deepcopy(self.users[0]);restored['allowedViews']=['financeView']
            storage.write_users([restored]);self.users[:]=copy.deepcopy(write.call_args.args[0])
        self.assertIsNone(storage.verify_session_token(token))

    def test_companion_ticket_is_revoked_with_admin_permissions(self):
        self.user['role']='admin'
        token=storage.create_session_token(self.user);ticket=issue(token)
        self.assertEqual(verify(ticket)['role'],'admin')
        self.user['sessionVersion']='new-epoch'
        with self.assertRaises(service.ApiError):verify(ticket)

    def test_flask_transport_enforces_finance_gate(self):
        try:from api_server import app
        except ImportError:self.skipTest('Flask unavailable')
        token=storage.create_session_token(self.user)
        result=app.test_client().get('/api/finance/data',headers={'Authorization':'Bearer '+token})
        self.assertEqual(result.status_code,403)
        self.assertTrue(result.json['financeLocked'])


class CompleteDataTests(unittest.TestCase):
    def pages(self,entity,page=1,page_size=500,query=''):
        rows=[{'id':str(i),'status':'未完成','orderNumber':'WO-'+str(i),'amount':10,'received':0} for i in range(603)]
        return {'items':rows[(page-1)*page_size:page*page_size],'pages':2,'total':603}

    def test_report_reader_and_line_totals_read_later_pages(self):
        with patch('api.service.list_records',side_effect=self.pages):self.assertEqual(len(service._all_records('orders')),603)
        with patch('api.line_bot.list_records',side_effect=self.pages):
            self.assertIn('603 筆',line_bot._reply_pending_orders())
            self.assertIn('NT$ 6,030',line_bot._reply_receivables())
            context=line_bot._collect_website_context(['receivables'])['receivables']
            self.assertEqual(context['totalMatched'],603)
            self.assertEqual(context['aggregate']['outstanding'],6030)
            self.assertTrue(context['truncated'])

    def test_later_page_failure_never_yields_a_partial_report(self):
        def fail(entity,page=1,page_size=500,query=''):
            if page==2:raise RuntimeError('fixture read failure')
            return self.pages(entity,page,page_size,query)
        with patch('api.service.list_records',side_effect=fail):
            with self.assertRaises(RuntimeError):service._all_records('orders')

    def test_atomic_order_save_failure_preserves_original_order_and_audit(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch('api.records.RECORDS_PATH',Path(directory)/'records.json'),patch('api.records.RECORD_STORAGE_READY',True),patch('api.storage.DATABASE_URL',''),patch('api.storage.ensure_storage'),patch('api.service.verify_session_token',return_value={'username':'ops-fixture','role':'ops'}):
                records.upsert_record('orders','o1',{'id':'o1','orderNumber':'WO-1','status':'未完成','totalPrice':100})
                with patch('api.records._write_local',side_effect=OSError('fixture failure')):
                    with self.assertRaises(OSError):service.upsert_entity_payload('token','orders','o1',{'status':'已完成','totalPrice':150,'_expectedVersion':records.get_record('orders','o1')['_updatedAt']})
                self.assertEqual(records.get_record('orders','o1')['totalPrice'],100)
                self.assertEqual(records.all_records('audits'),[])
                self.assertEqual(records.all_records('receivables'),[])

    def test_operator_order_change_persists_server_audit_and_receivable(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch('api.records.RECORDS_PATH',Path(directory)/'records.json'),patch('api.records.RECORD_STORAGE_READY',True),patch('api.storage.DATABASE_URL',''),patch('api.storage.ensure_storage'),patch('api.service.verify_session_token',return_value={'username':'ops-fixture','role':'ops'}):
                records.upsert_record('orders','o1',{'id':'o1','orderNumber':'WO-1','status':'未完成','totalPrice':100,'actualCost':None})
                service.upsert_entity_payload('token','orders','o1',{'status':'已完成','totalPrice':150,'actualCost':40,'_expectedVersion':records.get_record('orders','o1')['_updatedAt']})
                audits=records.all_records('audits')
                self.assertEqual({row['field'] for row in audits},{'總價','狀態','實際成本'})
                self.assertTrue(all(row['id'] and row['user']=='ops-fixture' for row in audits))
                receivable=records.all_records('receivables')[0]
                self.assertEqual(receivable['amount'],150)
                records.upsert_record('receivables',receivable['id'],{**receivable,'received':30})
                service.upsert_entity_payload('token','orders','o1',{'orderNumber':'WO-RENAMED','_expectedVersion':records.get_record('orders','o1')['_updatedAt']})
                self.assertEqual(len(records.all_records('receivables')),1)
                self.assertEqual(records.all_records('receivables')[0]['received'],30)
                self.assertEqual(records.all_records('receivables')[0]['orderNumber'],'WO-RENAMED')


class TripTests(unittest.TestCase):
    factory={'id':'factory','address':'新北市中和區立言街53號'}
    stops=[{'id':'p','address':'台北市中正區重慶南路一段122號','type':'pickup'}, {'id':'d','address':'台北市信義區市府路1號','type':'delivery'}]

    def test_no_key_returns_addresses_and_unknown_metrics(self):
        with patch.dict('os.environ',{'GOOGLE_MAPS_API_KEY':''}),patch('api.trip_optimizer.urlopen') as fetch:
            result=trip_optimizer.optimize_trip({'factory':self.factory,'stops':self.stops})
        fetch.assert_not_called()
        self.assertEqual(result['routeMode'],'address-only')
        self.assertIsNone(result['bestRoute']['totalDistanceM'])
        self.assertIsNone(result['bestRoute']['totalDurationSec'])
        self.assertEqual([point['id'] for point in result['bestRoute']['orderedStops']],['factory','d','p','factory'])
        self.assertEqual(parse_qs(urlparse(result['googleMapsUrl']).query)['origin'][0],self.factory['address'])

    def test_provider_road_values_are_used_instead_of_straight_lines(self):
        matrix=[[(0,0),(20,200),(10,100)],[(30,300),(0,0),(40,400)],[(50,500),(60,600),(0,0)]]
        with patch.dict('os.environ',{'GOOGLE_MAPS_API_KEY':'fixture'}),patch('api.trip_optimizer.road_matrix',return_value=matrix) as provider:
            result=trip_optimizer.optimize_trip({'factory':self.factory,'stops':self.stops})
        provider.assert_called_once_with([self.factory['address'],*[stop['address'] for stop in self.stops]],'fixture')
        self.assertEqual(result['bestRoute']['totalDistanceM'],1000)
        self.assertEqual(result['bestRoute']['totalDurationSec'],100)
        self.assertEqual(result['routeMode'],'road')

    def test_missing_address_excess_stops_and_manual_business_order_are_rejected(self):
        with patch.dict('os.environ',{'GOOGLE_MAPS_API_KEY':''}):
            for stops in ([{**self.stops[0],'address':''}],self.stops*13):
                with self.assertRaises(ValueError):trip_optimizer.optimize_trip({'factory':self.factory,'stops':stops})
            with self.assertRaises(ValueError):trip_optimizer.optimize_trip({'factory':self.factory,'stops':self.stops,'preserveOrder':True})

    def test_provider_errors_do_not_leak_keys_or_fake_metrics(self):
        with patch('api.trip_optimizer.urlopen',side_effect=RuntimeError('fixture-secret')):
            with self.assertRaises(ValueError) as caught:trip_optimizer.road_matrix(['address'],'fixture-secret')
        self.assertNotIn('fixture-secret',str(caught.exception))

    def test_routes_api_parser_and_address_request(self):
        elements=[
            {'condition':'ROUTE_EXISTS'},
            {'originIndex':0,'destinationIndex':1,'condition':'ROUTE_EXISTS','distanceMeters':120,'duration':'12s'},
            {'originIndex':1,'destinationIndex':0,'condition':'ROUTE_EXISTS','distanceMeters':140,'duration':'14.5s'},
            {'originIndex':1,'destinationIndex':1,'condition':'ROUTE_EXISTS'},
        ]
        with patch('api.trip_optimizer.urlopen',return_value=io.BytesIO(json.dumps(elements).encode())) as fetch:
            matrix=trip_optimizer.road_matrix(['地址甲','地址乙'],'fixture-key')
        self.assertEqual(matrix[1][0],(14.5,140))
        self.assertEqual(matrix[0][0],(0,0))
        request=fetch.call_args.args[0]
        self.assertEqual(request.full_url,'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix')
        self.assertEqual(json.loads(request.data)['origins'][0]['waypoint']['address'],'地址甲')
        self.assertEqual(request.get_method(),'POST')
        with patch('api.trip_optimizer.urlopen',return_value=io.BytesIO(b'[]')):
            with self.assertRaises(ValueError):trip_optimizer.road_matrix(['address'],'fixture')

    def test_large_trip_maps_links_cover_every_leg(self):
        stops=[{'id':str(i),'address':f'真實地址{i}','type':'delivery'} for i in range(24)]
        with patch.dict('os.environ',{'GOOGLE_MAPS_API_KEY':''}):
            result=trip_optimizer.optimize_trip({'factory':self.factory,'stops':stops})
        self.assertIsNone(result['googleMapsUrl'])
        links=result['googleMapsUrls']
        self.assertEqual(len(links),3)
        decoded=[parse_qs(urlparse(link).query) for link in links]
        for left,right in zip(decoded,decoded[1:]):self.assertEqual(left['destination'],right['origin'])
        self.assertEqual(decoded[-1]['destination'],[self.factory['address']])
