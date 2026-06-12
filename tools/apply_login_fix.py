from pathlib import Path
import re

records = Path('api/records.py')
text = records.read_text()
text = text.replace("RECORDS_LOCK = Lock()\n", "RECORDS_LOCK = Lock()\nRECORD_STORAGE_INIT_LOCK = Lock()\nRECORD_STORAGE_READY = False\n")
replacement = '''def ensure_record_storage():
    global RECORD_STORAGE_READY
    storage.ensure_storage()
    if RECORD_STORAGE_READY:
        return
    with RECORD_STORAGE_INIT_LOCK:
        if RECORD_STORAGE_READY:
            return
        if storage.DATABASE_URL:
            with storage.get_db_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(\'\'\'CREATE TABLE IF NOT EXISTS app_records (
                        entity TEXT NOT NULL,
                        record_id TEXT NOT NULL,
                        data_json JSONB NOT NULL,
                        updated_at BIGINT NOT NULL,
                        deleted BOOLEAN NOT NULL DEFAULT FALSE,
                        PRIMARY KEY (entity, record_id)
                    )\'\'\')
                    cur.execute(\'CREATE INDEX IF NOT EXISTS app_records_entity_updated_idx ON app_records(entity, updated_at)\')
                    cur.execute(\'CREATE INDEX IF NOT EXISTS app_records_entity_deleted_idx ON app_records(entity, deleted)\')
                conn.commit()
            _migrate_postgres_once()
        else:
            _migrate_local_once()
        RECORD_STORAGE_READY = True


def _migrate_postgres_once'''
text, count = re.subn(r'def ensure_record_storage\(\):.*?\n\ndef _migrate_postgres_once', replacement, text, flags=re.S)
assert count == 1
records.write_text(text)

main = Path('js/main.js')
text = main.read_text()
text = text.replace("let financeUnlockedUntil = 0;", "let financeUnlockedUntil = 0;\nlet activeViewId = 'loginView';")
text = text.replace("const activeView = views.find((viewId) => !$(viewId)?.classList.contains('hidden'));", "const activeView = activeViewId;")
text = text.replace("$('dashboardView')?.classList.remove('hidden');\n  }", "$('dashboardView')?.classList.remove('hidden');\n    activeViewId = 'dashboardView';\n  }")
text = text.replace("if (id !== 'loginView') mountInternalViews();\n  views.forEach", "if (id !== 'loginView') mountInternalViews();\n  activeViewId = id;\n  views.forEach")
old = """    await startAuthenticatedSync();
    appendSystemEvent(`使用者登入：${state.user}`, 'info', { role: state.userRole });
    saveState();
    const landing = state.settings?.defaultLandingView || 'dashboardView';
    showView(hasViewPermission(landing) ? landing : 'dashboardView');"""
new = """    const landing = state.settings?.defaultLandingView || 'dashboardView';
    showView(hasViewPermission(landing) ? landing : 'dashboardView');
    startAuthenticatedSync().then(() => {
      appendSystemEvent(`使用者登入：${state.user}`, 'info', { role: state.userRole });
      saveState();
    }).catch((err) => applySyncUi({ badgeText: '同步失敗', detailText: err?.message || '背景載入失敗', ok: false }));"""
assert old in text
main.write_text(text.replace(old, new))

record_tests = Path('tests/test_records.py')
text = record_tests.read_text().replace("        self.root = Path(self.temp.name)\n", "        self.root = Path(self.temp.name)\n        records.RECORD_STORAGE_READY = False\n")
text = text.replace("    def tearDown(self):\n", "    def tearDown(self):\n        records.RECORD_STORAGE_READY = False\n")
record_tests.write_text(text)

static_tests = Path('tests/test_static_structure.py')
text = static_tests.read_text()
extra = '''    def test_login_loads_only_role_data_without_waiting_for_sync(self):
        store = (ROOT / 'js' / 'store.js').read_text(encoding='utf-8')
        main = (ROOT / 'js' / 'main.js').read_text(encoding='utf-8')
        self.assertIn('ROLE_KEYS', store)
        self.assertNotIn('await loadServerReport()', store)
        self.assertNotIn('await startAuthenticatedSync()', main)

    def test_background_refresh_preserves_active_view(self):
        main = (ROOT / 'js' / 'main.js').read_text(encoding='utf-8')
        self.assertIn("let activeViewId = 'loginView'", main)
        self.assertIn('const activeView = activeViewId', main)


'''
static_tests.write_text(text.replace("\n\nif __name__ == '__main__':", "\n\n" + extra + "if __name__ == '__main__':"))
