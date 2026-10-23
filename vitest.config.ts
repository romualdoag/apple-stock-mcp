import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    // Cache frio (SQLite) isolado por padrão: cada suite reseta pra
    // ':memory:' no beforeEach via __resetCatalogCacheForTests().
    env: {
      APPLE_CACHE_PATH: ":memory:",
    },
  },
});
