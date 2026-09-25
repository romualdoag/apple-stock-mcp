/** Offline tests for catalog parsing + product search (stubbed fetch). */
import { describe, it, expect } from "vitest";
import { DEFAULT_REFERER } from "../src/apple.js";
import {
  asPartNumber,
  extractVariants,
  refererForCategory,
  searchProducts,
  clearCatalogCache,
} from "../src/catalog.js";

const SAMPLE_HTML = `
{"sku":"MJWA4","partNumber":"MJWA4LL/A","price":{"fullPrice":1499.00},"category":"iphone","name":"iPhone 18 Pro Max 512GB Burgundy"},
{"sku":"MJQ64","partNumber":"MJQ64LL/A","price":{"fullPrice":1199.00},"category":"iphone","name":"iPhone 18 Pro 256GB Glacier"},
{"sku":"MJWH4","partNumber":"MJWH4LL/A","price":{"fullPrice":1599.00},"category":"iphone","name":"iPhone 18 Pro Max 512GB Glacier"},
{"partNumber":"IPHONE18PRO_MAIN"}
`;

describe("extractVariants", () => {
  it("pairs part numbers with names", () => {
    const variants = extractVariants(SAMPLE_HTML, "iphone-18-pro", "https://example/u");
    expect(variants).toHaveLength(3);
    const max = variants.find((v) => v.partNumber === "MJWA4LL/A")!;
    expect(max.name).toBe("iPhone 18 Pro Max 512GB Burgundy");
    expect(max.price).toBe(1499);
  });

  it("skips placeholder entries without names", () => {
    const variants = extractVariants(SAMPLE_HTML, "iphone-18-pro", "https://example/u");
    expect(variants.some((v) => v.partNumber === "IPHONE18PRO_MAIN")).toBe(false);
  });
});

describe("asPartNumber", () => {
  it("accepts exact parts case-insensitively", () => {
    expect(asPartNumber("mjwa4ll/a")).toBe("MJWA4LL/A");
    expect(asPartNumber("  MJWA4LL/A ")).toBe("MJWA4LL/A");
  });

  it("rejects free text", () => {
    expect(asPartNumber("iPhone 18 Pro Max 512GB")).toBeNull();
    expect(asPartNumber("")).toBeNull();
  });
});

describe("refererForCategory", () => {
  it("returns a matching buy page per family", () => {
    expect(refererForCategory("iphone")).toContain("/shop/buy-iphone/");
    expect(refererForCategory("mac")).toContain("/shop/buy-mac/");
    expect(refererForCategory("watch")).toContain("/shop/buy-watch/");
  });

  it("falls back to the default referer when unknown", () => {
    expect(refererForCategory(undefined)).toBe(DEFAULT_REFERER);
    expect(refererForCategory("toaster")).toBe(DEFAULT_REFERER);
  });
});

describe("searchProducts (stubbed)", () => {
  const stubFetch = (async () =>
    new Response(SAMPLE_HTML, { status: 200, headers: { "Content-Type": "text/html" } })) as typeof fetch;

  it("ranks the 512GB Pro Max variants first", async () => {
    clearCatalogCache();
    const { matches, pagesFailed } = await searchProducts("iPhone 18 Pro Max 512GB", {
      category: "iphone",
      limit: 5,
      fetchFn: stubFetch,
    });
    expect(pagesFailed).toHaveLength(0);
    expect(matches.length).toBeGreaterThan(0);
    // Both 512GB Max variants share the top score.
    expect(matches[0].score).toBe(matches[1].score);
    expect(matches.slice(0, 2).every((m) => m.name.includes("Pro Max") && m.name.includes("512GB"))).toBe(true);
  });
});
