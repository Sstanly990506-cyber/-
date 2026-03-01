#!/usr/bin/env python3
import json
import os
import sqlite3
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

DB_PATH = os.environ.get("APP_DB_PATH", "data.db")


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
    conn.execute(
        "UPDATE app_state SET state_json = ?, updated_at = ? WHERE id = 1",
        (json.dumps(new_state, ensure_ascii=False), tick),
    )
    conn.commit()
    conn.close()


class Handler(SimpleHTTPRequestHandler):
    def _json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/state":
            self._json(200, read_state())
            return
        if self.path == "/api/health":
            self._json(200, {"ok": True, "db": DB_PATH})
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
        write_state(payload)
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
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()

