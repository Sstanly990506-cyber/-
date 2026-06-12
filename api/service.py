"""Transport-independent API operations shared by Flask and the built-in server."""
from api.document_ai import DocumentAIError, analyze_document_image
from api.records import changes_since, delete_record, list_records, upsert_record
from api.storage import DEFAULT_APP_STATE, authenticate_user, change_finance_module_password, create_session_token, ensure_storage, filter_state_for_role, get_storage_mode, merge_state_for_role, read_state, register_user, verify_finance_module_password, verify_session_token, write_state
from api.trip_optimizer import optimize_trip
REQUIRED_STATE_KEYS=('glossOptions','customers','orders','audits','receivables','payables')
ENTITY_ROLE={'orders':{'admin','ops'},'customers':{'admin','ops'},'inventory':{'admin','ops'},'events':{'admin','ops','finance','audit'},'audits':{'admin','audit'},'receivables':{'admin','finance'},'payables':{'admin','finance'}}
class ApiError(Exception):
    def __init__(self,message,status=400,**extra):super().__init__(message);self.status=status;self.payload={'ok':False,'error':message,**extra}
def require_account(token):
    account=verify_session_token(token)
    if not account:raise ApiError('login required',401)
    return account
def require_entity_access(token,entity):
    account=require_account(token);role=account.get('role') or 'viewer'
    if entity not in ENTITY_ROLE:raise ApiError('unsupported entity',404)
    if role=='viewer' or role not in ENTITY_ROLE[entity]:raise ApiError('permission denied',403)
    return account
def health_payload():ensure_storage();return {'ok':True,'database':get_storage_mode()}
def bootstrap_payload(token):
    account=require_account(token);source=filter_state_for_role(read_state(),account.get('role') or 'viewer');payload={key:([] if isinstance(value,list) else value) for key,value in DEFAULT_APP_STATE.items()};payload['glossOptions']=source.get('glossOptions') or DEFAULT_APP_STATE['glossOptions'];payload['settings']=source.get('settings');payload['syncTick']=source.get('syncTick') or 0;payload['scalableDataApi']=True;return payload
def get_state_payload(token):
    account=require_account(token);return filter_state_for_role(read_state(),account.get('role') or 'viewer')
def update_state_payload(token,payload):
    account=require_account(token)
    if not isinstance(payload,dict):raise ApiError('invalid json',400)
    for key in REQUIRED_STATE_KEYS:
        if key not in payload:raise ApiError(f'missing key: {key}',400)
    current=read_state();merged=merge_state_for_role(current,dict(payload),account.get('role') or 'viewer');ok,tick=write_state(merged)
    if not ok:raise ApiError('stale syncTick',409,serverSyncTick=tick)
    return {'ok':True,'syncTick':tick}
def list_entity_payload(token,entity,page=1,page_size=100,query=''):
    require_entity_access(token,entity)
    try:return list_records(entity,page,page_size,query)
    except ValueError as err:raise ApiError(str(err),400) from err
def upsert_entity_payload(token,entity,record_id,payload):
    require_entity_access(token,entity)
    try:return upsert_record(entity,record_id,payload)
    except ValueError as err:raise ApiError(str(err),400) from err
def delete_entity_payload(token,entity,record_id):require_entity_access(token,entity);return delete_record(entity,record_id)
def changes_payload(token,since=0,limit=1000):
    account=require_account(token);role=account.get('role') or 'viewer';result=changes_since(since,limit);allowed={entity for entity,roles in ENTITY_ROLE.items() if role in roles};result['changes']=[row for row in result['changes'] if row.get('entity') in allowed];return result
def _all_records(entity):
    first=list_records(entity,1,500);rows=list(first['items'])
    for page in range(2,first['pages']+1):rows.extend(list_records(entity,page,500)['items'])
    return rows
def _number(value):
    try:return float(value or 0)
    except (TypeError,ValueError):return 0.0
def report_payload(token):
    account=require_account(token)
    if account.get('role') not in {'admin','finance','ops'}:raise ApiError('permission denied',403)
    orders=_all_records('orders');receivables=_all_records('receivables');payables=_all_records('payables');inventory=_all_records('inventory')
    return {'ok':True,'summary':{'ordersLoaded':len(orders),'pendingOrders':sum(1 for row in orders if row.get('status')!='已完成'),'receivableOutstanding':sum(max(0,_number(row.get('amount'))-_number(row.get('received'))) for row in receivables),'payableOutstanding':sum(max(0,_number(row.get('amount'))-_number(row.get('paid'))) for row in payables),'lowInventory':sum(1 for row in inventory if _number(row.get('stock'))<=_number(row.get('safetyStock')))}}
def user_action_payload(token,payload):
    if not isinstance(payload,dict):raise ApiError('invalid json',400)
    action=str(payload.get('action') or '').strip().lower()
    if action=='register':raise ApiError('public registration disabled',403)
    if action=='login':
        username=str(payload.get('username') or '').strip();password=str(payload.get('password') or '')
        if not username or not password:raise ApiError('missing login fields',400)
        account=authenticate_user(username,password)
        if not account:raise ApiError('invalid credentials',401)
        return {'ok':True,'account':account,'token':create_session_token(account)}
    if action=='verify_finance_password':
        account=require_account(token)
        if account.get('role') not in {'admin','finance'}:raise ApiError('finance role required',403)
        password=str(payload.get('password') or '')
        if not password:raise ApiError('missing finance password',400)
        if not verify_finance_module_password(password):raise ApiError('invalid finance password',401)
        return {'ok':True}
    if action=='create_account':
        account=require_account(token)
        if account.get('role')!='admin':raise ApiError('admin role required',403)
        username=str(payload.get('username') or '').strip();password=str(payload.get('password') or '');display=str(payload.get('display') or '').strip();role=str(payload.get('role') or 'viewer').strip()
        if role not in {'admin','ops','finance','audit','viewer'}:raise ApiError('invalid role',400)
        if not username or len(password)<8:raise ApiError('username required and password must be at least 8 characters',400)
        try:created=register_user(username,password,display or username,role,source='admin-created')
        except ValueError as err:raise ApiError(str(err),409) from err
        return {'ok':True,'account':created}
    if action=='change_finance_password':
        account=require_account(token)
        if account.get('role')!='admin':raise ApiError('admin role required',403)
        password=str(payload.get('password') or '')
        try:change_finance_module_password(password)
        except ValueError as err:raise ApiError(str(err),400) from err
        return {'ok':True}
    raise ApiError('unsupported action',400)
def optimize_trip_payload(token,payload):
    require_account(token)
    if not isinstance(payload,dict):raise ApiError('invalid json',400)
    try:return optimize_trip(payload)
    except ValueError as err:raise ApiError(str(err),400) from err
def analyze_document_payload(token,payload):
    account=require_account(token)
    if account.get('role') not in {'admin','ops'}:raise ApiError('permission denied',403)
    if not isinstance(payload,dict):raise ApiError('invalid json',400)
    try:return {'ok':True,'document':analyze_document_image(payload.get('image'))}
    except DocumentAIError as err:raise ApiError(str(err),400) from err
