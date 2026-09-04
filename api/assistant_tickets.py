"""Scoped, short-lived AI attestations. NOT valid website login sessions."""
import base64
import hashlib
import hmac
import json
import time

from api import storage
from api.service import ApiError, require_account


def _sign(body):
    return hmac.new(storage.SESSION_SECRET.encode('utf-8'), ('sanqing-local-ai-ticket-v1:' + body).encode('ascii'), hashlib.sha256).hexdigest()


def issue(token):
    account = require_account(token)
    if account.get('role') != 'admin':
        raise ApiError('第一版僅開放管理員。', 403)
    payload = {'username': account['username'], 'display': account.get('display') or account['username'], 'role': 'admin', 'expires': int(time.time()) + 1200, 'session': hashlib.sha256(token.encode('utf-8')).hexdigest()}
    body = base64.urlsafe_b64encode(json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).decode('ascii')
    return 'sqai1.' + body + '.' + _sign(body)


def verify(ticket):
    try:
        if not isinstance(ticket, str) or len(ticket) > 4096:
            raise ValueError()
        prefix, body, signature = ticket.split('.')
        if prefix != 'sqai1' or not hmac.compare_digest(signature, _sign(body)):
            raise ValueError()
        payload = json.loads(base64.b64decode(body, altchars=b'-_', validate=True))
        if payload['role'] != 'admin' or not time.time() < payload['expires'] <= time.time() + 1205:
            raise ValueError()
        return {key: payload[key] for key in ('username', 'display', 'role')}
    except (ValueError, TypeError, KeyError, UnicodeError):
        raise ApiError('本機 AI 的短期授權已失效，請重新連接。', 401) from None
