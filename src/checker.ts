// One stock-check run: fetch every store, update the snapshot and history,
// record watched hits and run status for the browser client.

import { fetchAllStock, type FetchFn } from "./apple.ts";
import { buildAlert, sendDiscord } from "./alert.ts";
import { type Catalog, findStore, shopUrl } from "./catalog.ts";
import {
  appendHistory,
  appendRestocks,
  type HistoryEntry,
  type RestockEvent,
} from "./history.ts";
import {
  getLastRun,
  getSettings,
  type Hit,
  pairKey,
  parsePairKey,
  type RunStatus,
  saveLastRun,
} from "./settings.ts";
import {
  diffSnapshots,
  getSnapshot,
  saveSnapshot,
  type StockSnapshot,
} from "./stock.ts";

/** Send the failure warning exactly when the counter reaches this value. */
const FAILURE_WARNING_THRESHOLD = 10;

export interface CheckerDeps {
  fetchFn?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/** Run one check. Never throws; problems are logged and recorded in the status. */
export async function runCheck(
  kv: Deno.Kv,
  deps: CheckerDeps = {},
): Promise<RunStatus> {
  const at = (deps.now?.() ?? new Date()).toISOString();
  const status: RunStatus = {
    at,
    ok: true,
    hits: [],
    storesChecked: [],
    storesMissing: [],
    consecutiveFailures: 0,
  };

  try {
    const settings = await getSettings(kv);
    const cat = settings.catalog;
    const prevRun = await getLastRun(kv);

    try {
      const result = await fetchAllStock(
        cat.stores.map((s) => s.id),
        cat.skus.map((s) => s.part),
        { region: cat.region, fetchFn: deps.fetchFn, sleep: deps.sleep },
      );
      status.storesChecked = result.storesChecked;
      status.storesMissing = result.storesMissing;

      // New snapshot: previous data overlaid with the stores seen this run.
      const prevSnap = await getSnapshot(kv);
      const next: StockSnapshot = {
        at,
        stores: { ...(prevSnap?.stores ?? {}) },
      };
      for (const [id, parts] of Object.entries(result.stores)) {
        next.stores[id] = { checkedAt: at, parts };
      }

      const diff = diffSnapshots(prevSnap, next);
      const events: RestockEvent[] = diff.restocks.map((r) => ({
        at,
        storeId: r.storeId,
        part: r.part,
      }));
      if (events.length > 0) await appendRestocks(kv, events);

      // Hits: available pairs that are watched (none while alerts are off).
      if (settings.enabled) {
        const watched = new Set(settings.watch);
        for (const store of cat.stores) {
          for (const sku of cat.skus) {
            if (!watched.has(pairKey(store.id, sku.part))) continue;
            const p = next.stores[store.id]?.parts[sku.part];
            if (!result.storesChecked.includes(store.id) || !p?.available) {
              continue;
            }
            status.hits.push({
              storeId: store.id,
              storeName: store.name,
              part: sku.part,
              quote: p.quote,
            });
          }
        }
      }

      // No notification history while alerts are off.
      const history = settings.enabled
        ? historyEntries(prevRun?.hits ?? [], status.hits, {
          at,
          checked: result.storesChecked,
          snapshot: next,
          cat,
        })
        : [];
      if (history.length > 0) await appendHistory(kv, history);
      await saveSnapshot(kv, next);

      // Remember (without re-notifying) hits at stores we couldn't check this
      // run, so they aren't logged as a fresh in_stock when the store returns.
      if (settings.enabled) {
        const watched = new Set(settings.watch);
        for (const h of prevRun?.hits ?? []) {
          if (
            !result.storesChecked.includes(h.storeId) &&
            watched.has(pairKey(h.storeId, h.part))
          ) status.hits.push(h);
        }
      }
      const prevKeys = new Set(
        (prevRun?.hits ?? []).map((h) => pairKey(h.storeId, h.part)),
      );
      status.newHits = status.hits.filter((h) =>
        !prevKeys.has(pairKey(h.storeId, h.part))
      );
      const webhook = settings.discordWebhookUrl ??
        Deno.env.get("DISCORD_WEBHOOK_URL");
      const alert = buildAlert(
        status.newHits.filter((h) => result.storesChecked.includes(h.storeId)),
        cat,
      );
      if (webhook && settings.enabled && alert) {
        await sendDiscord(webhook, alert, shopUrl(cat), deps.fetchFn);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const prev = prevRun?.consecutiveFailures ?? 0;
      status.ok = false;
      status.error = message;
      status.consecutiveFailures = prev + 1;
      // Keep the last known hits so the next successful run doesn't re-log them.
      status.hits = prevRun?.hits ?? [];
      console.error("Stock check failed:", message);
      if (status.consecutiveFailures === FAILURE_WARNING_THRESHOLD) {
        const warning = `Stock checker failing: ${message}`;
        try {
          await appendHistory(kv, [{ at, kind: "warning", message: warning }]);
        } catch (err) {
          console.error("Failed to record failure warning:", err);
        }
      }
    }

    await saveLastRun(kv, status);
  } catch (e) {
    // KV or other unexpected failure: log and report without throwing.
    console.error("runCheck error:", e);
    status.ok = false;
    status.error = e instanceof Error ? e.message : String(e);
  }
  return status;
}

/** in_stock for newly present hits; sold_out for vanished hits in checked stores. */
function historyEntries(
  prevHits: Hit[],
  hits: Hit[],
  ctx: {
    at: string;
    checked: string[];
    snapshot: StockSnapshot;
    cat: Catalog;
  },
): HistoryEntry[] {
  const before = new Set(prevHits.map((h) => pairKey(h.storeId, h.part)));
  const now = new Set(hits.map((h) => pairKey(h.storeId, h.part)));
  const out: HistoryEntry[] = [];
  for (const key of now) {
    if (before.has(key)) continue;
    const p = parsePairKey(key)!;
    out.push({ at: ctx.at, kind: "in_stock", ...p });
  }
  for (const key of before) {
    if (now.has(key)) continue;
    const p = parsePairKey(key);
    if (
      !p || !ctx.checked.includes(p.storeId) || !findStore(p.storeId, ctx.cat)
    ) {
      continue;
    }
    // Still available but no longer a hit (e.g. unwatched): not a sell-out.
    if (ctx.snapshot.stores[p.storeId]?.parts[p.part]?.available) continue;
    out.push({ at: ctx.at, kind: "sold_out", ...p });
  }
  return out;
}
