"""Run against an explicitly configured disposable PostgreSQL database in CI."""
import copy
import os
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from unittest.mock import patch

from api import local_ai_records, records, service, storage


@unittest.skipUnless(os.environ.get('AUDIT_TEST_DATABASE_URL'), 'disposable PostgreSQL not configured')
class PostgresAuditTests(unittest.TestCase):
    def setUp(self):
        self.schema = 'audit_' + uuid.uuid4().hex
        source = os.environ['AUDIT_TEST_DATABASE_URL']
        parsed = urlparse(source)
        params = dict(parse_qsl(parsed.query)); params['options'] = f'-csearch_path={self.schema}'
        self.url = urlunparse(parsed._replace(query=urlencode(params)))
        with storage.connect(source) as conn:conn.execute(f'CREATE SCHEMA {self.schema}')
        def cleanup():
            with storage.connect(source) as conn:conn.execute(f'DROP SCHEMA {self.schema} CASCADE')
        self.addCleanup(cleanup)
        for target, name, value in (
            (storage,'DATABASE_URL',self.url), (storage,'STORAGE_READY',True),
            (records,'RECORD_STORAGE_READY',True),
            (service,'verify_session_token',lambda token: {'username':'fixture','role':'admin'}),
        ):
            p=patch.object(target,name,value);p.start();self.addCleanup(p.stop)
        with storage.get_db_connection() as conn:
            conn.execute('''CREATE TABLE app_records(entity TEXT NOT NULL,record_id TEXT NOT NULL,data_json JSONB NOT NULL,updated_at BIGINT NOT NULL,deleted BOOLEAN NOT NULL DEFAULT FALSE,PRIMARY KEY(entity,record_id))''')
            conn.execute('CREATE TABLE app_state(id INTEGER PRIMARY KEY,state_json JSONB NOT NULL,updated_at BIGINT NOT NULL)')
            conn.execute('INSERT INTO app_state VALUES(1,%s,1)',(storage.Jsonb({'settings':{'appTitle':'Original'}}),))

    def save(self, rid, number='WO-1', **changes):
        row={'id':rid,'orderNumber':number,'status':'已完成','totalPrice':1000,**changes}
        return service.upsert_entity_payload('fixture','orders',rid,row)

    def test_simultaneous_duplicate_numbers_cannot_both_commit(self):
        barrier=threading.Barrier(2); original=service.get_record
        def read(entity,rid):
            row=original(entity,rid)
            if entity=='orders':barrier.wait(timeout=10)
            return row
        def create(rid):
            try:self.save(rid);return 200
            except service.ApiError as err:return err.status
        with patch.object(service,'get_record',side_effect=read):
            with ThreadPoolExecutor(max_workers=2) as pool:statuses=list(pool.map(create,['a','b']))
        self.assertEqual(sorted(statuses),[200,409])
        self.assertEqual(len(records.all_records('receivables')),1)

    def test_stale_write_and_renumber_preserve_money(self):
        self.save('o1');stale=records.get_record('orders','o1')
        self.save('o1',totalPrice=1500,_expectedVersion=stale['_updatedAt'])
        with self.assertRaises(service.ApiError):service.upsert_entity_payload('fixture','orders','o1',stale)
        self.assertEqual(records.get_record('orders','o1')['totalPrice'],1500)
        receipt=records.all_records('receivables')[0]
        records.upsert_record('receivables',receipt['id'],{**receipt,'received':300})
        self.save('o1','WO-NEW',totalPrice=1500,_expectedVersion=records.get_record('orders','o1')['_updatedAt'])
        after=records.all_records('receivables')[0]
        self.assertEqual((after['orderId'],after['orderNumber'],after['received']),('o1','WO-NEW',300))

    def test_restore_sql_failure_rolls_back_and_valid_restore_commits_settings(self):
        self.save('original')
        backup=records.export_records();broken=copy.deepcopy(backup)
        broken['orders']=[{'id':'first','orderNumber':'FIRST'},{'id':'fail','orderNumber':'FAIL'}]
        with storage.get_db_connection() as conn:conn.execute("ALTER TABLE app_records ADD CONSTRAINT fixture_failure CHECK(record_id <> 'fail')")
        with self.assertRaises(storage.PsycopgError):records.restore_records(broken,{'settings':{'appTitle':'Bad'}})
        self.assertEqual(records.export_records(),backup)
        self.assertEqual(storage.read_state()['settings']['appTitle'],'Original')
        records.restore_records(backup,{'settings':{'appTitle':'Restored'}})
        self.assertEqual(storage.read_state()['settings']['appTitle'],'Restored')

    def test_dashboard_sql_counts_all_pages_and_only_unlocked_finance(self):
        records.write_record_batch([('orders',str(i),{'id':str(i),'status':'未完成' if i==0 or i>=100 else '已完成'}) for i in range(150)])
        records.upsert_record('inventory','film',{'stock':1,'safetyStock':10})
        records.upsert_record('receivables','r1',{'amount':100,'received':10})
        summary=service.dashboard_payload('fixture')['summary']
        self.assertEqual((summary['pendingOrders'],summary['lowInventory']),(51,1))
        self.assertNotIn('pendingReceivables',summary)
        with patch.object(service,'verify_session_token',return_value={'role':'finance','financeUntil':10**12}):
            self.assertEqual(service.dashboard_payload('fixture')['summary']['pendingReceivables'],1)

    def test_ai_note_and_browser_edit_use_consistent_lock_order(self):
        records.upsert_record('inventory','film',{'id':'film','stock':40,'note':'original'})
        stale=records.get_record('inventory','film')
        expected=local_ai_records.fingerprint(local_ai_records.inventory_snapshot('film'))
        ai_ready=threading.Event();browser_ready=threading.Event();release=threading.Event()
        fingerprint=local_ai_records.fingerprint;get_record=service.get_record
        def paused_fingerprint(value):
            ai_ready.set()
            if not release.wait(5):raise AssertionError('browser did not reach the write')
            return fingerprint(value)
        def read(entity,rid):
            row=get_record(entity,rid);browser_ready.set();return row
        def browser_edit():
            try:service.upsert_entity_payload('fixture','inventory','film',{**stale,'stock':50});return 200
            except service.ApiError as err:return err.status
        with patch.object(local_ai_records,'fingerprint',side_effect=paused_fingerprint),patch.object(service,'get_record',side_effect=read):
            with ThreadPoolExecutor(max_workers=2) as pool:
                ai=pool.submit(local_ai_records.update_inventory_note,'film',expected,'AI note','fixture')
                self.assertTrue(ai_ready.wait(5))
                browser=pool.submit(browser_edit)
                self.assertTrue(browser_ready.wait(5));release.set()
                self.assertTrue(ai.result(timeout=10)['ok'])
                self.assertEqual(browser.result(timeout=10),409)
        self.assertEqual(records.get_record('inventory','film')['note'],'AI note')
