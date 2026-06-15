#!/usr/bin/env python3
import errno
import socket
from api.http_server import create_server, is_blocked_static_path
from api.service import ApiError, bootstrap_payload, changes_payload, delete_entity_payload, get_state_payload, health_payload, list_entity_payload, optimize_trip_payload, recognize_order_payload, recognize_order_status_payload, report_payload, update_state_payload, upsert_entity_payload, user_action_payload
from api.storage import BASE_DIR, DATABASE_URL, LOCAL_STATE_PATH, ensure_storage, get_storage_mode
try:
    from flask import Flask, abort, jsonify, request, send_from_directory
except ImportError:
    Flask=None;abort=jsonify=request=send_from_directory=None
app=Flask(__name__,static_folder=str(BASE_DIR),static_url_path='') if Flask is not None else None
def get_lan_ips():
    ips=set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(),None,family=socket.AF_INET):
            if not info[4][0].startswith('127.'):ips.add(info[4][0])
    except OSError:pass
    return sorted(ips)
if app is not None:
    def bearer_token():
        scheme,_,token=request.headers.get('Authorization','').partition(' ');return token.strip() if scheme.lower()=='bearer' else ''
    def service_response(operation,*args):
        try:return jsonify(operation(*args))
        except ApiError as err:return jsonify(err.payload),err.status
        except Exception as err:return jsonify({'ok':False,'error':str(err)}),500
    @app.get('/api/health')
    @app.get('/health')
    def health():return service_response(health_payload)
    @app.get('/api/bootstrap')
    def bootstrap():return service_response(bootstrap_payload,bearer_token())
    @app.get('/api/state')
    @app.get('/state')
    def get_state():return service_response(get_state_payload,bearer_token())
    @app.post('/api/state')
    @app.post('/state')
    def post_state():return service_response(update_state_payload,bearer_token(),request.get_json(silent=True))
    @app.post('/api/users')
    @app.post('/users')
    def post_users():return service_response(user_action_payload,bearer_token(),request.get_json(silent=True))
    @app.post('/api/trips/optimize')
    @app.post('/trips/optimize')
    def post_optimize_trip():return service_response(optimize_trip_payload,bearer_token(),request.get_json(silent=True))
    @app.post('/api/orders/recognize')
    def post_recognize_order():return service_response(recognize_order_payload,bearer_token(),request.get_json(silent=True))
    @app.get('/api/orders/recognize/status')
    def get_recognize_order_status():return service_response(recognize_order_status_payload,bearer_token())
    @app.get('/api/data/<entity>')
    def list_entity(entity):return service_response(list_entity_payload,bearer_token(),entity,request.args.get('page',1),request.args.get('pageSize',100),request.args.get('q',''))
    @app.put('/api/data/<entity>/<record_id>')
    def put_entity(entity,record_id):return service_response(upsert_entity_payload,bearer_token(),entity,record_id,request.get_json(silent=True))
    @app.delete('/api/data/<entity>/<record_id>')
    def remove_entity(entity,record_id):return service_response(delete_entity_payload,bearer_token(),entity,record_id)
    @app.get('/api/changes')
    def get_changes():return service_response(changes_payload,bearer_token(),request.args.get('since',0),request.args.get('limit',1000))
    @app.get('/api/reports/summary')
    def get_report():return service_response(report_payload,bearer_token())
    @app.get('/')
    def index():return send_from_directory(BASE_DIR,'index.html')
    @app.get('/<path:path>')
    def static_files(path):
        if path.startswith('api/'):abort(404)
        if is_blocked_static_path(path):abort(403)
        return send_from_directory(BASE_DIR,path)
def _resolve_port(host,preferred_port,max_tries=20):
    for candidate in range(preferred_port,preferred_port+max_tries):
        with socket.socket(socket.AF_INET,socket.SOCK_STREAM) as probe:
            try:probe.bind((host,candidate));return candidate
            except OSError as err:
                if err.errno!=errno.EADDRINUSE:raise
    raise SystemExit(f'[ERROR] 找不到可用連接埠（起始埠 {preferred_port}）。')
def run_server(host,port):
    actual_port=_resolve_port(host,port);ensure_storage();print(f'[INFO] centralized storage: {get_storage_mode()}')
    if not DATABASE_URL:print(f'[INFO] 使用本機 {LOCAL_STATE_PATH} 儲存。')
    print(f'[INFO] server running: http://{host}:{actual_port}')
    if host=='0.0.0.0':
        for ip in get_lan_ips():print(f'       http://{ip}:{actual_port}')
    if app is not None:app.run(host=host,port=actual_port,use_reloader=False);return
    server=create_server(host,actual_port)
    try:server.serve_forever()
    finally:server.server_close()
if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--host',default='127.0.0.1');parser.add_argument('--port',type=int,default=4173);args=parser.parse_args();run_server(args.host,args.port)
