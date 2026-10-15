"""Regression cases reproduced during the October operations audit."""
import copy
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from api import records, service, storage


class AuditFixTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='audit-fixes-')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        for target, name, value in (
            (storage, 'DATABASE_URL', ''), (storage, 'DATA_DIR', self.root),
            (storage, 'LOCAL_STATE_PATH', self.root / 'state.json'),
            (storage, 'ensure_storage', lambda: None),
            (records, 'RECORDS_PATH', self.root / 'records.json'),
            (records, 'RECORD_STORAGE_READY', True),
            (service, 'verify_session_token', lambda token: {'username':'fixture','role':'admin'}),
        ):
            p = patch.object(target, name, value); p.start(); self.addCleanup(p.stop)

    def order(self, record_id='o1', number='WO-1', amount=1000, **extra):
        return {'id':record_id,'orderNumber':number,'status':'已完成','totalPrice':amount,'note':'original',**extra}

    def save(self, row):
        return service.upsert_entity_payload('fixture','orders',row['id'],row)

    def test_stale_snapshot_cannot_overwrite_price_or_receivable(self):
        self.save(self.order())
        first = records.get_record('orders','o1')
        stale = copy.deepcopy(first)
        first['totalPrice'] = 1500
        self.save(first)
        stale['note'] = 'only editing note'
        with self.assertRaises(service.ApiError) as caught:self.save(stale)
        self.assertEqual(caught.exception.status,409)
        self.assertEqual(records.get_record('orders','o1')['totalPrice'],1500)
        self.assertEqual(records.all_records('receivables')[0]['amount'],1500)

    def test_same_millisecond_write_changes_version(self):
        with patch.object(records,'_now',return_value=100):
            self.save(self.order())
            first = records.get_record('orders','o1')
            second = self.save({**first,'note':'next'})
        self.assertGreater(second['updatedAt'],first['_updatedAt'])

    def test_an_old_browser_without_a_version_cannot_overwrite_existing_data(self):
        self.save(self.order())
        with self.assertRaises(service.ApiError) as caught:self.save(self.order(amount=1))
        self.assertEqual(caught.exception.status,409)
        self.assertEqual(records.get_record('orders','o1')['totalPrice'],1000)

    def test_concurrent_duplicate_number_only_creates_one_receivable(self):
        barrier = threading.Barrier(2)
        original = service.get_record
        def simultaneous_read(entity, record_id):
            value = original(entity, record_id)
            if entity == 'orders':barrier.wait(timeout=5)
            return value
        def create(record_id):
            try:
                self.save(self.order(record_id=record_id)); return 200
            except service.ApiError as err:return err.status
        with patch.object(service,'get_record',side_effect=simultaneous_read):
            with ThreadPoolExecutor(max_workers=2) as pool:statuses=list(pool.map(create,['o1','o2']))
        self.assertEqual(sorted(statuses),[200,409])
        self.assertEqual(len(records.all_records('orders')),1)
        self.assertEqual(len(records.all_records('receivables')),1)

    def test_whitespace_does_not_bypass_order_number_uniqueness(self):
        self.save(self.order())
        with self.assertRaises(service.ApiError) as caught:self.save(self.order('other','\tWO-1\n'))
        self.assertEqual(caught.exception.status,409)
        self.assertEqual(len(records.all_records('receivables')),1)

    def test_legacy_receivable_keeps_paid_money_when_number_changes(self):
        records.upsert_record('orders','o1',self.order())
        records.upsert_record('receivables','legacy',{'id':'legacy','source':'auto-order','orderNumber':'WO-1','amount':1000,'received':300})
        self.save({**records.get_record('orders','o1'),'orderNumber':'WO-RENAMED'})
        rows = records.all_records('receivables')
        self.assertEqual(len(rows),1)
        self.assertEqual((rows[0]['id'],rows[0]['orderId'],rows[0]['orderNumber'],rows[0]['received']),('legacy','o1','WO-RENAMED',300))

    def test_old_duplicate_numbers_do_not_delete_other_orders_receivable(self):
        for record_id in ['o1','o2']:records.upsert_record('orders',record_id,self.order(record_id))
        for record_id in ['o1','o2']:
            records.upsert_record('receivables',record_id,{'id':record_id,'source':'auto-order','orderId':record_id,'orderNumber':'WO-1','amount':1000})
        service.delete_entity_payload('fixture','orders','o1')
        self.assertEqual([row['orderId'] for row in records.all_records('receivables')],['o2'])

    def test_malformed_restore_preserves_original_records_and_settings(self):
        self.save(self.order())
        storage.write_local_state_file({'syncTick':1,'settings':{'appTitle':'Original'}})
        before = records.RECORDS_PATH.read_bytes()
        state_before = storage.LOCAL_STATE_PATH.read_bytes()
        for bad in ['wrong-type',[42],[{'id':'same'},{'id':'same'}]]:
            backup = records.export_records(); backup['orders'] = bad
            with self.assertRaises(service.ApiError):
                service.restore_backup_payload('fixture',{'confirm':'還原備份','backup':{'records':backup,'settings':{'appTitle':'Changed'}}})
            self.assertEqual(records.RECORDS_PATH.read_bytes(),before)
            self.assertEqual(storage.LOCAL_STATE_PATH.read_bytes(),state_before)

    def test_restore_storage_failure_rolls_back_settings_and_records(self):
        self.save(self.order())
        storage.write_local_state_file({'syncTick':1,'settings':{'appTitle':'Original'}})
        before = records.RECORDS_PATH.read_bytes()
        state_before = storage.LOCAL_STATE_PATH.read_bytes()
        backup = records.export_records(); backup['orders'] = [self.order('other','WO-OTHER')]
        with patch.object(records,'_write_local',side_effect=OSError('fixture disk failure')):
            with self.assertRaises(OSError):records.restore_records(backup,{'settings':{'appTitle':'Changed'}})
        self.assertEqual(records.RECORDS_PATH.read_bytes(),before)
        self.assertEqual(storage.LOCAL_STATE_PATH.read_bytes(),state_before)

    def test_dashboard_counts_all_pages_and_excludes_finished_sent_cancelled(self):
        with patch.object(records,'_now',return_value=100):
            for index in range(150):records.upsert_record('orders',str(index),self.order(str(index),f'WO-{index}',status='未完成' if index == 0 or index >= 100 else '已完成'))
        for status in ['已送出','已取消']:records.upsert_record('orders',status,self.order(status,status,status=status))
        self.assertEqual(service.dashboard_payload('fixture')['summary']['pendingOrders'],51)
        service.list_entity_payload('fixture','orders',page=2)
        self.assertEqual(service.dashboard_payload('fixture')['summary']['pendingOrders'],51)

    def test_dashboard_does_not_expose_locked_finance_or_driver_money(self):
        with patch.object(service,'verify_session_token',return_value={'role':'finance'}):
            summary = service.dashboard_payload('fixture')['summary']
            self.assertTrue(summary['financeLocked'])
            self.assertNotIn('pendingReceivables',summary)
        with patch.object(service,'verify_session_token',return_value={'role':'driver'}):
            summary = service.dashboard_payload('fixture')['summary']
            self.assertNotIn('pendingReceivables',summary)
            self.assertNotIn('lowInventory',summary)

    def test_trip_save_uses_same_stable_receivable_and_atomic_audit(self):
        self.save(self.order(status='未完成'))
        result = service.execute_trip_payload('fixture',{'orderIds':['o1']})
        self.assertEqual(result['updated'],1)
        self.assertEqual(records.all_records('receivables')[0]['orderId'],'o1')
        self.assertEqual(records.all_records('audits')[0]['after'],'已送出')


if __name__ == '__main__':unittest.main()
