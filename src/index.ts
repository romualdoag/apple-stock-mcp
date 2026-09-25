#!/usr/bin/env node
/**
 * apple-stock-mcp — point-in-time Apple Store pickup availability (US).
 *
 * Ask: "is the iPhone 18 Pro Max 512GB in stock at any Orlando store?"
 * via check_product_availability — no watcher, no polling, one answer.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { checkAvailability, checkProductAvailability, searchStores } from "./service.js";
import { searchProducts } from "./catalog.js";

const server = new McpServer({ name: "apple-stock-mcp", version: "0.1.0" });

type TextResult = { content: [{ type: "text"; text: string }] };

function asText(obj: unknown): TextResult {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

const categoryParam = z
  .enum(["iphone", "ipad", "mac", "watch", "accessory"])
  .optional()
  .describe("Hint to narrow catalog search: iphone, ipad, mac, watch, accessory.");
const locationParam = z
  .string()
  .optional()
  .describe("ZIP code, city, or 'City, ST' — e.g. '32839', 'Orlando', 'Orlando, FL'.");
const storeNumber = z
  .string()
  .regex(/^R\d+$/i, "Store number must look like R053")
  .transform((s) => s.trim().toUpperCase());
const storesParam = z
  .array(storeNumber)
  .optional()
  .describe("Explicit Apple Store numbers, e.g. ['R053', 'R143']. Takes precedence over location.");

server.registerTool(
  "check_product_availability",
  {
    description:
      "Check right now whether an Apple device is available for store pickup near a location. Give a free-text product ('iPhone 18 Pro Max 512GB') and a location ('Orlando', '32839') or explicit store numbers. Resolves matching variants and reports per-store pickup status (in_stock / out_of_stock / unknown). This is a one-shot query, not a watcher.",
    inputSchema: {
      product: z.string().describe("Free text or exact part number, e.g. 'iPhone 18 Pro Max 512GB' or 'MJWA4LL/A'."),
      location: locationParam,
      stores: storesParam,
      category: categoryParam,
      maxVariants: z.coerce.number().int().min(1).max(20).optional().describe("Max matching variants to check (default 6, max 20)."),
    },
  },
  async ({ product, location, stores, category, maxVariants }) => {
    if (!location && !stores?.length) {
      throw new Error("Provide location or stores.");
    }
    return asText(await checkProductAvailability(product, { location, stores }, { category, maxVariants }));
  },
);

server.registerTool(
  "check_availability",
  {
    description:
      "Check exact Apple part numbers (e.g. ['MJWA4LL/A']) for pickup availability at explicit stores or near a location. Returns tri-state status per store/part with Apple's pickup quote.",
    inputSchema: {
      parts: z.array(z.string()).min(1).max(10).describe("Apple part numbers, e.g. ['MJWA4LL/A'] (max 10)."),
      location: locationParam,
      stores: storesParam,
    },
  },
  async ({ parts, location, stores }) => {
    if (!location && !stores?.length) {
      throw new Error("Provide location or stores.");
    }
    return asText(await checkAvailability(parts, { location, stores }));
  },
);

server.registerTool(
  "search_products",
  {
    description:
      "Find Apple part numbers matching free text ('iPhone 18 Pro Max 512GB') across the current US lineup. Use the returned part numbers with check_availability.",
    inputSchema: {
      query: z.string().describe("Free-text product query."),
      category: categoryParam,
      limit: z.coerce.number().int().min(1).max(50).optional().describe("Max results (default 10, max 50)."),
    },
  },
  async ({ query, category, limit }) => asText(await searchProducts(query, { category, limit })),
);

server.registerTool(
  "search_stores",
  {
    description:
      "List Apple Stores near a location (ZIP, city, or 'City, ST') with store numbers and distances. Use the numbers with check_availability.",
    inputSchema: { location: z.string().describe("ZIP, city, or 'City, ST' — e.g. '32839', 'Orlando, FL'.") },
  },
  async ({ location }) => asText(await searchStores(location)),
);

await server.connect(new StdioServerTransport());
