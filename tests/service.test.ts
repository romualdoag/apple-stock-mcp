/** Offline tests for service-level store normalization (stubbed fetch). */
import { describe, it, expect } from "vitest";
import { checkAvailability } from "../src/service.js";

const PICKUP_BODY = {
  body: {
    stores: [
      {
        storeNumber: "R053",
        storeName: "Millenia",
        city: "Orlando",
        state: "FL",
        storeDistanceWithUnit: "1.65 mi",
        partsAvailability: {
          "MJQ64LL/A": {
            partNumber: "MJQ64LL/A",
            pickupDisplay: "available",
            pickupSearchQuote: "Available Today",
            messageTypes: {
              regular: {
                storePickupQuote: "Today at Apple Millenia",
                storePickupProductTitle: "iPhone 18 Pro 256GB Glacier",
              },
            },
          },
        },
      },
    ],
  },
};

describe("checkAvailability store normalization (stubbed)", () => {
  it("sends canonical R053 even when given r053", async () => {
    const urls: string[] = [];
    const stubFetch = (async (url: unknown) => {
      if (!String(url).includes("pickup-message")) {
        return new Response("", { status: 200 });
      }
      urls.push(String(url));
      return new Response(JSON.stringify(PICKUP_BODY), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const r = await checkAvailability(["MJQ64LL/A"], { stores: ["r053"] }, {
      fetchFn: stubFetch,
      retryDelayMs: 0,
    });

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("store=R053");
    expect(r.scope).toEqual({ stores: ["R053"] });
    expect(r.stores[0].storeNumber).toBe("R053");
    expect(r.stores[0].parts[0].kind).toBe("in_stock");
  });
});
