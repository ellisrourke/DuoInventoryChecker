// Entry point for Deno Deploy: schedules the stock check every minute and
// serves the password-protected settings page.

import { runCheck } from "./src/checker.ts";
import { getLastRun, type RunStatus } from "./src/settings.ts";
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

Deno.cron("iphone-duo-stock-check", "* * * * *", async () => {
  const last = await getLastRun(kv);
  if (
    last && !last.ok && last.error?.includes("(541)") &&
    Date.now() - Date.parse(last.at) < BLOCK_COOLDOWN_MS
  ) return;
  await runOnce();
});

Deno.serve(createHandler(kv, { runCheck: runOnce }));
