"""Authenticated local assistant. Documents/data never become executable tools."""
import hashlib
import secrets
import threading
import time
from api.assistant_security import SITE_ORIGIN, SITE_ORIGINS, COMPANION_ORIGIN, contains_secret

from api.service import ApiError, require_account, require_entity_read_access, require_entity_access, list_entity_payload
from api.local_ai_records import inventory_snapshot, fingerprint, update_inventory_note, RecordConflict

ENABLED = False
PRODUCTION = False
DEMO = False
ALLOW_WRITES = False
ANSWER = None
SECRET_CHECK = None
STOP_SERVER = None
_MODEL_LOCK = threading.Lock()
_PROPOSAL_LOCK = threading.Lock()
_PROPOSALS = {}
FIELDS = {
    'orders': (('orderNumber', '工單'), ('billingCustomer', '客戶'), ('status', '狀態'), ('orderDate', '交貨日期'), ('sheetCount', '張數')),
    'customers': (('name', '名稱'), ('role', '類別')),
    'inventory': (('material', '品項'), ('category', '分類'), ('stock', '庫存'), ('unit', '單位'), ('safetyStock', '安全庫存'), ('note', '備註')),
}
LABELS = {'orders': '工單', 'customers': '客戶', 'inventory': '庫存'}


def configure(*, answer, secret_check, demo=False, allow_writes=False, stop=None):
    global ENABLED, DEMO, ALLOW_WRITES, ANSWER, SECRET_CHECK, STOP_SERVER, PRODUCTION
    ANSWER, SECRET_CHECK = answer, secret_check
    ENABLED, DEMO, ALLOW_WRITES = True, bool(demo), bool(allow_writes)
    STOP_SERVER = stop
    PRODUCTION = False


def configure_production():
    global PRODUCTION
    configure(answer=None, secret_check=contains_secret, demo=False, allow_writes=True)
    PRODUCTION = True


def session_payload(token):
    enabled()
    if PRODUCTION:
        from api.assistant_tickets import verify
        account = verify(token)
    else:
        account = require_account(token)
    if account.get('role') != 'admin':
        raise ApiError('第一版僅開放管理員與經配對的本機電腦。', 403)
    return {'ok': True, 'account': {key: account.get(key) for key in ('username', 'display', 'role')}, 'protocol': 1}


def ticket_payload(token, payload):
    enabled()
    _payload(payload, ())
    from api.assistant_tickets import issue
    return {'ok': True, 'ticket': issue(token), 'expiresIn': 1200}


def stop_payload(token, payload):
    enabled()
    account = require_account(token)
    if not DEMO or account.get('role') != 'admin' or STOP_SERVER is None:
        raise ApiError('此功能只用於停止本機假資料示範。', 403)
    _payload(payload, ('confirmed',))
    if payload.get('confirmed') is not True:
        raise ApiError('尚未確認停止。', 400)
    threading.Timer(0.2, STOP_SERVER).start()
    return {'ok': True, 'answer': '正在停止本機網站。若模型仍在回答，將待它完成並釋放記憶體。示範資料不會刪除。'}


def enabled():
    if not ENABLED:
        raise ApiError('本機 AI 未啟用。請在你的電腦執行 start-ai.cmd；Vercel 無法連到你的本機 Ollama。', 503)


def validate_request(remote, host, origin, port, method, content_type='', length='0'):
    """Transport boundary, also protects the optional passwordless FAKE demo."""
    expected = f'127.0.0.1:{port}'
    if PRODUCTION:
        if 'https://' + host not in SITE_ORIGINS or (origin and origin != 'https://' + host):
            raise ApiError('請使用正式網站網址。', 403)
    elif remote != '127.0.0.1' or host != expected:
        raise ApiError('本機 AI 僅接受 127.0.0.1。', 403)
    if not PRODUCTION and origin and origin != 'http://' + expected:
        raise ApiError('拒絕其他網站發出的請求。', 403)
    try:
        size = int(length or '0')
    except (TypeError, ValueError):
        raise ApiError('請求格式錯誤。', 400)
    if size < 0 or size > 16384:
        raise ApiError('請求過大。', 413)
    if method == 'POST' and content_type.split(';')[0].strip().lower() != 'application/json':
        raise ApiError('請使用 JSON 請求。', 415)


def public_config(token, query=None):
    return {'ok': True, 'enabled': ENABLED, 'demo': DEMO and ENABLED, 'transport': 'companion' if PRODUCTION else 'same-origin', 'companionOrigin': COMPANION_ORIGIN, 'protocol': 1}


def demo_session(token, payload):
    enabled()
    if not DEMO:
        raise ApiError('示範登入未啟用。', 404)
    from api.storage import create_session_token
    from api.service import build_bootstrap_payload
    account = {'username': 'local-demo', 'display': '假資料示範', 'role': 'admin', 'allowedViews': []}
    return {'ok': True, 'account': account, 'token': create_session_token(account), 'bootstrap': build_bootstrap_payload(account)}


def _text(value, maximum=1200, *, allow_empty=False):
    if not isinstance(value, str) or len(value) > maximum or (not allow_empty and not value.strip()):
        raise ApiError('請輸入有效文字，且不要超過長度限制。', 400)
    value = value.strip()
    if SECRET_CHECK and SECRET_CHECK(value):
        raise ApiError('內容疑似包含機密；請移除密碼、金鑰或憑證後再試。', 400)
    return value


def _payload(payload, allowed):
    if not isinstance(payload, dict) or set(payload) - set(allowed):
        raise ApiError('不支援的請求格式。', 400)


def _safe(value):
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        return '—'
    text = str(value)
    return '〔敏感內容已隱藏〕' if SECRET_CHECK and SECRET_CHECK(text) else text[:500]


def chat_payload(token, payload):
    enabled()
    account = require_account(token)
    if PRODUCTION and account.get('role') != 'admin':
        raise ApiError('第一版僅開放管理員。', 403)
    _payload(payload, ('question', 'mode', 'entity', 'history'))
    question = _text(payload.get('question'))
    mode = payload.get('mode', 'general')
    if PRODUCTION and mode != 'data':
        raise ApiError('一般對話與文件問題只能直接傳給已配對的本機 AI。', 400)
    if mode not in ('general', 'documents', 'data'):
        raise ApiError('不支援的對話模式。', 400)
    if mode == 'data':
        entity = payload.get('entity', 'orders')
        if not isinstance(entity, str) or entity not in FIELDS:
            raise ApiError('只能查詢工單、客戶或庫存。', 400)
        # Search is a literal, bounded query. Never interpret data or question as code.
        require_entity_read_access(token, entity)
        query = '' if question in ('全部', '最近', '列出最近資料') else _text(question, 100)
        try:
            result = list_entity_payload(token, entity, 1, 5, query)
        except ApiError:
            raise
        except Exception:
            raise ApiError('網站資料目前無法讀取，請稍後再試。', 503) from None
        rows, sources, output = [], [], []
        for row in result.get('items', [])[:5]:
            safe = {key: _safe(row.get(key, '')) for key, _ in FIELDS[entity]}
            safe['id'] = _safe(row.get('id', ''))
            rows.append(safe)
            source = f"網站／{LABELS[entity]}／{safe['id']}（資料版本 {int(row.get('_updatedAt') or 0)}）"
            sources.append(source)
            output.append('；'.join(f'{label}：{safe[key]}' for key, label in FIELDS[entity]))
        answer = ('以下是關鍵字符合的最近資料（最多 5 筆，不代表完整統計）：\n\n' + '\n\n'.join(output)) if rows else '找不到符合條件的網站資料，因此我不知道。請試試工單編號、品項或客戶名稱。'
        return {'ok': True, 'found': bool(rows), 'answer': answer, 'sources': sources, 'rows': rows, 'mode': mode, 'canEditNote': ALLOW_WRITES and account.get('role') == 'admin' and entity == 'inventory'}
    if mode == 'documents' and account.get('role') != 'admin':
        raise ApiError('目前文件庫尚未分級，只開放管理員查詢。', 403)
    history = payload.get('history', [])
    if not isinstance(history, list) or len(history) > 2:
        raise ApiError('對話紀錄過長。', 400)
    pairs = []
    if mode == 'general':
        for pair in history:
            if not isinstance(pair, list) or len(pair) != 2:
                raise ApiError('對話紀錄格式錯誤。', 400)
            pairs.append((_text(pair[0], 300), _text(pair[1], 500)))
    if not _MODEL_LOCK.acquire(blocking=False):
        raise ApiError('AI 正在處理另一個問題，請稍後再試。', 429)
    try:
        result = ANSWER(question, mode, pairs)
        require_account(token)
        return {'ok': True, 'found': result.found, 'answer': _safe_answer(result.answer), 'sources': [_safe(s) for s in result.sources], 'mode': result.mode}
    except ApiError:
        raise
    except Exception:
        raise ApiError('本機 AI 暫時無法回答。請確認模型、索引與可用記憶體；沒有改用雲端服務。', 503) from None
    finally:
        _MODEL_LOCK.release()


def _safe_answer(answer):
    if SECRET_CHECK and SECRET_CHECK(answer):
        return '回答疑似含有敏感內容，已隱藏。請改用不含憑證的問題。'
    return str(answer)[:8000]


def _writer(token):
    enabled()
    account = require_entity_access(token, 'inventory')
    if not ALLOW_WRITES or account.get('role') != 'admin':
        raise ApiError('備註修改尚未啟用，或你不是管理員。', 403)
    return account


def _owner(token):
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


def preview_payload(token, payload):
    _writer(token)
    _payload(payload, ('recordId', 'note'))
    record_id = _text(payload.get('recordId'), 120)
    note = _text(payload.get('note'), 500)  # No empty/deletion operation.
    try:
        snapshot = inventory_snapshot(record_id)
    except RecordConflict as err:
        raise ApiError(str(err), 409) from None
    except Exception:
        raise ApiError('無法讀取庫存；沒有修改資料。', 503) from None
    before = _text(str(snapshot['data'].get('note') or ''), 500, allow_empty=True)
    if before == note:
        raise ApiError('備註沒有改變，不需儲存。', 400)
    proposal_id = secrets.token_urlsafe(24)
    now = time.monotonic()
    proposal = {'owner': _owner(token), 'recordId': record_id, 'note': note, 'version': fingerprint(snapshot), 'expires': now + 120}
    if PRODUCTION:
        from api.assistant_proposals import seal
        proposal['expires'] = time.time() + 120
        proposal_id = seal(proposal)
    else:
        with _PROPOSAL_LOCK:
            for key in [key for key, item in _PROPOSALS.items() if item['expires'] <= now]:
                del _PROPOSALS[key]
            if len(_PROPOSALS) >= 64:
                raise ApiError('待確認操作過多，請兩分鐘後再試。', 429)
            _PROPOSALS[proposal_id] = proposal
    return {'ok': True, 'proposalId': proposal_id, 'recordId': record_id, 'before': before, 'after': note, 'expiresIn': 120, 'warning': '確認後會修改這一筆庫存的備註，並新增稽核紀錄。請核對內容；不會修改數量或金額。'}


def confirm_payload(token, payload):
    account = _writer(token)
    _payload(payload, ('proposalId', 'confirmed'))
    if payload.get('confirmed') is not True:
        raise ApiError('尚未確認，沒有修改資料。', 400)
    proposal_id = _text(payload.get('proposalId'), 10000 if PRODUCTION else 100)
    if PRODUCTION:
        from api.assistant_proposals import unseal
        proposal = unseal(proposal_id, _owner(token))
    else:
        with _PROPOSAL_LOCK:
            proposal = _PROPOSALS.get(proposal_id)
            if not proposal or proposal['owner'] != _owner(token) or proposal['expires'] <= time.monotonic():
                raise ApiError('確認已逾期、已使用或不屬於此登入，請重新取得預覽。', 409)
            del _PROPOSALS[proposal_id]  # Single-use even if DB fails; never blindly retry writes.
    try:
        result = update_inventory_note(proposal['recordId'], proposal['version'], proposal['note'], account['username'])
    except RecordConflict as err:
        raise ApiError(str(err), 409) from None
    except Exception:
        raise ApiError('儲存結果無法確認，請重新查詢並查看稽核紀錄，勿重複提交。', 503) from None
    return result | {'answer': '庫存備註已更新，並留下稽核紀錄。'}
