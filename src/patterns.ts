// Pure aggregation of restock events into "when does stock arrive" patterns.

import {
  capacitiesOf,
  type Catalog,
  colorsOf,
  DEFAULT_CATALOG,
  findSku,
  findStore,
} from "./catalog.ts";
import type { RestockEvent } from "./history.ts";

export interface PatternFilter {
  storeId?: string;
  colorKey?: string;
  capacity?: string;
}

export interface Patterns {
  matrix: Record<
    string,
    Record<string, { count: number; typicalHour: number | null }>
  >;
  byHour: number[];
  byDay: number[];
  restocks: number;
  moments: number;
  peakHour: number | null;
  peakDay: number | null;
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Index of the largest value (ties -> earliest), or null if all zero. */
function argmax(values: number[]): number | null {
  let best: number | null = null;
  let max = 0;
  values.forEach((v, i) => {
    if (v > max) {
      max = v;
      best = i;
    }
  });
  return best;
}

export function computePatterns(
  events: RestockEvent[],
  filter: PatternFilter = {},
  cat: Catalog = DEFAULT_CATALOG,
): Patterns {
  const timeZone = cat.timeZone;
  const COLORS = colorsOf(cat);
  const CAPACITIES = capacitiesOf(cat);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    weekday: "short",
    hourCycle: "h23",
  });
  const local = (iso: string): { hour: number; day: number } | null => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    let hour = -1;
    let day = -1;
    for (const p of fmt.formatToParts(new Date(t))) {
      if (p.type === "hour") hour = Number(p.value) % 24;
      else if (p.type === "weekday") day = WEEKDAYS[p.value] ?? -1;
    }
    return hour < 0 || day < 0 ? null : { hour, day };
  };

  const matrix: Patterns["matrix"] = {};
  const cellHours: Record<string, Record<string, number[]>> = {};
  for (const c of COLORS) {
    matrix[c.key] = {};
    cellHours[c.key] = {};
    for (const cap of CAPACITIES) {
      matrix[c.key][cap] = { count: 0, typicalHour: null };
      cellHours[c.key][cap] = new Array(24).fill(0);
    }
  }
  const byHour = new Array<number>(24).fill(0);
  const byDay = new Array<number>(7).fill(0);
  const moments = new Set<string>();
  let restocks = 0;

  for (const e of events) {
    if (!findStore(e.storeId, cat)) continue;
    const sku = findSku(e.part, cat);
    if (!sku || !matrix[sku.colorKey]?.[sku.capacity]) continue;
    if (filter.storeId && e.storeId !== filter.storeId) continue;
    if (filter.colorKey && sku.colorKey !== filter.colorKey) continue;
    if (filter.capacity && sku.capacity !== filter.capacity) continue;
    const l = local(e.at);
    if (!l) continue;

    restocks++;
    matrix[sku.colorKey][sku.capacity].count++;
    cellHours[sku.colorKey][sku.capacity][l.hour]++;

    const moment = `${e.storeId}\u0000${e.at}`;
    if (!moments.has(moment)) {
      moments.add(moment);
      byHour[l.hour]++;
      byDay[l.day]++;
    }
  }

  for (const c of COLORS) {
    for (const cap of CAPACITIES) {
      matrix[c.key][cap].typicalHour = argmax(cellHours[c.key][cap]);
    }
  }

  return {
    matrix,
    byHour,
    byDay,
    restocks,
    moments: moments.size,
    peakHour: argmax(byHour),
    peakDay: argmax(byDay),
  };
}
