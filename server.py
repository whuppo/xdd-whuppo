#!/usr/bin/env python3
"""Essence price tracker: proxies poe.ninja, caches responses, and records price history.

Run:  python3 server.py  (then open http://localhost:8000)
No third-party dependencies.
"""

import json
import os
import re
import sqlite3
import threading
import time
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(ROOT, "static")
DB_PATH = os.path.join(ROOT, "data", "history.sqlite")

NINJA = "https://poe.ninja/poe1/api"
IMAGE_CDN = "https://web.poecdn.com"
USER_AGENT = "essence-tracker/0.1"

CACHE_TTL = 30 * 60        # poe.ninja itself serves with max-age=1800
LEAGUES_TTL = 60 * 60
SNAPSHOT_MIN_GAP = 25 * 60  # don't store two snapshots for a league closer than this
POLL_INTERVAL = 30 * 60

TIERS = ["Whispering", "Muttering", "Weeping", "Wailing", "Screaming", "Shrieking", "Deafening"]
TIER_RE = re.compile(r"^(%s) Essence of (.+)$" % "|".join(TIERS))

_cache = {}
_cache_lock = threading.Lock()
_db_lock = threading.Lock()


# ---------- upstream ----------

def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.load(resp)


def cached(key, ttl, loader):
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
    try:
        value = loader()
    except Exception:
        if hit:  # serve stale data rather than failing
            return hit[1]
        raise
    with _cache_lock:
        _cache[key] = (now, value)
    return value


def get_leagues():
    def load():
        data = fetch_json(f"{NINJA}/data/index-state")
        return [l["name"] for l in data.get("economyLeagues", []) if not l.get("isPrivate")]
    return cached("leagues", LEAGUES_TTL, load)


def classify(name):
    m = TIER_RE.match(name)
    if m:
        return m.group(2), TIERS.index(m.group(1)) + 1
    # Special essences (Hysteria, Insanity, Horror, Delirium, Desolation, ...)
    return name.replace("Essence of ", ""), None


def load_essences(league):
    qs = urllib.parse.urlencode({"league": league, "type": "Essence"})
    raw = fetch_json(f"{NINJA}/economy/exchange/current/overview?{qs}")
    items = {i["id"]: i for i in raw.get("items", [])}
    divine_per_chaos = raw.get("core", {}).get("rates", {}).get("divine")
    out = []
    for line in raw.get("lines", []):
        item = items.get(line["id"], {})
        name = item.get("name", line["id"])
        kind, tier = classify(name)
        spark = line.get("sparkline") or {}
        out.append({
            "id": line["id"],
            "name": name,
            "kind": kind,
            "tier": tier,
            "image": IMAGE_CDN + item["image"] if item.get("image") else None,
            "chaos": line.get("primaryValue"),
            "volume": line.get("volumePrimaryValue"),
            "change": spark.get("totalChange"),
            "sparkline": spark.get("data") or [],
        })
    result = {
        "league": league,
        "fetchedAt": int(time.time()),
        "divinePrice": round(1 / divine_per_chaos, 1) if divine_per_chaos else None,
        "essences": out,
    }
    record_snapshot(result)
    return result


def get_essences(league):
    return cached(("essences", league), CACHE_TTL, lambda: load_essences(league))


# ---------- history ----------

def db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""CREATE TABLE IF NOT EXISTS prices (
        league TEXT NOT NULL, item_id TEXT NOT NULL, ts INTEGER NOT NULL,
        chaos REAL, volume REAL, PRIMARY KEY (league, item_id, ts))""")
    return conn


def record_snapshot(result):
    league, ts = result["league"], result["fetchedAt"]
    with _db_lock:
        conn = db()
        try:
            with conn:
                last = conn.execute("SELECT MAX(ts) FROM prices WHERE league = ?", (league,)).fetchone()[0]
                if last and ts - last < SNAPSHOT_MIN_GAP:
                    return
                conn.executemany(
                    "INSERT OR IGNORE INTO prices VALUES (?, ?, ?, ?, ?)",
                    [(league, e["id"], ts, e["chaos"], e["volume"]) for e in result["essences"]],
                )
        finally:
            conn.close()


def get_history(league, item_id):
    with _db_lock:
        conn = db()
        try:
            rows = conn.execute(
                "SELECT ts, chaos, volume FROM prices WHERE league = ? AND item_id = ? ORDER BY ts",
                (league, item_id),
            ).fetchall()
        finally:
            conn.close()
    return [{"ts": ts, "chaos": c, "volume": v} for ts, c, v in rows]


def poller():
    while True:
        try:
            for league in get_leagues():
                try:
                    get_essences(league)
                except Exception as exc:
                    print(f"[poller] {league}: {exc}")
        except Exception as exc:
            print(f"[poller] leagues: {exc}")
        time.sleep(POLL_INTERVAL)


# ---------- http ----------

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if not url.path.startswith("/api/"):
            return super().do_GET()
        q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
        try:
            if url.path == "/api/leagues":
                return self.send_json(get_leagues())
            league = q.get("league")
            if not league:
                return self.send_json({"error": "league is required"}, 400)
            if url.path == "/api/essences":
                return self.send_json(get_essences(league))
            if url.path == "/api/history" and q.get("id"):
                return self.send_json(get_history(league, q["id"]))
            return self.send_json({"error": "not found"}, 404)
        except Exception as exc:
            return self.send_json({"error": str(exc)}, 502)

    def log_message(self, fmt, *args):
        if args and "/api/" in str(args[0]):
            super().log_message(fmt, *args)


def main():
    port = int(os.environ.get("PORT", "8000"))
    threading.Thread(target=poller, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Essence tracker running at http://localhost:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
