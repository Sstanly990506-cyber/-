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
        for route in ('/api/bootstrap', '/api/data/', '/api/changes', '/api/reports/summary', '/api/orders/recognize'):
            self.assertIn(route, flask_server)
            self.assertIn(route, builtin_server)

    def test_frontend_uses_paged_incremental_storage(self):
        store = (ROOT / 'js' / 'store.js').read_text(encoding='utf-8')
        self.assertIn('pageSize=100', store)
        self.assertIn('/api/changes', store)
        self.assertIn("localStorage.setItem('uiSettings'", store)
        self.assertNotIn("localStorage.setItem('orders'", store)

    def test_login_does_not_wait_for_all_entity_pages(self):
        store = (ROOT / 'js' / 'store.js').read_text(encoding='utf-8')
        self.assertIn('loadEntityPagesInBackground(keys)', store)
        self.assertIn('concurrency=2', store)
        self.assertNotIn('await Promise.all(keys.map', store)

    def test_refresh_renders_only_the_active_view(self):
        main = (ROOT / 'js' / 'main.js').read_text(encoding='utf-8')
        render_all = main[main.index('function renderAll()'):main.index('function showView(id)')]
        self.assertIn('switch (activeViewId)', render_all)
        self.assertNotIn('\n  renderDashboard();', render_all)
        self.assertNotIn('\n  renderCustomers(state);', render_all)
        self.assertNotIn('\n  renderSettings(state);', render_all)

    def test_dashboard_is_compact_and_actionable(self):
        view = (ROOT / 'views' / 'app-shell.html').read_text(encoding='utf-8')
        main = (ROOT / 'js' / 'main.js').read_text(encoding='utf-8')
        styles = (ROOT / 'styles.css').read_text(encoding='utf-8')
        self.assertEqual(view.count('data-dashboard-target'), 3)
        self.assertNotIn('dashboardSmartTip', view)
        self.assertNotIn('dashboardHeroTitle', view)
        self.assertIn('summaries = {', main)
        self.assertIn("priority.dataset.dashboardTarget === 'financeView'", main)
        self.assertIn('.dashboard-module-grid { grid-template-columns: repeat(2', styles)

    def test_admin_security_forms_are_present(self):
        view = (ROOT / 'views' / 'app-shell.html').read_text(encoding='utf-8')
        settings = (ROOT / 'js' / 'settings.js').read_text(encoding='utf-8')
        storage = (ROOT / 'api' / 'storage.py').read_text(encoding='utf-8')
        self.assertIn('createAccountForm', view)
        self.assertIn('financePasswordForm', view)
        self.assertIn("action: 'create_account'", settings)
        self.assertIn("action: 'change_finance_password'", settings)
        self.assertIn("hash_password(value)", storage)
        settings_close = view.index('</form>', view.index('id="settingsForm"'))
        self.assertGreater(view.index('id="createAccountForm"'), settings_close)
        self.assertGreater(view.index('id="financePasswordForm"'), settings_close)

    def test_ai_order_recognition_fills_existing_form(self):
        view = (ROOT / 'views' / 'app-shell.html').read_text(encoding='utf-8')
        orders = (ROOT / 'js' / 'orders.js').read_text(encoding='utf-8')
        self.assertIn('id="aiOrderImage"', view)
        self.assertIn("fetch('/api/orders/recognize'", orders)
        self.assertIn('applyRecognizedOrder', orders)


if __name__ == '__main__':
    unittest.main()
