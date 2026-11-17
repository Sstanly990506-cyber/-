"""Exact authorized order lookup used to reconcile uncertain save outcomes."""
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from api import records, service, storage
from api.http_server import create_server
from api_server import app


class OrderLookupTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        for target, name, value in [
            (storage, 'DATABASE_URL', ''), (storage, 'DATA_DIR', Path(temp.name)),
            (storage, 'ensure_storage', lambda: None),
            (records, 'RECORDS_PATH', Path(temp.name) / 'records.json'),
            (records, 'RECORD_STORAGE_READY', True),
            (service, 'verify_session_token', lambda token: {'role':'ops','allowedViews':['ordersView']} if token=='allowed' else ({'role':'viewer','allowedViews':[]} if token=='denied' else None)),
        ]:
            item=patch.object(target,name,value);item.start();self.addCleanup(item.stop)
        records.upsert_record('orders','order-123',{'id':'order-123','orderNumber':'WO-1','itemName':'紙盒'})
        records.upsert_record('orders','other-id',{'id':'other-id','orderNumber':'order-123','itemName':'其他'})

    def test_exact_lookup_returns_version_without_searching_by_number(self):
        data=service.get_order_payload('allowed','order-123')
        self.assertEqual(data['item']['id'],'order-123')
        self.assertEqual(data['item']['itemName'],'紙盒')
        self.assertGreater(data['item']['_updatedAt'],0)
        with self.assertRaises(service.ApiError) as absent:service.get_order_payload('allowed','WO-1')
        self.assertEqual(absent.exception.status,404)

    def test_unauthenticated_and_unpermitted_users_cannot_read(self):
        for token,status in [('',401),('denied',403)]:
            with self.subTest(status=status), self.assertRaises(service.ApiError) as error:
                service.get_order_payload(token,'order-123')
            self.assertEqual(error.exception.status,status)

    @unittest.skipIf(app is None,'Flask unavailable')
    def test_flask_route_and_failure_responses_disable_caching(self):
        client=app.test_client()
        for path,token,status in [('/api/data/orders/order-123','allowed',200),('/api/data/orders/missing','allowed',404),('/api/data/orders/order-123','denied',403)]:
            response=client.get(path,headers={'Authorization':'Bearer '+token})
            self.assertEqual(response.status_code,status)
            self.assertEqual(response.headers.get('Cache-Control'),'no-store')
        self.assertEqual(client.get('/api/data/orders/order-123',headers={'Authorization':'Bearer allowed'}).json['item']['id'],'order-123')

    def test_builtin_http_route_matches_flask(self):
        server=create_server('127.0.0.1',0)
        worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
        try:
            url=f'http://127.0.0.1:{server.server_address[1]}/api/data/orders/order-123'
            req=urllib.request.Request(url,headers={'Authorization':'Bearer allowed'})
            with urllib.request.urlopen(req,timeout=3) as response:
                self.assertEqual(json.load(response)['item']['id'],'order-123')
                self.assertEqual(response.headers['Cache-Control'],'no-store')
        finally:
            server.shutdown();server.server_close();worker.join(3)
