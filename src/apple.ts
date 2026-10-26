// Apple pickup-availability client.

import type { PartStock } from "./stock.ts";

export type FetchFn = typeof fetch;
type Sleep = (ms: number) => Promise<void>;

export interface StoreAvailability {
  storeId: string;
  storeName: string;
  city?: string;
  parts: Record<string, { pickupDisplay: string; quote?: string }>;
}

export class AppleError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "AppleError";
    this.status = status;
  }
}

const DEFAULT_REGION = "au";

function endpoint(region: string): string {
  return `https://www.apple.com/${region}/shop/retail/pickup-message`;
}

function headers(region: string) {
  const country = region.slice(0, 2) === "uk"
    ? "GB"
    : region.slice(0, 2).toUpperCase();
  return {
    ...HEADERS,
    "Accept-Language": `en-${country},en;q=0.9`,
  };
}

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "application/json",
};
const MAX_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 15_000;

export function buildPickupUrl(
  anchorStore: string,
  parts: string[],
  searchNearby = true,
  region = DEFAULT_REGION,
): string {
  const p = new URLSearchParams();
  p.set("fae", "true");
  p.set("store", anchorStore);
  p.set("searchNearby", String(searchNearby));
  p.set("little", "false");
  parts.forEach((part, i) => p.set(`parts.${i}`, part));
  p.set("mts.0", "regular");
  p.set("mts.1", "sticky");
  p.set("fts", "true");
  return `${endpoint(region)}?${p}`;
}

// deno-lint-ignore no-explicit-any
type Json = any;

/** Parse Apple's JSON; stores may live at body.stores or body.content.pickupMessage.stores. */
export function parsePickupResponse(json: unknown): StoreAvailability[] {
  const body: Json = (json as Json)?.body;
  if (typeof body !== "object" || body === null) {
    throw new AppleError("Unexpected response: missing body");
  }
  const stores: Json = body.stores ?? body.PickupMessage?.stores ??
    body.content?.pickupMessage?.stores;
  if (!Array.isArray(stores)) {
    const keys = body.content?.pickupMessage?.errorMessageKeys;
    const detail = Array.isArray(keys) && keys.length
      ? ` (${keys.join(", ")})`
      : "";
    throw new AppleError(`Unexpected response: no stores list${detail}`);
  }
  const out: StoreAvailability[] = [];
  for (const s of stores) {
    if (typeof s?.storeNumber !== "string") continue;
    const parts: StoreAvailability["parts"] = {};
    for (const [key, v] of Object.entries<Json>(s.partsAvailability ?? {})) {
      parts[v?.partNumber ?? key] = {
        pickupDisplay: String(v?.pickupDisplay ?? "unknown"),
        quote: v?.messageTypes?.regular?.storePickupQuote ??
          v?.pickupSearchQuote ?? undefined,
      };
    }
    out.push({
      storeId: s.storeNumber,
      storeName: String(s.storeName ?? s.storeNumber),
      city: typeof s.city === "string" ? s.city : undefined,
      parts,
    });
  }
  return out;
}

interface Opts {
  /** Apple storefront path such as "au" or "us". */
  region?: string;
  fetchFn?: FetchFn;
  sleep?: Sleep;
}

const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One pickup-message request, retrying Apple's 541 bot-detection responses. */
export async function fetchPickup(
  anchorStore: string,
  parts: string[],
  opts: Opts = {},
): Promise<StoreAvailability[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const region = opts.region ?? DEFAULT_REGION;
  const url = buildPickupUrl(anchorStore, parts, true, region);

  for (let attempt = 0;; attempt++) {
    let res: Response;
    try {
      res = await fetchFn(url, {
        headers: headers(region),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      throw new AppleError(
        `Request failed: ${e instanceof Error ? e.message : e}`,
      );
    }
    if (res.status === 541) {
      await res.body?.cancel();
      if (attempt >= MAX_RETRIES) {
        throw new AppleError("Blocked by Apple (541) after retries", 541);
      }
      // ~2s, then ~4s, plus up to 500ms jitter.
      await sleep(2000 * (attempt + 1) + Math.floor(Math.random() * 500));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new AppleError(`HTTP ${res.status}`, res.status);
    if (text.trimStart().startsWith("<")) {
      throw new AppleError("Apple returned HTML instead of JSON", res.status);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AppleError("Apple returned invalid JSON", res.status);
    }
    return parsePickupResponse(json);
  }
}

/**
 * Fetch availability for the given stores and parts. The first request is
 * anchored at the first store (returns ~12 nearby stores); any store still
 * missing gets its own follow-up request. A failure on the first request
 * throws; failed follow-ups just leave the store in `storesMissing`.
 */
export async function fetchAllStock(
  storeIds: string[],
  parts: string[],
  opts: Opts = {},
): Promise<{
  stores: Record<string, Record<string, PartStock>>;
  storesChecked: string[];
  storesMissing: string[];
}> {
  if (storeIds.length === 0 || parts.length === 0) {
    return { stores: {}, storesChecked: [], storesMissing: [...storeIds] };
  }
  const seen = new Map<string, StoreAvailability>();
  const merge = (list: StoreAvailability[]) => {
    for (const s of list) {
      const prev = seen.get(s.storeId);
      seen.set(
        s.storeId,
        prev ? { ...prev, ...s, parts: { ...prev.parts, ...s.parts } } : s,
      );
    }
  };

  merge(await fetchPickup(storeIds[0], parts, opts));
  for (const id of storeIds.slice(1)) {
    if (seen.has(id)) continue;
    try {
      merge(await fetchPickup(id, parts, opts));
    } catch (e) {
      // Leave the store in storesMissing; the UI surfaces it.
      console.warn(`Follow-up request for ${id} failed:`, e);
    }
  }

  const stores: Record<string, Record<string, PartStock>> = {};
  const storesChecked: string[] = [];
  const storesMissing: string[] = [];
  for (const id of storeIds) {
    const s = seen.get(id);
    if (!s) {
      storesMissing.push(id);
      continue;
    }
    storesChecked.push(id);
    const out: Record<string, PartStock> = {};
    for (const part of parts) {
      const p = s.parts[part];
      if (!p) continue;
      out[part] = { available: p.pickupDisplay === "available" };
      if (p.quote !== undefined) out[part].quote = p.quote;
    }
    stores[id] = out;
  }
  return { stores, storesChecked, storesMissing };
}
