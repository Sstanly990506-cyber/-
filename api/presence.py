"""Short-lived collaboration presence, separate from orders and audit records."""
import hashlib
import json
import math
import re
import time
from threading import Lock
from api import storage
from api.service import ApiError, require_entity_access

TTL_MS = 15000
FIELDS = {'orderNumber':'工單編號','orderDate':'交貨日期','billingCustomerInput':'客人','upstreamInput':'上游','downstreamInput':'下游','orderAddress':'送貨地址','orderItemName':'品名','sheetCountText':'數量說明','sheetCount':'張數','sizeNotation':'尺寸','sizeLength':'天','sizeWidth':'地','sizeUnit':'單位','machineType':'尺寸級距','glossType':'上光','totalPrice':'總價','orderStatus':'狀態'}
_LOCK = Lock()
_DB_READY = False

def _prepare_table():
    global _DB_READY
    with _LOCK:
        if _DB_READY:return
        with storage.get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute('CREATE TABLE IF NOT EXISTS app_presence (presence_key TEXT PRIMARY KEY, data_json JSONB NOT NULL, updated_at BIGINT NOT NULL)')
        _DB_READY = True

def presence_payload(token, payload):
    account = require_entity_access(token,'orders')
    if not isinstance(payload,dict):raise ApiError('invalid presence',400)
    client = payload.get('clientId')
    if not isinstance(client,str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,80}',client):raise ApiError('invalid client id',400)
    actor = str(account.get('id') or account.get('username') or '')+':'+client
    key = hashlib.sha256(actor.encode()).hexdigest()
    active = payload.get('active') is True
    order_id = payload.get('orderId','')
    field = payload.get('field','')
    if not isinstance(order_id,str) or len(order_id)>128 or not isinstance(field,str) or field and field not in FIELDS:raise ApiError('invalid presence target',400)
    cursor = payload.get('cursor')
    if cursor is not None:
        if not isinstance(cursor,dict) or cursor.get('kind') not in ['row','field']:raise ApiError('invalid cursor',400)
        target=cursor.get('id')
        if not isinstance(target,str) or len(target)>128 or cursor['kind']=='field' and target not in FIELDS:raise ApiError('invalid cursor target',400)
        if not all(isinstance(cursor.get(k),(int,float)) and not isinstance(cursor[k],bool) and math.isfinite(cursor[k]) and 0<=cursor[k]<=1 for k in ['x','y']):raise ApiError('invalid cursor position',400)
        cursor={k:cursor[k] for k in ['kind','id','x','y']}
    now=int(time.time()*1000)
    data={'id':key,'clientId':client,'name':str(account.get('display') or account.get('username') or '使用者')[:60],
          'color':['#60a5fa','#f472b6','#34d399','#fbbf24','#a78bfa','#fb923c'][int(key[:2],16)%6],
          'orderId':order_id,'orderNumber':str(payload.get('orderNumber') or '')[:80],
          'field':field,'fieldLabel':FIELDS.get(field,''),'editing':payload.get('editing') is True,'moving':payload.get('moving') is True,'cursor':cursor,'updatedAt':now}
    storage.ensure_storage()
    if storage.DATABASE_URL:
        _prepare_table()
        with storage.get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute('DELETE FROM app_presence WHERE updated_at < %s',(now-TTL_MS,))
                if active:
                    cur.execute('INSERT INTO app_presence(presence_key,data_json,updated_at) VALUES(%s,%s,%s) ON CONFLICT(presence_key) DO UPDATE SET data_json=EXCLUDED.data_json,updated_at=EXCLUDED.updated_at',(key,storage.Jsonb(data),now))
                else:cur.execute('DELETE FROM app_presence WHERE presence_key=%s',(key,))
                cur.execute('SELECT data_json FROM app_presence WHERE presence_key<>%s AND updated_at>=%s ORDER BY updated_at DESC LIMIT 30',(key,now-TTL_MS))
                peers=[row['data_json'] for row in cur.fetchall()]
    else:
        with _LOCK:
            path=storage.DATA_DIR/'presence.json'
            values=json.loads(path.read_text()) if path.exists() else {}
            values={k:v for k,v in values.items() if v.get('updatedAt',0)>=now-TTL_MS}
            if active:values[key]=data
            else:values.pop(key,None)
            path.parent.mkdir(parents=True,exist_ok=True)
            tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(values,ensure_ascii=False),encoding='utf-8');tmp.replace(path)
            peers=sorted((v for k,v in values.items() if k!=key),key=lambda v:-v['updatedAt'])[:30]
    return {'ok':True,'peers':peers,'ttlMs':TTL_MS,'serverTime':now}
