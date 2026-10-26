// Alert text shared by browser notifications and the Discord webhook.

import { shortLabel } from "./catalog.ts";
import type { Hit } from "./settings.ts";

export interface Alert {
  title: string;
  body: string;
}

export function buildAlert(hits: Hit[]): Alert | null {
  const grouped = new Map<string, string[]>();
  for (const hit of hits) {
    const stores = grouped.get(hit.part) ?? [];
    if (!stores.includes(hit.storeName)) stores.push(hit.storeName);
    grouped.set(hit.part, stores);
  }
  const storeCount = new Set(hits.map((h) => h.storeId)).size;
  if (!storeCount) return null;
  return {
    title: `iPhone Duo in stock at ${storeCount} store${
      storeCount === 1 ? "" : "s"
    }`,
    body: [...grouped].map(([part, stores]) =>
      `${shortLabel(part)}: ${stores.join(", ")}`
    ).join("\n"),
  };
}

/** Post to a Discord webhook; failures are logged and reported as `false`. */
export async function sendDiscord(
  webhookUrl: string,
  alert: Alert,
  shopUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchFn(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `🔔 **${alert.title}**\n${alert.body}\n${shopUrl}`,
      }),
    });
    if (!res.ok) console.error(`Discord webhook failed: HTTP ${res.status}`);
    await res.body?.cancel();
    return res.ok;
  } catch (e) {
    console.error("Discord webhook failed:", e);
    return false;
  }
}
