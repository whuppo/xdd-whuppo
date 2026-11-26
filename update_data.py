#!/usr/bin/env python3
"""Fetch the data the site's tools need and write it as static JSON.

Run every 30 minutes by the updater Lambda (lambda_handler.py, which syncs the output to S3)
and by server.py for local runs. Each tool that needs fetched data has a fetcher in FETCHERS.

Output layout (under --out, default ./data):
  essences tool (at the root for historical reasons; new tools use <tool>/...):
    leagues.json                      [{"name": "Covens", "slug": "covens"}, ...]
    essences/<league-slug>.json       current prices: {league, fetchedAt, divinePrice, primalLifeforce,
                                      essences: [...]}; primalLifeforce is chaos per unit, or null
    history/<league-slug>/<id>.json   [[unix_ts, chaos, volume], ...], oldest first
  xesht tool:
    xesht/leagues.json                [{"name": "Covens", "slug": "covens"}, ...]
    xesht/<league-slug>.json          {league, fetchedAt, divinePrice, xesht, pairs, variants, items: [...]}

No third-party dependencies. Keep it that way if you can: the Lambda deploy zips these files as-is.
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


def fetch_overview(league, item_type):
    qs = urllib.parse.urlencode({"league": league, "type": item_type})
    return fetch_json(f"{NINJA}/economy/exchange/current/overview?{qs}")


def fetch_primal_lifeforce(league):
    """Chaos price of one Primal Crystallised Lifeforce, or None if it isn't trading in this league."""
    for line in fetch_overview(league, "Currency").get("lines", []):
        if line["id"] == "primal-lifeforce":
            return line.get("primaryValue")
    return None


def fetch_essences(league):
    raw = fetch_overview(league, "Essence")
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


def update_essences(out, log=print):
    """Refresh essence prices for every current league. Returns the number of leagues that failed."""
    leagues = fetch_leagues()
    failed = 0
    ok = []
    for name in leagues:
        slug = slugify(name)
        try:
            result = fetch_essences(name)
            path = os.path.join(out, "essences", f"{slug}.json")
            try:
                result["primalLifeforce"] = fetch_primal_lifeforce(name)
            except Exception as exc:  # essence prices are still good; reuse the last lifeforce price
                failed += 1
                result["primalLifeforce"] = read_json(path, {}).get("primalLifeforce")
                log(f"{name}: lifeforce price FAILED ({exc})")
            write_json(path, result)
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


# ---------- Flesh of Xesht ----------

# Flesh of Xesht turns a Breach unique into its alternate and back. A Foulborn unique stays Foulborn
# but its Foulborn mod is re-rolled among the alternate's. Skin of the Loyal is left out: its
# alternate, Skin of the Lords, is always corrupted and poe.ninja doesn't price it.
# Sources: poewiki.net "List of Breach unique items" and "Foulborn unique item".
# Kept here rather than in a data file because the Lambda deploy zips only this script.
XESHT_PAIRS = [
    ("Xoph's Inception", "Xoph's Nurture"),
    ('The Formless Flame', 'The Formless Inferno'),
    ("Xoph's Heart", "Xoph's Blood"),
    ('Tulborn', 'Tulfall'),
    ('The Snowblind Grace', 'The Perfect Form'),
    ('The Halcyon', 'The Pandemonius'),
    ('Hand of Thought and Motion', 'Hand of Wisdom and Action'),
    ("Esh's Mirror", "Esh's Visage"),
    ('Voice of the Storm', 'Choir of the Storm'),
    ("Uul-Netol's Kiss", "Uul-Netol's Embrace"),
    ('The Infinite Pursuit', 'The Red Trail'),
    ('The Anticipation', 'The Surrender'),
    ('Severed in Sleep', 'United in Dream'),
    ('The Red Dream', 'The Red Nightmare'),
    ('The Green Dream', 'The Green Nightmare'),
    ('The Blue Dream', 'The Blue Nightmare'),
    ('Eye of Chayula', 'Presence of Chayula'),
]

# Single-mod Foulborn variants per unique: (poe.ninja variant label, the Foulborn mod's text).
XESHT_VARIANTS = {
    "Xoph's Inception": [
        ('Returning Projectiles', 'Socketed Gems are Supported by Level 20 Returning Projectiles'),
        ('Fast Ignite', 'Ignites you inflict deal Damage (20-40)% faster'),
    ],
    "Xoph's Nurture": [
        ('All Ignite', 'All Damage can Ignite'),
        ('Immolate', 'Socketed Gems are Supported by Level 30 Immolate'),
    ],
    'The Formless Flame': [
        ('Fire to Physical', '30% of Fire Damage from Hits taken as Physical Damage'),
        ('Totem Overcap', 'Totem Life is increased by their Overcapped Fire Resistance'),
    ],
    'The Formless Inferno': [
        ('Fire to Physical', '30% of Fire Damage from Hits taken as Physical Damage'),
        ('Minion Life', 'Socketed Gems are Supported by Level 30 Minion Life'),
    ],
    "Xoph's Heart": [
        ('Debilitate', 'Nearby Enemies are Debilitated'),
        ('Fire', '(5-15)% of Physical Damage from Hits taken as Fire Damage'),
    ],
    "Xoph's Blood": [
        ('Fire', '(5-15)% of Physical Damage from Hits taken as Fire Damage'),
        ('Elemental Overload', 'Elemental Overload'),
    ],
    'Tulborn': [
        ('Cold Spell Level', '+(2-3) to Level of all Cold Spell Skill Gems'),
        ('Mana Power', 'Gain a Power Charge after Spending a total of 200 Mana'),
    ],
    'Tulfall': [
        ('Mana Power', 'Gain a Power Charge after Spending a total of 200 Mana'),
        ('Cold Multi', '+(15-20)% to Cold Damage over Time Multiplier per Power Charge'),
    ],
    'The Snowblind Grace': [
        ('Life Evasion', '+6 to Evasion Rating per 10 Player Maximum Life'),
        ('Purity of Ice', 'Purity of Ice has no Reservation'),
    ],
    'The Perfect Form': [
        ('Life Evasion', '+8 to Evasion Rating per 10 Player Maximum Life'),
        ('Ghost Dance', 'Ghost Dance'),
    ],
    'The Halcyon': [
        ('Freeze Immune', 'Cannot be Frozen'),
        ('Cold', '(5-15)% of Physical Damage from Hits taken as Cold Damage'),
    ],
    'The Pandemonius': [
        ('Cold', '(5-15)% of Physical Damage from Hits taken as Cold Damage'),
        ('Chill Immune', 'Cannot be Chilled'),
    ],
    'Hand of Thought and Motion': [
        ('Int Accuracy', '3% increased Accuracy Rating per 25 Intelligence'),
        ('Strength', '(8-12)% increased Strength'),
    ],
    'Hand of Wisdom and Action': [
        ('Dex Multi', '+3% to Critical Strike Multiplier per 25 Dexterity'),
        ('Strength', '(8-12)% increased Strength'),
    ],
    "Esh's Mirror": [
        ('Shock Low Life', 'Hits always Shock Enemies that are on Low Life'),
        ('No Reflect', 'Damage cannot be Reflected'),
    ],
    "Esh's Visage": [
        ('Chaos Shield', 'Chaos Damage taken does not bypass Energy Shield while not on Low Mana'),
        ('No Reflect', 'Damage cannot be Reflected'),
    ],
    'Voice of the Storm': [
        ('Unlucky Damage', 'Damage of Enemies Hitting you is Unlucky'),
        ('Max Lightning', '+3% to maximum Lightning Resistance'),
    ],
    'Choir of the Storm': [
        ('Max Lightning', '+3% to maximum Lightning Resistance'),
        ('Overcap Mana', 'Mana is increased by 1% per 4% Overcapped Lightning Resistance'),
    ],
    "Uul-Netol's Kiss": [
        ('Exert', 'Warcries Exert 1 additional Attack'),
        ('Cooldown', '500% increased Warcry Cooldown Recovery Rate'),
    ],
    "Uul-Netol's Embrace": [
        ('Fast Bleed', 'Bleeding you inflict deals Damage (20-40)% faster'),
        ('Low Intelligence', '80% reduced Intelligence'),
    ],
    'The Infinite Pursuit': [
        ('Bleed Immune', 'Immune to Elemental Ailments while Bleeding'),
        ('Bleed Armour', '(50-100)% increased Armour while Bleeding'),
    ],
    'The Red Trail': [
        ('Bleed Power', 'Gain a Power Charge on Hit while Bleeding'),
        ('Stationary Endurance', 'Gain an Endurance Charge each second while Stationary'),
    ],
    'The Anticipation': [
        ('Armour Elemental', '(8-12)% of Armour applies to Fire, Cold and Lightning Damage taken from Hits if you have Blocked Recently'),
        ('Max Block', '+3% to maximum Chance to Block Attack Damage'),
    ],
    'The Surrender': [
        ('Max Block', '+3% to maximum Chance to Block Attack Damage'),
        ('Block Shield', 'Gain (300-650) Energy Shield when you Block'),
    ],
    'Severed in Sleep': [
        ('Minion Crit', 'Minions have +5% to Critical Strike Chance'),
        ('Minion Unholy', 'Minions have 25% chance to gain Unholy Might for 4 seconds on Kill'),
    ],
    'United in Dream': [
        ('Minion Quality', '+(20-30)% to Quality of all Minion Skill Gems'),
        ('Minion Unholy', 'Minions have 25% chance to gain Unholy Might for 4 seconds on Kill'),
    ],
    'The Red Dream': [
        ('Fire Life', 'Passives granting Fire Resistance or all Elemental Resistances in Radius also grant increased Maximum Life at 50% of its value'),
        ('Endurance Chaos', '+4% to Chaos Resistance per Endurance Charge'),
        ('Fire Lucky', "Fire Damage with Hits is Lucky if you've Blocked an Attack Recently"),
    ],
    'The Red Nightmare': [
        ('Endurance Chaos', '+4% to Chaos Resistance per Endurance Charge'),
        ('Fire Lucky', "Fire Damage with Hits is Lucky if you've Blocked an Attack Recently"),
        ('Fire to Chaos', 'Passives granting Fire Resistance or all Elemental Resistances in Radius also grant Fire Damage Converted to Chaos Damage at 100% of its value'),
    ],
    'The Green Dream': [
        ('Cold to Mana', 'Passives granting Cold Resistance or all Elemental Resistances in Radius also grant increased Maximum Mana at 75% of its value'),
        ('Frenzy Speed', '1% increased Movement Speed per Frenzy Charge'),
        ('Cold Lucky', "Cold Damage with Hits is Lucky if you've Suppressed Spell Damage Recently"),
    ],
    'The Green Nightmare': [
        ('Frenzy Speed', '1% increased Movement Speed per Frenzy Charge'),
        ('Cold Lucky', "Cold Damage with Hits is Lucky if you've Suppressed Spell Damage Recently"),
        ('Cold to Chaos', 'Passives granting Cold Resistance or all Elemental Resistances in Radius also grant Cold Damage Converted to Chaos Damage at 100% of its value'),
    ],
    'The Blue Dream': [
        ('Lightning to Shield', 'Passives granting Lightning Resistance or all Elemental Resistances in Radius also grant increased Maximum Energy Shield at 75% of its value'),
        ('Crit Multi', '+3% to Critical Strike Multiplier per Power Charge'),
        ('Lightning Lucky', "Lightning Damage with Hits is Lucky if you've Blocked Spell Damage Recently"),
    ],
    'The Blue Nightmare': [
        ('Crit Multi', '+3% to Critical Strike Multiplier per Power Charge'),
        ('Lightning Lucky', "Lightning Damage with Hits is Lucky if you've Blocked Spell Damage Recently"),
        ('Lightning to Chaos', 'Passives granting Lightning Resistance or all Elemental Resistances in Radius also grant Lightning Damage Converted to Chaos Damage at 100% of its value'),
    ],
    'Eye of Chayula': [
        ('Reduced Mana', '20% reduced maximum Mana'),
        ('Gold', '20% increased Quantity of Gold Dropped by Slain Enemies'),
    ],
    'Presence of Chayula': [
        ('Shield Recoup', 'Recoup Energy Shield instead of Life'),
        ('Chaos Recoup', '50% of Chaos Damage taken Recouped as Life'),
    ],
}

XESHT_TYPES = ("UniqueWeapon", "UniqueArmour", "UniqueAccessory", "UniqueJewel")
FOULBORN = "Foulborn "


def fetch_unique_overview(league, item_type):
    qs = urllib.parse.urlencode({"league": league, "type": item_type})
    return fetch_json(f"{NINJA}/economy/stash/current/item/overview?{qs}")


def fetch_xesht(league):
    """Prices for every Breach unique Xesht can convert, plain and single-mod Foulborn, per link count.

    Returns None when the league has no Flesh of Xesht price.
    """
    singles = {name: {label for label, _ in variants} for name, variants in XESHT_VARIANTS.items()}
    items = []
    for item_type in XESHT_TYPES:
        for line in fetch_unique_overview(league, item_type).get("lines", []):
            name = line["name"]
            foulborn = name.startswith(FOULBORN)
            if foulborn:
                name = name[len(FOULBORN):]
            if name not in singles:
                continue
            variant = line.get("variant") or ""
            if foulborn and variant not in singles[name]:
                continue  # double-Foulborn: Xesht only yields single-mod outcomes
            if not foulborn and variant:
                continue
            items.append({
                "name": name,
                "foulborn": foulborn,
                "variant": variant if foulborn else None,
                "links": line.get("links") or 0,
                "chaos": line.get("chaosValue"),
                "listings": line.get("listingCount"),
                "icon": line.get("icon"),
            })

    currency = fetch_overview(league, "Currency")
    xesht = next((l for l in currency.get("lines", []) if l["id"] == "flesh-of-xesht"), None)
    if not xesht:
        return None  # not traded in this league (Hardcore, for one): nothing to compute
    xesht_item = next((i for i in currency.get("items", []) if i["id"] == "flesh-of-xesht"), {})
    divine_per_chaos = currency.get("core", {}).get("rates", {}).get("divine")
    return {
        "league": league,
        "fetchedAt": int(time.time()),
        "divinePrice": round(1 / divine_per_chaos, 1) if divine_per_chaos else None,
        "xesht": {
            "chaos": xesht.get("primaryValue"),
            "image": IMAGE_CDN + xesht_item["image"] if xesht_item.get("image") else None,
        },
        "pairs": [list(p) for p in XESHT_PAIRS],
        "variants": {name: [{"label": l, "mod": m} for l, m in v] for name, v in XESHT_VARIANTS.items()},
        "items": items,
    }


def update_xesht(out, log=print):
    """Refresh Xesht conversion prices for every current league. Returns the number of leagues that failed."""
    base = os.path.join(out, "xesht")
    leagues = fetch_leagues()
    failed = 0
    ok = []
    for name in leagues:
        slug = slugify(name)
        path = os.path.join(base, f"{slug}.json")
        try:
            result = fetch_xesht(name)
            if result is None:
                log(f"{name}: no Flesh of Xesht trading, skipped")
                continue
            write_json(path, result)
            ok.append({"name": name, "slug": slug})
            log(f"{name}: {len(result['items'])} prices, Xesht {result['xesht']['chaos']}c")
        except Exception as exc:  # keep going; one bad league shouldn't block the rest
            failed += 1
            log(f"{name}: FAILED ({exc})")
            if os.path.exists(path):
                ok.append({"name": name, "slug": slug})  # keep serving last good data
    write_json(os.path.join(base, "leagues.json"), ok)
    keep = {f"{l['slug']}.json" for l in ok} | {"leagues.json"}
    for fname in os.listdir(base):
        if fname not in keep and fname.endswith(".json"):
            os.remove(os.path.join(base, fname))
    return failed if ok else len(leagues) or 1


# ---------- registry ----------

# Every tool that needs regularly fetched data registers a fetcher here: name -> fn(out, log).
# A fetcher must:
#   - write only under its own paths in `out` (new tools: `out/<tool>/...`), and prune only those;
#   - keep the last good data when a fetch fails, rather than deleting or blanking it;
#   - return how many of its updates failed (0 = all good). Raising counts as one failure.
# It runs every 30 minutes; if a tool needs data less often, skip work while its files are fresh.
FETCHERS = {
    "essences": update_essences,
    "xesht": update_xesht,
}


def update_all(out, tools=None, log=print):
    """Run every fetcher (or only those named in `tools`). Returns the total number of failures.

    One tool failing never stops the others.
    """
    unknown = set(tools or ()) - FETCHERS.keys()
    if unknown:
        log(f"unknown tool(s): {', '.join(sorted(unknown))}")
    failed = len(unknown)
    for name, fetch in FETCHERS.items():
        if tools is not None and name not in tools:
            continue
        try:
            failed += fetch(out, log=lambda msg, name=name: log(f"{name}: {msg}"))
        except Exception as exc:
            failed += 1
            log(f"{name}: FAILED ({exc})")
    return failed


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))
    parser.add_argument("--tool", action="append", choices=sorted(FETCHERS),
                        help="only run this tool's fetcher (repeatable; default: all)")
    args = parser.parse_args()
    failed = update_all(args.out, tools=args.tool)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
