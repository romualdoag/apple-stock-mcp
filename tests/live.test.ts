/**
 * Live tests against www.apple.com (needs network; no credentials).
 *
 * Opt-in only: skipped unless LIVE=1, so `npm test` stays offline.
 *   npm test              # offline (fixtures + stubs)
 *   LIVE=1 npm run test:live  # hits apple.com
 */
import { describe, it, expect } from "vitest";
import { checkAvailability, checkProductAvailability, searchStores } from "../src/service.js";

const LIVE = process.env.LIVE === "1";

describe.skipIf(!LIVE)("live: searchStores", () => {
  it("lists Orlando stores including Millenia R053", async () => {
    const r = await searchStores("32839", { probePart: "MJQ64LL/A" });
    const numbers = r.stores.map((s) => s.storeNumber);
    expect(numbers).toContain("R053");
    expect(numbers).toContain("R143"); // Florida Mall
    const millenia = r.stores.find((s) => s.storeNumber === "R053")!;
    expect(millenia.city).toBe("Orlando");
  }, 60_000);
});

describe.skipIf(!LIVE)("live: checkAvailability", () => {
  it("returns tri-state status for a real part at a real store", async () => {
    const r = await checkAvailability(["MJQ64LL/A"], { stores: ["R053"] });
    expect(r.stores).toHaveLength(1);
    expect(r.stores[0].storeNumber).toBe("R053");
    const part = r.stores[0].parts[0];
    expect(["in_stock", "out_of_stock", "unknown"]).toContain(part.kind);
    if (part.kind === "unknown") expect(part.reason).toBeTruthy();
  }, 60_000);
});

describe.skipIf(!LIVE)("live: checkProductAvailability", () => {
  it("resolves iPhone 18 Pro Max 512GB near Orlando and reports per-store status", async () => {
    const r = await checkProductAvailability("iPhone 18 Pro Max 512GB", { location: "Orlando" });
    expect(r.resolvedParts.length).toBeGreaterThan(0);
    expect(r.resolvedParts.every((p) => /\/A$/.test(p.partNumber))).toBe(true);
    expect(r.availability.stores.length).toBeGreaterThan(0);
    for (const s of r.availability.stores) {
      for (const p of s.parts) {
        expect(["in_stock", "out_of_stock", "unknown"]).toContain(p.kind);
      }
    }
  }, 120_000);
});
