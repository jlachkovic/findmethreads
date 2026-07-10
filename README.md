# FindMeThreads

Daily checker for second-hand and vintage clothing drops.

Out of the box it knows how to check:

- Shopify collection JSON endpoints, with optional vendor filtering.
- Shopify product pages where measurements are rendered into the page HTML.
- Product pages that expose structured JSON-LD product metadata.
- Multiple configured stores in one daily run.

It keeps local memory in `data/seen-products.json` and writes the latest report to:

- `data/index.html`
- `data/latest-report.html`
- `data/latest-report.json`
- `data/reports/YYYY-MM-DD/report.html`
- `data/reports/YYYY-MM-DD/report.json`

## Run it now

```sh
cp config.example.json config.json
npm run check
open -a "Google Chrome" data/index.html
```

Or double-click `Open Clothing Report.command`, which opens the report archive in Google Chrome.

The first run seeds current matches without notifying. Later runs only flag products it has not seen before.
Each run also archives a dated report, so you can browse previous days from `data/index.html`.

## Tune the filters

Edit your local `config.json`. It is intentionally ignored by Git, so your sizes, watched brands, watched stores, and reports stay private.

Useful settings:

- `crisis.collectionUrl`: Shopify collection URL to watch.
- `crisis.vendors`: exact Shopify vendor names to keep from that collection.
- `*.fit.tops`: chest, label-size, and cut preferences.
- `*.fit.bottoms`: waist, inseam, and cut preferences.
- `*.fit.shoes`: shoe size preferences.
- `run.maxProductsPerSite`: how many newest products to inspect from each store.
- `run.notifyOnMatches`: show a macOS notification when new matches are found.
- `run.openReportWhenMatchesFound`: automatically open the HTML report when new matches are found.

The committed `config.example.json` contains illustrative values only. Copy it to `config.json` and replace the URLs, brands, and measurements with your own.

## Run daily on macOS

Double-click `Install on this Mac.command`.

That creates a LaunchAgent at:

```sh
~/Library/LaunchAgents/com.findmethreads.app.plist
```

Manual install is:

```sh
mkdir -p ~/Library/LaunchAgents
sed "s#__PROJECT_DIR__#$(pwd)#g" launchd/com.findmethreads.app.plist > ~/Library/LaunchAgents/com.findmethreads.app.plist
launchctl load ~/Library/LaunchAgents/com.findmethreads.app.plist
```

It runs every day at 9:15 AM local time and writes logs to `data/launchd.log` and `data/launchd.err.log`.

To run the scheduled job immediately:

```sh
launchctl start com.findmethreads.app
```

To disable it:

```sh
launchctl unload ~/Library/LaunchAgents/com.findmethreads.app.plist
```

## Reset memory

```sh
npm run reset
```

After resetting, the next run will treat current matches as new again.
