// Entry point for Deno Deploy: schedules the stock check every minute and
// serves the local settings page.

import { runCheck } from "./src/checker.ts";
import { getLastRun, getSettings, type RunStatus } from "./src/settings.ts";
import { createHandler } from "./src/web.ts";

const kv = await Deno.openKv();

// Guard against a manual "Run check now" overlapping a scheduled run.
let inFlight: Promise<RunStatus> | null = null;
function runOnce(): Promise<RunStatus> {
  inFlight ??= runCheck(kv).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

// After Apple blocks us (541), pause scheduled checks so the block can clear.
const BLOCK_COOLDOWN_MS = 10 * 60_000;

// The cron fires every minute; the interval chosen in the UI throttles it.
const INTERVAL_SLACK_MS = 5_000;

Deno.cron("iphone-duo-stock-check", "* * * * *", async () => {
  const [last, settings] = await Promise.all([getLastRun(kv), getSettings(kv)]);
  if (
    last &&
    Date.now() - Date.parse(last.at) <
      settings.intervalMinutes * 60_000 - INTERVAL_SLACK_MS
  ) return;
  if (
    last && !last.ok && last.error?.includes("(541)") &&
    Date.now() - Date.parse(last.at) < BLOCK_COOLDOWN_MS
  ) return;
  await runOnce();
});

Deno.serve(createHandler(kv, { runCheck: runOnce }));
