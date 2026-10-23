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
 * Chave: `catalog:<slug>` → { html, variants, fetchedAt }.
 * Fail-soft: qualquer erro de SQLite (cwd read-only, lock, schema) desliga
 * o cache e segue direto pro upstream. Cache nunca quebra chamada.
 * Banco local nunca commitado (`*.sqlite*` no .gitignore).
 */

export interface CatalogCacheEntry {
  html: string;
  variants: Variant[];
  fetchedAt: string;
}

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

/** Grava no KV (fail-soft). */
export function kvSet(key: string, value: unknown): void {
  const store = getDb();
  if (!store) return;
  try {
    ensureKvTable(store);
    store
      .prepare("INSERT OR REPLACE INTO kv_cache (key, value_json, fetched_at) VALUES (?, ?, ?)")
      .run(key, JSON.stringify(value), new Date().toISOString());
  } catch {
    /* fail-soft */
  }
}

export function catalogKey(slug: string): string {
  return `catalog:${slug}`;
}

/** Lê buy-page do frio se fresca; `undefined` = miss/expirada/desligada. */
export function getCatalogEntry(slug: string): CatalogCacheEntry | undefined {
  const raw = kvGet(catalogKey(slug), catalogCacheTtlHours()) as CatalogCacheEntry | undefined;
  if (!raw || typeof raw.html !== "string" || !Array.isArray(raw.variants)) return undefined;
  return raw;
}

/** Grava buy-page (html + variants) no frio (fail-soft). */
export function setCatalogEntry(slug: string, html: string, variants: Variant[]): void {
  const entry: CatalogCacheEntry = { html, variants, fetchedAt: new Date().toISOString() };
  kvSet(catalogKey(slug), entry);
}

/** Limpa entradas `catalog:*` do frio (fail-soft). Usado por clearCatalogCache(). */
export function clearCatalogEntries(): void {
  const store = getDb();
  if (!store) return;
  try {
    ensureKvTable(store);
    store.prepare("DELETE FROM kv_cache WHERE key LIKE 'catalog:%'").run();
  } catch {
    /* fail-soft */
  }
}
