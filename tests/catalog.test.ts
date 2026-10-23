/** Offline tests for catalog parsing + product search (stubbed fetch). */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DEFAULT_REFERER } from "../src/apple.js";
import {
  asPartNumber,
  extractVariants,
  refererForCategory,
  searchProducts,
  clearCatalogCache,
} from "../src/catalog.js";
import {
  __resetCatalogCacheForTests,
  catalogKey,
  closeCatalogCache,
  getCatalogEntry,
  kvGet,
  kvSet,
  setCatalogEntry,
} from "../src/catalogCache.js";

const SAMPLE_HTML = `
{"sku":"MJWA4","partNumber":"MJWA4LL/A","price":{"fullPrice":1499.00},"category":"iphone","name":"iPhone 18 Pro Max 512GB Burgundy"},
{"sku":"MJQ64","partNumber":"MJQ64LL/A","price":{"fullPrice":1199.00},"category":"iphone","name":"iPhone 18 Pro 256GB Glacier"},
{"sku":"MJWH4","partNumber":"MJWH4LL/A","price":{"fullPrice":1599.00},"category":"iphone","name":"iPhone 18 Pro Max 512GB Glacier"},
{"partNumber":"IPHONE18PRO_MAIN"}
`;

beforeEach(() => {
  __resetCatalogCacheForTests(":memory:");
});

afterEach(() => {
  closeCatalogCache();
  delete process.env.APPLE_CACHE_ENABLED;
  delete process.env.APPLE_CATALOG_TTL_HOURS;
});

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

describe("catalog cold cache (SQLite kv_cache)", () => {
  const countingStub = (counter: { n: number }) =>
    (async () => {
      counter.n++;
      return new Response(SAMPLE_HTML, { status: 200, headers: { "Content-Type": "text/html" } });
    }) as typeof fetch;

  it("grava variants+html no frio na chave catalog:<slug>", async () => {
    const counter = { n: 0 };
    await searchProducts("iPhone 18 Pro Max 512GB", {
      category: "iphone",
      limit: 5,
      fetchFn: countingStub(counter),
    });
    expect(counter.n).toBe(3); // 3 buy pages do iphone
    const entry = getCatalogEntry("iphone-18-pro");
    expect(entry).toBeDefined();
    expect(entry!.html).toContain("MJWA4LL/A");
    expect(entry!.variants.length).toBeGreaterThan(0);
    expect(entry!.variants.some((v) => v.partNumber === "MJWA4LL/A")).toBe(true);
  });

  it("serve a 2ª busca do frio sem novo fetch", async () => {
    const counter = { n: 0 };
    const fetchFn = countingStub(counter);
    await searchProducts("iPhone 18 Pro Max 512GB", { category: "iphone", limit: 5, fetchFn });
    const first = counter.n;
    expect(first).toBeGreaterThan(0);
    const { matches, pagesFailed } = await searchProducts("iPhone 18 Pro Max 512GB", {
      category: "iphone",
      limit: 5,
      fetchFn,
    });
    expect(counter.n).toBe(first); // zero chamadas novas
    expect(pagesFailed).toHaveLength(0);
    expect(matches.length).toBeGreaterThan(0);
  });

  it("clearCatalogCache invalida o frio (próxima busca refaz fetch)", async () => {
    const counter = { n: 0 };
    const fetchFn = countingStub(counter);
    await searchProducts("iPhone 18 Pro Max 512GB", { category: "iphone", limit: 5, fetchFn });
    expect(counter.n).toBeGreaterThan(0);
    clearCatalogCache();
    expect(getCatalogEntry("iphone-18-pro")).toBeUndefined();
    await searchProducts("iPhone 18 Pro Max 512GB", { category: "iphone", limit: 5, fetchFn });
    expect(counter.n).toBe(6);
  });

  it("TTL expirado = miss (kvGet respeita ttlHours)", () => {
    kvSet(catalogKey("iphone-18-pro"), { html: SAMPLE_HTML, variants: [], fetchedAt: new Date().toISOString() });
    // TTL negativo sempre expira.
    expect(kvGet(catalogKey("iphone-18-pro"), -1)).toBeUndefined();
    // TTL normal acerta.
    expect(kvGet(catalogKey("iphone-18-pro"), 168)).toBeDefined();
  });

  it("APPLE_CACHE_ENABLED=0 faz bypass (fail-soft, sempre live)", async () => {
    process.env.APPLE_CACHE_ENABLED = "0";
    const counter = { n: 0 };
    const fetchFn = countingStub(counter);
    await searchProducts("iPhone 18 Pro Max 512GB", { category: "iphone", limit: 5, fetchFn });
    await searchProducts("iPhone 18 Pro Max 512GB", { category: "iphone", limit: 5, fetchFn });
    expect(counter.n).toBe(6); // sem cache: 3 + 3
    expect(getCatalogEntry("iphone-18-pro")).toBeUndefined();
  });

  it("setCatalogEntry/getCatalogEntry roundtrip", () => {
    const variants = extractVariants(SAMPLE_HTML, "iphone-18-pro", "https://example/u");
    setCatalogEntry("iphone-18-pro", SAMPLE_HTML, variants);
    const entry = getCatalogEntry("iphone-18-pro");
    expect(entry?.html).toBe(SAMPLE_HTML);
    expect(entry?.variants).toHaveLength(3);
  });
});
