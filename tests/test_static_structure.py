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
        self.assertIn('include_environment=False', service)

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


if __name__ == '__main__':
    unittest.main()
