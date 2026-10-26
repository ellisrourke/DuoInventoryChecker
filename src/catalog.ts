// Catalog: the product, SKUs, stores, region and time zone being watched.
// DEFAULT_CATALOG is the starting point; users edit it in the Settings tab.

export interface Sku {
  part: string;
  capacity: string;
  colorKey: string;
  colorDisplay: string;
}

export interface Store {
  id: string;
  name: string;
  address?: string;
  phone?: string;
}

/** Everything that identifies what is watched and where. */
export interface Catalog {
  /** Apple storefront path, e.g. "au", "us", "uk" or "ca/fr". */
  region: string;
  /** IANA time zone used to display times and group restock patterns. */
  timeZone: string;
  productName: string;
  /** Product page linked from alerts; derived from `region` when empty. */
  shopUrl: string;
  stores: Store[];
  skus: Sku[];
}

export const DEFAULT_CATALOG: Catalog = {
  region: "au",
  timeZone: "Australia/Brisbane",
  productName: "iPhone Duo",
  shopUrl: "",
  stores: [
    {
      id: "R466",
      name: "Brisbane",
      address: "MacArthur Chambers, 233 Queen Street, Brisbane City, QLD 4000",
      phone: "07-31829000",
    },
    {
      id: "R509",
      name: "Carindale",
      address: "Westfield Carindale, 1151 Creek Road, Carindale, QLD 4152",
      phone: "07-3199 2200",
    },
    {
      id: "R351",
      name: "Robina",
      address: "Robina Town Centre, Robina, QLD 4226",
      phone: "07-5667 0400",
    },
  ],
  skus: [
    {
      part: "MK2D4X/A",
      capacity: "256GB",
      colorKey: "starwhite",
      colorDisplay: "Star White",
    },
    {
      part: "MK2E4X/A",
      capacity: "256GB",
      colorKey: "nightsky",
      colorDisplay: "Night Sky",
    },
    {
      part: "MK2F4X/A",
      capacity: "512GB",
      colorKey: "starwhite",
      colorDisplay: "Star White",
    },
    {
      part: "MK2G4X/A",
      capacity: "512GB",
      colorKey: "nightsky",
      colorDisplay: "Night Sky",
    },
    {
      part: "MK2H4X/A",
      capacity: "1TB",
      colorKey: "starwhite",
      colorDisplay: "Star White",
    },
    {
      part: "MK2J4X/A",
      capacity: "1TB",
      colorKey: "nightsky",
      colorDisplay: "Night Sky",
    },
    {
      part: "MK2K4X/A",
      capacity: "2TB",
      colorKey: "starwhite",
      colorDisplay: "Star White",
    },
    {
      part: "MK2L4X/A",
      capacity: "2TB",
      colorKey: "nightsky",
      colorDisplay: "Night Sky",
    },
  ],
};

export const STORES: Store[] = DEFAULT_CATALOG.stores;
export const ALL_SKUS: Sku[] = DEFAULT_CATALOG.skus;

export function shopUrl(cat: Catalog = DEFAULT_CATALOG): string {
  return cat.shopUrl || `https://www.apple.com/${cat.region}/shop/buy-iphone`;
}

export function findSku(
  part: string,
  cat: Catalog = DEFAULT_CATALOG,
): Sku | undefined {
  return cat.skus.find((s) => s.part === part);
}

export function findStore(
  id: string,
  cat: Catalog = DEFAULT_CATALOG,
): Store | undefined {
  return cat.stores.find((s) => s.id === id);
}

/** Colours in order of first appearance. */
export function colorsOf(
  cat: Catalog = DEFAULT_CATALOG,
): { key: string; display: string }[] {
  const seen = new Map<string, string>();
  for (const s of cat.skus) {
    if (!seen.has(s.colorKey)) seen.set(s.colorKey, s.colorDisplay);
  }
  return [...seen].map(([key, display]) => ({ key, display }));
}

/** Capacities in order of first appearance. */
export function capacitiesOf(cat: Catalog = DEFAULT_CATALOG): string[] {
  return [...new Set(cat.skus.map((s) => s.capacity))];
}

/** The SKU for a colour key and capacity, if one exists. */
export function skuFor(
  colorKey: string,
  capacity: string,
  cat: Catalog = DEFAULT_CATALOG,
): Sku | undefined {
  return cat.skus.find((s) =>
    s.colorKey === colorKey && s.capacity === capacity
  );
}

/** Short label such as "Night Sky 256GB"; falls back to the part number. */
export function shortLabel(
  part: string,
  cat: Catalog = DEFAULT_CATALOG,
): string {
  const sku = findSku(part, cat);
  return sku ? `${sku.colorDisplay} ${sku.capacity}` : part;
}

// ------------------------------------------------------- text editing ----

const colorKeyOf = (display: string) =>
  display.toLowerCase().replace(/[^a-z0-9]/g, "");

function dataLines(text: string): string[][] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) =>
    l && !l.startsWith("#")
  ).map((l) => l.split("|").map((c) => c.trim()));
}

/** "ID | Name | Address | Phone" per line (address and phone optional). */
export function parseStores(text: string): Store[] {
  const out: Store[] = [];
  for (const [id, name, address, phone] of dataLines(text)) {
    if (!id || out.some((s) => s.id === id)) continue;
    const st: Store = { id, name: name || id };
    if (address) st.address = address;
    if (phone) st.phone = phone;
    out.push(st);
  }
  return out;
}

export function formatStores(stores: Store[]): string {
  return stores.map((s) =>
    [s.id, s.name, s.address ?? "", s.phone ?? ""].join(" | ").replace(
      /(?: \| )+$/,
      "",
    )
  ).join("\n");
}

/** "Part number | Capacity | Colour" per line. */
export function parseSkus(text: string): Sku[] {
  const out: Sku[] = [];
  for (const [part, capacity, colorDisplay] of dataLines(text)) {
    if (!part || !capacity || !colorDisplay) continue;
    if (out.some((s) => s.part === part)) continue;
    out.push({
      part,
      capacity,
      colorDisplay,
      colorKey: colorKeyOf(colorDisplay),
    });
  }
  return out;
}

export function formatSkus(skus: Sku[]): string {
  return skus.map((s) => `${s.part} | ${s.capacity} | ${s.colorDisplay}`)
    .join("\n");
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function isValidRegion(region: string): boolean {
  return /^[a-z]{2}(\/[a-z]{2})?$/.test(region);
}

/** Coerce arbitrary input (stored JSON, form data) into a valid Catalog. */
export function sanitizeCatalog(input: unknown): Catalog {
  const o =
    (typeof input === "object" && input !== null ? input : {}) as Record<
      string,
      unknown
    >;
  const str = (v: unknown) => typeof v === "string" ? v.trim() : "";
  const region = str(o.region).toLowerCase();
  const timeZone = str(o.timeZone);
  const url = str(o.shopUrl);
  const stores = Array.isArray(o.stores)
    ? parseStores(
      formatStores(o.stores.filter((s): s is Store =>
        typeof s?.id === "string" && typeof s?.name === "string"
      )),
    )
    : [];
  const skus = Array.isArray(o.skus)
    ? o.skus.filter((s): s is Sku =>
      typeof s?.part === "string" && typeof s?.capacity === "string" &&
      typeof s?.colorDisplay === "string"
    ).map((s) => ({
      part: s.part,
      capacity: s.capacity,
      colorDisplay: s.colorDisplay,
      colorKey: colorKeyOf(s.colorDisplay),
    }))
    : [];
  return {
    region: isValidRegion(region) ? region : DEFAULT_CATALOG.region,
    timeZone: isValidTimeZone(timeZone) && timeZone
      ? timeZone
      : DEFAULT_CATALOG.timeZone,
    productName: str(o.productName) || DEFAULT_CATALOG.productName,
    shopUrl: /^https:\/\/\S+$/.test(url) ? url : "",
    stores: stores.length ? stores : DEFAULT_CATALOG.stores,
    skus: skus.length ? skus : DEFAULT_CATALOG.skus,
  };
}
