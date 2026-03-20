from http.server import BaseHTTPRequestHandler

from api_server import optimize_trip

from api._common import json_response, read_json_body


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        payload = read_json_body(self)
        if not isinstance(payload, dict):
            json_response(self, 400, {"error": "invalid json"})
            return
        try:
            json_response(self, 200, optimize_trip(payload))
        except ValueError as err:
            json_response(self, 400, {"error": str(err)})
