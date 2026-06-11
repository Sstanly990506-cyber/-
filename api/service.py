"""Transport-independent API operations shared by Flask and the built-in server."""
from api.storage import (
    authenticate_user,
    create_session_token,
    ensure_storage,
    filter_state_for_role,
    get_environment_status,
    get_storage_mode,
    merge_state_for_role,
    read_state,
    verify_finance_module_password,
    verify_session_token,
    write_state,
)
from api.trip_optimizer import optimize_trip

REQUIRED_STATE_KEYS = ('glossOptions', 'customers', 'orders', 'audits', 'receivables', 'payables')


class ApiError(Exception):
    def __init__(self, message, status=400, **extra):
        super().__init__(message)
        self.status = status
        self.payload = {'ok': False, 'error': message, **extra}


def require_account(token):
    account = verify_session_token(token)
    if not account:
        raise ApiError('login required', 401)
    return account


def health_payload(include_environment=False):
    ensure_storage()
    payload = {'ok': True, 'database': get_storage_mode()}
    if include_environment:
        payload['environment'] = get_environment_status()
    return payload


def get_state_payload(token):
    account = require_account(token)
    return filter_state_for_role(read_state(), account.get('role') or 'viewer')


def update_state_payload(token, payload):
    account = require_account(token)
    if not isinstance(payload, dict):
        raise ApiError('invalid json', 400)
    for key in REQUIRED_STATE_KEYS:
        if key not in payload:
            raise ApiError(f'missing key: {key}', 400)

    current = read_state()
    merged = merge_state_for_role(current, dict(payload), account.get('role') or 'viewer')
    ok, tick = write_state(merged)
    if not ok:
        raise ApiError('stale syncTick', 409, serverSyncTick=tick)
    return {'ok': True, 'syncTick': tick}


def user_action_payload(token, payload):
    if not isinstance(payload, dict):
        raise ApiError('invalid json', 400)

    action = str(payload.get('action') or '').strip().lower()
    if action == 'register':
        raise ApiError('public registration disabled', 403)

    if action == 'login':
        username = str(payload.get('username') or '').strip()
        password = str(payload.get('password') or '')
        if not username or not password:
            raise ApiError('missing login fields', 400)
        account = authenticate_user(username, password)
        if not account:
            raise ApiError('invalid credentials', 401)
        return {'ok': True, 'account': account, 'token': create_session_token(account)}

    if action == 'verify_finance_password':
        account = require_account(token)
        if account.get('role') not in {'admin', 'finance'}:
            raise ApiError('finance role required', 403)
        password = str(payload.get('password') or '')
        if not password:
            raise ApiError('missing finance password', 400)
        if not verify_finance_module_password(password):
            raise ApiError('invalid finance password', 401)
        return {'ok': True}

    raise ApiError('unsupported action', 400)


def optimize_trip_payload(token, payload):
    require_account(token)
    if not isinstance(payload, dict):
        raise ApiError('invalid json', 400)
    try:
        return optimize_trip(payload)
    except ValueError as err:
        raise ApiError(str(err), 400) from err
