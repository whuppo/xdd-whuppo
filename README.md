# Essence Prices

A small website that tracks Path of Exile essence prices from [poe.ninja](https://poe.ninja).

- **Grid view:** laid out like the in-game essence stash tab, shaded by relative value within each tier, with 7-day change. The layout comes from `static/essence_tab.txt` (tab-separated; the first line is each column's tier, cells are essence types or `(special) Name`, blanks are intentional). Edit that file to change the grid.
- **List view:** sortable by price, 7-day change or volume, with sparklines.
- **Upgrade view:** profit from the 3:1 vendor recipe (3 Screaming → 1 Shrieking, 3 Shrieking → 1 Deafening) and the 9:1 two-step, as a stash-layout grid and a table sortable by profit or ROI.
- **Your stash:** load a [WealthyExile](https://wealthyexile.com) CSV export (needs `Name` and `Quantity` columns) to get the most profitable upgrade plan for the essences you own. The upgrade grid then shows, per cell, how many you own → how many after the plan and that step's profit (toggle back to per-essence profit any time), with the total above. The file is parsed in the browser and kept only in that browser's localStorage.
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
