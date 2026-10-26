// Static catalog: the products/SKUs we watch and the Queensland Apple Stores.

export interface Sku {
  part: string;
  capacity: string;
  colorKey: string;
  colorDisplay: string;
}

export interface Product {
  id: string;
  name: string;
  shopUrl: string;
  skus: Sku[];
}

export interface Store {
  id: string;
  name: string;
  city: string;
  address: string;
  phone: string;
}

export const PRODUCTS: Product[] = [
  {
    id: "iphone-duo",
    name: "iPhone Duo",
    shopUrl: "https://www.apple.com/au/shop/buy-iphone/iphone-duo",
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
  },
];

export const STORES: Store[] = [
  {
    id: "R466",
    name: "Brisbane",
    city: "Brisbane City",
    address: "MacArthur Chambers, 233 Queen Street, Brisbane City, QLD 4000",
    phone: "07-31829000",
  },
  {
    id: "R509",
    name: "Carindale",
    city: "Carindale",
    address: "Westfield Carindale, 1151 Creek Road, Carindale, QLD 4152",
    phone: "07-3199 2200",
  },
  {
    id: "R351",
    name: "Robina",
    city: "Robina",
    address: "Robina Town Centre, Robina, QLD 4226",
    phone: "07-5667 0400",
  },
];

export const ALL_SKUS: Sku[] = PRODUCTS.flatMap((p) => p.skus);

/** Look up a SKU (and its product) by Apple part number. */
export function findSku(
  part: string,
): { product: Product; sku: Sku } | undefined {
  for (const product of PRODUCTS) {
    const sku = product.skus.find((s) => s.part === part);
    if (sku) return { product, sku };
  }
  return undefined;
}

export function findStore(id: string): Store | undefined {
  return STORES.find((s) => s.id === id);
}

/** Human label such as "iPhone Duo 1TB Night Sky"; falls back to the part number. */
export function skuLabel(part: string): string {
  const found = findSku(part);
  if (!found) return part;
  return `${found.product.name} ${found.sku.capacity} ${found.sku.colorDisplay}`;
}

/** Colours in display order. */
export const COLORS: { key: string; display: string }[] = [
  { key: "nightsky", display: "Night Sky" },
  { key: "starwhite", display: "Star White" },
];

/** Capacities in display order. */
export const CAPACITIES: string[] = ["256GB", "512GB", "1TB", "2TB"];

/** The SKU for a colour key and capacity, if one exists. */
export function skuFor(colorKey: string, capacity: string): Sku | undefined {
  return ALL_SKUS.find((s) =>
    s.colorKey === colorKey && s.capacity === capacity
  );
}

/** Short label such as "Night Sky 256GB"; falls back to the part number. */
export function shortLabel(part: string): string {
  const found = findSku(part);
  if (!found) return part;
  return `${found.sku.colorDisplay} ${found.sku.capacity}`;
}
