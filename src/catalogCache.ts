import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { Variant } from "./catalog.js";

/**
 * catalogCache.ts — cache FRIO para buy-pages do catálogo Apple (SQLite kv_cache).
 *
 * Quente vs frio (não negociável):
 * - QUENTE: disponibilidade pickup (checkAvailability) é SEMPRE live — nunca
 *   passa por este cache. Staleness aqui prejudica decisão de compra.
 * - FRIO: buy-page HTML + variants extraídos vão pro SQLite com TTL longo
 *   (default 7 dias). Catálogo muda poucas vezes/ano; status vem do live.
 *
 * Chave: `v1:catalog:<slug>` → { html, variants, fetchedAt }, onde <slug> é
 * normalizado (trim + lowercase) e aliases de lineup resolvidos
 * (CATALOG_SLUG_ALIASES). Leitura cai pro fallback da chave legada
 * `catalog:<slug>` e migra o hit pra chave v1. Hit servido só após
 * validação barata; se inválido, invalida em vez de servir stale.
 *
 * Fail-soft: qualquer erro de SQLite (cwd read-only, lock, schema) desliga
 * o cache e segue direto pro upstream. Cache nunca quebra chamada.
 * Banco local nunca commitado (`*.sqlite*` no .gitignore).
 */

export interface CatalogCacheEntry {
  html: string;
  variants: Variant[];
  fetchedAt: string;
}

/** Versão do esquema das chaves de catálogo (bump = invalida o frio). */
export const CATALOG_CACHE_VERSION = "v1";

/**
 * Alias de slugs renomeados entre lineups: nome antigo → slug atual.
 * Pequeno e editável — ao trocar de lineup, mapeie aqui a página da
 * geração anterior pra página que a substitui (mesmo tier), sem mexer
 * no resto do código.
 */
export const CATALOG_SLUG_ALIASES: Record<string, string> = {
  "iphone-17-pro": "iphone-18-pro",
  "iphone-16": "iphone-17",
  "apple-watch-series-10": "apple-watch",
  "apple-watch-ultra-2": "apple-watch-ultra",
};

let dbPathOverride: string | undefined;
let db: DatabaseSync | null = null;

export function isCatalogCacheEnabled(): boolean {
  return process.env.APPLE_CACHE_ENABLED !== "0";
}

export function catalogCacheTtlHours(): number {
  const raw = Number(process.env.APPLE_CATALOG_TTL_HOURS ?? 168); // 7 dias
  return Number.isFinite(raw) && raw > 0 ? raw : 168;
}

function cacheDbPath(): string {
  return dbPathOverride ?? process.env.APPLE_CACHE_PATH ?? path.join(process.cwd(), "catalog-cache.sqlite");
}

/** Test hook: aponta o cache pra outro arquivo (ou ':memory:'). */
export function __resetCatalogCacheForTests(dbPath = ":memory:"): void {
  closeCatalogCache();
  dbPathOverride = dbPath;
}

export function closeCatalogCache(): void {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  db = null;
}

function ensureKvTable(store: DatabaseSync): void {
  store.exec(`
    CREATE TABLE IF NOT EXISTS kv_cache (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
  `);
}

function getDb(): DatabaseSync | null {
  if (!isCatalogCacheEnabled()) return null;
  if (db) return db;
  try {
    const opened = new DatabaseSync(cacheDbPath());
    opened.exec("PRAGMA journal_mode=WAL");
    opened.exec("PRAGMA busy_timeout=5000");
    ensureKvTable(opened);
    db = opened;
    return db;
  } catch {
    // Fail-soft: cwd read-only ou arquivo travado nunca quebra catalog calls.
    return null;
  }
}

/** Lê do KV se fresco; `undefined` = miss, expirado, desligado ou erro. */
export function kvGet(key: string, ttlHours: number): unknown | undefined {
  const store = getDb();
  if (!store) return undefined;
  try {
    ensureKvTable(store);
    const row = store
      .prepare("SELECT value_json AS valueJson, fetched_at AS fetchedAt FROM kv_cache WHERE key = ?")
      .get(key) as { valueJson: string; fetchedAt: string } | undefined;
    if (!row) return undefined;
    const ageMs = Date.now() - Date.parse(row.fetchedAt);
    if (!Number.isFinite(ageMs) || ageMs > ttlHours * 3_600_000) return undefined;
    return JSON.parse(row.valueJson) as unknown;
  } catch {
    return undefined;
  }
}

function kvSetAt(key: string, value: unknown, fetchedAt: string): void {
  const store = getDb();
  if (!store) return;
  try {
    ensureKvTable(store);
    store
      .prepare("INSERT OR REPLACE INTO kv_cache (key, value_json, fetched_at) VALUES (?, ?, ?)")
      .run(key, JSON.stringify(value), fetchedAt);
  } catch {
    /* fail-soft */
  }
}

/** Grava no KV (fail-soft). */
export function kvSet(key: string, value: unknown): void {
  kvSetAt(key, value, new Date().toISOString());
}

/** Apaga uma chave do KV (fail-soft). Usado pra invalidar hit divergente. */
export function kvDelete(key: string): void {
  const store = getDb();
  if (!store) return;
  try {
    ensureKvTable(store);
    store.prepare("DELETE FROM kv_cache WHERE key = ?").run(key);
  } catch {
    /* fail-soft */
  }
}

/** Normaliza slug pra chave: trim + lowercase. */
export function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

/**
 * Resolve alias de lineup (nome antigo → slug atual), com guarda contra
 * ciclos. Slugs mudam a cada lineup (`iphone-18-pro` → `iphone-19-pro`);
 * part numbers são o identificador estável — o alias só evita miss frio.
 */
export function resolveSlug(slug: string): string {
  let cur = normalizeSlug(slug);
  const seen = new Set<string>([cur]);
  for (let i = 0; i < 8; i++) {
    const next = CATALOG_SLUG_ALIASES[cur];
    if (!next) return cur;
    const norm = normalizeSlug(next);
    if (seen.has(norm)) return cur; // ciclo no mapa: para no último são
    seen.add(norm);
    cur = norm;
  }
  return cur;
}

/** Chave atual: versionada + normalizada + alias resolvido. */
export function catalogKey(slug: string): string {
  return `${CATALOG_CACHE_VERSION}:catalog:${resolveSlug(slug)}`;
}

/**
 * Chave legada (pré-v1, sem versão): só leitura com fallback + migração.
 * Nunca grave nela — `setCatalogEntry` sempre usa `catalogKey()`.
 */
export function legacyCatalogKey(slug: string): string {
  return `catalog:${resolveSlug(slug)}`;
}

function isEntryShape(raw: unknown): raw is CatalogCacheEntry {
  if (!raw || typeof raw !== "object") return false;
  const e = raw as { html?: unknown; variants?: unknown };
  return typeof e.html === "string" && Array.isArray(e.variants);
}

const PART_RE = /^[A-Z0-9]{3,8}\/A$/;

/**
 * Validação barata de um hit, sem rede: todo part number guardado precisa
 * ser bem-formado e ainda constar no html guardado. `false` = html
 * corrompido ou parser à deriva → invalide em vez de servir.
 * (Lista vazia passa: página sem variants é plausível e refetch repetiria
 * o mesmo resultado — sem prova de stale, serve.)
 */
export function validateCatalogEntry(entry: CatalogCacheEntry): boolean {
  if (!isEntryShape(entry)) return false;
  return entry.variants.every(
    (v) =>
      typeof v?.partNumber === "string" && PART_RE.test(v.partNumber) && entry.html.includes(v.partNumber),
  );
}

export interface GetCatalogEntryOpts {
  /**
   * Validação contra o catálogo atual quando houver refresh barato em mãos
   * (ex. comparar part numbers com uma lista recém-obtida). Retornou
   * `false` → invalida a chave em vez de servir stale.
   */
  validate?: (entry: CatalogCacheEntry) => boolean;
}

/**
 * Lê buy-page do frio se fresca; `undefined` = miss/expirada/desligada.
 * Ordem: chave v1 → legada do slug canônico → legada do slug cru
 * (migra o hit pra v1 preservando `fetchedAt`, sem renovar TTL).
 */
export function getCatalogEntry(slug: string, opts: GetCatalogEntryOpts = {}): CatalogCacheEntry | undefined {
  const ttl = catalogCacheTtlHours();
  const canonical = resolveSlug(slug);
  const rawNorm = normalizeSlug(slug);
  const current = catalogKey(slug);
  const candidates = [
    current,
    legacyCatalogKey(slug),
    ...(rawNorm === canonical ? [] : [`catalog:${rawNorm}`]),
  ];
  for (const key of candidates) {
    const raw = kvGet(key, ttl) as CatalogCacheEntry | undefined;
    if (!isEntryShape(raw)) continue;
    if (opts.validate) {
      let ok = false;
      try {
        ok = opts.validate(raw);
      } catch {
        ok = true; // fail-soft: validador quebrou não derruba o hit
      }
      if (!ok) {
        kvDelete(key);
        return undefined;
      }
    }
    if (key !== current) {
      // Migra pra chave v1 preservando a idade original (sem renovar TTL).
      kvSetAt(current, raw, raw.fetchedAt);
      kvDelete(key);
    }
    return raw;
  }
  return undefined;
}

/** Grava buy-page (html + variants) no frio, sempre na chave v1 (fail-soft). */
export function setCatalogEntry(slug: string, html: string, variants: Variant[]): void {
  const entry: CatalogCacheEntry = { html, variants, fetchedAt: new Date().toISOString() };
  kvSet(catalogKey(slug), entry);
}

/** Apaga todas as chaves (v1 + legadas) de um slug (fail-soft). */
export function deleteCatalogEntry(slug: string): void {
  const canonical = resolveSlug(slug);
  const rawNorm = normalizeSlug(slug);
  const keys = new Set([catalogKey(slug), `catalog:${canonical}`, `catalog:${rawNorm}`]);
  for (const key of keys) kvDelete(key);
}

/** Limpa entradas de catálogo v1 e legadas do frio (fail-soft). Usado por clearCatalogCache(). */
export function clearCatalogEntries(): void {
  const store = getDb();
  if (!store) return;
  try {
    ensureKvTable(store);
    store.prepare("DELETE FROM kv_cache WHERE key LIKE 'catalog:%' OR key LIKE 'v1:catalog:%'").run();
  } catch {
    /* fail-soft */
  }
}
