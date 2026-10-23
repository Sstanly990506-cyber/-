"""Transport-independent API operations shared by Flask and the built-in server."""
import time
import uuid
from datetime import datetime, timedelta, timezone
from api.records import RecordConflict, dashboard_counts, get_record, write_record_batch, changes_since, clear_records, count_records_by_entity, delete_record, export_records, first_pages_for_entities, list_records, restore_records, upsert_record
from api.ai_orders import OrderRecognitionError, add_recognition_review, get_order_recognition_result, get_order_recognition_status, normalize_recognized_order, recognize_order_image
from api.storage import DEFAULT_APP_STATE, VALID_ROLES, authenticate_user, change_finance_module_password, create_session_token, ensure_storage, get_storage_mode, normalize_allowed_views, read_state, read_users, register_user, sanitize_account_public, verify_finance_module_password, verify_session_token, write_state, write_users
from api.trip_optimizer import optimize_trip
from api.pricing import calculate_quote, classify_pricing_tier_with_bounds, normalize_coating_type, normalize_pricing_tier
REQUIRED_STATE_KEYS=('glossOptions','customers','orders','audits','receivables','payables')
ENTITY_VIEW={'orders':'ordersView','customers':'customersView','inventory':'inventoryView','events':'notificationsView','audits':'auditView','receivables':'financeView','payables':'financeView','priceRules':'ordersView','aiCorrections':'ordersView','lineDestinations':'notificationsView'}
STATE_FIELD_VIEW={'glossOptions':'ordersView','customers':'customersView','orders':'ordersView','audits':'auditView','receivables':'financeView','payables':'financeView','priceRules':'ordersView','systemEvents':'notificationsView','inventoryItems':'inventoryView','lineDestinations':'notificationsView'}
class ApiError(Exception):
    def __init__(self,message,status=400,**extra):super().__init__(message);self.status=status;self.payload={'ok':False,'error':message,**extra}
def require_account(token):
    account=verify_session_token(token)
    if not account:raise ApiError('login required',401)
    return account
def finance_is_unlocked(account):
    return float((account or {}).get('financeUntil') or 0) > time.time()

def require_finance(account):
    if not account_can_view(account, 'financeView'):
        raise ApiError('permission denied', 403)
    if not finance_is_unlocked(account):
        raise ApiError('finance unlock required', 403, financeLocked=True)

def require_entity_access(token,entity):
    account=require_account(token)
    if entity not in ENTITY_VIEW:raise ApiError('unsupported entity',404)
    if entity=='lineDestinations' and account.get('role')!='admin':raise ApiError('admin role required',403)
    if not account_can_view(account,ENTITY_VIEW[entity]):raise ApiError('permission denied',403)
    if entity in {'receivables', 'payables'}:require_finance(account)
    return account
def require_entity_read_access(token,entity):
    account=require_account(token)
    if entity not in ENTITY_VIEW:raise ApiError('unsupported entity',404)
    if entity in {'receivables', 'payables'}:require_finance(account)
    if not account_can_read_entity(account,entity):raise ApiError('permission denied',403)
    return account
def account_can_view(account,view_id):
    if view_id in {'loginView','dashboardView'}:return True
    if (account or {}).get('role')=='admin':return True
    return view_id in normalize_allowed_views((account or {}).get('allowedViews'),(account or {}).get('role') or 'viewer')
def account_can_read_entity(account,entity):
    if entity in {'receivables','payables'} and not finance_is_unlocked(account):return False
    if entity in {'orders','customers'} and account_can_view(account,'financeView') and finance_is_unlocked(account):return True
    if account_can_view(account,ENTITY_VIEW.get(entity,'')):return True
    return entity in {'orders','customers'} and account_can_view(account,'tripsView')
def bootstrap_entities_for_account(account):
    return [entity for entity in ENTITY_VIEW if account_can_read_entity(account,entity)]

def visible_record(account,entity,row):
    if entity not in {'orders','customers'} or account_can_view(account,ENTITY_VIEW[entity]) or (account_can_view(account,'financeView') and finance_is_unlocked(account)):return row
    fields={'id','name','address','phone','active','role','_updatedAt','updatedAt'} if entity=='customers' else {'id','orderNumber','orderDate','status','upstream','downstream','address','_updatedAt','updatedAt'}
    return {key:value for key,value in row.items() if key in fields}
def filter_state_for_account(state,account):
    payload=dict(DEFAULT_APP_STATE)
    for field in DEFAULT_APP_STATE:
        if field=='settings':
            payload[field]=state.get(field)
        elif field in STATE_FIELD_VIEW and account_can_view(account,STATE_FIELD_VIEW[field]) and (field not in {'receivables','payables'} or finance_is_unlocked(account)):
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
        if field=='lineDestinations' and (account or {}).get('role')!='admin':continue
        if field in incoming and field in STATE_FIELD_VIEW and account_can_view(account,STATE_FIELD_VIEW[field]) and (field not in {'receivables','payables'} or finance_is_unlocked(account)):
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

def dashboard_payload(token):
    return {'ok':True,'summary':dashboard_summary(require_account(token))}

def dashboard_summary(account):
    entities=[entity for entity in ('orders','inventory','receivables','payables','audits') if account_can_read_entity(account,entity)]
    today=datetime.now(timezone(timedelta(hours=8))).date().isoformat()
    counts=dashboard_counts(entities,today)
    summary={'financeLocked':not finance_is_unlocked(account)}
    fields={'orders':{'pendingOrders':'pending','todayOrders':'today','ordersTotal':'total'},
            'inventory':{'lowInventory':'low'},'receivables':{'pendingReceivables':'unpaid_receivable'},
            'payables':{'pendingPayables':'unpaid_payable'},'audits':{'auditCount':'total'}}
    for entity in entities:
        for key,source in fields[entity].items():summary[key]=counts.get(entity,{}).get(source,0)
    return summary
def build_bootstrap_payload(account,include_pages=True):
    source=filter_state_for_account(read_state(),account);payload={key:([] if isinstance(value,list) else value) for key,value in DEFAULT_APP_STATE.items()};payload['glossOptions']=source.get('glossOptions') or DEFAULT_APP_STATE['glossOptions'];payload['settings']=source.get('settings');payload['syncTick']=source.get('syncTick') or 0;payload['scalableDataApi']=True
    if include_pages:
        try:
            payload['initialPages']=first_pages_for_entities(bootstrap_entities_for_account(account),100)
            for entity,page in payload['initialPages'].items():
                page['items']=[visible_record(account,entity,row) for row in page.get('items',[])]
            payload['dashboardSummary']=dashboard_summary(account)
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
    account=require_entity_read_access(token,entity)
    try:
        result=list_records(entity,page,page_size,query)
        result['items']=[visible_record(account,entity,row) for row in result.get('items',[])]
        return result
    except ValueError as err:raise ApiError(str(err),400) from err
def upsert_entity_payload(token,entity,record_id,payload):
    account=require_entity_access(token,entity)
    if not isinstance(payload,dict):raise ApiError('invalid record',400)
    return save_entity_record(account,entity,record_id,payload,require_version=True)

def save_entity_record(account,entity,record_id,payload,require_version=False):
    previous = get_record(entity, record_id)
    expected = payload.get('_expectedVersion', payload.get('_updatedAt'))
    if require_version and previous and expected is None:
        raise ApiError('畫面版本已過期；請先保留修改，再重新登入取得最新資料。',409,conflict=True)
    if expected is not None:
        try:expected=int(expected)
        except (ValueError,TypeError):raise ApiError('invalid record version',400)
        if expected != int((previous or {}).get('_updatedAt') or 0):
            raise ApiError('資料已由其他人更新；你的修改已保留，請核對最新資料後再儲存。',409,conflict=True)
    if require_version and entity == 'orders' and previous and 'sortOrder' in payload and payload['sortOrder'] != previous.get('sortOrder'):
        raise ApiError('排序必須整批儲存，請重新整理網站後再拖移排序。',409,conflict=True)
    if entity == 'orders' and previous:
        payload={**previous,**payload}
    if entity == 'orders' and 'orderNumber' in payload:
        payload['orderNumber']=str(payload['orderNumber'] or '').strip()
    if entity == 'orders' and payload.get('actualCost') is not None:
        import math
        try:
            cost = float(payload['actualCost'])
            if not math.isfinite(cost) or cost < 0:raise ValueError()
        except (TypeError, ValueError):raise ApiError('actual cost must be a nonnegative number',400)
    try:
        payload={key:value for key,value in payload.items() if key not in {'_updatedAt','_expectedVersion'}}
        guards={(entity,record_id):int((previous or {}).get('_updatedAt') or 0)}
        if entity != 'orders':
            result=write_record_batch([(entity,record_id,payload)],expected_versions=guards)
            return {**result,'id':record_id}
        writes=[('orders',record_id,payload)]
        linked_writes, linked_deletes=order_receivable_changes(payload,record_id,previous)
        writes.extend(linked_writes)
        for linked_entity, linked_id, *_ in [*linked_writes,*linked_deletes]:
            linked=get_record(linked_entity,linked_id)
            guards[(linked_entity,linked_id)]=int((linked or {}).get('_updatedAt') or 0)
            # A payment made after the derived row was read must not be overwritten.
            if linked and linked_writes and _number(linked.get('received')) != linked_writes[0][2].get('received'):
                raise RecordConflict('收款資料已更新，請重新載入後再儲存工單。')
        if previous:
            for field,label in (('totalPrice','總價'),('status','狀態'),('actualCost','實際成本')):
                if previous.get(field) != payload.get(field):
                    audit_id=str(uuid.uuid4())
                    writes.append(('audits',audit_id,{
                        'id':audit_id,'orderNumber':payload.get('orderNumber') or previous.get('orderNumber'),
                        'field':label,'before':previous.get(field),'after':payload.get(field),
                        'changedAt':datetime.now(timezone.utc).isoformat(),
                        'user':account.get('display') or account.get('username'),'device':'工單 API',
                    }))
        result=write_record_batch(writes,linked_deletes,expected_versions=guards,unique_orders=True)
        return {**result,'id':record_id}
    except RecordConflict as err:raise ApiError(str(err),409,conflict=True) from err
    except ValueError as err:raise ApiError(str(err),400) from err

def order_receivable_changes(order, record_id, previous=None):
    key=str(order.get('orderNumber') or '').strip() or f'ORDER-{record_id}'
    old_key=str((previous or {}).get('orderNumber') or '').strip() or key
    rows=[row for row in _all_records('receivables') if row.get('source')=='auto-order']
    existing=next((row for row in rows if row.get('orderId')==record_id),None)
    if not existing:
        legacy=[row for row in rows if not row.get('orderId') and str(row.get('orderNumber') or '').strip() in {key,old_key}]
        if legacy:
            others=[row for row in _all_records('orders') if row.get('id')!=record_id and str(row.get('orderNumber') or '').strip() in {key,old_key}]
            if len(legacy)>1 or others:
                raise ApiError('舊帳款存在重複工號，請先在財務資料核對工單關聯，避免覆蓋收款。',409,conflict=True)
            existing=legacy[0]
    if order.get('status') not in {'已完成','已送出'} or _number(order.get('totalPrice')) <= 0:
        return [], [('receivables',existing['id'])] if existing else []
    row_id=(existing or {}).get('id') or f'auto-order-{record_id}'
    row={
        'id':row_id,'source':'auto-order','orderId':record_id,
        'date':order.get('orderDate') or datetime.now(timezone.utc).date().isoformat(),
        'customer':order.get('billingCustomer') or order.get('upstream') or '-',
        'orderNumber':key,'amount':_number(order.get('totalPrice')),
        'received':_number((existing or {}).get('received')),
    }
    return [('receivables',row_id,row)], []

def reorder_orders_payload(token, payload):
    require_entity_access(token, 'orders')
    items = payload.get('orders') if isinstance(payload, dict) else None
    if not isinstance(items, list) or not 2 <= len(items) <= 500:
        raise ApiError('invalid order list', 400)
    ids = [item.get('id') if isinstance(item, dict) else None for item in items]
    if any(not isinstance(value, str) or not value for value in ids) or len(set(ids)) != len(ids):
        raise ApiError('invalid or duplicate order id', 400)
    writes, guards, rows = [], {}, []
    for position, item in enumerate(items):
        expected = item.get('_expectedVersion')
        if not isinstance(expected, int) or isinstance(expected, bool) or expected < 0:
            raise ApiError('排序資料缺少版本，請重新整理後再試。', 409, conflict=True)
        row = get_record('orders', item['id'])
        if not row or int(row.get('_updatedAt') or 0) != expected:
            raise ApiError('工單已被更新或重新排序，本次排序未儲存，請核對後再試。', 409, conflict=True)
        guards[('orders', item['id'])] = expected
        rows.append(row)
    # Keep this page's existing rank slots instead of assigning page two the
    # same 0..N ranks as page one. Legacy missing ranks retain the old fallback.
    import math
    slots = [row.get('sortOrder') for row in rows]
    valid_slots = all(isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value) for value in slots)
    slots = sorted(slots) if valid_slots and len(set(slots)) == len(slots) else list(range(len(rows)))
    for position,row in enumerate(rows):
        writes.append(('orders', row['id'], {**{k:v for k,v in row.items() if k != '_updatedAt'}, 'sortOrder':slots[position]}))
    try:
        result = write_record_batch(writes, expected_versions=guards)
    except RecordConflict as err:
        raise ApiError('工單已被更新或重新排序，本次排序未儲存，請核對後再試。', 409, conflict=True) from err
    return {**result, 'orders':[{'id':item['id'], 'sortOrder':slots[position]} for position,item in enumerate(items)]}

def move_order_payload(token, payload):
    require_entity_access(token,'orders')
    if not isinstance(payload,dict) or not all(isinstance(payload.get(key),str) and 0<len(payload[key])<=128 for key in ['id','targetId']) or not isinstance(payload.get('after',False),bool):
        raise ApiError('invalid move',400)
    from api.records import move_order_record
    try:return move_order_record(payload['id'],payload['targetId'],payload.get('after',False))
    except RecordConflict as err:raise ApiError(str(err),409,conflict=True) from err

def delete_entity_payload(token,entity,record_id,expected_version=None,require_version=False):
    require_entity_access(token,entity)
    if entity=='orders':
        order=next((row for row in _all_records('orders') if str(row.get('id') or '')==str(record_id or '')),None)
        if require_version and expected_version is None:
            raise ApiError('刪除前必須核對工單版本，請重新整理後再試。',409,conflict=True)
        if expected_version is not None:
            try: expected_version=int(expected_version)
            except (ValueError,TypeError):raise ApiError('invalid record version',400)
            if expected_version != int((order or {}).get('_updatedAt') or 0):
                raise ApiError('這張工單已被其他人更新，已取消刪除，請先核對最新資料。',409,conflict=True)
        order_number=str((order or {}).get('orderNumber') or '').strip()
        ambiguous=any(row.get('id')!=record_id and str(row.get('orderNumber') or '').strip()==order_number for row in _all_records('orders'))
        linked=[row for row in _all_records('receivables') if row.get('source')=='auto-order' and
                (row.get('orderId')==record_id or (not row.get('orderId') and order_number and not ambiguous and str(row.get('orderNumber') or '').strip()==order_number))]
        guards={('orders',record_id):int((order or {}).get('_updatedAt') or 0)}
        guards.update({('receivables',row['id']):int(row.get('_updatedAt') or 0) for row in linked})
        try:result=write_record_batch([], [('orders',record_id),*(('receivables',row['id']) for row in linked)], expected_versions=guards)
        except RecordConflict as err:raise ApiError(str(err),409,conflict=True) from err
        return {**result,'id':record_id,'deletedLinkedReceivables':len(linked)}
    return delete_record(entity,record_id)
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
    updates={}
    if isinstance(backup.get('settings'),dict):updates['settings']=backup['settings']
    if isinstance(backup.get('glossOptions'),list):updates['glossOptions']=backup['glossOptions']
    try:result=restore_records(backup['records'],state_updates=updates)
    except (ValueError,TypeError) as err:raise ApiError(str(err),400) from err
    return {'ok':True,'restored':result.get('restored') or {},'syncTick':result.get('updatedAt'),'message':'備份已還原；帳號、財務密碼與系統設定安全資訊已保留。'}
def changes_payload(token,since=0,limit=1000):
    account=require_account(token);result=changes_since(since,limit)
    result['changes']=[{**row,'data':visible_record(account,row.get('entity'),row.get('data') or {})} for row in result['changes'] if account_can_read_entity(account,row.get('entity'))]
    return result
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
def _customer_names_for_ai():
    rows=list_records('customers',1,200).get('items') or []
    names=[]
    for row in rows:
        if row.get('active') is False:continue
        name=str(row.get('name') or '').strip()
        if name and name not in names:names.append(name)
    return names[:80]
def report_payload(token):
    account=require_account(token)
    require_finance(account)
    orders=_all_records('orders');receivables=_all_records('receivables');payables=_all_records('payables');inventory=_all_records('inventory')
    return {'ok':True,'summary':{'ordersLoaded':len(orders),'pendingOrders':sum(1 for row in orders if row.get('status')!='已完成'),'receivableOutstanding':sum(max(0,_number(row.get('amount'))-_number(row.get('received'))) for row in receivables),'payableOutstanding':sum(max(0,_number(row.get('amount'))-_number(row.get('paid'))) for row in payables),'lowInventory':sum(1 for row in inventory if _number(row.get('stock'))<=_number(row.get('safetyStock')))}}
def finance_data_payload(token):
    account = require_account(token)
    require_finance(account)
    return {'ok': True, 'records': {entity: _all_records(entity) for entity in ('orders', 'customers', 'receivables', 'payables', 'audits')}}

def line_status_payload(token):
    account=require_account(token)
    if not account_can_view(account,'notificationsView'):raise ApiError('permission denied',403)
    from api.line_bot import line_status_payload as build_line_status
    return build_line_status()
def configure_line_destination_payload(token,payload):
    account=require_account(token)
    if account.get('role')!='admin':raise ApiError('admin role required',403)
    if not isinstance(payload,dict):raise ApiError('invalid json',400)
    destination_id=str(payload.get('id') or '').strip()
    access_mode=str(payload.get('accessMode') or '').strip().lower()
    customer_name=str(payload.get('customerName') or '').strip()
    if not destination_id:raise ApiError('missing destination id',400)
    if access_mode not in {'internal','customer'}:raise ApiError('invalid LINE access mode',400)
    if access_mode=='customer' and not customer_name:raise ApiError('customer group requires customer name',400)
    rows=list_records('lineDestinations',1,100).get('items') or []
    current=next((row for row in rows if str(row.get('destinationId') or row.get('id') or '')==destination_id),None)
    if not current:raise ApiError('LINE destination not found',404)
    updated={**current,'accessMode':access_mode,'customerName':customer_name if access_mode=='customer' else ''}
    result=upsert_record('lineDestinations',str(current.get('id') or destination_id),updated)
    return {'ok':True,'destination':{'id':result.get('id'),'accessMode':access_mode,'customerName':updated.get('customerName') or ''}}
def send_line_payload(token,payload):
    account=require_account(token)
    if not account_can_view(account,'notificationsView'):raise ApiError('permission denied',403)
    if payload is not None and not isinstance(payload,dict):raise ApiError('invalid json',400)
    if (payload or {}).get('manual') is not True:raise ApiError('automatic LINE push is disabled',403)
    from api.line_bot import LineBotError, send_line_message
    try:return send_line_message((payload or {}).get('message'))
    except LineBotError as err:raise ApiError(str(err),err.status) from err
def _format_customer_phone(value):
    text=str(value or '').strip()
    digits=''.join(ch for ch in text if ch.isdigit())
    if digits.startswith('02'):digits=digits[2:]
    if len(digits)==8:return f'{digits[:4]}-{digits[4:]}'
    return text
def import_customers_payload(token,payload):
    account=require_account(token)
    if account.get('role')!='admin':raise ApiError('admin role required',403)
    if not isinstance(payload,dict):raise ApiError('invalid json',400)
    rows=payload.get('customers')
    if not isinstance(rows,list) or not rows:raise ApiError('missing customers',400)
    existing=list_records('customers',1,5000).get('items') or []
    by_name={str(row.get('name') or '').strip().lower():row for row in existing if str(row.get('name') or '').strip()}
    by_tax={str(row.get('taxId') or '').strip():row for row in existing if str(row.get('taxId') or '').strip()}
    results=[]
    for row in rows:
        if not isinstance(row,dict):continue
        name=str(row.get('name') or '').strip()
        if not name:continue
        role=str(row.get('role') or '上游').strip()
        if role=='客人':role='上游'
        if role not in {'上游','下游','兩者'}:role='上游'
        tax_id=''.join(ch for ch in str(row.get('taxId') or '') if ch.isdigit())[:8]
        phone=_format_customer_phone(row.get('phone'))
        address=str(row.get('address') or '').strip()
        match=(by_tax.get(tax_id) if tax_id else None) or by_name.get(name.lower())
        record_id=str((match or {}).get('id') or row.get('id') or uuid.uuid4())
        record={'id':record_id,'name':name,'role':role,'taxId':tax_id,'phone':phone,'address':address,'active':row.get('active',True) is not False}
        upsert_record('customers',record_id,record)
        by_name[name.lower()]=record
        if tax_id:by_tax[tax_id]=record
        results.append({'id':record_id,'name':name,'mode':'updated' if match else 'created'})
    if not results:raise ApiError('no valid customers',400)
    return {'ok':True,'count':len(results),'results':results}
def user_action_payload(token,payload):
    if not isinstance(payload,dict):raise ApiError('invalid json',400)
    action=str(payload.get('action') or '').strip().lower()
    if action=='register':raise ApiError('public registration disabled',403)
    if action=='login':
        username=str(payload.get('username') or '').strip();password=str(payload.get('password') or '')
        if not username or not password:raise ApiError('missing login fields',400)
        account=authenticate_user(username,password)
        if not account:raise ApiError('invalid credentials',401)
        return {'ok':True,'account':account,'token':create_session_token(account),'bootstrap':build_bootstrap_payload(account,include_pages=False)}
    if action=='verify_finance_password':
        account=require_account(token)
        if not account_can_view(account,'financeView'):raise ApiError('finance role required',403)
        password=str(payload.get('password') or '')
        if not password:raise ApiError('missing finance password',400)
        if not verify_finance_module_password(password):raise ApiError('invalid finance password',401)
        return {'ok':True,'token':create_session_token(account,finance_unlocked=True),'financeUntil':int(time.time())+15*60}
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
def execute_trip_payload(token,payload):
    account=require_account(token)
    if not account_can_view(account,'tripsView'):raise ApiError('permission denied',403)
    if not isinstance(payload,dict) or not isinstance(payload.get('orderIds'),list):
        raise ApiError('orderIds required',400)

    order_ids=[]
    for value in payload['orderIds']:
        order_id=str(value or '').strip()
        if order_id and order_id not in order_ids:order_ids.append(order_id)
    if not order_ids:raise ApiError('select at least one order',400)
    if len(order_ids)>200:raise ApiError('too many orders',400)

    orders_by_id={str(row.get('id') or ''):row for row in _all_records('orders')}
    changed_at=datetime.now(timezone(timedelta(hours=8))).isoformat(timespec='seconds')
    updated_orders=[];missing=[];already_sent=0

    for order_id in order_ids:
        source=orders_by_id.get(order_id)
        if not source:
            missing.append(order_id);continue
        status=str(source.get('status') or '未完成').strip()
        if status=='已送出':
            already_sent+=1;continue

        order={key:value for key,value in source.items() if key!='_updatedAt'}
        order['status']='已送出';order['updatedAt']=changed_at
        order['_expectedVersion']=int(source.get('_updatedAt') or 0)
        saved=save_entity_record(account,'orders',order_id,order)
        order.pop('_expectedVersion',None)
        updated_orders.append({**order,'_updatedAt':saved.get('updatedAt')})

    return {
        'ok':True,
        'processed':len(order_ids)-len(missing),
        'updated':len(updated_orders),
        'alreadySent':already_sent,
        'skippedCompleted':0,
        'missing':missing,
        'orders':[visible_record(account,'orders',row) for row in updated_orders],
    }
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
    customers=_customer_names_for_ai()
    try:job=recognize_order_image(payload.get('image'),payload.get('glossOptions'),corrections,customers,True,True)
    except ValueError as err:raise ApiError(str(err),400) from err
    except OrderRecognitionError as err:raise ApiError(str(err),503) from err
    return {'ok':True,'pending':True,**job}
def recognize_order_status_payload(token,recognition_id=''):
    account=require_account(token)
    if not account_can_view(account,'ordersView'):raise ApiError('permission denied',403)
    if not recognition_id:return {'ok':True,**get_order_recognition_status()}
    try:result=get_order_recognition_result(recognition_id)
    except ValueError as err:raise ApiError(str(err),400) from err
    except OrderRecognitionError as err:raise ApiError(str(err),503) from err
    if result.get('pending'):return {'ok':True,**result}
    customers=_customer_names_for_ai()
    recognized=add_recognition_review(_fill_recognized_customer_address(normalize_recognized_order(result.get('order') or {})),customers)
    return {'ok':True,**result,'order':recognized}
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
