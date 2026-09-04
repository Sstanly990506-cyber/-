from pathlib import Path
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def read_json_body(handler):
    length = int(handler.headers.get("Content-Length", "0"))
    raw = handler.rfile.read(length) if length else b"{}"
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return None


def json_response(handler, status, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def get_bearer_token(handler):
    value = handler.headers.get("Authorization", "")
    scheme, _, token = value.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return ""
    return token.strip()


def discard_small_rejected_body(handler):
    """Avoid Windows TCP resets hiding 4xx responses when a small body is pending.

    Never parse, store or log rejected content. Do not drain unbounded/chunked input.
    """
    if getattr(handler, '_body_read', False) or handler.headers.get('Transfer-Encoding'):
        return
    lengths = handler.headers.get_all('Content-Length') or ['0']
    previous = handler.connection.gettimeout()
    try:
        size = int(lengths[0])
        if len(lengths) == 1 and 0 < size <= 16384:
            handler.connection.settimeout(1)
            handler.rfile.read(size)
            handler._body_read = True
    except (ValueError, OSError):
        pass
    finally:
        handler.connection.settimeout(previous)
