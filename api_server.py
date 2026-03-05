#!/usr/bin/env python3
import json
import os
import socket
import sqlite3
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

DB_PATH = os.environ.get("APP_DB_PATH", "data.db")
SENSITIVE_SUFFIXES = {".db", ".sqlite", ".sqlite3", ".py", ".bat", ".ps1", ".sh"}


class AppServer(ThreadingHTTPServer):
    allow_reuse_address = True


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS app_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            state_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO app_state (id, state_json, updated_at)
        VALUES (1, ?, strftime('%s','now') * 1000)
        """,
        (
            json.dumps(
                {
                    "glossOptions": ["A光", "B光"],
                    "customers": [],
                    "orders": [],
                    "audits": [],
                    "receivables": [],
                    "payables": [],
                    "syncTick": 0,
                },
                ensure_ascii=False,
            ),
        ),
    )
    conn.commit()
    conn.close()


def read_state():
    conn = sqlite3.connect(DB_PATH)
    row = conn.execute("SELECT state_json, updated_at FROM app_state WHERE id = 1").fetchone()
    conn.close()
    state = json.loads(row[0])
    state["serverUpdatedAt"] = row[1]
    return state


def write_state(new_state):
    tick = int(new_state.get("syncTick") or 0)
    conn = sqlite3.connect(DB_PATH)
    row = conn.execute("SELECT updated_at FROM app_state WHERE id = 1").fetchone()
    current_tick = int(row[0] if row else 0)
    if tick < current_tick:
        conn.close()
        return False, current_tick
    conn.execute(
        "UPDATE app_state SET state_json = ?, updated_at = ? WHERE id = 1",
        (json.dumps(new_state, ensure_ascii=False), tick),
    )
    conn.commit()
    conn.close()
    return True, tick


def get_lan_ips():
    ips = set()
    try:
        host = socket.gethostname()
        for info in socket.getaddrinfo(host, None, family=socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127."):
                ips.add(ip)
    except OSError:
        pass

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            ip = sock.getsockname()[0]
            if ip and not ip.startswith("127."):
                ips.add(ip)
    except OSError:
        pass

    return sorted(ips)


class Handler(SimpleHTTPRequestHandler):
    def _json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _is_sensitive_path(self):
        path = self.path.split("?", 1)[0].lower()
        return any(path.endswith(suffix) for suffix in SENSITIVE_SUFFIXES)

    def do_GET(self):
        if self.path == "/api/state":
            self._json(200, read_state())
            return
        if self.path == "/api/health":
            self._json(200, {"ok": True, "db": DB_PATH})
            return
        if self._is_sensitive_path():
            self.send_error(403, "forbidden")
            return
        return super().do_GET()

    def do_POST(self):
        if self.path != "/api/state":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception:
            self._json(400, {"error": "invalid json"})
            return
        required = ["glossOptions", "customers", "orders", "audits", "receivables", "payables"]
        for key in required:
            if key not in payload:
                self._json(400, {"error": f"missing key: {key}"})
                return
        if not payload.get("syncTick"):
            payload["syncTick"] = int(__import__("time").time() * 1000)
        ok, tick = write_state(payload)
        if not ok:
            self._json(409, {"error": "stale syncTick", "serverSyncTick": tick})
            return
        self._json(200, {"ok": True, "syncTick": payload["syncTick"]})


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4173)
    args = parser.parse_args()

    init_db()
    print(f"[INFO] centralized DB: {DB_PATH}")
    print(f"[INFO] server running: http://{args.host}:{args.port}")
    if args.host == "0.0.0.0":
        lan_ips = get_lan_ips()
        if lan_ips:
            print("[INFO] LAN 可用網址：")
            for ip in lan_ips:
                print(f"       http://{ip}:{args.port}")
        else:
            print("[WARN] 無法自動偵測區網 IP，請手動查詢電腦 IP 後讓手機連線。")
    AppServer((args.host, args.port), Handler).serve_forever()
