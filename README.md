# xdd.whuppo

Vibe coded bullshit from United Warriors United: a small collection of Path of Exile tools. The home page (`/`) is a hub of tool cards; each tool lives on its own sub-page.

## Tools

### Essence Prices (`/essences/`)

Tracks essence prices from [poe.ninja](https://poe.ninja).

- **Grid view:** laid out like the in-game essence stash tab, shaded by relative value within each tier, with 7-day change. The layout comes from `static/essences/essence_tab.txt` (tab-separated; the first line is each column's tier, cells are essence types or `(special) Name`, blanks are intentional). Edit that file to change the grid.
- **List view:** sortable by price, 7-day change or volume, with sparklines.
- **Upgrade view:** profit from the 3:1 vendor recipe (3 Screaming → 1 Shrieking, 3 Shrieking → 1 Deafening) and the 9:1 two-step, as a stash-layout grid and a table sortable by profit or ROI.
- **Your stash:** load a [WealthyExile](https://wealthyexile.com) CSV export (needs `Name` and `Quantity` columns) to get the most profitable upgrade plan for the essences you own. The upgrade grid then shows, per cell, how many you own → how many after the plan and that step's profit (toggle back to per-essence profit any time), with the total above. The file is parsed in the browser and kept only in that browser's localStorage. `test-data/wealthyexile-triple-digit.csv` is a fake export with large stacks for testing.
- **Detail view:** click any essence to see its upgrade profit, poe.ninja's 7-day trend and the history this tracker has recorded.
- Views can be linked directly: `/essences/#grid`, `#list`, `#upgrade`.
- Lower tiers (Whispering through Wailing) aren't tracked, since they barely show up in the game.
- Prices in chaos or divine, league selector, and a text filter.

## Layout

```
server.py              API proxy, cache, price history, static file server
static/
  index.html           tools hub
  style.css            shared styles (colors, header, cards, grids)
  theme.js             shared light/dark/auto toggle
  essences/            Essence Prices tool (index.html, app.js, essence_tab.txt)
test-data/             sample WealthyExile exports
```

To add a tool: create `static/<tool>/index.html` (link `../style.css` and `../theme.js`, add an `← All tools` link to `../`) and add a card for it in `static/index.html`.

## Run

```sh
python3 server.py
# open http://localhost:8000   (set PORT=... to change the port)
```

Needs only Python 3. The server proxies poe.ninja, which doesn't send CORS headers, so the browser can't call it directly. Responses are cached for 30 minutes, matching poe.ninja's own cache. A background thread snapshots every active league every 30 minutes into `data/history.sqlite`, so the price history grows while the server runs.

## Data source

`https://poe.ninja/poe1/api/economy/exchange/current/overview?league=<League>&type=Essence`. This API is undocumented and has changed before. If prices stop loading, check this endpoint first.
