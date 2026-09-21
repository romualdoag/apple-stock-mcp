/**
 * service.ts — orchestration over apple.ts + catalog.ts.
 * Every public function returns tri-state availability; failures are
 * reported as `unknown` with a reason, never as out_of_stock.
 */

import {
  AppleApiError,
  CookieJar,
  DEFAULT_REFERER,
  parsePickupResponse,
  queryPickupRaw,
  type FetchFn,
  type StoreAvailability,
} from "./apple.js";
import { asPartNumber, searchProducts } from "./catalog.js";

const jar = new CookieJar();

export interface AvailabilitySummary {
  checkedAt: string;
  parts: string[];
  scope: { stores?: string[]; location?: string };
  stores: StoreAvailability[];
  /** True when every store/part resolved to a known state. */
  healthy: boolean;
  /** True when at least one part is confirmed in stock somewhere. */
  anyInStock: boolean;
}

function summarize(
  stores: StoreAvailability[],
  parts: string[],
  scope: AvailabilitySummary["scope"],
): AvailabilitySummary {
  let healthy = true;
  let anyInStock = false;
  for (const s of stores) {
    for (const p of s.parts) {
      if (p.kind === "unknown") healthy = false;
      if (p.kind === "in_stock") anyInStock = true;
    }
  }
  return { checkedAt: new Date().toISOString(), parts, scope, stores, healthy, anyInStock };
}

export async function checkAvailability(
  parts: string[],
  scope: { stores?: string[]; location?: string },
  opts: { referer?: string; fetchFn?: FetchFn } = {},
): Promise<AvailabilitySummary> {
  const fetchFn = opts.fetchFn ?? fetch;
  const referer = opts.referer ?? DEFAULT_REFERER;
  if (parts.length === 0) throw new Error("parts must not be empty");

  try {
    if (scope.stores && scope.stores.length > 0) {
      const all: StoreAvailability[] = [];
      for (const store of scope.stores) {
        const raw = await queryPickupRaw(parts, { store }, { jar, referer, fetchFn });
        all.push(...parsePickupResponse(raw, parts));
      }
      return summarize(all, parts, { stores: scope.stores });
    }
    if (scope.location) {
      const raw = await queryPickupRaw(parts, { location: scope.location }, { jar, referer, fetchFn });
      return summarize(parsePickupResponse(raw, parts), parts, { location: scope.location });
    }
    throw new Error("Either stores or location is required");
  } catch (err) {
    if (err instanceof AppleApiError) {
      // Whole-query failure: report one unknown entry per requested part.
      const label = scope.stores?.join(",") ?? scope.location ?? "?";
      const stores: StoreAvailability[] = [
        {
          storeNumber: label,
          storeName: "",
          city: null,
          state: null,
          distance: null,
          parts: parts.map((partNumber) => ({
            partNumber,
            kind: "unknown" as const,
            pickupDisplay: "",
            quote: null,
            productTitle: null,
            reason: err.message,
          })),
        },
      ];
      return summarize(stores, parts, scope);
    }
    throw err;
  }
}

export interface StoreInfo {
  storeNumber: string;
  storeName: string;
  city: string | null;
  state: string | null;
  distance: string | null;
}

/**
 * List Apple Stores near a location (ZIP, city, or "City, ST").
 * Uses a probe part when the caller doesn't supply one: the pickup API
 * requires at least one part to return the nearby store list.
 */
export async function searchStores(
  location: string,
  opts: { probePart?: string; fetchFn?: FetchFn } = {},
): Promise<{ location: string; stores: StoreInfo[]; probePart: string }> {
  const fetchFn = opts.fetchFn ?? fetch;
  let probePart = opts.probePart ?? asPartNumber(location) ?? "";
  if (!probePart) {
    // Resolve a probe from the live catalog (first iPhone 18 Pro variant).
    const found = await searchProducts("iPhone 18 Pro", { limit: 1, fetchFn });
    probePart = found.matches[0]?.partNumber ?? "";
  }
  if (!probePart) throw new Error("Could not resolve a probe part to list stores");
  const raw = await queryPickupRaw([probePart], { location }, { jar, fetchFn });
  const parsed = parsePickupResponse(raw, [probePart]);
  return {
    location,
    probePart,
    stores: parsed.map((s) => ({
      storeNumber: s.storeNumber,
      storeName: s.storeName,
      city: s.city,
      state: s.state,
      distance: s.distance,
    })),
  };
}

export interface ProductCheckResult {
  query: string;
  resolvedParts: { partNumber: string; name: string }[];
  availability: AvailabilitySummary;
  note: string | null;
}

/**
 * One-shot: resolve a free-text product query to part numbers, then check
 * them at the given location (ZIP/city) or explicit store numbers.
 * The user's main use case: "iPhone 18 Pro Max 512GB em Orlando".
 */
export async function checkProductAvailability(
  productQuery: string,
  scope: { location?: string; stores?: string[] },
  opts: { category?: string; maxVariants?: number; fetchFn?: FetchFn; exactParts?: string[] } = {},
): Promise<ProductCheckResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  let resolved: { partNumber: string; name: string }[];
  let note: string | null = null;

  const exact = opts.exactParts?.length
    ? opts.exactParts
    : (() => {
        const single = asPartNumber(productQuery);
        return single ? [single] : [];
      })();

  if (exact.length > 0) {
    resolved = exact.map((partNumber) => ({ partNumber, name: partNumber }));
  } else {
    const found = await searchProducts(productQuery, {
      category: opts.category,
      limit: opts.maxVariants ?? 6,
      fetchFn,
    });
    if (found.matches.length === 0) {
      throw new Error(
        `No products matched "${productQuery}"${found.pagesFailed.length ? ` (${found.pagesFailed.length} catalog pages failed to load)` : ""}`,
      );
    }
    // Keep only top-score matches to avoid checking unrelated variants.
    const top = found.matches[0].score;
    resolved = found.matches
      .filter((m) => m.score === top)
      .slice(0, opts.maxVariants ?? 6)
      .map((m) => ({ partNumber: m.partNumber, name: m.name }));
    if (found.pagesFailed.length > 0) {
      note = `Catalog incomplete: ${found.pagesFailed.join(", ")} failed to load. Results cover: ${found.pagesChecked.join(", ")}.`;
    }
  }

  const refererHint = await refererFor(resolved[0]?.partNumber, fetchFn).catch(() => DEFAULT_REFERER);
  const availability = await checkAvailability(
    resolved.map((r) => r.partNumber),
    scope,
    { referer: refererHint, fetchFn },
  );
  return { query: productQuery, resolvedParts: resolved, availability, note };
}

async function refererFor(_part: string | undefined, _fetchFn: FetchFn): Promise<string> {
  // The buy-iphone hub works as a referer for all iPhone parts; keep the
  // default unless catalog search told us otherwise in the future.
  return DEFAULT_REFERER;
}
