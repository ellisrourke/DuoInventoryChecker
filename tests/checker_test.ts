import { runCheck } from "../src/checker.ts";
import { ALL_SKUS, STORES } from "../src/catalog.ts";
import { listHistory, listRestocks } from "../src/history.ts";
import { getLastRun, saveSettings } from "../src/settings.ts";
import { getSnapshot } from "../src/stock.ts";
import fixture from "./fixtures/pickup_r121.json" with { type: "json" };
import { assert, assertEquals } from "./_assert.ts";

const noSleep = () => Promise.resolve();
const ALL_WATCH = STORES.flatMap((s) =>
  ALL_SKUS.map((k) => `${s.id}|${k.part}`)
);

const single = (
  id: string,
  name: string,
  part: string,
  available: boolean,
) =>
  new Response(JSON.stringify({
    body: {
      content: {
        pickupMessage: {
          stores: [{
            storeNumber: id,
            storeName: name,
            partsAvailability: {
              [part]: {
                partNumber: part,
                pickupDisplay: available ? "available" : "unavailable",
                pickupSearchQuote: available ? "Available Today" : "No",
              },
            },
          }],
        },
      },
    },
  }));

/**
 * Mock Apple. The anchor response includes Brisbane; Carindale and Robina
 * need follow-up requests. `state` controls availability for each store.
 */
function makeMock() {
  const state = {
    r509: false,
    r351: false,
    broken: false,
    failR351: false,
    anchorAvailable: true,
  };
  const requested: string[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    const url = String(input);
    if (state.broken) return Promise.resolve(new Response("<html/>"));
    const store = new URL(url).searchParams.get("store")!;
    requested.push(store);
    if (store === "R509") {
      return Promise.resolve(
        single("R509", "Carindale", "MK2L4X/A", state.r509),
      );
    }
    if (store === "R351") {
      return Promise.resolve(
        state.failR351
          ? new Response("", { status: 500 })
          : single("R351", "Robina", "MK2D4X/A", state.r351),
      );
    }
    const body = structuredClone(fixture);
    const brisbane = body.body.content.pickupMessage.stores[0];
    brisbane.storeNumber = "R466";
    brisbane.storeName = "Brisbane";
    brisbane.city = "Brisbane City";
    if (!state.anchorAvailable) {
      // deno-lint-ignore no-explicit-any
      (brisbane.partsAvailability as any)["MK2F4X/A"].pickupDisplay =
        "unavailable";
    }
    return Promise.resolve(new Response(JSON.stringify(body)));
  };
  return {
    state,
    fetchFn,
    requested,
  };
}

async function withKv(fn: (kv: Deno.Kv) => Promise<void>) {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(kv);
  } finally {
    kv.close();
  }
}

const T0 = new Date("2026-05-01T12:00:00Z");
const at = (min: number) => () => new Date(T0.getTime() + min * 60_000);

Deno.test("runCheck: disabled still fetches all stores, but no push and no history", async () => {
  await withKv(async (kv) => {
    await saveSettings(kv, { enabled: false, watch: ALL_WATCH });
    const m = makeMock();
    m.state.r351 = true;
    const r = await runCheck(kv, {
      fetchFn: m.fetchFn,
      sleep: noSleep,
      now: at(0),
    });
    assertEquals(m.requested, ["R466", "R509", "R351"]);
    assert(r.ok);
    assertEquals(r.hits, []);
    assertEquals(r.storesChecked.length, 3);
    assertEquals(await listHistory(kv, { now: T0 }), []);
    const snap = await getSnapshot(kv);
    assertEquals(Object.keys(snap!.stores).length, 3);
    assertEquals(snap!.stores["R351"].parts["MK2D4X/A"].available, true);
    assertEquals((await getLastRun(kv))?.ok, true);
  });
});

Deno.test("runCheck: records each hit, logs stock changes, then sold_out", async () => {
  await withKv(async (kv) => {
    await saveSettings(kv, {
      enabled: true,
      watch: ["R466|MK2F4X/A", "R509|MK2L4X/A", "R351|MK2D4X/A"],
    });
    const m = makeMock();
    m.state.r351 = true;
    m.state.r509 = true;
    const run = (min: number) =>
      runCheck(kv, {
        fetchFn: m.fetchFn,
        sleep: noSleep,
        now: at(min),
      });

    const r1 = await run(0);
    assert(r1.ok);
    assertEquals(r1.at, "2026-05-01T12:00:00.000Z");
    assertEquals(
      r1.hits.map((h) => `${h.storeId}:${h.part}`),
      ["R466:MK2F4X/A", "R509:MK2L4X/A", "R351:MK2D4X/A"],
    );
    const r2 = await run(1);
    assertEquals(r2.hits.length, 3);

    let hist = await listHistory(kv, { now: at(2)() });
    assertEquals(hist.length, 3);
    assert(hist.every((h) => h.kind === "in_stock" && h.at === r1.at));

    // Robina sells out, Brisbane too.
    m.state.r351 = false;
    m.state.anchorAvailable = false;
    const r3 = await run(2);
    assertEquals(r3.hits.map((h) => h.storeId), ["R509"]);
    hist = await listHistory(kv, { now: at(3)() });
    assertEquals(hist.length, 5);
    assertEquals(
      hist.slice(0, 2).map((h) => `${h.kind}:${h.storeId}:${h.part}`).sort(),
      ["sold_out:R351:MK2D4X/A", "sold_out:R466:MK2F4X/A"],
    );
    assertEquals((await getLastRun(kv))?.hits.length, 1);
  });
});

Deno.test("runCheck: restock events appended on transitions only", async () => {
  await withKv(async (kv) => {
    await saveSettings(kv, { enabled: false, watch: [] });
    const m = makeMock();
    const run = (min: number) =>
      runCheck(kv, {
        fetchFn: m.fetchFn,
        sleep: noSleep,
        now: at(min),
      });
    const events = () => listRestocks(kv, { now: at(10)() });

    await run(0); // first run: no previous snapshot, nothing logged
    assertEquals(await events(), []);
    await run(1); // unchanged
    assertEquals(await events(), []);

    m.state.r351 = true;
    m.state.r509 = true;
    await run(2);
    let ev = await events();
    assertEquals(
      ev.map((e) => `${e.storeId}:${e.part}`).sort(),
      ["R351:MK2D4X/A", "R509:MK2L4X/A"],
    );
    assert(ev.every((e) => e.at === "2026-05-01T12:02:00.000Z"));

    await run(3); // still available: no new events
    assertEquals((await events()).length, 2);

    m.state.r351 = false; // sold out: no event
    await run(4);
    assertEquals((await events()).length, 2);

    m.state.r351 = true; // restock again
    await run(5);
    ev = await events();
    assertEquals(ev.length, 3);
    assertEquals(ev[2].at, "2026-05-01T12:05:00.000Z");
  });
});

Deno.test("runCheck: missing store keeps old snapshot data and logs no sold_out", async () => {
  await withKv(async (kv) => {
    await saveSettings(kv, { enabled: true, watch: ["R351|MK2D4X/A"] });
    const m = makeMock();
    m.state.r351 = true;
    const deps = (min: number) => ({
      fetchFn: m.fetchFn,
      sleep: noSleep,
      now: at(min),
    });
    await runCheck(kv, deps(0));
    m.state.failR351 = true;
    const r = await runCheck(kv, deps(1));
    assert(r.ok);
    assertEquals(r.storesMissing, ["R351"]);
    // The hit is carried forward (not re-alerted) while Robina is unchecked.
    assertEquals(r.hits.map((h) => h.storeId), ["R351"]);
    const snap = (await getSnapshot(kv))!;
    assertEquals(snap.at, "2026-05-01T12:01:00.000Z");
    assertEquals(snap.stores["R351"].checkedAt, "2026-05-01T12:00:00.000Z");
    assertEquals(snap.stores["R351"].parts["MK2D4X/A"].available, true);
    assertEquals(snap.stores["R466"].checkedAt, "2026-05-01T12:01:00.000Z");
    const hist = await listHistory(kv, { now: at(2)() });
    assertEquals(hist.map((h) => h.kind), ["in_stock"]);
    // Robina is back and still in stock: no duplicate in_stock entry.
    m.state.failR351 = false;
    await runCheck(kv, deps(2));
    const hist2 = await listHistory(kv, { now: at(3)() });
    assertEquals(hist2.map((h) => h.kind), ["in_stock"]);
  });
});

Deno.test("runCheck: a failed run doesn't cause a duplicate in_stock entry", async () => {
  await withKv(async (kv) => {
    await saveSettings(kv, { enabled: true, watch: ["R466|MK2F4X/A"] });
    const m = makeMock();
    const deps = (min: number) => ({
      fetchFn: m.fetchFn,
      sleep: noSleep,
      now: at(min),
    });
    await runCheck(kv, deps(0));
    m.state.broken = true;
    assert(!(await runCheck(kv, deps(1))).ok);
    m.state.broken = false;
    await runCheck(kv, deps(2));
    const hist = await listHistory(kv, { now: at(3)() });
    assertEquals(hist.map((h) => h.kind), ["in_stock"]);
  });
});

Deno.test("runCheck: unwatching an in-stock pair is not logged as sold_out", async () => {
  await withKv(async (kv) => {
    await saveSettings(kv, { enabled: true, watch: ["R466|MK2F4X/A"] });
    const m = makeMock();
    const deps = (min: number) => ({
      fetchFn: m.fetchFn,
      sleep: noSleep,
      now: at(min),
    });
    await runCheck(kv, deps(0));
    await saveSettings(kv, { enabled: true, watch: [] });
    await runCheck(kv, deps(1));
    const hist = await listHistory(kv, { now: at(2)() });
    assertEquals(hist.map((h) => h.kind), ["in_stock"]);
  });
});

Deno.test("runCheck: no hits means no browser alert", async () => {
  await withKv(async (kv) => {
    await saveSettings(kv, { enabled: true, watch: ["R466|MK2D4X/A"] });
    const m = makeMock();
    const r = await runCheck(kv, {
      fetchFn: m.fetchFn,
      sleep: noSleep,
    });
    assertEquals(r.hits, []);
  });
});

Deno.test("runCheck: failure warning logged once at 10, success resets", async () => {
  await withKv(async (kv) => {
    await saveSettings(kv, { enabled: true, watch: ["R466|MK2F4X/A"] });
    const m = makeMock();
    m.state.broken = true;
    const run = (min = 0) =>
      runCheck(kv, {
        fetchFn: m.fetchFn,
        sleep: noSleep,
        now: at(min),
      });

    for (let i = 1; i <= 9; i++) {
      const r = await run(i);
      assert(!r.ok);
      assertEquals(r.consecutiveFailures, i);
    }
    assertEquals(await listHistory(kv, { now: at(10)() }), []);

    const tenth = await run(10);
    assertEquals(tenth.consecutiveFailures, 10);
    const hist = await listHistory(kv, { now: at(11)() });
    assertEquals(hist.length, 1);
    assertEquals(hist[0].kind, "warning");
    assert(String(hist[0].message).startsWith("Stock checker failing: "));

    await run(11);
    await run(12);
    assertEquals((await listHistory(kv, { now: at(13)() })).length, 1);

    m.state.broken = false;
    const good = await run(13);
    assert(good.ok);
    assertEquals(good.consecutiveFailures, 0);
    assertEquals((await getLastRun(kv))?.consecutiveFailures, 0);
  });
});

Deno.test("runCheck: failure warning is logged for browser clients", async () => {
  await withKv(async (kv) => {
    const m = makeMock();
    m.state.broken = true;
    for (let i = 1; i <= 10; i++) {
      await runCheck(kv, {
        fetchFn: m.fetchFn,
        sleep: noSleep,
        now: at(i),
      });
    }
    const hist = await listHistory(kv, { now: at(11)() });
    assertEquals(hist.map((h) => h.kind), ["warning"]);
  });
});

Deno.test("runCheck: records hits for browser notifications", async () => {
  await withKv(async (kv) => {
    await saveSettings(kv, { enabled: true, watch: ["R466|MK2F4X/A"] });
    const m = makeMock();
    const r = await runCheck(kv, { fetchFn: m.fetchFn, sleep: noSleep });
    assert(r.ok);
    assertEquals(r.hits.length, 1);
  });
});

Deno.test("runCheck: only newly in-stock hits are flagged for notification", async () => {
  await withKv(async (kv) => {
    await saveSettings(kv, { enabled: true, watch: ["R466|MK2F4X/A"] });
    const m = makeMock();
    const first = await runCheck(kv, { fetchFn: m.fetchFn, sleep: noSleep });
    assertEquals(first.newHits?.length, 1);
    const second = await runCheck(kv, { fetchFn: m.fetchFn, sleep: noSleep });
    assertEquals(second.hits.length, 1);
    assertEquals(second.newHits, []);
  });
});

Deno.test("sendDiscord: posts the alert and never throws", async () => {
  const { sendDiscord, buildAlert } = await import("../src/alert.ts");
  const alert = buildAlert([
    { storeId: "R466", storeName: "Brisbane", part: "MK2F4X/A" },
  ])!;
  let body = "";
  const accepted = await sendDiscord(
    "https://example.test/hook",
    alert,
    "https://shop",
    (
      _u,
      init,
    ) => {
      body = String(init?.body);
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  );
  assertEquals(accepted, true);
  assert(body.includes("iPhone Duo in stock at 1 store"));
  const rejected = await sendDiscord(
    "https://example.test/hook",
    alert,
    "https://shop",
    () => Promise.reject(new Error("down")),
  );
  assertEquals(rejected, false);
});
