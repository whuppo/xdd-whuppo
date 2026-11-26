# xdd.whuppo

Vibe coded bullshit from United Warriors United: a small collection of Path of Exile tools. The home page (`/`) is a hub of tool cards; each tool lives on its own sub-page.

## Tools

### Essence Prices (`/essences/`)

Tracks essence prices from [poe.ninja](https://poe.ninja).

- **Grid view:** laid out like the in-game essence stash tab, shaded by relative value within each tier, with 7-day change. The layout comes from `static/essences/essence_tab.txt` (tab-separated; the first line is each column's tier, cells are essence types or `(special) Name`, blanks are intentional). Edit that file to change the grid.
- **List view:** sortable by price, 7-day change or volume, with sparklines.
- **Upgrade view:** profit from the 3:1 vendor recipe (3 Screaming → 1 Shrieking, 3 Shrieking → 1 Deafening) and the 9:1 two-step, as a stash-layout grid and a table sortable by profit or ROI.
- **Gamble view:** expected profit of spending 30 Primal Crystallised Lifeforce to turn an essence into a random different one of the same tier (Hysteria, Insanity, Horror and Delirium only turn into each other; Desolation and Trickery can't be gambled), with the break-even price for each pool and each essence's chance of coming out ahead. We don't have the real odds, so it assumes every outcome is equally likely (the page says so) and that you can sell at poe.ninja prices. Lifeforce is priced from poe.ninja too.
- **Your stash:** load a [WealthyExile](https://wealthyexile.com) CSV export (needs `Name` and `Quantity` columns) to get the most profitable upgrade plan for the essences you own. The upgrade grid then shows, per cell, how many you own → how many after the plan and that step's profit (toggle back to per-essence profit any time), with the total above. The file is parsed in the browser and kept only in that browser's localStorage. `test-data/wealthyexile-triple-digit.csv` is a fake export with large stacks for testing.
- **Detail view:** click any essence to see its upgrade profit, gamble EV, poe.ninja's 7-day trend and the history this tracker has recorded.
- Views can be linked directly: `/essences/#grid`, `#list`, `#upgrade`, `#gamble`.
- Lower tiers (Whispering through Wailing) aren't tracked, since they barely show up in the game.
- Prices in chaos or divine, league selector, and a text filter.

### Apps & extensions

The hub also links to tools that live in their own repos:

- **[Scalpel + Gem Scanner](https://github.com/richardC-git/scalpel/tree/gem-scanner):** a fork of the Scalpel overlay with an exceptional-gem scanner built in ([releases](https://github.com/richardC-git/scalpel/releases)).
- **[POE Bulk Trade](https://github.com/richardC-git/POEBulkTradePlugin):** a Chrome extension that loads more trade results at once, folds duplicate listings and flags sellers with several of the searched item.

## Layout

```
update_data.py         fetchers for every tool's data (FETCHERS registry); writes static JSON
lambda_handler.py      AWS Lambda entry point: syncs data/ from S3, runs the fetchers, syncs back
server.py              local dev server: runs the fetchers every 30 min, serves static/ and /data/
infra/updater.yml      CloudFormation: S3 + CloudFront for data, the Lambda, its 30-min schedule,
                       the GitHub OIDC deploy role, optional failure alerts
.github/workflows/
  pages.yml            deploy static/ to GitHub Pages on push to main
  deploy-updater.yml   deploy the Lambda's code on push to main (when the updater changes)
static/
  index.html           tools hub
  style.css            shared styles (colors, header, cards, grids)
  theme.js             shared light/dark/auto toggle
  icons/               local card icons
  config.js            where tools load data from (CloudFront in production, /data locally)
  essences/            Essence Prices tool (index.html, app.js, essence_tab.txt)
test-data/             sample WealthyExile exports
```

How it fits together: the site (`static/`) is plain files on GitHub Pages. The data is generated
separately: every 30 minutes EventBridge Scheduler runs a Lambda that executes `update_data.py`
and writes the JSON to S3, which CloudFront serves to the pages. Locally, `server.py` runs the same
`update_data.py` and serves everything from one place.

## Adding a tool

1. **The page.** Create `static/<tool>/index.html`: link `../style.css` and `../theme.js`, add an
   `← All tools` link to `../`, and include `<meta name="robots" content="noindex, nofollow">` so it
   stays out of search results. Add a card for it in `static/index.html`.
2. **Its data, if it needs any fetched on a schedule.**
   - Write a fetcher in `update_data.py` and add it to `FETCHERS`. It writes only under
     `out/<tool>/`, keeps its last good data when a fetch fails, and returns its failure count
     (the comment above `FETCHERS` has the full contract).
   - In the page, include `../config.js` before your script and fetch from
     `${window.XDD_DATA}/<tool>/...`.
   - Stick to the Python standard library. The Lambda deploy zips `update_data.py` as-is, so
     third-party packages would need changes to `deploy-updater.yml`.
   - Fetchers run every 30 minutes. For data that changes less often, have the fetcher skip work
     while its files are still fresh.

No AWS changes are needed for either step: the Lambda can write anywhere under `data/`, CloudFront
serves all of it with CORS, and merging to `main` redeploys both the site and the Lambda.
`python3 update_data.py --tool <tool>` runs one fetcher on its own.

## Run locally

```sh
python3 server.py
# open http://localhost:8000   (set PORT=... to change the port)
```

Needs only Python 3. It fetches data on startup and every 30 minutes into `data/` (git-ignored),
and `config.js` points pages at it when the host is `localhost`.

## Deploy

### Site (GitHub Pages)

`.github/workflows/pages.yml` deploys `static/` on every push to `main` (or on demand), replacing
the `__DATA_URL__` placeholder in `config.js` with the `DATA_URL` repository variable.

One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**. For a custom
domain, add it under Settings → Pages and point DNS at GitHub (a `CNAME` to `<user>.github.io` for a
subdomain).

### Data updater (AWS)

`.github/workflows/deploy-updater.yml` deploys `update_data.py` + `lambda_handler.py` to the Lambda
whenever they change on `main`, then runs it once and fails if the run fails. Logs are in CloudWatch
under `/aws/lambda/<stack>-updater`. To refresh data right away, run that workflow or invoke the
function from the console.

One-time setup:

1. **Create the stack** from `infra/updater.yml` (CloudFormation console → Create stack → upload
   the file, or the CLI below). Set `CreateGitHubOidcProvider=false` if the account already has the
   `token.actions.githubusercontent.com` identity provider, and `AlertEmail` if you want an email
   when updates fail twice in a row or stop running.
   ```sh
   aws cloudformation deploy --stack-name xdd-whuppo --template-file infra/updater.yml      --capabilities CAPABILITY_IAM --parameter-overrides AlertEmail=you@example.com
   aws cloudformation describe-stacks --stack-name xdd-whuppo --query "Stacks[0].Outputs"
   ```
2. **Set repository variables** (Settings → Secrets and variables → Actions → Variables) from the
   outputs: `AWS_REGION` (the stack's region), `AWS_DEPLOY_ROLE_ARN`, `AWS_UPDATER_FUNCTION`,
   `DATA_URL`. None of them are secret.
3. **Carry over the existing history** from the old `data` branch (once):
   `infra/seed-from-data-branch.sh <DataBucketName>`.
4. **Deploy the Lambda code**: run the "Deploy data updater" workflow (Actions → Run workflow). The
   stack starts with a placeholder function, so scheduled runs fail until this has run once.

Cost is effectively zero: a few cents a month at most for Lambda, S3 and CloudFront at this size.

## Data source

`https://poe.ninja/poe1/api/economy/exchange/current/overview?league=<League>&type=Essence` (and `type=Currency` for the lifeforce price). poe.ninja doesn't send CORS headers, so the browser can't call it directly; that's why prices are fetched by the updater (or the local server) and saved as static files. This API is undocumented and has changed before. If prices stop updating, check the Lambda's CloudWatch logs and this endpoint first.
