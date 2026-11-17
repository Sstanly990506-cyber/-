"""Account-scoped key for encrypting local order drafts.

The key is never persisted by the browser. Drafts remain available after a new
login to the same account, but cannot be opened by another account.
"""
import base64
import hashlib
import hmac

from api import storage
from api.service import ApiError, require_entity_access


def order_draft_key_payload(token):
    account = require_entity_access(token, 'orders')
    owner = str(account.get('id') or '').strip()
    if not owner:
        raise ApiError('無法確認草稿所屬帳號。', 403)
    if storage.SESSION_SECRET_SOURCE == 'runtime-random':
        raise ApiError('伺服器尚未設定穩定的草稿保護金鑰。', 503)
    key = hmac.new(storage.SESSION_SECRET.encode('utf-8'),
                   b'sanqing-order-draft-key-v1\0' + owner.encode('utf-8'),
                   hashlib.sha256).digest()
    return {'ok': True, 'ownerId': owner,
            'key': base64.urlsafe_b64encode(key).decode('ascii').rstrip('=')}
