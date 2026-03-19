#!/usr/bin/env python3
import itertools
import json
import math
import os
import socket
import time
from pathlib import Path
from threading import Lock
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from flask import Flask, abort, jsonify, request, send_from_directory
from psycopg import connect
<<<<<< codex/add-options-for-loading-and-delivery-in-tickets-hybuzu
from psycopg import Error as PsycopgError
=======
>>>>>> main
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

BASE_DIR = Path(__file__).resolve().parent
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
SENSITIVE_SUFFIXES = {".db", ".sqlite", ".sqlite3", ".py", ".bat", ".ps1", ".sh"}
DEFAULT_APP_STATE = {
    "glossOptions": ["PVA光", "PVB光/油", "耐磨", "壓光"],
    "customers": [],
    "orders": [],
    "audits": [],
    "receivables": [],
    "payables": [],
    "systemEvents": [],
    "settings": None,
    "inventoryItems": [],
    "syncTick": 0,
}
DB_INIT_LOCK = Lock()
DB_INITIALIZED = False

app = Flask(__name__, static_folder=str(BASE_DIR), static_url_path="")


def normalize_database_url(url: str) -> str:
    if not url:
        raise RuntimeError("DATABASE_URL 未設定，無法連線到 PostgreSQL")
    parsed = urlparse(url)
    if parsed.scheme not in {"postgres", "postgresql"}:
        raise RuntimeError("DATABASE_URL 必須是 PostgreSQL 連線字串")
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query.setdefault("sslmode", "require")
    return urlunparse(parsed._replace(query=urlencode(query)))


def get_db_connection():
    return connect(normalize_database_url(DATABASE_URL), row_factory=dict_row)


def ensure_db():
    global DB_INITIALIZED
    if DB_INITIALIZED:
        return
    with DB_INIT_LOCK:
        if DB_INITIALIZED:
            return
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS app_state (
                        id SMALLINT PRIMARY KEY CHECK (id = 1),
                        state_json JSONB NOT NULL,
                        updated_at BIGINT NOT NULL
                    )
                    """
                )
                cur.execute(
                    """
                    INSERT INTO app_state (id, state_json, updated_at)
                    VALUES (1, %s, %s)
                    ON CONFLICT (id) DO NOTHING
                    """,
                    (Jsonb(DEFAULT_APP_STATE), 0),
                )
            conn.commit()
        DB_INITIALIZED = True


def read_state():
    ensure_db()
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT state_json, updated_at FROM app_state WHERE id = 1")
            row = cur.fetchone()
    state = row["state_json"] if isinstance(row["state_json"], dict) else json.loads(row["state_json"])
    state["serverUpdatedAt"] = int(row["updated_at"] or 0)
    return state


def write_state(new_state):
    ensure_db()
    tick = int(new_state.get("syncTick") or int(time.time() * 1000))
    payload = dict(new_state)
    payload["syncTick"] = tick
    with get_db_connection() as conn:
        with conn.transaction():
            with conn.cursor() as cur:
                cur.execute("SELECT updated_at FROM app_state WHERE id = 1 FOR UPDATE")
                row = cur.fetchone()
                current_tick = int((row or {}).get("updated_at") or 0)
                if tick < current_tick:
                    return False, current_tick
                cur.execute(
                    "UPDATE app_state SET state_json = %s, updated_at = %s WHERE id = 1",
                    (Jsonb(payload), tick),
                )
        conn.commit()
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


def infer_segment(a, b):
    dx = (float(a.get("lat", 0)) - float(b.get("lat", 0))) * 111000
    dy = (float(a.get("lng", 0)) - float(b.get("lng", 0))) * 101000
    meters = int(math.sqrt(dx * dx + dy * dy))
    duration_sec = max(60, int((meters / 1000) * 180))
    return {"durationSec": duration_sec, "distanceM": meters}


def evaluate_route(route):
    total_duration = 0
    total_distance = 0
    for i in range(len(route) - 1):
        seg = infer_segment(route[i], route[i + 1])
        total_duration += seg["durationSec"]
        total_distance += seg["distanceM"]
    return total_duration, total_distance


def build_maps_url(route):
    origin = f"{route[0]['lat']},{route[0]['lng']}"
    destination = f"{route[-1]['lat']},{route[-1]['lng']}"
    waypoints = "|".join([f"{r['lat']},{r['lng']}" for r in route[1:-1]])
    from urllib.parse import quote

    return (
        "https://www.google.com/maps/dir/?api=1"
        f"&origin={quote(origin)}"
        f"&destination={quote(destination)}"
        "&travelmode=driving"
        f"&waypoints={quote(waypoints)}"
    )


def optimize_trip(payload):
    factory = payload.get("factory")
    stops = payload.get("stops", [])
    if not factory or not isinstance(stops, list):
        raise ValueError("factory/stops invalid")

    deliveries = [s for s in stops if s.get("type") == "delivery"]
    pickups = [s for s in stops if s.get("type") == "pickup"]

    if not stops:
        raise ValueError("stops required")

    best_route = None
    best_duration = None
    best_distance = None
    candidate_count = 0

    for d_perm in itertools.permutations(deliveries):
        for p_perm in itertools.permutations(pickups):
            route = [factory] + list(d_perm) + list(p_perm) + [factory]
            duration, distance = evaluate_route(route)
            candidate_count += 1
            if best_duration is None or duration < best_duration:
                best_route = route
                best_duration = duration
                best_distance = distance

    return {
        "originalStops": stops,
        "grouped": {
            "deliveries": deliveries,
            "pickups": pickups,
        },
        "candidateCount": candidate_count,
        "bestRoute": {
            "pointIds": [p.get("id") for p in best_route],
            "orderedStops": best_route,
            "totalDurationSec": best_duration,
            "totalDistanceM": best_distance,
        },
        "googleMapsUrl": build_maps_url(best_route),
    }


def is_sensitive_path(path: str) -> bool:
    normalized = path.split("?", 1)[0].lower()
    return any(normalized.endswith(suffix) for suffix in SENSITIVE_SUFFIXES)


<<<<<< codex/add-options-for-loading-and-delivery-in-tickets-hybuzu
def json_error(message, status=500):
    return jsonify({"ok": False, "error": message}), status


@app.get("/api/health")
@app.get("/health")
def health():
    try:
        ensure_db()
        return jsonify({"ok": True, "database": "postgresql", "hasDatabaseUrl": bool(DATABASE_URL)})
    except (RuntimeError, PsycopgError) as err:
        return json_error(str(err), 500)


@app.get("/api/state")
@app.get("/state")
def get_state():
    try:
        return jsonify(read_state())
    except (RuntimeError, PsycopgError) as err:
        return json_error(str(err), 500)


@app.post("/api/state")
@app.post("/state")
=======
@app.get("/api/health")
def health():
    ensure_db()
    return jsonify({"ok": True, "database": "postgresql", "hasDatabaseUrl": bool(DATABASE_URL)})


@app.get("/api/state")
def get_state():
    return jsonify(read_state())


@app.post("/api/state")
>>>>>> main
def post_state():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid json"}), 400

    required = ["glossOptions", "customers", "orders", "audits", "receivables", "payables"]
    for key in required:
        if key not in payload:
            return jsonify({"error": f"missing key: {key}"}), 400

<<<<<< codex/add-options-for-loading-and-delivery-in-tickets-hybuzu
    try:
        ok, tick = write_state(payload)
    except (RuntimeError, PsycopgError) as err:
        return json_error(str(err), 500)
=======
    ok, tick = write_state(payload)
>>>>>> main
    if not ok:
        return jsonify({"error": "stale syncTick", "serverSyncTick": tick}), 409
    return jsonify({"ok": True, "syncTick": tick})


@app.post("/api/trips/optimize")
<<<<<< codex/add-options-for-loading-and-delivery-in-tickets-hybuzu
@app.post("/trips/optimize")
=======
>>>>>> main
def post_optimize_trip():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid json"}), 400
    try:
        result = optimize_trip(payload)
    except ValueError as err:
        return jsonify({"error": str(err)}), 400
    return jsonify(result)


@app.get("/")
def index():
    return send_from_directory(BASE_DIR, "index.html")


@app.get("/<path:path>")
def static_files(path):
    if path.startswith("api/"):
        abort(404)
    if is_sensitive_path(path):
        abort(403)
    file_path = BASE_DIR / path
    if not file_path.exists() or not file_path.is_file():
        abort(404)
    return send_from_directory(BASE_DIR, path)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4173)
    args = parser.parse_args()

    ensure_db()
    print("[INFO] centralized DB: PostgreSQL via DATABASE_URL")
    print(f"[INFO] server running: http://{args.host}:{args.port}")
    if args.host == "0.0.0.0":
        lan_ips = get_lan_ips()
        if lan_ips:
            print("[INFO] LAN 可用網址：")
            for ip in lan_ips:
                print(f"       http://{ip}:{args.port}")
        else:
            print("[WARN] 無法自動偵測區網 IP，請手動查詢電腦 IP 後讓手機連線。")
    app.run(host=args.host, port=args.port)
