import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class StaticStructureTests(unittest.TestCase):
    def test_health_uses_shared_service(self):
        flask_server = (ROOT / 'api_server.py').read_text(encoding='utf-8')
        builtin_server = (ROOT / 'api' / 'http_server.py').read_text(encoding='utf-8')
        self.assertIn('from api.service import', flask_server)
        self.assertIn('from api.service import', builtin_server)

    def test_environment_details_are_not_exposed_by_health_route(self):
        service = (ROOT / 'api' / 'service.py').read_text(encoding='utf-8')
        self.assertNotIn('get_environment_status', service)

    def test_configurable_text_is_sanitized(self):
        shared = (ROOT / 'js' / 'shared.js').read_text(encoding='utf-8')
        self.assertIn('sanitizePlainText', shared)
        self.assertIn('merged.moduleLabels = sanitizeMap', shared)
        self.assertIn('merged.moduleIcons = sanitizeMap', shared)

    def test_large_view_is_outside_index(self):
        index = (ROOT / 'index.html').read_text(encoding='utf-8')
        view = (ROOT / 'views' / 'app-shell.html').read_text(encoding='utf-8')
        loader = (ROOT / 'js' / 'view-loader.js').read_text(encoding='utf-8')
        self.assertNotIn('ordersView', index)
        self.assertIn('ordersView', view)
        self.assertIn("fetch('views/app-shell.html'", loader)
        self.assertNotIn('innerHTML', loader)

    def test_scalable_data_routes_exist_in_both_servers(self):
        flask_server = (ROOT / 'api_server.py').read_text(encoding='utf-8')
        builtin_server = (ROOT / 'api' / 'http_server.py').read_text(encoding='utf-8')
        for route in ('/api/bootstrap', '/api/data/', '/api/changes', '/api/reports/summary'):
            self.assertIn(route, flask_server)
            self.assertIn(route, builtin_server)

    def test_document_analysis_route_exists_in_both_servers(self):
        flask_server = (ROOT / 'api_server.py').read_text(encoding='utf-8')
        builtin_server = (ROOT / 'api' / 'http_server.py').read_text(encoding='utf-8')
        self.assertIn('/api/documents/analyze', flask_server)
        self.assertIn('/api/documents/analyze', builtin_server)

    def test_frontend_uses_paged_incremental_storage(self):
        store = (ROOT / 'js' / 'store.js').read_text(encoding='utf-8')
        self.assertIn('pageSize=100', store)
        self.assertIn('/api/changes', store)
        self.assertIn("localStorage.setItem('uiSettings'", store)
        self.assertNotIn("localStorage.setItem('orders'", store)

    def test_admin_security_forms_are_present(self):
        view = (ROOT / 'views' / 'app-shell.html').read_text(encoding='utf-8')
        settings = (ROOT / 'js' / 'settings.js').read_text(encoding='utf-8')
        storage = (ROOT / 'api' / 'storage.py').read_text(encoding='utf-8')
        self.assertIn('createAccountForm', view)
        self.assertIn('financePasswordForm', view)
        self.assertIn("action: 'create_account'", settings)
        self.assertIn("action: 'change_finance_password'", settings)
        self.assertIn("hash_password(value)", storage)


if __name__ == '__main__':
    unittest.main()
