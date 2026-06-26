"""Transport-independent API operations shared by Flask and the built-in server."""
import time
import uuid
from api.records import changes_since, clear_records, count_records_by_entity, delete_record, export_records, first_pages_for_entities, list_records, restore_records, upsert_record
from api.ai_orders import OrderRecognitionError, get_order_recognition_status, normalize_recognized_order, recognize_order_image
from api.storage import DEFAULT_APP_STATE, VALID_ROLES, authenticate_user, change_finance_module_password, create_session_token, ensure_storage, get_storage_mode, normalize_allowed_views, read_state, read_users, register_user, sanitize_account_public, verify_finance_module_password, verify_session_token, write_state, write_users
from api.trip_optimizer import optimize_trip
from api.pricing import calculate_quote, classify_pricing_tier_with_bounds, normalize_coating_type, normalize_pricing_tier
REQUIRED_STATE_KEYS=('glossOptions','customers','orders','audits','receivables','payables')
ENTITY_VIEW={'orders':'ordersView','customers':'customersView','inventory':'inventoryView','events':'notificationsView','audits':'auditView','receivables':'financeView','payables':'financeView','priceRules':'ordersView','aiCorrections':'ordersView'}
STATE_FIELD_VIEW={'glossOptions':'ordersView','customers':'customersView','orders':'ordersView','audits':'auditView','receivables':'financeView','payables':'financeView','priceRules':'ordersView','systemEvents':'notificationsView','inventoryItems':'inventoryView'}
class ApiError(Exception):
    def __init__(self,message,status=400,**extra):super().__init__(message);self.status=status;self.payload={'ok':False,'error':message,**extra}
def require_account(token):
    account=verify_session_token(token)
    if not account:raise ApiError('login required',401)
    return account
def require_entity_access(token,entity):
    account=require_account(token)
    if entity not in ENTITY_VIEW:raise ApiError('unsupported entity',404)
    if not account_can_view(account,ENTITY_VIEW[entity]):raise ApiError('permission denied',403)
    return account
def require_entity_read_access(token,entity):
    account=require_account(token)
    if entity not in ENTITY_VIEW:raise ApiError('unsupported entity',404)
    if not account_can_read_entity(account,entity):raise ApiError('permission denied',403)
    return account
def account_can_view(account,view_id):
    if view_id in {'loginView','dashboardView'}:return True
    if (account or {}).get('role')=='admin':return True
    return view_id in normalize_allowed_views((account or {}).get('allowedViews'),(account or {}).get('role') or 'viewer')
def account_can_read_entity(account,entity):
    if account_can_view(account,ENTITY_VIEW.get(entity,'')):return True
    return entity in {'orders','customers'} and account_can_view(account,'tripsView')
def bootstrap_entities_for_account(account):
    return [entity for entity in ENTITY_VIEW if account_can_read_entity(account,entity)]
def filter_state_for_account(state,account):
    payload=dict(DEFAULT_APP_STATE)
    for field in DEFAULT_APP_STATE:
        if field=='settings':
            payload[field]=state.get(field)
        elif field in STATE_FIELD_VIEW and account_can_view(account,STATE_FIELD_VIEW[field]):
            payload[field]=state.get(field,payload[field])
        elif field in {'syncTick'}:
            payload[field]=state.get(field) or state.get('serverUpdatedAt') or 0
        elif field in {'serverUpdatedAt'}:
            payload[field]=state.get(field) or state.get('syncTick') or 0
        else:
            payload[field]=[] if isinstance(payload.get(field),list) else payload.get(field)
    payload['syncTick']=state.get('syncTick') or state.get('serverUpdatedAt') or 0
    payload['serverUpdatedAt']=state.get('serverUpdatedAt') or payload['syncTick']
    return payload
def merge_state_for_account(current,incoming,account):
    merged=dict(current)
    for field in DEFAULT_APP_STATE:
        if field=='syncTick':continue
        if field=='settings':
            if (account or {}).get('role')=='admin' and field in incoming:merged[field]=incoming[field]
            continue
        if field in incoming and field in STATE_FIELD_VIEW and account_can_view(account,STATE_FIELD_VIEW[field]):
            merged[field]=incoming[field]
    if 'syncTick' in incoming:merged['syncTick']=incoming['syncTick']
    return merged
def health_payload():ensure_storage();return {'ok':True,'database':get_storage_mode()}
def capacity_payload(token):
    account=require_account(token)
    if account.get('role')!='admin':raise ApiError('admin role required',403)
    started=time.perf_counter();ensure_storage();storage_ms=(time.perf_counter()-started)*1000
    entities=['orders','customers','receivables','payables','priceRules','inventory','audits','events','aiCorrections']
    errors={};query_ms=0
    try:
        counts,query_ms=count_records_by_entity(entities)
    except Exception as err:
        counts={entity:0 for entity in entities};errors['counts']=str(err)
    timings={entity:0 for entity in entities}
    total=sum(counts.values())
    warnings=[]
    if get_storage_mode()!='postgresql':warnings.append('目前不是 PostgreSQL，正式多人使用建議改用 PostgreSQL。')
    if counts.get('orders',0)>=100000:warnings.append('工單已超過 100,000 筆，建議加強搜尋索引與封存舊工單。')
    elif counts.get('orders',0)>=50000:warnings.append('工單已超過 50,000 筆，建議開始規劃封存與查詢優化。')
    if total>=200000:warnings.append('總資料量已超過 200,000 筆，建議拆分報表或增加資料庫索引。')
    if query_ms>=1500:warnings.append('資料庫第一次連線偏慢，通常是 Vercel 或資料庫冷啟動；連續操作會變快。')
    status='ok'
    if warnings:status='watch'
    if errors:status='error'
    return {'ok':True,'status':status,'storageMode':get_storage_mode(),'checkedAt':int(time.time()*1000),'storageMs':round(storage_ms,1),'countMs':query_ms,'counts':counts,'totalRecords':total,'timingsMs':timings,'warnings':warnings,'errors':errors}
def bootstrap_payload(token):
    return build_bootstrap_payload(require_account(token))
def build_bootstrap_payload(account,include_pages=True):
    source=filter_state_for_account(read_state(),account);payload={key:([] if isinstance(value,list) else value) for key,value in DEFAULT_APP_STATE.items()};payload['glossOptions']=source.get('glossOptions') or DEFAULT_APP_STATE['glossOptions'];payload['settings']=source.get('settings');payload['syncTick']=source.get('syncTick') or 0;payload['scalableDataApi']=True
    if include_pages:
        try:payload['initialPages']=first_pages_for_entities(bootstrap_entities_for_account(account),100)
        except Exception as err:payload['initialPagesError']=str(err);payload['initialPages']={}
    return payload
def get_state_payload(token):
    account=require_account(token);return filter_state_for_account(read_state(),account)
def update_state_payload(token,payload):
    account=require_account(token)
    if not isinstance(payload,dict):raise ApiError('invalid json',400)
    for key in REQUIRED_STATE_KEYS:
        if key not in payload:raise ApiError(f'missing key: {key}',400)
    current=read_state();merged=merge_state_for_account(current,dict(payload),account);ok,tick=write_state(merged)
    if not ok:raise ApiError('stale syncTick',409,serverSyncTick=tick)
    return {'ok':True,'syncTick':tick}
def list_entity_payload(token,entity,page=1,page_size=100,query=''):
    require_entity_read_access(token,entity)
    try:return list_records(entity,page,page_size,query)
    except ValueError as err:raise ApiError(str(err),400) from err
def upsert_entity_payload(token,entity,record_id,payload):
    require_entity_access(token,entity)
    try:return upsert_record(entity,record_id,payload)
    except ValueError as err:raise ApiError(str(err),400) from err
def delete_entity_payload(token,entity,record_id):
    require_entity_access(token,entity)
    linked_receivables=0
    order_number=''
    if entity=='orders':
        order=next((row for row in _all_records('orders') if str(row.get('id') or '')==str(record_id or '')),None)
        order_number=str((order or {}).get('orderNumber') or '').strip()
    result=delete_record(entity,record_id)
    if order_number:
        for receivable in _all_records('receivables'):
            if receivable.get('source')=='auto-order' and str(receivable.get('orderNumber') or '').strip()==order_number:
                delete_record('receivables',receivable.get('id'))
                linked_receivables+=1
    if entity=='orders':result['deletedLinkedReceivables']=linked_receivables
    return result
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
    account=require_account(token);result=changes_since(since,limit);result['changes']=[row for row in result['changes'] if account_can_read_entity(account,row.get('entity'))];return result
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
def _billing_customer_names_for_ai():
    rows=list_records('customers',1,200).get('items') or []
    names=[]
    for row in rows:
        if row.get('active') is False:continue
        role=str(row.get('role') or '').strip()
        if role=='客人':role='上游'
        if role and role not in {'上游','兩者'}:continue
        name=str(row.get('name') or '').strip()
        if name and name not in names:names.append(name)
    return names[:80]
def report_payload(token):
    account=require_account(token)
    if not account_can_view(account,'financeView'):raise ApiError('permission denied',403)
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
        return {'ok':True,'account':account,'token':create_session_token(account),'bootstrap':build_bootstrap_payload(account)}
    if action=='verify_finance_password':
        account=require_account(token)
        if not account_can_view(account,'financeView'):raise ApiError('finance role required',403)
        password=str(payload.get('password') or '')
        if not password:raise ApiError('missing finance password',400)
        if not verify_finance_module_password(password):raise ApiError('invalid finance password',401)
        return {'ok':True}
    if action=='create_account':
        account=require_account(token)
        if account.get('role')!='admin':raise ApiError('admin role required',403)
        username=str(payload.get('username') or '').strip();password=str(payload.get('password') or '');display=str(payload.get('display') or '').strip();role=str(payload.get('role') or 'viewer').strip()
        if role not in VALID_ROLES:raise ApiError('invalid role',400)
        if not username or len(password)<8:raise ApiError('username required and password must be at least 8 characters',400)
        try:created=register_user(username,password,display or username,role,source='admin-created',allowed_views=normalize_allowed_views(payload.get('allowedViews'),role))
        except ValueError as err:raise ApiError(str(err),409) from err
        return {'ok':True,'account':created}
    if action=='list_accounts':
        account=require_account(token)
        if account.get('role')!='admin':raise ApiError('admin role required',403)
        return {'ok':True,'accounts':[sanitize_account_public(user) for user in read_users()]}
    if action=='update_account_permissions':
        account=require_account(token)
        if account.get('role')!='admin':raise ApiError('admin role required',403)
        user_id=str(payload.get('id') or '').strip();username=str(payload.get('username') or '').strip().lower();role=str(payload.get('role') or '').strip()
        if role and role not in VALID_ROLES:raise ApiError('invalid role',400)
        users=read_users();target=None
        for user in users:
            if (user_id and str(user.get('id') or '')==user_id) or (username and str(user.get('usernameKey') or '').lower()==username):
                target=user;break
        if not target:raise ApiError('account not found',404)
        if role:target['role']=role
        target['allowedViews']=normalize_allowed_views(payload.get('allowedViews'),target.get('role') or 'viewer')
        write_users(users)
        return {'ok':True,'account':sanitize_account_public(target)}
    if action=='change_finance_password':
        account=require_account(token)
        if account.get('role')!='admin':raise ApiError('admin role required',403)
        password=str(payload.get('password') or '')
        try:change_finance_module_password(password)
        except ValueError as err:raise ApiError(str(err),400) from err
        return {'ok':True}
    if action=='update_settings':
        account=require_account(token)
        if account.get('role')!='admin':raise ApiError('admin role required',403)
        settings=payload.get('settings')
        if not isinstance(settings,dict):raise ApiError('invalid settings',400)
        current=read_state();current['settings']=settings
        ok,tick=write_state(current)
        if not ok:raise ApiError('settings changed on another device; retry',409,serverSyncTick=tick)
        return {'ok':True,'syncTick':tick}
    raise ApiError('unsupported action',400)
def optimize_trip_payload(token,payload):
    account=require_account(token)
    if not account_can_view(account,'tripsView'):raise ApiError('permission denied',403)
    if not isinstance(payload,dict):raise ApiError('invalid json',400)
    try:return optimize_trip(payload)
    except ValueError as err:raise ApiError(str(err),400) from err
def pricing_quote_payload(token,payload):
    account=require_account(token)
    if not account_can_view(account,'ordersView'):raise ApiError('permission denied',403)
    if not isinstance(payload,dict):raise ApiError('invalid json',400)
    try:
        settings=(read_state().get('settings') or {}).get('moduleInternals',{}).get('orders',{}).get('pricingRules')
        customer=str(payload.get('customer') or '').strip().lower()
        quote_payload=dict(payload)
        customer_price=None
        if customer:
            width=float(payload.get('width') or 0);height=float(payload.get('height') or 0)
            fallback_customer_price=None
            price_rules=_all_records('priceRules')
            bounds_rule=next((rule for rule in price_rules if str(rule.get('customer') or '').strip().lower()==customer and rule.get('priceScope')=='customer-tier-bounds'),None)
            if bounds_rule and not quote_payload.get('machineType'):
                quote_payload['machineType']=classify_pricing_tier_with_bounds(width,height,bounds_rule.get('tierBounds'),settings)
            for rule in price_rules:
                if rule.get('priceScope')=='customer-tier-bounds':continue
                if str(rule.get('customer') or '').strip().lower()!=customer or rule.get('pricingMode')!='formula':continue
                if normalize_coating_type(rule.get('glossType'))!=normalize_coating_type(payload.get('coatingType')):continue
                rule_tier=rule.get('machineType')
                if rule_tier not in {None,'','ANY'} and normalize_pricing_tier(rule_tier)!=normalize_pricing_tier(quote_payload.get('machineType')):continue
                rule_width=float(rule.get('sizeWidthTai') or rule.get('sizeWidth') or 0)
                rule_height=float(rule.get('sizeLengthTai') or rule.get('sizeLength') or 0)
                if not rule_width and not rule_height:
                    fallback_customer_price=rule.get('unitPrice');continue
                if (abs(rule_width-width)<=0.15 and abs(rule_height-height)<=0.15) or (abs(rule_width-height)<=0.15 and abs(rule_height-width)<=0.15):
                    customer_price=rule.get('unitPrice');break
            if customer_price is None:customer_price=fallback_customer_price
        return {'ok':True,**calculate_quote(quote_payload,settings,customer_price)}
    except ValueError as err:raise ApiError(str(err),400) from err
def recognize_order_payload(token,payload):
    account=require_account(token)
    if not account_can_view(account,'ordersView'):raise ApiError('permission denied',403)
    if not isinstance(payload,dict):raise ApiError('invalid json',400)
    corrections=list_records('aiCorrections',1,20).get('items') or []
    customers=_billing_customer_names_for_ai()
    try:recognized=_fill_recognized_customer_address(normalize_recognized_order(recognize_order_image(payload.get('image'),payload.get('glossOptions'),corrections,customers)))
    except ValueError as err:raise ApiError(str(err),400) from err
    except OrderRecognitionError as err:raise ApiError(str(err),503) from err
    return {'ok':True,'order':recognized}
def recognize_order_status_payload(token):
    account=require_account(token)
    if not account_can_view(account,'ordersView'):raise ApiError('permission denied',403)
    return {'ok':True,**get_order_recognition_status()}
def report_order_correction_payload(token,payload):
    account=require_account(token)
    if not account_can_view(account,'ordersView'):raise ApiError('permission denied',403)
    if not isinstance(payload,dict) or not isinstance(payload.get('changes'),dict):raise ApiError('invalid correction',400)
    allowed={'orderNumber','orderDate','billingCustomer','upstream','downstream','address','sheetCountText','sheetCount','sizeLength','sizeWidth','sizeUnit','glossType','totalPrice'}
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
