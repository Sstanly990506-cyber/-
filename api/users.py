from http.server import BaseHTTPRequestHandler

from api._common import get_bearer_token, json_response, read_json_body
from api.service import ApiError, user_action_payload


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            payload = user_action_payload(get_bearer_token(self), read_json_body(self))
            json_response(self, 200, payload)
        except ApiError as err:
            json_response(self, err.status, err.payload)
        except Exception as err:
            json_response(self, 500, {'ok': False, 'error': str(err)})
