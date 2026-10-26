import { createHandler } from "../src/web.ts";
import {
  getSettings,
  pairKey,
  type RunStatus,
  saveLastRun,
} from "../src/settings.ts";
import { saveSnapshot } from "../src/stock.ts";
import { appendHistory, appendRestocks } from "../src/history.ts";
import { assert, assertEquals } from "./_assert.ts";

const auth = {};
const goodRun: RunStatus = {
  at: "2026-01-01T15:00:00Z",
  ok: true,
  hits: [],
  storesChecked: [],
  storesMissing: [],
  consecutiveFailures: 0,
};

function post(
  path: string,
  body: string,
  headers: Record<string, string> = {},
) {
  return new Request("http://localhost" + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...auth,
      ...headers,
    },
    body,
  });
}

async function withKv(fn: (kv: Deno.Kv) => Promise<void>) {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(kv);
  } finally {
    kv.close();
  }
}

Deno.test("404 and 405", async () => {
  await withKv(async (kv) => {
    const h = createHandler(kv, {});
    assertEquals(
      (await h(new Request("http://localhost/nope", { headers: auth }))).status,
      404,
    );
    assertEquals(
      (await h(new Request("http://localhost/settings", { headers: auth })))
        .status,
      405,
    );
    assertEquals((await h(post("/", ""))).status, 405);
  });
});

Deno.test("POST /toggle flips a pair and redirects to the stock anchor", async () => {
  await withKv(async (kv) => {
    const h = createHandler(kv, {});
    const key = pairKey("R466", "MK2D4X/A");
    assert((await getSettings(kv)).watch.includes(key));
    const r = await h(post("/toggle", "store=R466&part=MK2D4X%2FA"));
    assertEquals(r.status, 303);
    assertEquals(r.headers.get("Location"), "/?tab=stock#R466");
    assert(!(await getSettings(kv)).watch.includes(key));
    await h(post("/toggle", "store=R466&part=MK2D4X%2FA"));
    assert((await getSettings(kv)).watch.includes(key));
    const before = (await getSettings(kv)).watch.length;
    await h(post("/toggle", "store=BOGUS&part=MK244VC%2FA"));
    assertEquals((await getSettings(kv)).watch.length, before);
  });
});

Deno.test("POST /settings: alerts form toggles enabled", async () => {
  await withKv(async (kv) => {
    const h = createHandler(kv, {});
    const r = await h(
      post("/settings", "alerts_form=1", { Origin: "http://localhost" }),
    );
    assertEquals(r.status, 303);
    assertEquals(r.headers.get("Location"), "/?tab=settings&saved=1");
    let s = await getSettings(kv);
    assertEquals(s.enabled, false);
    await h(post("/settings", "alerts_form=1&enabled=on"));
    s = await getSettings(kv);
    assertEquals(s.enabled, true);
    const api = await h(
      new Request("http://localhost/api/status", { headers: auth }),
    );
    const body = await api.json();
    assertEquals(body.settings, s);
    assertEquals(body.snapshot, null);
  });
});

const catalogForm = (over: Record<string, string> = {}) =>
  new URLSearchParams({
    catalog_form: "1",
    productName: "iPhone 20",
    region: "us",
    timeZone: "America/New_York",
    shopUrl: "",
    stores: "R001 | Fifth Avenue | 767 5th Ave | 555-0100\nR002 | SoHo",
    skus: "ABC1/A | 128GB | Black\nABC2/A | 256GB | Black",
    ...over,
  }).toString();

Deno.test("POST /settings: catalog form saves, watches new pairs, validates", async () => {
  await withKv(async (kv) => {
    const h = createHandler(kv, {});
    const r = await h(post("/settings", catalogForm()));
    assertEquals(r.headers.get("Location"), "/?tab=settings&saved=1");
    const s = await getSettings(kv);
    assertEquals(s.catalog.region, "us");
    assertEquals(s.catalog.timeZone, "America/New_York");
    assertEquals(s.catalog.stores.map((x) => x.id), ["R001", "R002"]);
    assertEquals(s.catalog.skus.map((x) => x.colorKey), ["black", "black"]);
    assertEquals(s.watch.length, 4);

    const html = await get(h, "/");
    assert(html.includes("iPhone 20"));
    assert(html.includes("Fifth Avenue"));
    assert(!html.includes("Carindale"));

    const bads: Record<string, string>[] = [
      { region: "United States" },
      { timeZone: "Mars/Olympus" },
      { stores: "" },
      { skus: "" },
      { productName: "" },
      { shopUrl: "http://insecure.example" },
    ];
    for (const bad of bads) {
      const res = await h(post("/settings", catalogForm(bad)));
      assert(res.headers.get("Location")!.includes("error="));
    }
    assertEquals((await getSettings(kv)).catalog.region, "us");
  });
});

Deno.test("CSRF: mismatched Origin/Referer rejected", async () => {
  await withKv(async (kv) => {
    const h = createHandler(kv, {});
    const r = await h(
      post("/settings", "alerts_form=1", { Origin: "https://evil.example" }),
    );
    assertEquals(r.status, 403);
    const r2 = await h(
      post("/run", "", { Referer: "https://evil.example/x" }),
    );
    assertEquals(r2.status, 403);
    assertEquals((await getSettings(kv)).watch.length, 24);
  });
});

Deno.test("POST /run calls injected runCheck", async () => {
  await withKv(async (kv) => {
    let n = 0;
    const h = createHandler(kv, {
      runCheck: () => {
        n++;
        return Promise.resolve(goodRun);
      },
    });
    const r = await h(post("/run", ""));
    assertEquals(r.headers.get("Location"), "/?tab=stock&ran=1");
    assertEquals(n, 1);
  });
});

async function get(h: (r: Request) => Promise<Response>, path: string) {
  return await (await h(
    new Request("http://localhost" + path, { headers: auth }),
  ))
    .text();
}

const NOW = new Date("2026-01-10T17:00:00Z");
const ago = (min: number) =>
  new Date(NOW.getTime() - min * 60000).toISOString();

async function seed(kv: Deno.Kv) {
  await saveSnapshot(kv, {
    at: ago(0),
    stores: {
      R466: {
        checkedAt: ago(0),
        parts: {
          "MK2D4X/A": { available: true, quote: "Today" },
          "MK2E4X/A": { available: true, quote: "Today" },
          "MK2F4X/A": { available: false },
        },
      },
    },
  });
  await appendHistory(kv, [
    { at: ago(90), kind: "in_stock", storeId: "R466", part: "MK2D4X/A" },
    { at: ago(80), kind: "sold_out", storeId: "R466", part: "MK2D4X/A" },
    { at: ago(70), kind: "warning", message: "Checks failing <b>10</b>" },
  ]);
  await appendRestocks(kv, [
    { at: "2026-01-09T14:00:00Z", storeId: "R466", part: "MK2D4X/A" }, // midnight
    { at: "2026-01-09T14:00:00Z", storeId: "R466", part: "MK2E4X/A" },
    { at: "2026-01-08T14:00:00Z", storeId: "R509", part: "MK2D4X/A" },
    { at: "2026-01-08T14:00:00Z", storeId: "R509", part: "MK2L4X/A" },
  ]);
}

Deno.test("tab: stock shows check marks and option counts", async () => {
  await withKv(async (kv) => {
    await seed(kv);
    const h = createHandler(kv, { now: () => NOW });
    const html = await get(h, "/");
    assert(html.includes("✓"));
    assert(html.includes("2 options available"));
    assert(
      html.includes(
        "2</strong> colour/size options available across 3 stores",
      ),
    );
    assert(html.includes('id="R466"'));
    assert(html.includes("Last restock"));
    assert(html.includes('http-equiv="refresh"'));
    assert(html.includes("Brisbane"));
    assert(html.includes("google.com/maps"));
    const u = await get(h, "/?tab=nonsense");
    assert(u.includes("options available across 3 stores"));
  });
});

Deno.test("tab: stock with nothing in stock", async () => {
  await withKv(async (kv) => {
    const h = createHandler(kv, {});
    const html = await get(h, "/?tab=stock");
    assert(html.includes("No check has run yet"));
    assert(html.includes("None available"));
    assert(!html.includes("✓"));
  });
});

Deno.test("tab: changes lists history with badges", async () => {
  await withKv(async (kv) => {
    await seed(kv);
    const h = createHandler(kv, { now: () => NOW });
    const html = await get(h, "/?tab=changes");
    assert(html.includes("Notification history"));
    assert(html.includes("IN STOCK"));
    assert(html.includes("SOLD OUT"));
    assert(html.includes("WARNING"));
    assert(html.includes("Star White 256GB at Brisbane"));
    assert(html.includes("Checks failing &lt;b&gt;10&lt;/b&gt;"));
    assert(!html.includes("http-equiv"));
  });
});

Deno.test("tab: patterns counts and filters", async () => {
  await withKv(async (kv) => {
    await seed(kv);
    const h = createHandler(kv, { now: () => NOW });
    const all = await get(h, "/?tab=patterns");
    assert(all.includes("When does stock come in?"));
    assert(all.includes("Based on 4 restocks"));
    assert(all.includes("around <b>12am–1am</b>"));
    assert(all.includes("<b>Friday</b>"));
    const store = await get(h, "/?tab=patterns&store=R509");
    assert(store.includes("Based on 2 restocks"));
    assert(store.includes('<option value="R509" selected>'));
    const color = await get(h, "/?tab=patterns&color=nightsky");
    assert(color.includes("Based on 2 restocks"));
    const size = await get(
      h,
      "/?tab=patterns&size=2TB&color=nightsky&store=R509",
    );
    assert(size.includes("Based on 1 restock."));
    const none = await get(h, "/?tab=patterns&size=1TB");
    assert(none.includes("No restocks logged yet"));
  });
});

Deno.test("tab: settings renders status and redirects return to tab", async () => {
  await withKv(async (kv) => {
    const h = createHandler(kv, {
      runCheck: () => Promise.resolve(goodRun),
    });
    const html = await get(h, "/?tab=settings");
    assert(html.includes("What to watch"));
    assert(!html.includes("Bulk watch tool"));
    assert(html.includes("Enable browser notifications"));
    assert(html.includes("Browser notifications require permission"));
    assert(html.includes("Test Discord alert"));
    const r = await h(post("/run", "return=settings"));
    assertEquals(r.headers.get("Location"), "/?tab=settings&ran=1");
  });
});

Deno.test("POST /discord-test reports webhook success and failure", async () => {
  await withKv(async (kv) => {
    const h = createHandler(kv, {
      discordWebhookUrl: "https://example.test/hook",
      fetchFn: () => Promise.resolve(new Response(null, { status: 204 })),
    });
    const ok = await h(post("/discord-test", ""));
    assertEquals(ok.headers.get("Location"), "/?tab=settings&discordTest=sent");

    const failing = createHandler(kv, {
      discordWebhookUrl: "https://example.test/hook",
      fetchFn: () => Promise.resolve(new Response(null, { status: 500 })),
    });
    const failed = await failing(post("/discord-test", ""));
    assertEquals(
      failed.headers.get("Location")?.startsWith(
        "/?tab=settings&error=",
      ),
      true,
    );
  });
});

Deno.test("GET /api/status provides a formatted browser notification", async () => {
  await withKv(async (kv) => {
    await saveLastRun(kv, {
      ...goodRun,
      newHits: [{
        storeId: "R466",
        storeName: "Brisbane",
        part: "MK2D4X/A",
      }],
      storesChecked: ["R466"],
    });
    const h = createHandler(kv, {});
    const response = await h(
      new Request("http://localhost/api/status", { headers: auth }),
    );
    const body = await response.json();
    assertEquals(body.notification, {
      title: "iPhone Duo in stock at 1 store",
      body: "Star White 256GB: Brisbane",
    });

    await saveLastRun(kv, {
      ...goodRun,
      newHits: [{
        storeId: "R466",
        storeName: "Brisbane",
        part: "MK2D4X/A",
      }],
      storesChecked: [],
      storesMissing: ["R466"],
    });
    const stale = await h(
      new Request("http://localhost/api/status", { headers: auth }),
    );
    assertEquals((await stale.json()).notification, null);
  });
});

Deno.test("escaping: malicious lastRun error and query values", async () => {
  await withKv(async (kv) => {
    await saveLastRun(kv, {
      ...goodRun,
      ok: false,
      error: "<script>alert(1)</script>",
      hits: [{
        storeId: "R466",
        storeName: "Brisbane <b>Store</b>",
        part: "MK2D4X/A",
      }],
      consecutiveFailures: 3,
    });
    const h = createHandler(kv, {});
    for (const tab of ["stock", "changes", "patterns", "settings"]) {
      const html = await get(h, `/?tab=${tab}&error=%3Cimg%20src%3Dx%3E`);
      assert(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
      assert(!html.includes("<script>alert(1)"));
      assert(html.includes("&lt;img src=x&gt;"));
      assert(!html.includes("<img src=x>"));
    }
    const s = await get(h, "/?tab=settings");
    assert(
      s.includes("Eaton &lt;b&gt;Centre&lt;/b&gt;") || !s.includes("<b>Centre"),
    );
  });
});
