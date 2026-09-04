"""Short-lived signed previews, compatible with multiple Vercel workers.

Replay protection is the atomic record snapshot comparison, not a process cache.
The existing application's configured signing key is used only at runtime.
"""
import base64
import hashlib
import hmac
import json
import time

from api import storage
from api.service import ApiError


def _sign(body):
    return hmac.new(storage.SESSION_SECRET.encode('utf-8'), b'sanqing-inventory-note-v1:' + body.encode('ascii'), hashlib.sha256).hexdigest()


def seal(proposal):
    body = base64.urlsafe_b64encode(json.dumps(proposal, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).decode('ascii')
    return body + '.' + _sign(body)


def unseal(value, owner):
    try:
        if not isinstance(value, str) or len(value) > 10000:
            raise ValueError()
        body, signature = value.rsplit('.', 1)
        if not hmac.compare_digest(signature, _sign(body)):
            raise ValueError()
        proposal = json.loads(base64.b64decode(body, altchars=b'-_', validate=True))
        if proposal['owner'] != owner or proposal['expires'] <= time.time() or proposal['expires'] > time.time() + 125:
            raise ValueError()
        if set(proposal) != {'owner', 'recordId', 'note', 'version', 'expires'}:
            raise ValueError()
        return proposal
    except (ValueError, TypeError, KeyError, UnicodeError):
        raise ApiError('確認已逾期、內容不符或不屬於此登入，請重新取得預覽。', 409) from None
