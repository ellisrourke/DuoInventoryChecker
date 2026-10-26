# Apple Store Stock Watcher

A [Deno Deploy](https://deno.com/deploy) app that checks Apple Store pickup
availability for any Apple product at any Apple Stores you choose, on a schedule
you set, and sends browser and Discord alerts when a model you've selected newly
comes into stock. It ships preconfigured for the iPhone Duo at three Queensland
stores; everything is editable in **Settings → What to watch**.

Based on the approach used by
[worthbak/apple-store-inventory-checker](https://github.com/worthbak/apple-store-inventory-checker)
and
[worthbak/inventory-checker-app](https://github.com/worthbak/inventory-checker-app)
(Apple's `shop/retail/pickup-message` endpoint, Australian part numbers from the
app's `iPhone-Duo-intl.json` catalog).

## What it watches

Set in **Settings → What to watch** (no redeploy needed):

- **Product name**, **Apple region** (the `apple.com/<region>` path, e.g. `au`,
  `us`, `uk`, `ca/fr`), **time zone** (IANA name) and an optional product page
  URL for alerts.
- **Stores**, one per line: `Store ID | Name | Address | Phone` (address and
  phone optional), e.g. `R466 | Brisbane | 233 Queen Street`.
- **Models**, one per line: `Part number | Capacity | Colour`, e.g.
  `MK2D4X/A | 256GB | Star White`.

Newly added store/model combinations are watched automatically. The defaults are
the iPhone Duo (Australian part numbers, 4 capacities × 2 colours) at Brisbane
(R466), Carindale (R509) and Robina (R351). Only the 256GB and 512GB Star White
part numbers were confirmed against Apple; double-check the rest.

Every check fetches all stores × all models so the dashboard stays live; you
choose which store/model combinations send alerts.

## The dashboard

- **Stock**: a status banner (with **Check stock now** and alert settings), then
  one grid with colour/storage as rows and your stores as columns. Cells are
  green **✓ In stock**, blue **🔔 Watching** (you'll be alerted), or dashed
  **Watch** (tap to start watching). Tap any cell to toggle its alert. Below the
  grid, each store lists its address, phone, last restock and usual restock
  hour. Light and dark themes follow your system, and phones show compact icon
  cells.
- **Recent changes**: your notification history for the last 7 days. It logs
  when a watched combination came into stock or sold out, plus any
  checker-failure warnings.
- **Patterns**: when restocks happen at your stores over the last 7 days, broken
  down by colour and size, hour of day, and day of week (in your time zone),
  with store, colour and size filters.
- **Settings**: the master alerts switch, the product/region/stores/models
  editor, Discord webhook, check schedule, browser notification permission,
  browser and Discord test alerts, and "Run check now".

## How it behaves

- Runs via `Deno.cron` every minute, throttled to the interval chosen in
  **Settings → Check schedule**. Each run makes one request anchored at your
  first store (with nearby stores included), plus one follow-up request for each
  store that wasn't in the first response.
- Alerts fire only when a watched item **newly** comes into stock, not on every
  check while it stays in stock. If it sells out and returns, you're alerted
  again.
- Browser notifications need permission and the dashboard tab to remain open.
  The page checks for updates every 15 seconds. Use HTTPS (or localhost for
  local development); browser notification permissions require a secure context.
- If a Discord webhook is configured in Settings, the server also posts to
  Discord on each new in-stock item, with or without the dashboard open.
- If Apple blocks requests (HTTP 541), scheduled checks pause for 10 minutes so
  the block can clear; a manual "Check stock now" still works. After 10 failures
  in a row, a warning is recorded in history and the counter resets on the next
  success.

## Setup

1. **Deno Deploy** ([console.deno.com](https://console.deno.com)): create a new
   app from this GitHub repo with entrypoint `main.ts`. Then, under
   **Databases**, choose **Provision Database** → **Deno KV** and **Assign** it
   to the app. The settings page and alert state are stored there.
2. **Environment variables** (project settings):

   | Variable              | Required | Purpose                                                                                                                                                          |
   | --------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `DISCORD_WEBHOOK_URL` | no       | Fallback Discord webhook URL (normally set in the Settings tab). Posts to a channel when an item newly comes into stock; the Discord iPhone app pushes it to you |

3. Open the deployment URL in the browser, allow notifications in **Settings**,
   and pick the models/stores to watch. Keep the dashboard open to receive
   browser alerts, or set up Discord (below) for phone alerts. The cron job
   shows up under the project's **Cron** tab.

## Local development

```sh
deno task dev   # http://localhost:8000
deno task test
deno task check
```

## Endpoints

- `GET /`: dashboard
- `POST /settings`, `POST /toggle`, `POST /run`: form actions
- `GET /api/status`: JSON settings plus the last run
- `GET /health`: public liveness check

## Caveats

- Apple's endpoint is unofficial and may change or rate-limit. Polling every
  minute can trigger bot detection (HTTP 541). The app retries twice per request
  and pauses after a block. If it keeps happening, lower the frequency by
  raising the check interval in Settings.
- Part numbers come from a scraped catalog (October 2026). If Apple changes
  them, update `src/catalog.ts`.

## iPhone alerts via Discord

1. In Discord, open a channel's **Edit Channel → Integrations → Webhooks → New
   Webhook** and copy the URL.
2. Paste it into **Settings → Discord webhook** in the app (the
   `DISCORD_WEBHOOK_URL` env var still works as a fallback).
3. Install Discord on your iPhone, join that server, and keep notifications on
   for the channel.
