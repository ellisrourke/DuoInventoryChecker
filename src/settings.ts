// User settings and last-run status, persisted in Deno KV.

import { type Catalog, DEFAULT_CATALOG, sanitizeCatalog } from "./catalog.ts";

export interface Settings {
  enabled: boolean;
  /** Watched store/model pairs, as pair keys ("R466|MK2D4X/A"). */
  watch: string[];
  /** Discord webhook URL; empty/absent means unset. */
  discordWebhookUrl?: string;
  /** Minutes between scheduled stock checks. */
  intervalMinutes: number;
  /** Region, time zone, product, stores and models being watched. */
  catalog: Catalog;
}

export const INTERVAL_OPTIONS = [1, 2, 3, 5, 10, 15, 30, 60];

export function pairKey(storeId: string, part: string): string {
  return `${storeId}|${part}`;
}

export function parsePairKey(
  key: string,
): { storeId: string; part: string } | null {
  const i = key.indexOf("|");
  if (i <= 0 || i === key.length - 1) return null;
  return { storeId: key.slice(0, i), part: key.slice(i + 1) };
}

/** Every store x every SKU, in catalog order. */
export function allPairs(cat: Catalog): string[] {
  return cat.stores.flatMap((st) =>
    cat.skus.map((sk) => pairKey(st.id, sk.part))
  );
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  watch: allPairs(DEFAULT_CATALOG),
  intervalMinutes: 1,
  catalog: DEFAULT_CATALOG,
};

export interface Hit {
  storeId: string;
  storeName: string;
  part: string;
  quote?: string;
}

export interface RunStatus {
  at: string;
  ok: boolean;
  error?: string;
  hits: Hit[];
  /** Hits that were not already in stock on the previous run. */
  newHits?: Hit[];
  storesChecked: string[];
  storesMissing: string[];
  consecutiveFailures: number;
}

/** Keep only known values from `input`, de-duplicated, in catalog order. */
function pickKnown(input: unknown, known: string[]): string[] {
  if (!Array.isArray(input)) return [];
  const wanted = new Set(
    input.filter((v): v is string => typeof v === "string"),
  );
  return known.filter((k) => wanted.has(k));
}

/**
 * Coerce arbitrary input (form data, stored JSON) into valid Settings.
 * Unknown pairs are dropped; a missing `enabled` defaults to true. Legacy
 * `{skus, stores}` input becomes the product of the two lists.
 */
export function sanitizeSettings(input: unknown): Settings {
  if (typeof input !== "object" || input === null) {
    return {
      enabled: true,
      watch: [...DEFAULT_SETTINGS.watch],
      intervalMinutes: 1,
      catalog: DEFAULT_CATALOG,
    };
  }
  const o = input as Record<string, unknown>;
  const enabled = typeof o.enabled === "boolean"
    ? o.enabled
    : o.enabled === undefined;

  const catalog = sanitizeCatalog(o.catalog);
  let candidates: unknown = o.watch;
  if (
    o.watch === undefined && (Array.isArray(o.skus) || Array.isArray(o.stores))
  ) {
    const skus = pickKnown(o.skus, catalog.skus.map((s) => s.part));
    const stores = pickKnown(o.stores, catalog.stores.map((s) => s.id));
    candidates = stores.flatMap((st) => skus.map((sk) => pairKey(st, sk)));
  }
  const intervalMinutes = INTERVAL_OPTIONS.includes(Number(o.intervalMinutes))
    ? Number(o.intervalMinutes)
    : 1;
  const out: Settings = {
    enabled,
    watch: pickKnown(candidates, allPairs(catalog)),
    intervalMinutes,
    catalog,
  };
  const hook = typeof o.discordWebhookUrl === "string"
    ? o.discordWebhookUrl.trim()
    : "";
  if (/^https:\/\/\S+$/.test(hook)) out.discordWebhookUrl = hook;
  return out;
}

export async function getSettings(kv: Deno.Kv): Promise<Settings> {
  const entry = await kv.get(["settings"]);
  if (entry.value === null) return sanitizeSettings(undefined);
  const settings = sanitizeSettings(entry.value);
  const storedWatch = (entry.value as { watch?: unknown } | null)?.watch;
  if (
    settings.watch.length === 0 && Array.isArray(storedWatch) &&
    storedWatch.length > 0
  ) {
    const migrated = { ...settings, watch: [...allPairs(settings.catalog)] };
    await kv.set(["settings"], migrated);
    return migrated;
  }
  return settings;
}

export async function saveSettings(
  kv: Deno.Kv,
  s: Partial<Settings>,
): Promise<void> {
  await kv.set(["settings"], sanitizeSettings(s));
}

/** Flip one store/model pair in the watch list and return the new settings. */
export async function toggleWatch(
  kv: Deno.Kv,
  storeId: string,
  part: string,
): Promise<Settings> {
  const settings = await getSettings(kv);
  const key = pairKey(storeId, part);
  const watch = settings.watch.includes(key)
    ? settings.watch.filter((k) => k !== key)
    : [...settings.watch, key];
  const next = sanitizeSettings({ ...settings, watch });
  await saveSettings(kv, next);
  return next;
}

export async function getLastRun(kv: Deno.Kv): Promise<RunStatus | null> {
  const entry = await kv.get<RunStatus>(["lastRun"]);
  return entry.value;
}

export async function saveLastRun(kv: Deno.Kv, r: RunStatus): Promise<void> {
  await kv.set(["lastRun"], r);
}
