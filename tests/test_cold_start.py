import os
import threading
import unittest
import uuid
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from unittest.mock import patch

from api import storage


class InitializationLockTests(unittest.TestCase):
    def setUp(self):
        for name, value in [('DATABASE_URL', ''), ('STORAGE_READY', False), ('STORAGE_INITIALIZING', False), ('STORAGE_INIT_LOCK', threading.RLock())]:
            patcher = patch.object(storage, name, value)
            patcher.start(); self.addCleanup(patcher.stop)

    def test_other_request_waits_for_initialization_and_nested_calls_do_not_deadlock(self):
        started, release, second_done = threading.Event(), threading.Event(), threading.Event()
        calls = []
        def setup():
            calls.append('setup')
            storage.ensure_storage()  # Reentrant helper in the initializing thread.
            started.set()
            if not release.wait(3): raise RuntimeError('test timed out')
        with patch.object(storage, 'ensure_local_storage', side_effect=setup), \
             patch.object(storage, 'migrate_legacy_users_once', side_effect=lambda: calls.append('migrate')), \
             patch.object(storage, 'ensure_builtin_users', side_effect=lambda: calls.append('users')):
            first = threading.Thread(target=storage.ensure_storage)
            second = threading.Thread(target=lambda: (storage.ensure_storage(), second_done.set()))
            first.start(); self.assertTrue(started.wait(2)); second.start()
            self.assertFalse(second_done.wait(.1))
            release.set(); first.join(2); second.join(2)
            self.assertFalse(first.is_alive()); self.assertFalse(second.is_alive())
            self.assertTrue(second_done.is_set())
        self.assertEqual(calls, ['setup', 'migrate', 'users'])
        self.assertTrue(storage.STORAGE_READY)

    def test_failed_initialization_releases_lock_and_a_later_request_retries(self):
        with patch.object(storage, 'ensure_local_storage', side_effect=[RuntimeError('offline'), None]) as setup, \
             patch.object(storage, 'migrate_legacy_users_once'), patch.object(storage, 'ensure_builtin_users'):
            with self.assertRaisesRegex(RuntimeError, 'offline'): storage.ensure_storage()
            self.assertFalse(storage.STORAGE_READY)
            self.assertFalse(storage.STORAGE_INITIALIZING)
            storage.ensure_storage()
        self.assertEqual(setup.call_count, 2)
        self.assertTrue(storage.STORAGE_READY)


@unittest.skipUnless(os.environ.get('COLD_START_TEST_DATABASE_URL'), 'disposable PostgreSQL not configured')
class PostgresSchemaTests(unittest.TestCase):
    def setUp(self):
        self.source = os.environ['COLD_START_TEST_DATABASE_URL']
        self.schema = 'cold_' + uuid.uuid4().hex
        with storage.connect(self.source) as conn: conn.execute(f'CREATE SCHEMA {self.schema}')
        parsed = urlparse(self.source)
        query = dict(parse_qsl(parsed.query, keep_blank_values=True)); query['options'] = f'-csearch_path={self.schema}'
        self.url = urlunparse(parsed._replace(query=urlencode(query)))
        for name, value in [('DATABASE_URL', self.url), ('DB_INITIALIZED', False), ('DB_INIT_LOCK', threading.Lock()), ('_db_pool', None), ('_db_pool_url', None), ('_db_pool_pid', None)]:
            patcher = patch.object(storage, name, value); patcher.start(); self.addCleanup(patcher.stop)
        self.addCleanup(self.cleanup_db)

    def cleanup_db(self):
        if storage._db_pool: storage._db_pool.close()
        with storage.connect(self.source) as conn: conn.execute(f'DROP SCHEMA {self.schema} CASCADE')

    def test_initializes_new_database_and_rechecks_idempotently(self):
        storage.ensure_postgres_storage()
        storage.DB_INITIALIZED = False
        storage.ensure_postgres_storage()
        with storage.get_db_connection() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) AS n FROM app_state').fetchone()['n'], 1)
            columns = {row['column_name'] for row in conn.execute("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'app_users'")}
            self.assertTrue({'allowed_views','session_version'} <= columns)
            self.assertIsNotNone(conn.execute("SELECT to_regclass('app_secrets') AS t").fetchone()['t'])

    def test_old_schema_is_migrated_without_replacing_existing_state_or_accounts(self):
        with storage.connect(self.url) as conn:
            conn.execute('CREATE TABLE app_state (id SMALLINT PRIMARY KEY CHECK (id=1), state_json JSONB NOT NULL, updated_at BIGINT NOT NULL)')
            conn.execute('INSERT INTO app_state VALUES (1, %s, 37)', (storage.Jsonb({'settings': {'appTitle': 'retained'}}),))
            conn.execute('''CREATE TABLE app_users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, username_key TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, source TEXT NOT NULL)''')
            conn.execute("INSERT INTO app_users VALUES ('1','alice','alice','hash','Alice','ops','now','test')")
        storage.ensure_postgres_storage()
        with storage.get_db_connection() as conn:
            state = conn.execute('SELECT state_json, updated_at FROM app_state').fetchone()
            self.assertEqual(state['state_json']['settings']['appTitle'], 'retained')
            self.assertEqual(state['updated_at'], 37)
            user = conn.execute('SELECT username, allowed_views, session_version FROM app_users').fetchone()
            self.assertEqual(user['username'], 'alice')
            self.assertIsNone(user['allowed_views'])
            self.assertEqual(user['session_version'], '')
