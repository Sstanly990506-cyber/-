"""Transport-independent API operations shared by Flask and the built-in server."""
import time
import uuid
from api.records import changes_since, clear_records, delete_record, export_records, list_records, restore_records, upsert_record
from api.ai_orders import OrderRecognitionError, get_order_recognition_status, recognize_order_image
from api.storage import DEFAULT_APP_STATE, authenticate_user, change_finance_module_password, create_session_token, ensure_storage, filter_state_for_role, get_storage_mode, merge_state_for_role, read_state, register_user, verify_finance_module_password, verify_session_token, write_state
from api.trip_optimizer import optimize_trip
REQUIRED_STATE_KEYS=('glossOptions','customers','orders','audits','receivables','payables')
ENTITY_ROLE={'orders':{'admin','ops'},'customers':{'admin','ops'},'inventory':{'admin','ops'},'events':{'admin','ops','finance','audit'},'audits':{'admin','audit'},'receivables':{'admin','finance'},'payables':{'admin','finance'},'aiCorrections':{'admin','ops'}}
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
def clear_test_data_payload(token,payload):
    account=require_account(token)
    if account.get('role')!='admin':raise ApiError('admin role required',403)
    if not isinstance(payload,dict) or str(payload.get('confirm') or '').strip()!='清空測試資料':raise ApiError('confirmation required',400)
    result=clear_records()
    result['message']='測試資料已清空；帳號、財務密碼與系統設定已保留。'
    return result
def backup_payload(token):
    account=require_account(token)
    if account.get('role')!='admin':raise ApiError('admin role required',403)
    state=read_state()
    return {'ok':True,'backup':{'version':1,'app':'sanqing-operations','exportedAt':int(time.time()*1000),'settings':state.get('settings') or {},'glossOptions':state.get('glossOptions') or DEFAULT_APP_STATE['glossOptions'],'records':export_records(),'note':'此備份不包含登入密碼、財務密碼或伺服器環境變數。'}}
def restore_backup_payload(token,payload):
    account=require_account(token)
    if account.get('role')!='admin':raise ApiError('admin role required',403)
    if not isinstance(payload,dict) or str(payload.get('confirm') or '').strip()!='還原備份':raise ApiError('confirmation required',400)
    backup=payload.get('backup')
    if not isinstance(backup,dict) or not isinstance(backup.get('records'),dict):raise ApiError('invalid backup file',400)
    current=read_state();next_state=dict(current);next_state['syncTick']=int(time.time()*1000)
    if isinstance(backup.get('settings'),dict):next_state['settings']=backup.get('settings')
    if isinstance(backup.get('glossOptions'),list):next_state['glossOptions']=backup.get('glossOptions')
    ok,tick=write_state(next_state)
    if not ok:raise ApiError('stale syncTick',409,serverSyncTick=tick)
    result=restore_records(backup.get('records'))
    return {'ok':True,'restored':result.get('restored') or {},'syncTick':tick,'message':'備份已還原；帳號、財務密碼與系統設定安全資訊已保留。'}
def changes_payload(token,since=0,limit=1000):
    account=require_account(token);role=account.get('role') or 'viewer';result=changes_since(since,limit);allowed={entity for entity,roles in ENTITY_ROLE.items() if role in roles};result['changes']=[row for row in result['changes'] if row.get('entity') in allowed];return result
def _all_records(entity):
    first=list_records(entity,1,500);rows=list(first['items'])
    for page in range(2,first['pages']+1):rows.extend(list_records(entity,page,500)['items'])
    return rows
def _number(value):
    try:return float(value or 0)
    except (TypeError,ValueError):return 0.0
def _fill_recognized_customer_address(recognized):
    downstream=str(recognized.get('downstream') or '').strip()
    if not downstream:return recognized
    customers=list_records('customers',1,20,downstream).get('items') or []
    key=downstream.lower()
    customer=next((row for row in customers if str(row.get('name') or '').strip().lower()==key),None)
    if not customer:customer=next((row for row in customers if key in str(row.get('name') or '').lower()),None)
    if customer and str(customer.get('address') or '').strip():
        recognized['downstream']=customer.get('name') or downstream
        recognized['address']=str(customer['address']).strip()
        recognized['addressSource']='customer-system'
    elif str(recognized.get('address') or '').strip():
        recognized['addressSource']='image-downstream-destination'
    return recognized
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
def recognize_order_payload(token,payload):
    account=require_account(token)
    if account.get('role') not in {'admin','ops'}:raise ApiError('permission denied',403)
    if not isinstance(payload,dict):raise ApiError('invalid json',400)
    corrections=list_records('aiCorrections',1,20).get('items') or []
    try:recognized=_fill_recognized_customer_address(recognize_order_image(payload.get('image'),payload.get('glossOptions'),corrections))
    except ValueError as err:raise ApiError(str(err),400) from err
    except OrderRecognitionError as err:raise ApiError(str(err),503) from err
    return {'ok':True,'order':recognized}
def recognize_order_status_payload(token):
    account=require_account(token)
    if account.get('role') not in {'admin','ops'}:raise ApiError('permission denied',403)
    return {'ok':True,**get_order_recognition_status()}
def report_order_correction_payload(token,payload):
    account=require_account(token)
    if account.get('role') not in {'admin','ops'}:raise ApiError('permission denied',403)
    if not isinstance(payload,dict) or not isinstance(payload.get('changes'),dict):raise ApiError('invalid correction',400)
    allowed={'orderNumber','orderDate','upstream','downstream','address','sheetCountText','sheetCount','sizeLength','sizeWidth','sizeUnit','glossType','totalPrice'}
    changes={}
    for key,value in payload['changes'].items():
        if key not in allowed or not isinstance(value,dict) or value.get('wrong')==value.get('correct'):continue
        wrong=value.get('wrong');correct=value.get('correct')
        if isinstance(wrong,str):wrong=wrong[:200]
        if isinstance(correct,str):correct=correct[:200]
        changes[key]={'wrong':wrong,'correct':correct}
    if not changes:raise ApiError('沒有可回報的修正欄位',400)
    record_id=str(uuid.uuid4())
    upsert_record('aiCorrections',record_id,{'id':record_id,'changes':changes,'confidence':payload.get('confidence'),'reportedAt':int(time.time()*1000),'reportedBy':account.get('username') or account.get('display') or ''})
    return {'ok':True,'savedFields':len(changes)}
