"""Loopback-only companion; fixed website authentication, no DB or cloud AI.

Pairing requires BOTH a valid website admin session and local browser approval.
Authentication/capability values exist only in memory, never in URLs or logs.
"""
import hashlib
import hmac
import json
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from api.assistant_security import SITE_ORIGIN, COMPANION_ORIGIN, contains_secret
from api.service import ApiError
from api._common import discard_small_rejected_body

ROOT = Path(__file__).resolve().parent


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ApiError('正式網站驗證不接受轉址。', 503)


def verify_website(token):
    if not isinstance(token, str) or not token.startswith('sqai1.') or not 20 <= len(token) <= 4096:
        raise ApiError('請先在正式網站登入。', 401)
    # This scoped AI ticket cannot log in or modify website records. Never send prompts.
    request = Request(SITE_ORIGIN + '/api/local-ai/session', headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/json'})
    try:
        with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=15) as response:
            if response.status != 200:
                raise ValueError()
            raw = response.read(8193)
            if len(raw) > 8192:
                raise ValueError()
            result = json.loads(raw)
        account = result.get('account') or {}
        if result.get('ok') is not True or result.get('protocol') != 1 or account.get('role') != 'admin' or not isinstance(account.get('username'), str):
            raise ApiError('本機 AI 第一版只接受正式網站的管理員。', 403)
        return {'username': account['username'][:100], 'display': str(account.get('display') or account['username'])[:100], 'role': 'admin'}
    except HTTPError as err:
        raise ApiError('正式網站登入已失效或權限不足，請重新登入。', 401 if err.code in (401, 403) else 503) from None
    except (URLError, OSError, ValueError, TypeError):
        raise ApiError('無法向正式網站驗證登入，請確認網路與網站狀態；未傳送對話內容。', 503) from None


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


class Companion:
    def __init__(self, answer, secret_check=contains_secret, verifier=verify_website):
        self.answer, self.secret_check, self.verifier = answer, secret_check, verifier
        self.lock = threading.Lock()
        self.model_lock = threading.Lock()
        self.pending = {}
        self.sessions = {}
        self.control_nonce = secrets.token_urlsafe(32)

    def _prune(self):
        now = time.monotonic()
        for collection in (self.pending, self.sessions):
            for key in [key for key, item in collection.items() if item['expires'] <= now]:
                del collection[key]

    def begin(self, token):
        account = self.verifier(token)
        with self.lock:
            self._prune()
            if len(self.pending) >= 4:
                raise ApiError('待配對請求過多，請在本機控制頁取消後再試。', 429)
            key = secrets.token_urlsafe(24)
            code = f'{secrets.randbelow(1000000):06d}'
            self.pending[key] = {'owner': digest(token), 'account': account, 'code': code, 'approved': False, 'expires': time.monotonic() + 120}
        return {'ok': True, 'pairId': key, 'code': code, 'expiresIn': 120}

    def control(self):
        with self.lock:
            self._prune()
            return {'ok': True, 'nonce': self.control_nonce, 'site': SITE_ORIGIN,
                    'pending': [{'id': key, 'code': item['code'], 'display': item['account']['display'], 'username': item['account']['username']} for key, item in self.pending.items() if not item['approved']],
                    'connected': len(self.sessions)}

    def approve(self, key, nonce):
        if not hmac.compare_digest(str(nonce), self.control_nonce):
            raise ApiError('本機確認已失效，請重新整理控制頁。', 403)
        with self.lock:
            self._prune()
            item = self.pending.get(key)
            if not item:
                raise ApiError('配對已逾期，請回正式網站重新連接。', 409)
            # Only the selected browser remains pending. Replaces any old pairing.
            self.pending = {key: item}
            item['approved'] = True
            self.sessions.clear()
        return {'ok': True}

    def finish(self, key, token):
        with self.lock:
            self._prune()
            item = self.pending.get(key)
            if not item or item['owner'] != digest(token):
                raise ApiError('配對已逾期或不屬於此登入。', 409)
            if not item['approved']:
                return {'ok': True, 'status': 'pending'}
            cap = secrets.token_urlsafe(32)
            self.sessions[digest(cap)] = {'owner': item['owner'], 'expires': time.monotonic() + 1200}
            del self.pending[key]
        return {'ok': True, 'status': 'connected', 'capability': cap, 'expiresIn': 1200}

    def check(self, cap, token):
        with self.lock:
            self._prune()
            session = self.sessions.get(digest(cap))
            if not session or session['owner'] != digest(token):
                raise ApiError('本機尚未配對或配對已到期，請重新連接。', 401)

    def disconnect(self, cap, token):
        self.check(cap, token)
        with self.lock:
            self.sessions.pop(digest(cap), None)
        return {'ok': True}

    def revoke(self, nonce):
        if not hmac.compare_digest(str(nonce), self.control_nonce):
            raise ApiError('本機確認失效。', 403)
        with self.lock:
            self.pending.clear()
            self.sessions.clear()
        return {'ok': True}

    def chat(self, payload, token, cap):
        self.check(cap, token)
        if set(payload) - {'mode', 'question', 'history'}:
            raise ApiError('不支援的本機請求。', 400)
        mode = payload.get('mode')
        question = payload.get('question')
        if mode not in ('general', 'documents') or not isinstance(question, str) or not question.strip() or len(question) > 1200:
            raise ApiError('請輸入有效問題。', 400)
        if self.secret_check(question):
            raise ApiError('請移除機密內容後再詢問；內容沒有送出。', 400)
        history = payload.get('history', [])
        if not isinstance(history, list) or len(history) > 2:
            raise ApiError('對話紀錄過長。', 400)
        pairs = []
        for pair in history:
            if not isinstance(pair, list) or len(pair) != 2 or not all(isinstance(part, str) for part in pair) or len(pair[0]) > 300 or len(pair[1]) > 500 or any(self.secret_check(part) for part in pair):
                raise ApiError('對話紀錄格式不符或包含機密。', 400)
            pairs.append(tuple(pair))
        if not self.model_lock.acquire(blocking=False):
            raise ApiError('AI 正在處理上一個問題，請稍後再試。', 429)
        try:
            self.verifier(token)
            self.check(cap, token)
            result = self.answer(question.strip(), mode, pairs if mode == 'general' else [])
            self.check(cap, token)  # Discard response if pairing was revoked mid-generation.
            answer = str(result.answer)[:8000]
            sources = [str(source)[:500] for source in result.sources]
            if self.secret_check(answer) or any(self.secret_check(source) for source in sources):
                return {'ok': True, 'found': False, 'answer': '回答含有疑似敏感內容，已隱藏。', 'sources': [], 'mode': mode}
            return {'ok': True, 'found': result.found, 'answer': answer, 'sources': sources, 'mode': result.mode}
        except ApiError:
            raise
        except Exception:
            raise ApiError('本機 AI 無法回答。請檢查模型、索引與可用記憶體；沒有使用雲端 AI。', 503) from None
        finally:
            self.model_lock.release()


class CompanionServer(ThreadingHTTPServer):
    allow_reuse_address = False
    request_queue_size = 8

    def __init__(self, state):
        self.state = state
        self.slots = threading.BoundedSemaphore(8)
        super().__init__(('127.0.0.1', 4175), CompanionHandler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


class CompanionHandler(BaseHTTPRequestHandler):
    server_version = 'SanqingLocal/1'

    def log_message(self, *args):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def reply(self, status, result, *, html=False):
        body = result if isinstance(result, bytes) else json.dumps(result, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'text/html; charset=utf-8' if html else 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        if self.headers.get('Origin') == SITE_ORIGIN:
            self.send_header('Access-Control-Allow-Origin', SITE_ORIGIN)
            self.send_header('Vary', 'Origin')
        self.end_headers()
        self.wfile.write(body)

    def boundary(self, *, control=False):
        if self.client_address[0] != '127.0.0.1' or self.headers.get_all('Host') != ['127.0.0.1:4175']:
            raise ApiError('只接受本機連線。', 403)
        origins = self.headers.get_all('Origin') or []
        expected = COMPANION_ORIGIN if control else SITE_ORIGIN
        if len(origins) > 1 or (self.command in ('POST', 'OPTIONS') and origins != [expected]) or (origins and origins != [expected]):
            raise ApiError('網站來源不符合允許範圍。', 403)
        if self.headers.get('Transfer-Encoding'):
            raise ApiError('不支援串流請求。', 400)
        lengths = self.headers.get_all('Content-Length') or ['0']
        try:
            size = int(lengths[0])
            if len(lengths) != 1 or not 0 <= size <= 16384:
                raise ValueError()
        except ValueError:
            raise ApiError('請求過大或格式錯誤。', 413)
        if self.command == 'POST' and self.headers.get('Content-Type', '').split(';')[0].strip() != 'application/json':
            raise ApiError('只接受 JSON。', 415)
        return size

    def do_OPTIONS(self):
        try:
            self.boundary()
            if self.path not in ('/pair', '/pair/status', '/chat', '/check', '/disconnect') or self.headers.get('Access-Control-Request-Method') != 'POST':
                raise ApiError('不支援的請求。', 403)
            allowed = {'authorization', 'content-type', 'x-sanqing-capability'}
            if set(part.strip().lower() for part in self.headers.get('Access-Control-Request-Headers', '').split(',') if part.strip()) - allowed:
                raise ApiError('不支援的標頭。', 403)
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin', SITE_ORIGIN)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Methods', 'POST')
            self.send_header('Access-Control-Allow-Headers', ', '.join(sorted(allowed)))
            self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.send_header('Access-Control-Max-Age', '60')
            self.send_header('Content-Length', '0')
            self.end_headers()
        except ApiError as err:
            self.reply(err.status, err.payload)

    def do_GET(self):
        try:
            self.boundary(control=True)
            if self.path == '/':
                self.reply(200, (ROOT / 'companion' / 'index.html').read_bytes(), html=True)
            elif self.path == '/control.js':
                body = (ROOT / 'companion' / 'control.js').read_bytes()
                self.send_response(200)
                self.send_header('Content-Type', 'text/javascript; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                self.wfile.write(body)
            elif self.path == '/control' and self.headers.get('X-Sanqing-Control') == '1':
                self.reply(200, self.server.state.control())
            else:
                raise ApiError('找不到頁面。', 404)
        except ApiError as err:
            self.reply(err.status, err.payload)

    def do_POST(self):
        try:
            control = self.path.startswith('/control/')
            size = self.boundary(control=control)
            raw = self.rfile.read(size)
            self._body_read = True
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise ApiError('請求格式錯誤。', 400)
            state = self.server.state
            if control:
                nonce = self.headers.get('X-Sanqing-Control', '')
                if self.path == '/control/approve' and set(payload) == {'pairId'} and isinstance(payload['pairId'], str):
                    result = state.approve(payload['pairId'], nonce)
                elif self.path in ('/control/revoke', '/control/stop') and not payload:
                    result = state.revoke(nonce)
                    if self.path.endswith('/stop'):
                        threading.Timer(0.2, self.server.shutdown).start()
                else:
                    raise ApiError('不支援的控制操作。', 400)
            else:
                if len(self.headers.get_all('Authorization') or []) != 1:
                    raise ApiError('請重新登入。', 401)
                scheme, _, token = self.headers.get('Authorization', '').partition(' ')
                if scheme.lower() != 'bearer' or not 20 <= len(token) <= 8192:
                    raise ApiError('請重新登入。', 401)
                cap = self.headers.get('X-Sanqing-Capability', '')
                if len(cap) > 128:
                    raise ApiError('配對格式錯誤。', 400)
                if self.path == '/pair' and not payload:
                    result = state.begin(token)
                elif self.path == '/pair/status' and set(payload) == {'pairId'} and isinstance(payload['pairId'], str):
                    result = state.finish(payload['pairId'], token)
                elif self.path == '/chat':
                    result = state.chat(payload, token, cap)
                elif self.path == '/check' and not payload:
                    state.check(cap, token)
                    state.verifier(token)
                    result = {'ok': True}
                elif self.path == '/disconnect' and not payload:
                    result = state.disconnect(cap, token)
                else:
                    raise ApiError('不支援的操作。', 400)
            self.reply(200, result)
        except ApiError as err:
            self.close_connection = True
            discard_small_rejected_body(self)
            self.reply(err.status, err.payload)
        except (ValueError, UnicodeError):
            self.close_connection = True
            self.reply(400, {'ok': False, 'error': '請求格式錯誤。'})
        except Exception:
            self.close_connection = True
            self.reply(503, {'ok': False, 'error': '本機連線暫時失敗，請稍後再試。'})
