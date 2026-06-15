import mimetypes
from functools import partial
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs,unquote,urlparse
from api._common import get_bearer_token,json_response,read_json_body
from api.service import ApiError,bootstrap_payload,changes_payload,delete_entity_payload,get_state_payload,health_payload,list_entity_payload,optimize_trip_payload,recognize_order_payload,report_payload,update_state_payload,upsert_entity_payload,user_action_payload
from api.storage import BASE_DIR
SENSITIVE_SUFFIXES={'.db','.sqlite','.sqlite3','.py','.bat','.ps1','.sh'};BLOCKED_PATH_PARTS={'data'};PUBLIC_ROOT=Path(BASE_DIR).resolve()
def is_sensitive_path(path):return any(path.split('?',1)[0].lower().endswith(s) for s in SENSITIVE_SUFFIXES)
def is_blocked_static_path(path):
    c=Path(path);parts=[p.lower() for p in c.parts if p not in {'','.'}];return c.is_absolute() or '..' in parts or any(p in BLOCKED_PATH_PARTS for p in parts) or is_sensitive_path(path)
def resolve_public_file(rel):
    if is_blocked_static_path(rel):return None
    f=(PUBLIC_ROOT/rel).resolve()
    try:f.relative_to(PUBLIC_ROOT)
    except ValueError:return None
    return f
class AppRequestHandler(BaseHTTPRequestHandler):
    server_version='GlossApp/2.0'
    def log_message(self,format,*args):return
    def send_service_response(self,op,*args):
        try:json_response(self,200,op(*args))
        except ApiError as err:json_response(self,err.status,err.payload)
        except Exception as err:json_response(self,500,{'ok':False,'error':str(err)})
    def do_GET(self):
        p=urlparse(self.path);path=p.path or '/';q=parse_qs(p.query);token=get_bearer_token(self)
        if path in {'/api/health','/health'}:self.send_service_response(health_payload)
        elif path=='/api/bootstrap':self.send_service_response(bootstrap_payload,token)
        elif path in {'/api/state','/state'}:self.send_service_response(get_state_payload,token)
        elif path=='/api/changes':self.send_service_response(changes_payload,token,q.get('since',['0'])[0],q.get('limit',['1000'])[0])
        elif path=='/api/reports/summary':self.send_service_response(report_payload,token)
        elif path.startswith('/api/data/'):
            entity=path.split('/')[3];self.send_service_response(list_entity_payload,token,entity,q.get('page',['1'])[0],q.get('pageSize',['100'])[0],q.get('q',[''])[0])
        elif path=='/':self.serve_file('index.html')
        else:
            rel=unquote(path.lstrip('/'))
            if rel.startswith('api/'):self.send_error(404)
            elif is_blocked_static_path(rel):self.send_error(403)
            else:self.serve_file(rel)
    def do_POST(self):
        path=urlparse(self.path).path or '/';token=get_bearer_token(self)
        if path in {'/api/state','/state'}:self.send_service_response(update_state_payload,token,read_json_body(self))
        elif path in {'/api/users','/users'}:self.send_service_response(user_action_payload,token,read_json_body(self))
        elif path in {'/api/trips/optimize','/trips/optimize'}:self.send_service_response(optimize_trip_payload,token,read_json_body(self))
        elif path=='/api/orders/recognize':self.send_service_response(recognize_order_payload,token,read_json_body(self))
        else:self.send_error(404)
    def do_PUT(self):
        parts=urlparse(self.path).path.split('/');token=get_bearer_token(self)
        if len(parts)>=5 and parts[1:3]==['api','data']:self.send_service_response(upsert_entity_payload,token,parts[3],unquote('/'.join(parts[4:])),read_json_body(self))
        else:self.send_error(404)
    def do_DELETE(self):
        parts=urlparse(self.path).path.split('/');token=get_bearer_token(self)
        if len(parts)>=5 and parts[1:3]==['api','data']:self.send_service_response(delete_entity_payload,token,parts[3],unquote('/'.join(parts[4:])))
        else:self.send_error(404)
    def serve_file(self,rel):
        f=resolve_public_file(rel)
        if f is None:self.send_error(403);return
        if not f.exists() or not f.is_file():self.send_error(404);return
        body=f.read_bytes();ctype=mimetypes.guess_type(str(f))[0] or 'application/octet-stream';self.send_response(200);self.send_header('Content-Type',ctype);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
def create_server(host,port):return ThreadingHTTPServer((host,port),partial(AppRequestHandler))
