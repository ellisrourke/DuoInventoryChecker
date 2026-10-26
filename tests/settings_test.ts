import { ALL_SKUS, DEFAULT_CATALOG, STORES } from "../src/catalog.ts";
import {
  DEFAULT_SETTINGS,
  getLastRun,
  getSettings,
  pairKey,
  parsePairKey,
  type RunStatus,
  sanitizeSettings,
  saveLastRun,
  saveSettings,
  toggleWatch,
} from "../src/settings.ts";
import { assert, assertEquals } from "./_assert.ts";

Deno.test("pairKey / parsePairKey round trip and rejects junk", () => {
  assertEquals(pairKey("R466", "MK2D4X/A"), "R466|MK2D4X/A");
  assertEquals(parsePairKey("R466|MK2D4X/A"), {
    storeId: "R466",
    part: "MK2D4X/A",
  });
  assertEquals(parsePairKey("nope"), null);
  assertEquals(parsePairKey("|X"), null);
  assertEquals(parsePairKey("R466|"), null);
});

Deno.test("sanitizeSettings: drops unknown pairs, dedupes, orders", () => {
  const s = sanitizeSettings({
    enabled: false,
    watch: [
      "R509|MK2D4X/A",
      "R466|MK2E4X/A",
      "R466|MK2E4X/A",
      "R466|BOGUS",
      "R999|MK2D4X/A",
      42,
      null,
      "R466|MK2D4X/A",
    ],
  });
  assertEquals(s, {
    enabled: false,
    watch: ["R466|MK2D4X/A", "R466|MK2E4X/A", "R509|MK2D4X/A"],
    intervalMinutes: 1,
    catalog: DEFAULT_CATALOG,
  });
});

Deno.test("sanitizeSettings: bad input yields defaults / empty watch", () => {
  assertEquals(sanitizeSettings(null), DEFAULT_SETTINGS);
  assertEquals(sanitizeSettings("x"), DEFAULT_SETTINGS);
  assertEquals(sanitizeSettings({}), {
    enabled: true,
    watch: [],
    intervalMinutes: 1,
    catalog: DEFAULT_CATALOG,
  });
  assertEquals(sanitizeSettings({ enabled: "yes", watch: "R466|MK2D4X/A" }), {
    enabled: false,
    watch: [],
    intervalMinutes: 1,
    catalog: DEFAULT_CATALOG,
  });
});

Deno.test("sanitizeSettings: legacy {skus, stores} becomes their product", () => {
  const s = sanitizeSettings({
    enabled: true,
    skus: ["MK2E4X/A", "BOGUS", "MK2D4X/A"],
    stores: ["R509", "R999", "R466"],
  });
  assertEquals(s, {
    enabled: true,
    watch: [
      "R466|MK2D4X/A",
      "R466|MK2E4X/A",
      "R509|MK2D4X/A",
      "R509|MK2E4X/A",
    ],
    intervalMinutes: 1,
    catalog: DEFAULT_CATALOG,
  });
  // Legacy settings predate Masonville, which therefore starts unwatched.
  const full = sanitizeSettings({
    skus: ALL_SKUS.map((x) => x.part),
    stores: STORES.slice(0, 2).map((x) => x.id),
  });
  assertEquals(full.watch.length, 2 * ALL_SKUS.length);
  assert(!full.watch.some((k) => k.startsWith("R351|")));
  // An explicit watch list wins over legacy fields.
  assertEquals(
    sanitizeSettings({ watch: ["R466|MK2D4X/A"], skus: ["MK2E4X/A"] }).watch,
    ["R466|MK2D4X/A"],
  );
});

Deno.test("DEFAULT_SETTINGS watches every store x SKU", () => {
  assertEquals(DEFAULT_SETTINGS.enabled, true);
  assertEquals(DEFAULT_SETTINGS.watch.length, ALL_SKUS.length * STORES.length);
  assertEquals(STORES.length, 3);
});

Deno.test("KV round trip for settings and last run", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    assertEquals(await getSettings(kv), DEFAULT_SETTINGS);
    assertEquals(await getLastRun(kv), null);

    await saveSettings(kv, {
      enabled: false,
      watch: ["R466|MK2D4X/A", "R466|NOPE"],
    });
    assertEquals(await getSettings(kv), {
      enabled: false,
      watch: ["R466|MK2D4X/A"],
      intervalMinutes: 1,
      catalog: DEFAULT_CATALOG,
    });

    const run: RunStatus = {
      at: "2026-01-01T00:00:00.000Z",
      ok: true,
      hits: [{ storeId: "R466", storeName: "Brisbane", part: "MK2D4X/A" }],
      storesChecked: ["R466"],
      storesMissing: [],
      consecutiveFailures: 0,
    };
    await saveLastRun(kv, run);
    assertEquals(await getLastRun(kv), run);
  } finally {
    kv.close();
  }
});

Deno.test("getSettings migrates legacy stored settings", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    await kv.set(["settings"], {
      enabled: true,
      skus: ["MK2D4X/A"],
      stores: ["R466", "R351"],
    });

    assertEquals(await getSettings(kv), {
      enabled: true,
      watch: ["R466|MK2D4X/A", "R351|MK2D4X/A"],
      intervalMinutes: 1,
      catalog: DEFAULT_CATALOG,
    });
  } finally {
    kv.close();
  }
});

Deno.test("getSettings defaults watches when stored pairs use the previous catalog", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    await kv.set(["settings"], {
      enabled: true,
      watch: ["R121|MK244VC/A"],
    });
    assertEquals(await getSettings(kv), DEFAULT_SETTINGS);
    assertEquals((await kv.get(["settings"])).value, {
      enabled: true,
      watch: DEFAULT_SETTINGS.watch,
      intervalMinutes: 1,
      catalog: DEFAULT_CATALOG,
    });
  } finally {
    kv.close();
  }
});

Deno.test("toggleWatch adds, removes and ignores unknown pairs", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    await saveSettings(kv, {
      enabled: true,
      watch: [],
      intervalMinutes: 1,
      catalog: DEFAULT_CATALOG,
    });
    let s = await toggleWatch(kv, "R509", "MK2D4X/A");
    assertEquals(s.watch, ["R509|MK2D4X/A"]);
    s = await toggleWatch(kv, "R466", "MK2E4X/A");
    assertEquals(s.watch, ["R466|MK2E4X/A", "R509|MK2D4X/A"]);
    s = await toggleWatch(kv, "R509", "MK2D4X/A");
    assertEquals(s.watch, ["R466|MK2E4X/A"]);
    s = await toggleWatch(kv, "R999", "MK2D4X/A");
    assertEquals(s.watch, ["R466|MK2E4X/A"]);
    assertEquals((await getSettings(kv)).watch, ["R466|MK2E4X/A"]);
  } finally {
    kv.close();
  }
});
