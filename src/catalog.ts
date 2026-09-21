/**
 * catalog.ts — resolve free-text product queries ("iPhone 18 Pro Max 512GB")
 * to Apple part numbers by parsing the buy-page embedded JSON.
 *
 * Buy pages embed variant objects shaped like:
 *   {"sku":"MJWA4","partNumber":"MJWA4LL/A","price":{"fullPrice":1499.00},
 *    "category":"iphone","name":"iPhone 18 Pro Max 512GB Burgundy"}
 */

import { APPLE_BASE_URL, USER_AGENT, type FetchFn } from "./apple.js";

export interface FamilyPage {
  category: "iphone" | "ipad" | "mac" | "watch" | "accessory";
  slug: string;
  url: string;
}

const buy = (path: string, slug: string, category: FamilyPage["category"]): FamilyPage => ({
  category,
  slug,
  url: `${APPLE_BASE_URL}/shop/${path}/${slug}`,
});

/** Current lineup (verified live 2026-09-21; new models only need a line here). */
export const FAMILY_PAGES: FamilyPage[] = [
  buy("buy-iphone", "iphone-18-pro", "iphone"),
  buy("buy-iphone", "iphone-17", "iphone"),
  buy("buy-iphone", "iphone-air", "iphone"),
  buy("buy-ipad", "ipad-pro", "ipad"),
  buy("buy-ipad", "ipad-air", "ipad"),
  buy("buy-ipad", "ipad", "ipad"),
  buy("buy-ipad", "ipad-mini", "ipad"),
  buy("buy-mac", "macbook-air", "mac"),
  buy("buy-mac", "macbook-pro", "mac"),
  buy("buy-mac", "imac", "mac"),
  buy("buy-mac", "mac-mini", "mac"),
  buy("buy-mac", "mac-studio", "mac"),
  buy("buy-watch", "apple-watch", "watch"),
  buy("buy-watch", "apple-watch-ultra", "watch"),
];

export interface Variant {
  partNumber: string;
  name: string;
  price: number | null;
  family: string;
  url: string;
}

/**
 * Extract variants from buy-page HTML. Tolerates Apple reshuffling the
 * surrounding JSON: only the partNumber -> name pairing matters.
 */
export function extractVariants(html: string, family: string, url: string): Variant[] {
  const re = /"partNumber":"([A-Z0-9]{3,8}\/A)"(?:[^]{0,400}?"name":"([^"]+)")?/g;
  const seen = new Map<string, Variant>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const partNumber = m[1];
    const name = m[2] ?? "";
    // Skip placeholder/configurator entries without a real name.
    if (!name || /_MAIN$/.test(partNumber)) {
      if (!seen.has(partNumber) && name) seen.set(partNumber, { partNumber, name, price: null, family, url });
      continue;
    }
    if (!seen.has(partNumber)) {
      const priceM = /"fullPrice":([\d.]+)/.exec(m[0]);
      seen.set(partNumber, {
        partNumber,
        name,
        price: priceM ? Number(priceM[1]) : null,
        family,
        url,
      });
    }
  }
  return [...seen.values()];
}

const fetchCache = new Map<string, { html: string; expires: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

export async function fetchBuyPage(page: FamilyPage, fetchFn: FetchFn = fetch): Promise<string> {
  const cached = fetchCache.get(page.url);
  if (cached && cached.expires > Date.now()) return cached.html;
  const res = await fetchFn(page.url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
  });
  if (!res.ok) throw new Error(`Buy page ${page.slug} returned HTTP ${res.status}`);
  const html = await res.text();
  fetchCache.set(page.url, { html, expires: Date.now() + CACHE_TTL_MS });
  return html;
}

export function clearCatalogCache(): void {
  fetchCache.clear();
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokens(s: string): string[] {
  return normalize(s).split(" ").filter(Boolean);
}

/** Score a variant name against query tokens (all-tokens-match wins). */
function scoreVariant(variantTokens: Set<string>, queryTokens: string[]): number {
  let hits = 0;
  for (const q of queryTokens) {
    // Allow "pro max" style multi-word + prefix matches ("18" vs model).
    for (const v of variantTokens) {
      if (v === q || v.startsWith(q) || q.startsWith(v)) {
        hits++;
        break;
      }
    }
  }
  return hits;
}

export interface ProductMatch extends Variant {
  score: number;
}

/**
 * Search product variants across relevant family pages.
 * Returns matches sorted by relevance (best first).
 */
export async function searchProducts(
  query: string,
  opts: { category?: string; limit?: number; fetchFn?: FetchFn } = {},
): Promise<{ matches: ProductMatch[]; pagesChecked: string[]; pagesFailed: string[] }> {
  const q = normalize(query);
  const queryTokens = tokens(query);
  const categoryHint = (opts.category ?? guessCategory(q)).toLowerCase();
  const pages = FAMILY_PAGES.filter((p) => !categoryHint || p.category === categoryHint);
  const fetchFn = opts.fetchFn ?? fetch;

  const pagesChecked: string[] = [];
  const pagesFailed: string[] = [];
  const all: Variant[] = [];
  for (const page of pages.length > 0 ? pages : FAMILY_PAGES) {
    try {
      const html = await fetchBuyPage(page, fetchFn);
      all.push(...extractVariants(html, page.slug, page.url));
      pagesChecked.push(page.slug);
    } catch {
      pagesFailed.push(page.slug);
    }
  }

  const scored: ProductMatch[] = all.map((v) => ({
    ...v,
    score: scoreVariant(new Set(tokens(v.name)), queryTokens),
  }));
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const limit = opts.limit ?? 10;
  return { matches: scored.slice(0, limit), pagesChecked, pagesFailed };
}

function guessCategory(q: string): string {
  if (/\biphone\b/.test(q)) return "iphone";
  if (/\bipad\b/.test(q)) return "ipad";
  if (/\bmac(book| mini| studio)?\b|\bimac\b/.test(q)) return "mac";
  if (/\bwatch\b/.test(q)) return "watch";
  return "";
}

/** Exact-part lookup: is this string already a part number? */
export function asPartNumber(s: string): string | null {
  const m = s.trim().toUpperCase().replace(/%2F/i, "/").match(/^([A-Z0-9]{3,8}\/A)$/);
  return m ? m[1] : null;
}
