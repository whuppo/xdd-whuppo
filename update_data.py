#!/usr/bin/env python3
"""Fetch essence prices from poe.ninja and write the static JSON files the site reads.

Used by the GitHub Action (every 30 min) and by server.py for local runs.

Output layout (under --out, default ./data):
  leagues.json                      [{"name": "Covens", "slug": "covens"}, ...]
  essences/<league-slug>.json       current prices: {league, fetchedAt, divinePrice, essences: [...]}
  history/<league-slug>/<id>.json   [[unix_ts, chaos, volume], ...], oldest first

No third-party dependencies.
"""

import argparse
import json
import os
import re
import shutil
import sys
import time
import urllib.parse
import urllib.request

NINJA = "https://poe.ninja/poe1/api"
IMAGE_CDN = "https://web.poecdn.com"
USER_AGENT = "essence-tracker/0.1"

ALL_TIERS = ["Whispering", "Muttering", "Weeping", "Wailing", "Screaming", "Shrieking", "Deafening"]
# Lower tiers barely show up in the actual game, so we don't track them.
TRACKED_TIERS = {"Screaming", "Shrieking", "Deafening"}
TIER_RE = re.compile(r"^(%s) Essence of (.+)$" % "|".join(ALL_TIERS))

SNAPSHOT_MIN_GAP = 25 * 60  # skip a history point if the last one is newer than this
HISTORY_DAYS = 90           # keep this much history per item


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def slugify(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def classify(name):
    m = TIER_RE.match(name)
    if m:
        return m.group(2), m.group(1)
    # Special essences (Hysteria, Insanity, Horror, Delirium, Desolation, ...)
    return name.replace("Essence of ", ""), None


def fetch_leagues():
    data = fetch_json(f"{NINJA}/data/index-state")
    return [l["name"] for l in data.get("economyLeagues", []) if not l.get("isPrivate")]


def fetch_essences(league):
    qs = urllib.parse.urlencode({"league": league, "type": "Essence"})
    raw = fetch_json(f"{NINJA}/economy/exchange/current/overview?{qs}")
    items = {i["id"]: i for i in raw.get("items", [])}
    divine_per_chaos = raw.get("core", {}).get("rates", {}).get("divine")
    out = []
    for line in raw.get("lines", []):
        item = items.get(line["id"], {})
        name = item.get("name", line["id"])
        kind, tier = classify(name)
        if tier and tier not in TRACKED_TIERS:
            continue
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
    return {
        "league": league,
        "fetchedAt": int(time.time()),
        "divinePrice": round(1 / divine_per_chaos, 1) if divine_per_chaos else None,
        "essences": out,
    }


def write_json(path, obj):
    """Write atomically so a reader (or a failed run) never sees a half-written file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(tmp, path)


def read_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def append_history(out, slug, result):
    ts = result["fetchedAt"]
    cutoff = ts - HISTORY_DAYS * 86400
    added = 0
    for e in result["essences"]:
        path = os.path.join(out, "history", slug, f"{e['id']}.json")
        points = read_json(path, [])
        if points and ts - points[-1][0] < SNAPSHOT_MIN_GAP:
            continue
        points.append([ts, e["chaos"], e["volume"]])
        write_json(path, [p for p in points if p[0] >= cutoff])
        added += 1
    return added


def prune(out, keep_slugs):
    """Drop data for leagues poe.ninja no longer lists, so the site stays small."""
    for sub in ("essences", "history"):
        base = os.path.join(out, sub)
        if not os.path.isdir(base):
            continue
        for name in os.listdir(base):
            slug = name[:-5] if name.endswith(".json") else name
            if slug not in keep_slugs:
                target = os.path.join(base, name)
                shutil.rmtree(target) if os.path.isdir(target) else os.remove(target)


def update_all(out, log=print):
    """Refresh every current league. Returns the number of leagues that failed."""
    leagues = fetch_leagues()
    failed = 0
    ok = []
    for name in leagues:
        slug = slugify(name)
        try:
            result = fetch_essences(name)
            write_json(os.path.join(out, "essences", f"{slug}.json"), result)
            added = append_history(out, slug, result)
            ok.append({"name": name, "slug": slug})
            log(f"{name}: {len(result['essences'])} essences, {added} history points")
        except Exception as exc:  # keep going; one bad league shouldn't block the rest
            failed += 1
            log(f"{name}: FAILED ({exc})")
            if os.path.exists(os.path.join(out, "essences", f"{slug}.json")):
                ok.append({"name": name, "slug": slug})  # keep serving last good data
    write_json(os.path.join(out, "leagues.json"), ok)
    prune(out, {l["slug"] for l in ok})
    return failed if ok else len(leagues) or 1


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))
    args = parser.parse_args()
    failed = update_all(args.out)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
