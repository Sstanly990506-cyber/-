import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
from api import storage

class AccountConcurrencyTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        for name,value in [('DATABASE_URL',''),('DATA_DIR',Path(temp.name)),('LOCAL_USERS_PATH',Path(temp.name)/'users.json'),('ensure_storage',lambda:None)]:
            context=patch.object(storage,name,value);context.start();self.addCleanup(context.stop)
    def create(self,name):
        return storage.register_user(name,'password123',name,'viewer')
    def test_different_accounts_update_without_losing_other_edits(self):
        a,b=self.create('a'),self.create('b');barrier=threading.Barrier(2)
        def change(user):
            barrier.wait()
            return storage.update_user_permissions(user['id'],'','ops',['ordersView'],user['accountVersion'])
        with ThreadPoolExecutor(max_workers=2) as pool:result=list(pool.map(change,[a,b]))
        self.assertEqual([x['role'] for x in result],['ops','ops'])
        self.assertEqual([x['role'] for x in storage.read_users()],['ops','ops'])
    def test_simultaneous_edits_same_account_only_one_succeeds(self):
        user=self.create('a');barrier=threading.Barrier(2)
        def change(role):
            barrier.wait()
            try:return storage.update_user_permissions(user['id'],'',role,['ordersView'],user['accountVersion'])
            except storage.AccountConflict:return None
        with ThreadPoolExecutor(max_workers=2) as pool:result=list(pool.map(change,['ops','finance']))
        self.assertEqual(sum(x is not None for x in result),1)
    def test_new_account_and_permission_update_do_not_overwrite_each_other(self):
        user=self.create('a');barrier=threading.Barrier(2)
        def create():barrier.wait();return self.create('b')
        def change():barrier.wait();return storage.update_user_permissions(user['id'],'','ops',['ordersView'],user['accountVersion'])
        with ThreadPoolExecutor(max_workers=2) as pool:
            a=pool.submit(create);b=pool.submit(change);a.result();b.result()
        users=storage.read_users();self.assertEqual({x['username'] for x in users},{'a','b'})
        self.assertEqual(next(x['role'] for x in users if x['username']=='a'),'ops')
    def test_duplicate_names_are_atomic(self):
        barrier=threading.Barrier(2)
        def create(_):
            barrier.wait()
            try:return self.create('same')
            except ValueError:return None
        with ThreadPoolExecutor(max_workers=2) as pool:result=list(pool.map(create,range(2)))
        self.assertEqual(sum(x is not None for x in result),1)
        self.assertEqual(len(storage.read_users()),1)
    def test_old_or_missing_version_cannot_overwrite_newer_permissions(self):
        user=self.create('a')
        updated=storage.update_user_permissions(user['id'],'','ops',['ordersView'],user['accountVersion'])
        self.assertNotEqual(updated['accountVersion'],user['accountVersion'])
        for version in [user['accountVersion'],None]:
            with self.assertRaises(storage.AccountConflict):storage.update_user_permissions(user['id'],'','viewer',[],version)
        self.assertEqual(storage.read_users()[0]['role'],'ops')

import os
import uuid
from urllib.parse import quote

@unittest.skipUnless(os.getenv('ACCOUNT_TEST_DATABASE_URL'), 'disposable PostgreSQL not configured')
class PostgresAccountConcurrencyTests(AccountConcurrencyTests):
    def setUp(self):
        base=os.environ['ACCOUNT_TEST_DATABASE_URL']; schema='account_test_'+uuid.uuid4().hex
        with storage.connect(base) as conn:conn.execute(f'CREATE SCHEMA {schema}')
        self.addCleanup(self.cleanup_schema,base,schema)
        url=base+'&options='+quote('-csearch_path='+schema)
        for name,value in [('DATABASE_URL',url),('ensure_storage',lambda:None),('_db_pool',None),('_db_pool_url',None),('_db_pool_pid',None)]:
            context=patch.object(storage,name,value);context.start();self.addCleanup(context.stop)
        with storage.get_db_connection() as conn:
            conn.execute('''CREATE TABLE app_users (id TEXT PRIMARY KEY, username TEXT NOT NULL, username_key TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL, display_name TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL,
                source TEXT NOT NULL, allowed_views JSONB, session_version TEXT)''')
        self.addCleanup(lambda:storage._db_pool.close() if storage._db_pool else None)
    @staticmethod
    def cleanup_schema(base,schema):
        with storage.connect(base) as conn:conn.execute(f'DROP SCHEMA {schema} CASCADE')
