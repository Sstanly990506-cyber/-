"""Opt-in, short-lived browser session cookie helpers."""
from urllib.parse import urlsplit
from http.cookies import SimpleCookie, CookieError
from api.service import ApiError, require_account, build_bootstrap_payload
from api.storage import SESSION_TTL_SECONDS

COOKIE_NAME = '__Secure-sanqing_remember'
COOKIE_PATH = '/api/session'

def validate_same_origin(headers):
    # Cookie-changing requests must be same-origin JSON fetches; SameSite is an
    # additional defence, rather than the sole CSRF protection.
    if (headers.get('Content-Type') or '').split(';', 1)[0].strip().lower() != 'application/json':
        raise ApiError('invalid content type', 415)
    site = (headers.get('Sec-Fetch-Site') or '').lower()
    if site and site != 'same-origin':
        raise ApiError('cross-origin request rejected', 403)
    origin = headers.get('Origin') or ''
    host = (headers.get('Host') or '').lower()
    try:
        parsed = urlsplit(origin)
        valid = parsed.scheme in ('http', 'https') and parsed.netloc.lower() == host and not parsed.path and not parsed.query and not parsed.fragment
    except ValueError:
        valid = False
    if not valid:
        raise ApiError('origin required', 403)

def cookie_header(token, max_age=min(SESSION_TTL_SECONDS, 12 * 60 * 60)):
    if not token or any(char not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.' for char in token):
        raise ApiError('invalid token', 401)
    return f'{COOKIE_NAME}={token}; Max-Age={max(0,int(max_age))}; Path={COOKIE_PATH}; Secure; HttpOnly; SameSite=Strict'

def clear_cookie_header():
    return f'{COOKIE_NAME}=; Max-Age=0; Path={COOKIE_PATH}; Secure; HttpOnly; SameSite=Strict'

def read_cookie(raw):
    try:
        cookies = SimpleCookie(); cookies.load(raw or '')
        return cookies[COOKIE_NAME].value if COOKIE_NAME in cookies else ''
    except CookieError:
        return ''

def remember(token):
    account = require_account(token)
    # Never persist the finance-unlocked credential: restoring always requires
    # a fresh finance password. The login credential itself has financeUntil=0.
    if account.get('financeUntil'):
        raise ApiError('finance-unlocked session cannot be remembered', 403)
    return cookie_header(token)

def restore(token):
    account = require_account(token)
    if account.get('financeUntil'):
        raise ApiError('invalid remembered session', 403)
    return {'ok': True, 'account': account, 'token': token,
            'bootstrap': build_bootstrap_payload(account, include_pages=False)}
