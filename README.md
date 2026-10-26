# iPhone Duo Brisbane Stock Watcher

A [Deno Deploy](https://deno.com/deploy) app that checks Apple Store pickup
availability for the **iPhone Duo** at Queensland Apple Stores **every minute**
and sends browser and Discord (iPhone) alerts when a model you've selected newly
comes into stock.

Based on the approach used by
[worthbak/apple-store-inventory-checker](https://github.com/worthbak/apple-store-inventory-checker)
and
[worthbak/inventory-checker-app](https://github.com/worthbak/inventory-checker-app)
(Apple's `shop/retail/pickup-message` endpoint, Australian part numbers from the
app's `iPhone-Duo-intl.json` catalog).

## What it watches

| Storage | Star White | Night Sky |
| ------- | ---------- | --------- |
| 256GB   | MK2D4X/A   | MK2E4X/A  |
| 512GB   | MK2F4X/A   | MK2G4X/A  |
| 1TB     | MK2H4X/A   | MK2J4X/A  |
| 2TB     | MK2K4X/A   | MK2L4X/A  |

Stores: Brisbane (R466), Carindale (R509), Robina (R351).

Every check fetches all 3 stores × 8 models so the dashboard stays live; you
choose which store/model combinations send alerts. The part numbers for 256GB
and 512GB Star White were confirmed against Apple; the rest follow the same
sequence and should be double-checked.

## The dashboard

- **Stock**: a status banner (with **Check stock now** and alert settings), then
  one grid with colour/storage as rows and the three stores as columns. Cells
  are green **✓ In stock**, blue **🔔 Watching** (you'll be alerted), or dashed
  **Watch** (tap to start watching). Tap any cell to toggle its alert. Below the
  grid, each store lists its address, phone, last restock and usual restock
  hour. Light and dark themes follow your system, and phones show compact icon
  cells.
- **Recent changes**: your notification history for the last 7 days. It logs
  when a watched combination came into stock or sold out, plus any
  checker-failure warnings.
- **Patterns**: when restocks happen at these 3 stores over the last 7 days,
  broken down by colour and size, hour of day, and day of week (Brisbane time),
  with store, colour and size filters.
- **Settings**: the master alerts switch, a bulk tool to watch or unwatch many
  combinations at once, browser notification permission, browser and Discord
  test alerts, and "Run check now".

## How it behaves

- Runs every minute via `Deno.cron`. Each run makes one request anchored at
  Brisbane (with nearby stores included), plus one follow-up request for each
  store that wasn't in the first response.
- Alerts fire only when a watched item **newly** comes into stock, not on every
  check while it stays in stock. If it sells out and returns, you're alerted
  again.
- Browser notifications need permission and the dashboard tab to remain open.
  The page checks for updates every 15 seconds. Use HTTPS (or localhost for
  local development); browser notification permissions require a secure context.
- If `DISCORD_WEBHOOK_URL` is set, the server also posts to Discord on each new
  in-stock item, with or without the dashboard open.
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

   | Variable              | Required | Purpose                                                                                                              |
   | --------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
   | `ADMIN_PASSWORD`      | yes      | Password for the settings page (any username)                                                                        |
   | `DISCORD_WEBHOOK_URL` | no       | Discord webhook URL. Posts to a channel when an item newly comes into stock; the Discord iPhone app pushes it to you |

3. Open the deployment URL in the browser, log in, allow notifications in
   **Settings**, and pick the models/stores to watch. Keep the dashboard open to
   receive browser alerts, or set up Discord (below) for phone alerts. The cron
   job shows up under the project's **Cron** tab.

## Local development

```sh
ADMIN_PASSWORD=secret deno task dev   # http://localhost:8000
deno task test
deno task check
```

## Endpoints

- `GET /`: dashboard (Basic auth)
- `POST /settings`, `POST /toggle`, `POST /run`: form actions (Basic auth)
- `GET /api/status`: JSON settings plus the last run (Basic auth)
- `GET /health`: public liveness check

## Caveats

- Apple's endpoint is unofficial and may change or rate-limit. Polling every
  minute can trigger bot detection (HTTP 541). The app retries twice per request
  and pauses after a block. If it keeps happening, lower the frequency by
  editing the cron schedule in `main.ts` (e.g. `*/3 * * * *`).
- Part numbers come from a scraped catalog (October 2026). If Apple changes
  them, update `src/catalog.ts`.

## iPhone alerts via Discord

1. In Discord, open a channel's **Edit Channel → Integrations → Webhooks → New
   Webhook** and copy the URL.
2. Set it as `DISCORD_WEBHOOK_URL` (Deno Deploy env vars, or
   `DISCORD_WEBHOOK_URL=... deno task start`).
3. Install Discord on your iPhone, join that server, and keep notifications on
   for the channel.
