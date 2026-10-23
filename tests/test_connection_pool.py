"""Connection reuse without sharing active transactions or delaying revocation."""
import os
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock, patch

from api import storage


class PoolConfigurationTests(unittest.TestCase):
    def setUp(self):
        for name, value in [('_db_pool', None), ('_db_pool_url', None), ('_db_pool_pid', None),
                            ('DATABASE_URL', 'postgresql://db.example/test')]:
            item = patch.object(storage, name, value)
            item.start()
            self.addCleanup(item.stop)

    def test_warm_requests_share_a_bounded_pool_and_check_connections_before_use(self):
        factory = Mock()
        with patch.object(storage, 'ConnectionPool', factory):
            storage.get_db_connection()
            storage.get_db_connection()
        factory.assert_called_once()
        config = factory.call_args.kwargs
        self.assertEqual(config['max_size'], 4)
        self.assertEqual(config['min_size'], 0)
        self.assertIs(config['check'], factory.check_connection)
        self.assertEqual(config['max_idle'], 60)
        self.assertEqual(factory.return_value.connection.call_count, 2)

    def test_parallel_requests_initialize_only_one_pool(self):
        factory = Mock()
        with patch.object(storage, 'ConnectionPool', factory):
            with ThreadPoolExecutor(max_workers=12) as executor:
                list(executor.map(lambda _: storage.get_db_connection(), range(30)))
        factory.assert_called_once()

    def test_changing_database_closes_the_previous_pool(self):
        factory = Mock()
        with patch.object(storage, 'ConnectionPool', factory):
            storage.get_db_connection()
            storage.DATABASE_URL = 'postgresql://different.example/test'
            storage.get_db_connection()
        self.assertEqual(factory.call_count, 2)
        factory.return_value.close.assert_called_once()

    def test_local_installations_without_pool_dependency_keep_direct_connections(self):
        with patch.object(storage, 'ConnectionPool', None), patch.object(storage, 'connect') as connect:
            storage.get_db_connection()
        connect.assert_called_once()


@unittest.skipUnless(os.environ.get('AUDIT_TEST_DATABASE_URL'), 'disposable PostgreSQL not configured')
class PostgresPoolTests(unittest.TestCase):
    def setUp(self):
        for name, value in [('_db_pool', None), ('_db_pool_url', None), ('_db_pool_pid', None),
                            ('DATABASE_URL', os.environ['AUDIT_TEST_DATABASE_URL'])]:
            item = patch.object(storage, name, value)
            item.start()
            self.addCleanup(item.stop)
        self.addCleanup(lambda: storage._db_pool.close() if storage._db_pool else None)

    def test_reuses_a_connection_and_rolls_back_failed_work_before_reuse(self):
        with storage.get_db_connection() as conn:
            first_pid = conn.info.backend_pid
            conn.execute('CREATE TEMP TABLE pool_rollback_fixture (value INTEGER)')
        with self.assertRaisesRegex(RuntimeError, 'cancel'):
            with storage.get_db_connection() as conn:
                self.assertEqual(conn.info.backend_pid, first_pid)
                conn.execute('INSERT INTO pool_rollback_fixture VALUES (1)')
                raise RuntimeError('cancel')
        with storage.get_db_connection() as conn:
            self.assertEqual(conn.info.backend_pid, first_pid)
            self.assertEqual(conn.execute('SELECT COUNT(*) AS total FROM pool_rollback_fixture').fetchone()['total'], 0)

    def test_parallel_requests_have_exclusive_connections(self):
        active = set()
        guard = threading.Lock()

        def read(_):
            with storage.get_db_connection() as conn:
                pid = conn.info.backend_pid
                with guard:
                    self.assertNotIn(pid, active)
                    active.add(pid)
                try:
                    conn.execute('SELECT pg_sleep(0.03)')
                finally:
                    with guard:
                        active.remove(pid)

        with ThreadPoolExecutor(max_workers=8) as executor:
            list(executor.map(read, range(16)))
        self.assertLessEqual(storage._db_pool.get_stats()['pool_size'], 4)

    def test_disconnected_idle_connection_is_replaced_before_next_request(self):
        with storage.get_db_connection() as conn:
            original_pid = conn.info.backend_pid
        with storage.connect(storage.DATABASE_URL) as admin:
            admin.execute('SELECT pg_terminate_backend(%s)', (original_pid,))
        with storage.get_db_connection() as conn:
            self.assertNotEqual(conn.info.backend_pid, original_pid)
            self.assertEqual(conn.execute('SELECT 1 AS value').fetchone()['value'], 1)
