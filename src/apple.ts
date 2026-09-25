/**
 * apple.ts — thin client for Apple's US pickup-message API.
 *
 * Endpoint (verified live 2026-09-21):
 *   GET https://www.apple.com/shop/retail/pickup-message
 *     ?pl=true&mts.0=regular&store=R053&parts.0=XXXXLL%2FA
 *   or
 *     ?pl=true&mts.0=regular&location=32839&parts.0=XXXXLL%2FA
 *
 * Notes:
 * - Cookies must be warmed first (GET a buy page), otherwise the API
 *   returns an empty body. The client does this automatically.
 * - The legacy /shop/fulfillment-messages endpoint is dead (HTTP 541).
 * - Availability is tri-state: in_stock / out_of_stock / unknown.
 *   Transport failures, blocks and unparseable responses MUST surface as
 *   `unknown` with a reason — never silently as out_of_stock.
 */

export const APPLE_BASE_URL = "https://www.apple.com";
export const PICKUP_MESSAGE_PATH = "/shop/retail/pickup-message";
export const DEFAULT_REFERER = `${APPLE_BASE_URL}/shop/buy-iphone/iphone-18-pro`;
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Network timeout (ms) applied to every Apple fetch. Keeps MCP tools from hanging. */
export const FETCH_TIMEOUT_MS = 15_000;

/**
 * Single-retry backoff (ms) after HTTP 429/541 on the pickup query.
 * Throttle-aware: Apple cools down for 10–15 min after ~30 rapid requests
 * (see README), so we retry exactly ONCE after a short delay and then
 * surface `blocked`/`unknown` with the wait guidance — never loop.
 */
export const PICKUP_RETRY_DELAY_MS = 1_500;
/** Cap for a server-sent Retry-After (never stall an MCP tool for minutes). */
export const PICKUP_RETRY_MAX_DELAY_MS = 5_000;

export type AvailabilityKind = "in_stock" | "out_of_stock" | "unknown";

export interface PartAvailability {
  partNumber: string;
  /** Tri-state availability. */
  kind: AvailabilityKind;
  /** Raw pickupDisplay value from Apple (e.g. "available"). */
  pickupDisplay: string;
  /** Human quote from Apple, e.g. "Today at Apple Millenia". */
  quote: string | null;
  /**
   * Day granularity parsed from Apple's quote, e.g. "Today".
   * The pickup-message API gives no time slots — the exact pickup window
   * is assigned at checkout. Null when unavailable/unknown.
   */
  pickupDay: string | null;
  /** Product title reported by Apple, e.g. "iPhone 18 Pro 256GB Glacier". */
  productTitle: string | null;
  /** Present only when kind === "unknown". */
  reason?: string;
}

/** One store-hours row from Apple, e.g. { days: "Mon-Sat:", timings: "10:00 AM-9:00 PM" }. */
export interface StoreHoursEntry {
  days: string;
  timings: string;
}

export interface StoreAvailability {
  storeNumber: string;
  storeName: string;
  city: string | null;
  state: string | null;
  distance: string | null;
  /** Store opening hours (general hours, not per-part pickup slots). */
  storeHours: StoreHoursEntry[] | null;
  /** e.g. "In-Store Pickup available at this location." */
  pickupTypeText: string | null;
  parts: PartAvailability[];
}

export type FetchFn = typeof fetch;

export class AppleApiError extends Error {
  readonly kind: "blocked" | "transport" | "parse";
  constructor(kind: AppleApiError["kind"], message: string) {
    super(message);
    this.name = "AppleApiError";
    this.kind = kind;
  }
}

/** Minimal in-memory cookie jar (name=value pairs keyed by name). */
export class CookieJar {
  private cookies = new Map<string, string>();

  storeFromHeaders(headers: Headers): void {
    // Node's undici Headers exposes getSetCookie(); fall back gracefully.
    const getSetCookie = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
    const raw: string[] = getSetCookie ? getSetCookie.call(headers) : [];
    for (const line of raw) {
      const pair = line.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header(): string | null {
    if (this.cookies.size === 0) return null;
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  get size(): number {
    return this.cookies.size;
  }
}

export interface QueryScope {
  store?: string;
  location?: string;
}

/** Canonical Apple Store number: trimmed + uppercase (r053 -> R053). */
export function normalizeStoreNumber(s: string): string {
  return s.trim().toUpperCase();
}

/** Build the pickup-message URL for the given scope + parts. */
export function buildPickupUrl(parts: string[], scope: QueryScope): string {
  const params = new URLSearchParams();
  params.set("pl", "true");
  params.set("mts.0", "regular");
  if (scope.store) params.set("store", normalizeStoreNumber(scope.store));
  else if (scope.location) params.set("location", scope.location);
  else throw new AppleApiError("transport", "Either store or location is required");
  parts.forEach((p, i) => params.set(`parts.${i}`, p));
  return `${APPLE_BASE_URL}${PICKUP_MESSAGE_PATH}?${params.toString()}`;
}

/** Warm cookies by visiting a buy page (Apple returns empty bodies without them). */
export async function warmCookies(
  jar: CookieJar,
  fetchFn: FetchFn = fetch,
  referer: string = DEFAULT_REFERER,
): Promise<void> {
  try {
    const res = await fetchFn(referer, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    jar.storeFromHeaders(res.headers);
    // Drain body so the connection can be reused.
    await res.arrayBuffer().catch(() => undefined);
  } catch {
    // Warmup is best-effort; the query still goes out and any failure
    // surfaces as `unknown` downstream (including timeouts here).
  }
}

function pickupHeaders(jar: CookieJar, referer: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
    Referer: referer,
    "X-Requested-With": "XMLHttpRequest",
    "Accept-Language": "en-US,en;q=0.9",
  };
  const cookies = jar.header();
  if (cookies) headers["Cookie"] = cookies;
  return headers;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Honor Retry-After (seconds) when present, capped so MCP tools never stall. */
function retryDelayFrom(res: Response, fallbackMs: number): number {
  const raw = res.headers?.get?.("retry-after");
  if (raw != null) {
    const secs = Number(raw);
    if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, PICKUP_RETRY_MAX_DELAY_MS);
  }
  return fallbackMs;
}

/**
 * Run one pickup-message query. Returns the raw parsed JSON.
 * Throws AppleApiError on blocks (HTTP 541/5xx/429), transport failures,
 * or non-JSON responses.
 *
 * Throttle policy: exactly ONE retry after HTTP 429/541 (short backoff,
 * honors Retry-After up to a cap). Anything persistent becomes `blocked`
 * with the 10–15 min cooldown guidance — the caller maps it to `unknown`.
 */
export async function queryPickupRaw(
  parts: string[],
  scope: QueryScope,
  opts: { jar?: CookieJar; referer?: string; fetchFn?: FetchFn; retryDelayMs?: number } = {},
): Promise<unknown> {
  if (parts.length === 0) throw new AppleApiError("transport", "parts list is empty");
  const jar = opts.jar ?? new CookieJar();
  const referer = opts.referer ?? DEFAULT_REFERER;
  const fetchFn = opts.fetchFn ?? fetch;
  const retryDelayMs = opts.retryDelayMs ?? PICKUP_RETRY_DELAY_MS;

  if (jar.size === 0) await warmCookies(jar, fetchFn, referer);

  const url = buildPickupUrl(parts, scope);
  const doFetch = async (): Promise<Response> => {
    try {
      return await fetchFn(url, {
        headers: pickupHeaders(jar, referer),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new AppleApiError("transport", `Apple query timed out after ${FETCH_TIMEOUT_MS}ms`);
      }
      // Node <22 / undici surfaces AbortSignal.timeout as AbortError.
      if (err instanceof Error && err.name === "AbortError") {
        throw new AppleApiError("transport", `Apple query timed out after ${FETCH_TIMEOUT_MS}ms`);
      }
      throw new AppleApiError("transport", `Network failure querying Apple: ${String(err)}`);
    }
  };

  let res = await doFetch();
  jar.storeFromHeaders(res.headers);

  if (res.status === 541 || res.status === 429) {
    // Single retry only — then fall through to the blocked error below.
    await res.arrayBuffer().catch(() => undefined);
    const delay = retryDelayFrom(res, retryDelayMs);
    if (delay > 0) await sleep(delay);
    res = await doFetch();
    jar.storeFromHeaders(res.headers);
  }

  if (res.status === 541 || res.status === 429 || res.status >= 500) {
    throw new AppleApiError(
      "blocked",
      `Apple rate-limited/blocked the request (HTTP ${res.status}). Wait 10-15 minutes before retrying.`,
    );
  }
  if (!res.ok) {
    throw new AppleApiError("transport", `Apple returned HTTP ${res.status}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new AppleApiError("parse", "Apple returned a non-JSON response");
  }
}

interface RawPartEntry {
  partNumber?: string;
  pickupDisplay?: string;
  pickupSearchQuote?: string;
  messageTypes?: {
    regular?: {
      storePickupQuote?: string;
      storePickupQuote2_0?: string;
      storePickupProductTitle?: string;
    };
  };
}

interface RawStore {
  storeNumber?: string;
  storeName?: string;
  city?: string;
  state?: string;
  storeDistanceWithUnit?: string;
  pickupTypeAvailabilityText?: string;
  storeHours?: {
    hours?: { storeDays?: string; storeTimings?: string }[];
  };
  partsAvailability?: Record<string, RawPartEntry>;
}

function mapPickupDisplay(display: string): AvailabilityKind {
  const d = display.trim().toLowerCase();
  if (d === "available") return "in_stock";
  if (["unavailable", "not available", "not_available", "out of stock", "nostock"].includes(d)) {
    return "out_of_stock";
  }
  // Unknown display values -> unknown (fail open, never fake out_of_stock).
  return "unknown";
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Day granularity from Apple's quote ("Today at Apple Millenia",
 * "Available Today") — the finest the API offers. Returns the leading day
 * word (Today/Tomorrow/weekday) or null when the quote carries no day info
 * (e.g. "Currently unavailable").
 */
export function pickupDayFromQuote(quote: string | null): string | null {
  if (!quote) return null;
  const m = quote.match(/^(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (m) return m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  const m2 = quote.match(/\b(today|tomorrow)\b/i);
  return m2 ? m2[1][0].toUpperCase() + m2[1].slice(1).toLowerCase() : null;
}

function storeHoursFor(s: RawStore): StoreHoursEntry[] | null {
  const hours = s.storeHours?.hours;
  if (!Array.isArray(hours) || hours.length === 0) return null;
  const mapped = hours
    .filter((h) => h.storeDays || h.storeTimings)
    .map((h) => ({ days: h.storeDays ?? "", timings: h.storeTimings ?? "" }));
  return mapped.length > 0 ? mapped : null;
}

function productTitleFor(store: RawStore, part: string): string | null {
  const entry = store.partsAvailability?.[part];
  // Canonical product title, e.g. "iPhone 18 Pro 256GB Glacier"
  // (Apple uses U+00A0 non-breaking spaces — normalize them).
  const titled = entry?.messageTypes?.regular?.storePickupProductTitle;
  if (titled) return titled.replace(/[\u00a0]/g, " ");
  // Fallback: pickupSearchQuote sometimes carries the title instead of a quote.
  const quote = entry?.pickupSearchQuote ?? "";
  if (quote && !/^(available|unavailable)/i.test(quote)) return quote;
  return null;
}

/**
 * Parse a pickup-message response body into tri-state store availability.
 * `wantParts` is the list of parts requested (used to mark missing parts
 * as unknown rather than dropping them silently).
 */
export function parsePickupResponse(body: unknown, wantParts: string[]): StoreAvailability[] {
  const root = body as { body?: { stores?: RawStore[] } };
  const stores = root?.body?.stores;
  if (!Array.isArray(stores)) {
    throw new AppleApiError("parse", "Apple response has no body.stores array");
  }
  return stores.map((s) => {
    const availability = storeAvailability(s);
    const storeNumber = availability?.storeNumber ?? s.storeNumber ?? "";
    const parts: PartAvailability[] = wantParts.map((part) => {
      const entry = s.partsAvailability?.[part];
      if (!entry) {
        return {
          partNumber: part,
          kind: "unknown" as const,
          pickupDisplay: "",
          quote: null,
          pickupDay: null,
          productTitle: null,
          reason: `Apple returned no data for ${part} at ${storeNumber || "this store"}`,
        };
      }
      const display = entry.pickupDisplay ?? "";
      const kind = mapPickupDisplay(display);
      const regular = entry.messageTypes?.regular;
      const quote = regular?.storePickupQuote
        ? stripHtml(regular.storePickupQuote)
        : entry.pickupSearchQuote
          ? stripHtml(entry.pickupSearchQuote)
          : null;
      const title = productTitleFor(s, part);
      return {
        partNumber: part,
        kind,
        pickupDisplay: display,
        quote,
        pickupDay: kind === "in_stock" ? pickupDayFromQuote(quote) : null,
        productTitle: title,
        ...(kind === "unknown" ? { reason: `Unrecognized pickupDisplay value: ${display || "(empty)"}` } : {}),
      };
    });
    return {
      storeNumber,
      storeName: s.storeName ?? "",
      city: s.city ?? null,
      state: s.state ?? null,
      distance: s.storeDistanceWithUnit ?? null,
      storeHours: storeHoursFor(s),
      pickupTypeText: s.pickupTypeAvailabilityText ?? null,
      parts,
    };
  });
}

function storeAvailability(s: RawStore): { storeNumber: string } | null {
  return s.storeNumber ? { storeNumber: s.storeNumber } : null;
}
