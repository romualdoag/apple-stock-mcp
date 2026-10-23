/** Testes :memory: do hardening de chaves do frio (v1 + alias + validação). */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  extractVariants,
  fetchBuyPage,
  type FamilyPage,
} from "../src/catalog.js";
import {
  __resetCatalogCacheForTests,
  catalogKey,
  closeCatalogCache,
  deleteCatalogEntry,
  getCatalogEntry,
  kvGet,
  kvSet,
  legacyCatalogKey,
  normalizeSlug,
  resolveSlug,
  setCatalogEntry,
  validateCatalogEntry,
} from "../src/catalogCache.js";

const SAMPLE_HTML = `
{"sku":"MJWA4","partNumber":"MJWA4LL/A","price":{"fullPrice":1499.00},"category":"iphone","name":"iPhone 18 Pro Max 512GB Burgundy"},
{"sku":"MJQ64","partNumber":"MJQ64LL/A","price":{"fullPrice":1199.00},"category":"iphone","name":"iPhone 18 Pro 256GB Glacier"},
`;

const PAGE: FamilyPage = { category: "iphone", slug: "iphone-18-pro", url: "https://example/iphone-18-pro" };

const stubFetch = (html: string, counter?: { n: number }) =>
  (async () => {
    if (counter) counter.n++;
    return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
  }) as typeof fetch;

beforeEach(() => {
  __resetCatalogCacheForTests(":memory:");
});

afterEach(() => {
  closeCatalogCache();
  delete process.env.APPLE_CACHE_ENABLED;
  delete process.env.APPLE_CATALOG_TTL_HOURS;
});

describe("normalização de slug", () => {
  it("catalogKey faz trim + lowercase com prefixo v1:", () => {
    expect(catalogKey("  iPhone-18-PRO ")).toBe("v1:catalog:iphone-18-pro");
    expect(normalizeSlug("  iPhone-18-PRO ")).toBe("iphone-18-pro");
  });

  it("gravado com case/espaço é lido em qualquer forma", () => {
    const variants = extractVariants(SAMPLE_HTML, "iphone-18-pro", PAGE.url);
    setCatalogEntry("  iPhone-18-Pro ", SAMPLE_HTML, variants);
    expect(getCatalogEntry("IPHONE-18-PRO")).toBeDefined();
    expect(getCatalogEntry("iphone-18-pro")?.html).toBe(SAMPLE_HTML);
    // Não cria chave duplicada com case diferente.
    expect(kvGet("v1:catalog:IPHONE-18-PRO", 168)).toBeUndefined();
  });
});

describe("fallback da chave legada", () => {
  it("lê catalog:<slug> e migra pra v1: preservando fetchedAt", () => {
    const variants = extractVariants(SAMPLE_HTML, "iphone-18-pro", PAGE.url);
    const fetchedAt = new Date(Date.now() - 3_600_000).toISOString(); // 1h atrás
    kvSet(legacyCatalogKey("iphone-18-pro"), { html: SAMPLE_HTML, variants, fetchedAt });
    expect(legacyCatalogKey("iphone-18-pro")).toBe("catalog:iphone-18-pro");

    const entry = getCatalogEntry("iphone-18-pro");
    expect(entry?.html).toBe(SAMPLE_HTML);
    expect(entry?.variants).toHaveLength(2);
    // Migrou: v1 serve, legada sumiu.
    expect(kvGet(catalogKey("iphone-18-pro"), 168)).toBeDefined();
    expect(kvGet(legacyCatalogKey("iphone-18-pro"), 168)).toBeUndefined();
    // Idade preservada (sem renovar TTL na migração).
    expect((kvGet(catalogKey("iphone-18-pro"), 168) as { fetchedAt: string }).fetchedAt).toBe(fetchedAt);
  });
});

describe("alias de lineup", () => {
  it("slug antigo resolve pro atual e lê a mesma entrada", () => {
    expect(resolveSlug("iphone-17-pro")).toBe("iphone-18-pro");
    const variants = extractVariants(SAMPLE_HTML, "iphone-18-pro", PAGE.url);
    setCatalogEntry("iphone-18-pro", SAMPLE_HTML, variants);
    const viaAlias = getCatalogEntry("iphone-17-pro");
    expect(viaAlias?.html).toBe(SAMPLE_HTML);
    expect(viaAlias?.variants.some((v) => v.partNumber === "MJWA4LL/A")).toBe(true);
  });

  it("entrada legada guardada sob o nome antigo também é achada e migrada", () => {
    const variants = extractVariants(SAMPLE_HTML, "iphone-18-pro", PAGE.url);
    kvSet("catalog:iphone-17-pro", { html: SAMPLE_HTML, variants, fetchedAt: new Date().toISOString() });
    const entry = getCatalogEntry("  IPHONE-17-PRO ");
    expect(entry?.html).toBe(SAMPLE_HTML);
    expect(kvGet(catalogKey("iphone-18-pro"), 168)).toBeDefined();
  });
});

describe("validação do hit", () => {
  it("validateCatalogEntry barra variants que não constam no html", () => {
    const good = {
      html: SAMPLE_HTML,
      variants: extractVariants(SAMPLE_HTML, "iphone-18-pro", PAGE.url),
      fetchedAt: new Date().toISOString(),
    };
    expect(validateCatalogEntry(good)).toBe(true);
    expect(
      validateCatalogEntry({
        ...good,
        variants: [{ partNumber: "ZZZ99LL/A", name: "Fantasma", price: null, family: "iphone-18-pro", url: PAGE.url }],
      }),
    ).toBe(false);
    expect(validateCatalogEntry({ html: SAMPLE_HTML, variants: [], fetchedAt: good.fetchedAt })).toBe(true);
  });

  it("fetchBuyPage invalida hit divergente e refaz fetch (senão invalide)", async () => {
    setCatalogEntry(PAGE.slug, SAMPLE_HTML, [
      { partNumber: "ZZZ99LL/A", name: "Fantasma", price: null, family: PAGE.slug, url: PAGE.url },
    ]);
    const counter = { n: 0 };
    const html = await fetchBuyPage(PAGE, stubFetch(SAMPLE_HTML, counter));
    expect(counter.n).toBe(1); // não serviu o stale: foi ao live
    expect(html).toBe(SAMPLE_HTML);
    // Refetch gravou entrada válida: próxima chamada sai do frio.
    await fetchBuyPage(PAGE, stubFetch(SAMPLE_HTML, counter));
    expect(counter.n).toBe(1);
  });

  it("validate callback com refresh barato: false invalida, true serve", () => {
    const variants = extractVariants(SAMPLE_HTML, "iphone-18-pro", PAGE.url);
    setCatalogEntry(PAGE.slug, SAMPLE_HTML, variants);
    expect(getCatalogEntry(PAGE.slug, { validate: () => true })?.html).toBe(SAMPLE_HTML);
    expect(getCatalogEntry(PAGE.slug, { validate: () => false })).toBeUndefined();
    expect(getCatalogEntry(PAGE.slug)).toBeUndefined(); // invalidada, não só miss
    // deleteCatalogEntry remove v1 + legadas.
    setCatalogEntry(PAGE.slug, SAMPLE_HTML, variants);
    deleteCatalogEntry(" IPHONE-18-PRO ");
    expect(getCatalogEntry(PAGE.slug)).toBeUndefined();
  });
});
