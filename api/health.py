from http.server import BaseHTTPRequestHandler

from api._common import json_response
from api.service import health_payload


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            json_response(self, 200, health_payload())
        except Exception as err:
            json_response(self, 500, {'ok': False, 'error': str(err)})
