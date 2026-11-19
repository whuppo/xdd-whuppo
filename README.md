# Essence Prices

A small website that tracks Path of Exile essence prices from [poe.ninja](https://poe.ninja).

- **Grid view:** essence types × tiers (Screaming, Shrieking, Deafening), shaded by relative value within each tier, with 7-day change.
- **List view:** sortable by price, 7-day change or volume, with sparklines.
- **Upgrade view:** profit from the 3:1 vendor recipe (3 Screaming → 1 Shrieking, 3 Shrieking → 1 Deafening) and the 9:1 two-step, sortable by profit or ROI.
- **Detail view:** click any essence to see its upgrade profit, poe.ninja's 7-day trend and the history this tracker has recorded.
- Lower tiers (Whispering through Wailing) aren't tracked, since they barely show up in the game.
- Prices in chaos or divine, league selector, and a text filter.

## Run

```sh
python3 server.py
# open http://localhost:8000   (set PORT=... to change the port)
```

Needs only Python 3. The server proxies poe.ninja, which doesn't send CORS headers, so the browser can't call it directly. Responses are cached for 30 minutes, matching poe.ninja's own cache. A background thread snapshots every active league every 30 minutes into `data/history.sqlite`, so the price history grows while the server runs.

## Data source

`https://poe.ninja/poe1/api/economy/exchange/current/overview?league=<League>&type=Essence`. This API is undocumented and has changed before. If prices stop loading, check this endpoint first.
