import {
  AppleError,
  buildPickupUrl,
  fetchAllStock,
  fetchPickup,
  parsePickupResponse,
} from "../src/apple.ts";
import { ALL_SKUS } from "../src/catalog.ts";
import fixture from "./fixtures/pickup_r121.json" with { type: "json" };
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "./_assert.ts";

const PARTS = ALL_SKUS.map((s) => s.part);
const noSleep = () => Promise.resolve();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

Deno.test("buildPickupUrl: params, encoding and order", () => {
  const url = buildPickupUrl("R121", ["MK2D4X/A", "MK2E4X/A"], true);
  assertEquals(
    url,
    "https://www.apple.com/au/shop/retail/pickup-message?fae=true&store=R121&searchNearby=true&little=false" +
      "&parts.0=MK2D4X%2FA&parts.1=MK2E4X%2FA&mts.0=regular&mts.1=sticky&fts=true",
  );
  assert(buildPickupUrl("R121", [], false).includes("searchNearby=false"));
});

Deno.test("parsePickupResponse: content.pickupMessage shape", () => {
  const stores = parsePickupResponse(fixture);
  assertEquals(stores.length, 10);
  const eaton = stores.find((s) => s.storeId === "R121")!;
  assertEquals(eaton.storeName, "Eaton Centre");
  assertEquals(eaton.city, "Toronto");
  assertEquals(Object.keys(eaton.parts).length, 8);
  assertEquals(eaton.parts["MK2F4X/A"], {
    pickupDisplay: "available",
    quote: "Today at Eaton Centre",
  });
  assertEquals(eaton.parts["MK2D4X/A"].pickupDisplay, "unavailable");
});

Deno.test("parsePickupResponse: body.stores shape and quote fallback", () => {
  const out = parsePickupResponse({
    body: {
      stores: [{
        storeNumber: "R1",
        storeName: "X",
        partsAvailability: {
          "A/B": {
            partNumber: "A/B",
            pickupDisplay: "available",
            pickupSearchQuote: "Soon",
          },
        },
      }],
    },
  });
  assertEquals(out[0].parts["A/B"], {
    pickupDisplay: "available",
    quote: "Soon",
  });
});

Deno.test("parsePickupResponse: garbage throws AppleError", () => {
  for (
    const bad of [null, "x", {}, { body: {} }, {
      body: { content: { pickupMessage: {} } },
    }]
  ) {
    assertThrows(() => parsePickupResponse(bad), AppleError);
  }
  const e = assertThrows(
    () =>
      parsePickupResponse({
        body: { content: { pickupMessage: { errorMessageKeys: ["bad"] } } },
      }),
    AppleError,
  );
  assert(e.message.includes("bad"));
});

Deno.test("fetchPickup: HTML body is an AppleError", async () => {
  const fetchFn = () =>
    Promise.resolve(
      new Response("<html>Access Denied</html>", { status: 200 }),
    );
  await assertRejects(
    () => fetchPickup("R121", PARTS, { fetchFn, sleep: noSleep }),
    AppleError,
  );
});

Deno.test("fetchPickup: invalid JSON and HTTP errors", async () => {
  await assertRejects(
    () =>
      fetchPickup("R121", PARTS, {
        fetchFn: () => Promise.resolve(new Response("nope")),
        sleep: noSleep,
      }),
    AppleError,
  );
  const e = await assertRejects(
    () =>
      fetchPickup("R121", PARTS, {
        fetchFn: () => Promise.resolve(new Response("", { status: 500 })),
        sleep: noSleep,
      }),
    AppleError,
  );
  assertEquals((e as AppleError).status, 500);
});

Deno.test("fetchPickup: 541 retries then succeeds", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const fetchFn: typeof fetch = () =>
    Promise.resolve(
      ++calls < 3 ? new Response("", { status: 541 }) : json(fixture),
    );
  const out = await fetchPickup("R121", PARTS, {
    fetchFn,
    sleep: (ms) => (sleeps.push(ms), Promise.resolve()),
  });
  assertEquals(calls, 3);
  assertEquals(out.length, 10);
  assertEquals(sleeps.length, 2);
  assert(
    sleeps[0] >= 2000 && sleeps[0] < 2500 && sleeps[1] >= 4000 &&
      sleeps[1] < 4500,
  );
});

Deno.test("fetchPickup: 541 forever gives up after 2 retries", async () => {
  let calls = 0;
  const fetchFn: typeof fetch = () =>
    Promise.resolve((calls++, new Response("", { status: 541 })));
  const e = await assertRejects(
    () => fetchPickup("R121", PARTS, { fetchFn, sleep: noSleep }),
    AppleError,
  );
  assertEquals((e as AppleError).status, 541);
  assertEquals(calls, 3);
});

Deno.test("fetchPickup: network failure becomes AppleError", async () => {
  const fetchFn: typeof fetch = () => Promise.reject(new TypeError("boom"));
  await assertRejects(
    () => fetchPickup("R121", PARTS, { fetchFn, sleep: noSleep }),
    AppleError,
  );
});

/** Mock that serves the fixture for R121 and a one-store response for R464. */
export function mockApple(requested: string[] = []): typeof fetch {
  return (input) => {
    const store = new URL(String(input)).searchParams.get("store")!;
    requested.push(store);
    if (store === "R464") {
      return Promise.resolve(json({
        body: {
          content: {
            pickupMessage: {
              stores: [{
                storeNumber: "R464",
                storeName: "Conestoga",
                city: "Waterloo",
                partsAvailability: {
                  "MK2D4X/A": {
                    partNumber: "MK2D4X/A",
                    pickupDisplay: "available",
                    pickupSearchQuote: "Available Today",
                  },
                  "MK2E4X/A": {
                    partNumber: "MK2E4X/A",
                    pickupDisplay: "unavailable",
                  },
                },
              }],
            },
          },
        },
      }));
    }
    return Promise.resolve(json(fixture));
  };
}

Deno.test("fetchAllStock: follow-up request anchored at missing R464", async () => {
  const requested: string[] = [];
  const r = await fetchAllStock(["R121", "R350", "R464"], PARTS, {
    fetchFn: mockApple(requested),
    sleep: noSleep,
  });
  assertEquals(requested, ["R121", "R464"]);
  assertEquals(r.storesChecked, ["R121", "R350", "R464"]);
  assertEquals(r.storesMissing, []);
  assertEquals(Object.keys(r.stores), ["R121", "R350", "R464"]);
  assertEquals(r.stores["R121"]["MK2F4X/A"], {
    available: true,
    quote: "Today at Eaton Centre",
  });
  assertEquals(r.stores["R121"]["MK2D4X/A"].available, false);
  assertEquals(r.stores["R350"]["MK2J4X/A"].available, true);
  assertEquals(r.stores["R350"]["MK2L4X/A"].available, true);
  assertEquals(r.stores["R464"]["MK2D4X/A"], {
    available: true,
    quote: "Available Today",
  });
  assertEquals(r.stores["R464"]["MK2E4X/A"].available, false);
});

Deno.test("fetchAllStock: only requested parts are returned", async () => {
  const requested: string[] = [];
  const r = await fetchAllStock(["R350"], ["MK2L4X/A"], {
    fetchFn: mockApple(requested),
    sleep: noSleep,
  });
  assertEquals(requested, ["R350"]);
  assertEquals(r.storesChecked, ["R350"]);
  assertEquals(Object.keys(r.stores["R350"]), ["MK2L4X/A"]);
  assertEquals(r.stores["R350"]["MK2L4X/A"].available, true);
});

Deno.test("fetchAllStock: unreachable follow-up leaves store missing; no stores means no request", async () => {
  const fetchFn: typeof fetch = (input) => {
    const store = new URL(String(input)).searchParams.get("store");
    return Promise.resolve(
      store === "R121" ? json(fixture) : new Response("", { status: 500 }),
    );
  };
  const r = await fetchAllStock(["R121", "R464"], PARTS, {
    fetchFn,
    sleep: noSleep,
  });
  assertEquals(r.storesMissing, ["R464"]);
  assertEquals(r.storesChecked, ["R121"]);
  assertEquals(Object.keys(r.stores), ["R121"]);

  const none = await fetchAllStock([], PARTS, {
    fetchFn: () => Promise.reject(new Error("no network")),
  });
  assertEquals(none, { stores: {}, storesChecked: [], storesMissing: [] });
});

Deno.test("fetchAllStock: first request failure throws", async () => {
  await assertRejects(
    () =>
      fetchAllStock(["R121"], PARTS, {
        fetchFn: () => Promise.resolve(new Response("", { status: 500 })),
        sleep: noSleep,
      }),
    AppleError,
  );
});

Deno.test("buildPickupUrl: region selects the storefront", () => {
  assert(
    buildPickupUrl("R001", ["X"], true, "us").startsWith(
      "https://www.apple.com/us/shop/retail/pickup-message?",
    ),
  );
});
