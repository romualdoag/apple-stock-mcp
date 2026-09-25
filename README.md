# apple-stock-mcp

MCP server for **point-in-time** Apple Store pickup availability (US).
Ask whether a device is in stock *right now* — no watcher, no polling.

```text
Is the iPhone 18 Pro Max 512GB available at any Orlando store?
→ check_product_availability(product="iPhone 18 Pro Max 512GB", location="Orlando")
```

## Tools

| Tool | What it does |
|---|---|
| `check_product_availability` | Free-text product + location/stores → resolves matching variants, reports per-store pickup status. The main tool. |
| `check_availability` | Exact part numbers (`MJWA4LL/A`) + location/stores → tri-state status with Apple's pickup quote. |
| `search_products` | Free text → part numbers across the current US lineup. |
| `search_stores` | ZIP/city → nearby Apple Stores with numbers and distances. |

Availability is **tri-state**: `in_stock` / `out_of_stock` / `unknown`.
Rate limits, blocks and parse failures surface as `unknown` with a reason —
never silently as `out_of_stock`.

## How it works

- Uses Apple's `GET /shop/retail/pickup-message` API (`?pl=true&mts.0=regular&location=…&parts.N=…`).
  The legacy `/shop/fulfillment-messages` endpoint is dead (HTTP 541).
- Cookies are warmed via a buy page first — without them Apple returns empty bodies.
- Product resolution parses the embedded variant JSON on Apple's buy pages
  (`partNumber` ↔ `name`, e.g. `MJWA4LL/A` ↔ `iPhone 18 Pro Max 512GB Burgundy`).

## Run

```bash
npm install
npm run build
npm start          # stdio MCP server
npm test           # build + vitest (offline + live)
```

Live tests hit `apple.com`; offline tests use fixtures in `tests/fixtures/`.

## Hermes

```yaml
mcp_servers:
  apple-stock:
    command: "node"
    args: ["/home/hermes/github/apple-stock-mcp/dist/index.js"]
```

## Notes

- Apple throttles pickup queries per egress IP (~30 rapid requests → HTTP 541
  cooldown of 10–15 min). Don't loop; one query per question.
- US storefront only (`www.apple.com`). Other regions need their base URL.
- New models: add the buy page slug to `FAMILY_PAGES` in `src/catalog.ts`.
