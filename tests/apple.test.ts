/** Offline tests for URL building + tri-state parsing (fixture-backed, no network). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  AppleApiError,
  buildPickupUrl,
  parsePickupResponse,
} from "../src/apple.js";

const dir = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(dir, "fixtures", "pickup-orlando.json"), "utf-8"),
);

describe("buildPickupUrl", () => {
  it("builds a store-scoped URL with indexed parts", () => {
    const url = buildPickupUrl(["MJWA4LL/A", "MJQ64LL/A"], { store: "R053" });
    expect(url).toBe(
      "https://www.apple.com/shop/retail/pickup-message?pl=true&mts.0=regular&store=R053&parts.0=MJWA4LL%2FA&parts.1=MJQ64LL%2FA",
    );
  });

  it("builds a location-scoped URL", () => {
    const url = buildPickupUrl(["MJWA4LL/A"], { location: "32839" });
    expect(url).toContain("location=32839");
    expect(url).toContain("parts.0=MJWA4LL%2FA");
  });

  it("rejects an empty scope", () => {
    expect(() => buildPickupUrl(["MJWA4LL/A"], {})).toThrow(AppleApiError);
  });
});

describe("parsePickupResponse (Orlando fixture)", () => {
  it("finds Millenia R053 in stock for the requested part", () => {
    const stores = parsePickupResponse(fixture, ["MJQ64LL/A"]);
    expect(stores.length).toBe(12);
    const millenia = stores.find((s) => s.storeNumber === "R053");
    expect(millenia).toBeDefined();
    expect(millenia!.storeName).toBe("Millenia");
    expect(millenia!.city).toBe("Orlando");
    const part = millenia!.parts[0];
    expect(part.partNumber).toBe("MJQ64LL/A");
    expect(part.kind).toBe("in_stock");
    expect(part.pickupDisplay).toBe("available");
    expect(part.productTitle).toContain("iPhone 18 Pro");
  });

  it("marks unrequested/missing parts as unknown, never out_of_stock", () => {
    const stores = parsePickupResponse(fixture, ["MJQ64LL/A", "NOPE0LL/A"]);
    for (const s of stores) {
      const missing = s.parts.find((p) => p.partNumber === "NOPE0LL/A")!;
      expect(missing.kind).toBe("unknown");
      expect(missing.reason).toContain("no data");
    }
  });

  it("maps unavailable display to out_of_stock", () => {
    const body = {
      body: {
        stores: [
          {
            storeNumber: "R999",
            storeName: "Test",
            city: "Nowhere",
            state: "FL",
            storeDistanceWithUnit: "0 mi",
            partsAvailability: {
              "X1234LL/A": {
                partNumber: "X1234LL/A",
                pickupDisplay: "unavailable",
                pickupSearchQuote: "Currently unavailable",
                messageTypes: { regular: { storePickupQuote: "Unavailable" } },
              },
            },
          },
        ],
      },
    };
    const [store] = parsePickupResponse(body, ["X1234LL/A"]);
    expect(store.parts[0].kind).toBe("out_of_stock");
  });

  it("maps unrecognized display values to unknown with a reason", () => {
    const body = {
      body: {
        stores: [
          {
            storeNumber: "R999",
            storeName: "Test",
            partsAvailability: {
              "X1234LL/A": { partNumber: "X1234LL/A", pickupDisplay: "coming_soon" },
            },
          },
        ],
      },
    };
    const [store] = parsePickupResponse(body, ["X1234LL/A"]);
    expect(store.parts[0].kind).toBe("unknown");
    expect(store.parts[0].reason).toContain("coming_soon");
  });

  it("throws a parse error when stores are absent", () => {
    expect(() => parsePickupResponse({ head: {}, body: {} }, ["X"])).toThrow(AppleApiError);
  });
});
