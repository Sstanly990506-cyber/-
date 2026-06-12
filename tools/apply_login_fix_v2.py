from pathlib import Path
import re

p=Path('api/records.py');s=p.read_text();s=s.replace("RECORDS_LOCK = Lock()\n","RECORDS_LOCK = Lock()\nRECORD_STORAGE_INIT_LOCK = Lock()\nRECORD_STORAGE_READY = False\n")
new='''def ensure_record_storage():
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
                        entity TEXT NOT NULL, record_id TEXT NOT NULL, data_json JSONB NOT NULL,
                        updated_at BIGINT NOT NULL, deleted BOOLEAN NOT NULL DEFAULT FALSE,
                        PRIMARY KEY (entity, record_id))\'\'\')
                    cur.execute(\'CREATE INDEX IF NOT EXISTS app_records_entity_updated_idx ON app_records(entity, updated_at)\')
                    cur.execute(\'CREATE INDEX IF NOT EXISTS app_records_entity_deleted_idx ON app_records(entity, deleted)\')
                conn.commit()
            _migrate_postgres_once()
        else:
            _migrate_local_once()
        RECORD_STORAGE_READY = True


def _migrate_postgres_once'''
s,n=re.subn(r'def ensure_record_storage\(\):.*?\n\ndef _migrate_postgres_once',new,s,flags=re.S);assert n==1;p.write_text(s)

p=Path('js/main.js');s=p.read_text();s=s.replace("let financeUnlockedUntil = 0;","let financeUnlockedUntil = 0;\nlet activeViewId = 'loginView';");s=s.replace("const activeView = views.find((viewId) => !$(viewId)?.classList.contains('hidden'));","const activeView = activeViewId;");s=s.replace("$('dashboardView')?.classList.remove('hidden');\n  }","$('dashboardView')?.classList.remove('hidden');\n    activeViewId = 'dashboardView';\n  }");s=s.replace("if (id !== 'loginView') mountInternalViews();\n  views.forEach","if (id !== 'loginView') mountInternalViews();\n  activeViewId = id;\n  views.forEach")
new='''    const landing = state.settings?.defaultLandingView || 'dashboardView';
    showView(hasViewPermission(landing) ? landing : 'dashboardView');
    startAuthenticatedSync().then(() => {
      appendSystemEvent(`使用者登入：${state.user}`, 'info', { role: state.userRole });
      saveState();
    }).catch((err) => applySyncUi({ badgeText: '同步失敗', detailText: err?.message || '背景載入失敗', ok: false }));'''
s,n=re.subn(r'    await startAuthenticatedSync\(\);.*?    showView\(hasViewPermission\(landing\) \? landing : \'dashboardView\'\);',new,s,flags=re.S);assert n==1;p.write_text(s)
